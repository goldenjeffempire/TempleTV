/**
 * React bindings for the player-core machine + transport.
 *
 * Session singleton model
 * ───────────────────────
 * The machine + transport are created ONCE per `baseUrl` and kept alive
 * indefinitely — they survive React component unmounts caused by SPA
 * navigation.  This means navigating away and back to the player produces
 * zero BOOTSTRAP latency: the machine is already in PLAYING state and the
 * new video elements are bound and started in one synchronous pass inside
 * `attachElements()`.
 *
 * Lifecycle
 * ─────────
 *   mount   → attachElements()  — wire new <video> elements, replay state
 *   unmount → detachElements()  — release HLS / pause; transport stays up
 *   remount → attachElements()  — same as mount, machine already PLAYING
 *
 * Usage:
 *   const { snapshot, attach } = useV2Broadcast({ baseUrl: "/api/broadcast-v2" });
 *   <video ref={attach.A} style={{ position:"absolute", inset:0 }} />
 *   <video ref={attach.B} style={{ position:"absolute", inset:0 }} />
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlayerMachine, type IntentHandler } from "./machine.js";
import { V2Transport } from "./transport.js";
import { createWebAdapter, type WebAdapterHandle, type WebBuffer } from "./adapters/web.js";
import type { PlayerSnapshot } from "./types.js";

export interface UseV2BroadcastOptions {
  baseUrl: string;
  attachHls?: (video: HTMLVideoElement, url: string) => () => void;
  enabled?: boolean;
  /**
   * Whether this player instance should fire `report-stall` to the server
   * when it reaches SKIP_PENDING (all local retries exhausted).
   *
   * Defaults to `true` for real viewer surfaces (TV, web, mobile) so that
   * a broken source is automatically removed from rotation after the first
   * stall report.
   *
   * Set to `false` for operator / monitoring surfaces (admin preview,
   * master-control panel) that should NEVER affect the broadcast stream.
   */
  enableStallReport?: boolean;
}

export interface UseV2BroadcastResult {
  snapshot: PlayerSnapshot;
  connected: boolean;
  attach: {
    A: (el: HTMLVideoElement | null) => void;
    B: (el: HTMLVideoElement | null) => void;
  };
}

// ── Module-level session store ──────────────────────────────────────────────

const INITIAL_SNAPSHOT: PlayerSnapshot = {
  state: "BOOTSTRAP",
  activeBufferId: "A",
  bufferA: null,
  bufferB: null,
  lastServerSnapshot: null,
  lastSequence: 0,
};

interface BroadcastSession {
  machine: PlayerMachine;
  transport: V2Transport;
  /** Current web adapter — null when no video elements are mounted. */
  adapter: WebAdapterHandle | null;
  bufA: WebBuffer | null;
  bufB: WebBuffer | null;
  /** Live machine snapshot, updated on every FSM state change. */
  snapshot: PlayerSnapshot;
  /** Live transport connection state. */
  connected: boolean;
  /** All active React snapshot subscribers (one per mounted hook instance). */
  snapshotListeners: Set<(s: PlayerSnapshot) => void>;
  /** All active React connection subscribers. */
  connectedListeners: Set<(c: boolean) => void>;
  /** Cleanup returned by machine.subscribe(). */
  machineUnsub: () => void;
}

/** Singleton sessions keyed by baseUrl. Persist across React component
 * unmounts so SPA navigation produces zero BOOTSTRAP latency. A janitor
 * (started lazily on first session creation) evicts sessions that have had
 * no listeners for SESSION_IDLE_EVICT_MS, so a long-lived tab that visited
 * a player once doesn't keep a WebSocket open indefinitely.
 */
const sessions = new Map<string, { session: BroadcastSession; lastIdleAtMs: number | null }>();

/**
 * Immediately pause and unload every active broadcast session's video elements.
 *
 * Call this synchronously in the same event-loop tick as any SPA navigation
 * that moves to a full-screen player (or away from one). Because the call
 * runs BEFORE `setState` / React's render cycle, the background player is
 * silenced before the first paint of the new surface — eliminating the
 * overlapping-audio window that exists while React schedules its unmount
 * cleanup effects.
 *
 * The session transport and FSM continue running so navigating back to the
 * hero reconnects at the exact wall-clock broadcast position without going
 * through BOOTSTRAP again.
 *
 * This is the symmetric complement to `attachElements`: just as attaching
 * must happen before playback starts, pausing all sessions must happen
 * before a new surface can safely start its own playback.
 */
export function pauseAllBroadcastSessions(): void {
  for (const [, entry] of sessions) {
    const { session } = entry;
    const { adapter } = session;
    if (!adapter) continue;
    // Destroy the adapter first: removes all DOM event listeners via the
    // AbortController so stale buffer-ready / buffer-error events cannot
    // fire into the FSM after the elements are detached. Then unbind both
    // buffers: each unbind() call pauses the video element, destroys any
    // attached HLS/DASH instance, and removes the src attribute — fully
    // stopping network activity and audio output.
    try {
      adapter.destroy();
      adapter.apply({ type: "unbind", bufferId: "A" });
      adapter.apply({ type: "unbind", bufferId: "B" });
    } catch { /* ignore — element may already be detached */ }
    session.adapter = null;
    session.bufA   = null;
    session.bufB   = null;
  }
}

/** Sessions idle this long with zero subscribers are torn down. */
const SESSION_IDLE_EVICT_MS = 5 * 60 * 1000;
let janitorInterval: ReturnType<typeof setInterval> | null = null;

function startJanitor(): void {
  if (janitorInterval !== null) return;
  if (typeof setInterval === "undefined") return;
  janitorInterval = setInterval(() => {
    const now = Date.now();
    for (const [baseUrl, entry] of sessions) {
      const hasListeners =
        entry.session.snapshotListeners.size > 0 ||
        entry.session.connectedListeners.size > 0;
      if (hasListeners) {
        entry.lastIdleAtMs = null;
        continue;
      }
      if (entry.lastIdleAtMs === null) {
        entry.lastIdleAtMs = now;
        continue;
      }
      if (now - entry.lastIdleAtMs >= SESSION_IDLE_EVICT_MS) {
        try {
          entry.session.machineUnsub();
          entry.session.transport.stop?.();
          detachElements(entry.session);
        } catch {
          /* best-effort */
        }
        sessions.delete(baseUrl);
      }
    }
    if (sessions.size === 0 && janitorInterval !== null) {
      clearInterval(janitorInterval);
      janitorInterval = null;
    }
  }, 60_000);
  // Don't keep Node-style event loops alive on RN/Node — best-effort
  // (browsers ignore unref).
  (janitorInterval as unknown as { unref?: () => void }).unref?.();
}

function createSession(baseUrl: string): BroadcastSession {
  // `session` is declared with `let` so the machine's IntentHandler closure
  // can reference it before the object literal is fully constructed.
  let session!: BroadcastSession;

  const machine = new PlayerMachine((intent) => {
    // Route every intent to the currently installed adapter (if any).
    // When no video elements are mounted (adapter === null) intents are
    // silently dropped — the machine state is still tracked correctly.
    session.adapter?.apply(intent);
  });

  const transport = new V2Transport({
    baseUrl,
    onPlayerEvent: (e) => machine.send(e),
    onConnectionChange: (c) => {
      session.connected = c;
      for (const l of session.connectedListeners) l(c);
    },
    // Forward server-client clock offset to the machine so resolvePositionSecs
    // uses server time instead of the local OS clock. Without this wire the
    // machine's clockOffsetMs stays 0 forever — every seek position is wrong
    // by the server-client clock delta, causing persistent timeline drift.
    onClockCalibration: (offset) => machine.setClockOffsetMs(offset),
  });

  // Wire machine → transport: when the active buffer ends with no preloaded
  // inactive item the machine calls this to request a fresh snapshot
  // immediately, cutting the SYNCING window from ≤8 s (keep-alive) to <1 s.
  machine.setNeedSnapshotCallback(() => transport.requestSnapshot());

  // Wire machine → server: when a video ends naturally before its scheduled
  // durationSecs slot expires, notify the server so it advances its cycle
  // anchor immediately.  Without this, every connected player gets pulled
  // back onto the just-finished item by the next server snapshot (which
  // still shows the old item as `current` with `endsAtMs` in the future).
  machine.setNaturalEndCallback((itemId: string) => {
    // Retry with backoff — the server MUST receive this signal or it keeps
    // presenting the ended item as `current`, causing every client's 30 s
    // post-natural-end guard to block the next item for up to half a minute.
    // The endpoint is item-level idempotent, so repeated POSTs are safe.
    const naturalEndRetryDelays = [2_000, 4_000, 8_000];
    const doPost = (attempt: number): void => {
      void fetch(`${baseUrl}/natural-end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId }),
        signal: AbortSignal.timeout(8_000),
      }).catch(() => {
        if (attempt < naturalEndRetryDelays.length) {
          setTimeout(() => doPost(attempt + 1), naturalEndRetryDelays[attempt]);
        } else {
          // All retries exhausted — fetch a fresh snapshot so the machine
          // can evaluate the server's current state immediately and clear
          // the 30 s guard as soon as the server finally advances on its
          // own drift-poll tick (≤ 30 s from the slot expiry).
          transport.requestSnapshot();
        }
      });
    };
    doPost(0);
  });

  const machineUnsub = machine.subscribe((snap) => {
    session.snapshot = snap;
    for (const l of session.snapshotListeners) l(snap);
  });

  transport.start();

  session = {
    machine,
    transport,
    adapter: null,
    bufA: null,
    bufB: null,
    snapshot: INITIAL_SNAPSHOT,
    connected: false,
    snapshotListeners: new Set(),
    connectedListeners: new Set(),
    machineUnsub,
  };

  return session;
}

/**
 * Attach fresh <video> elements to the session.
 *
 * Creates a new web adapter initialised with the machine's current active
 * buffer so z-index / mute state is correct from frame 0.  Then replays
 * the current machine state to the adapter so playback resumes at the exact
 * wall-clock position without going through BOOTSTRAP.
 */
function attachElements(
  session: BroadcastSession,
  elA: HTMLVideoElement,
  elB: HTMLVideoElement,
  attachHls?: (video: HTMLVideoElement, url: string) => () => void,
): void {
  // Release any stale elements before wiring new ones.
  detachElements(session);

  const { machine } = session;
  const snap = machine.getSnapshot();

  const bufA: WebBuffer = { el: elA, boundUrl: null };
  const bufB: WebBuffer = { el: elB, boundUrl: null };
  const adapter = createWebAdapter(
    bufA,
    bufB,
    { send: (e) => machine.send(e), attachHls },
    snap.activeBufferId, // initialActiveId — correct z-index from the start
  );

  session.bufA = bufA;
  session.bufB = bufB;
  session.adapter = adapter;

  // Immediately drive the new adapter to match the current machine state so
  // the viewer sees video within one animation frame on remount.
  // Pass the transport's clock offset so the seek position on remount uses
  // server time rather than the raw local OS clock.
  replayStateToAdapter(snap, (intent) => adapter.apply(intent), session.transport.getClockOffsetMs());
}

/**
 * Detach video elements — releases HLS instances and pauses buffers.
 * The transport and machine remain running so the session stays synchronised
 * with the server even while no player component is mounted.
 */
function detachElements(session: BroadcastSession): void {
  const { adapter } = session;
  if (!adapter) return;
  try {
    // Destroy the adapter first: removes all DOM event listeners via the
    // AbortController so stale buffer-error / buffer-ready events cannot
    // fire into the FSM after the elements are detached.
    adapter.destroy();
    adapter.apply({ type: "unbind", bufferId: "A" });
    adapter.apply({ type: "unbind", bufferId: "B" });
  } catch {
    /* ignore errors during detach */
  }
  session.adapter = null;
  session.bufA = null;
  session.bufB = null;
}

/**
 * Synchronously drive `adapter` to reflect `snap` so newly mounted video
 * elements immediately start playing from the correct wall-clock position.
 *
 * Skips BOOTSTRAP / SYNCING / recovery states where we have no item to play;
 * those states resolve naturally as the next server snapshot arrives.
 *
 * @param clockOffsetMs - Server-client clock delta (`serverTimeMs − Date.now()`).
 *   Applied to the seek calculation so remounts use server time rather than
 *   the raw local OS clock — the same correction the machine uses in
 *   resolvePositionSecs. Defaults to 0 (no correction) when not provided.
 */
function replayStateToAdapter(snap: PlayerSnapshot, adapter: IntentHandler, clockOffsetMs = 0): void {
  const activeId = snap.activeBufferId;
  const inactiveId: "A" | "B" = activeId === "A" ? "B" : "A";
  const activeItem = activeId === "A" ? snap.bufferA : snap.bufferB;
  const inactiveItem = inactiveId === "A" ? snap.bufferA : snap.bufferB;

  // Include recovery and loading states so remounting immediately binds
  // the active item and plays it at wall-clock position. Without this, the
  // adapter sits idle until the next server snapshot fires the correct FSM
  // transition (up to 8 s). PREPARING_ACTIVE is included so a mid-load
  // remount (e.g. SPA navigation back) re-issues the bind+play commands to
  // the freshly created adapter instead of waiting for the next keepAlive.
  const shouldPlay =
    snap.state === "PLAYING" ||
    snap.state === "PREPARING_ACTIVE" ||
    snap.state === "PREPARING_NEXT" ||
    snap.state === "HANDOFF" ||
    snap.state === "LIVE_OVERRIDE_ACTIVE" ||
    snap.state === "RECOVERING_PRIMARY" ||
    snap.state === "RECOVERING_FAILOVER";

  if (shouldPlay && activeItem) {
    adapter({ type: "bind", bufferId: activeId, item: activeItem });
    // Seek to wall-clock position so we rejoin the broadcast mid-stream.
    // Apply clockOffsetMs so the seek uses server time — matching the same
    // correction applied by resolvePositionSecs inside the machine. Without
    // this, devices with OS clock skew rejoin at the wrong position on every
    // SPA navigation or sleep-wake cycle.
    const server = snap.lastServerSnapshot;
    const startsAtMs =
      server?.current && "startsAtMs" in server.current
        ? (server.current as { startsAtMs: number }).startsAtMs
        : null;
    const nowMs = Date.now() + clockOffsetMs;
    const positionSecs = startsAtMs ? Math.max(0, (nowMs - startsAtMs) / 1000) : 0;
    adapter({ type: "play", bufferId: activeId, positionSecs });
  }

  // Pre-seed the inactive buffer so the next transition has zero black frames.
  if (inactiveItem) {
    adapter({ type: "bind", bufferId: inactiveId, item: inactiveItem });
  }
}

// ── React hook ──────────────────────────────────────────────────────────────

export function useV2Broadcast(opts: UseV2BroadcastOptions): UseV2BroadcastResult {
  const { baseUrl, attachHls, enabled = true, enableStallReport = true } = opts;

  // Keep latest option values in a ref so callbacks don't need to be
  // recreated when they change.
  const optsRef = useRef({ attachHls, enableStallReport });
  optsRef.current = { attachHls, enableStallReport };

  const elsRef = useRef<{ A: HTMLVideoElement | null; B: HTMLVideoElement | null }>({
    A: null,
    B: null,
  });

  // Get or lazily create the singleton session for this baseUrl.
  const session = useMemo<BroadcastSession | null>(() => {
    if (!enabled) return null;
    let entry = sessions.get(baseUrl);
    if (!entry) {
      entry = { session: createSession(baseUrl), lastIdleAtMs: null };
      sessions.set(baseUrl, entry);
      startJanitor();
    } else {
      // Re-entering with active hook — cancel any pending eviction.
      entry.lastIdleAtMs = null;
    }
    return entry.session;
  }, [baseUrl, enabled]);

  const [snapshot, setSnapshot] = useState<PlayerSnapshot>(
    () => session?.snapshot ?? INITIAL_SNAPSHOT,
  );
  const [connected, setConnected] = useState<boolean>(session?.connected ?? false);

  // Grace timer for `connected = false` state transitions.
  // If the transport reconnects within this window we never surface
  // "Reconnecting" to React — avoiding spurious UI flashes on tab-switch
  // or brief network hiccups where the WS reopens within ~1.5 s.
  const connGraceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to live session state changes.
  useEffect(() => {
    if (!session) return;
    const onSnap = (s: PlayerSnapshot) => setSnapshot(s);
    const onConn = (c: boolean) => {
      if (c) {
        // Connected — cancel any pending "disconnected" grace timer and
        // immediately surface the connected state to React.
        if (connGraceTimer.current !== null) {
          clearTimeout(connGraceTimer.current);
          connGraceTimer.current = null;
        }
        setConnected(true);
      } else {
        // Not connected — wait 1.5 s before showing disconnected state.
        // If the socket reconnects within the grace window the timer is
        // cancelled above and the UI never flashes "Reconnecting".
        if (connGraceTimer.current !== null) return; // already waiting
        connGraceTimer.current = setTimeout(() => {
          connGraceTimer.current = null;
          setConnected(false);
        }, 1_500);
      }
    };
    session.snapshotListeners.add(onSnap);
    session.connectedListeners.add(onConn);
    // Sync immediately — state may have changed while the component was unmounted.
    setSnapshot(session.snapshot);
    setConnected(session.connected);
    return () => {
      session.snapshotListeners.delete(onSnap);
      session.connectedListeners.delete(onConn);
      if (connGraceTimer.current !== null) {
        clearTimeout(connGraceTimer.current);
        connGraceTimer.current = null;
      }
    };
  }, [session]);

  // Per-hook stall reporting.  Kept separate from the session singleton so
  // that `enableStallReport` can differ between hook instances (admin preview
  // uses false; viewer surfaces use true) sharing the same baseUrl.
  useEffect(() => {
    if (!session || !enableStallReport) return;
    let lastReportedId: string | null = null;
    const onSnap = (s: PlayerSnapshot) => {
      if (s.state !== "SKIP_PENDING") return;
      if (session.adapter === null) return; // only report when video elements are attached
      const itemId = s.lastServerSnapshot?.current?.id ?? null;
      if (!itemId || itemId === lastReportedId) return;
      lastReportedId = itemId;
      void fetch(`${baseUrl}/report-stall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId }),
        // 8-second timeout mirrors the transport's snapshot fetch timeout.
        // Without this the fetch can hang indefinitely, blocking the .catch()
        // that resets lastReportedId — preventing any retry on the next snapshot.
        signal: AbortSignal.timeout(8_000),
      }).catch(() => {
        // Best-effort — reset guard so the next snapshot cycle can retry.
        lastReportedId = null;
      });
    };
    session.snapshotListeners.add(onSnap);
    return () => {
      session.snapshotListeners.delete(onSnap);
    };
  }, [session, baseUrl, enableStallReport]);

  // SKIP_PENDING escape valve: if the machine stays in SKIP_PENDING for more
  // than 20 s (report-stall POST silently failed, or the server's skip
  // snapshot was lost in transit), force-reconnect the transport to fetch
  // a fresh snapshot.  This breaks the deadlock where the transport is
  // technically "connected" but delivering stale frames.
  useEffect(() => {
    if (!session || !enableStallReport) return;
    let escapeTimer: ReturnType<typeof setTimeout> | null = null;
    const onSnap = (s: PlayerSnapshot) => {
      if (s.state === "SKIP_PENDING") {
        if (escapeTimer === null) {
          escapeTimer = setTimeout(() => {
            escapeTimer = null;
            session.transport.forceReconnect();
          }, 20_000);
        }
      } else if (escapeTimer !== null) {
        clearTimeout(escapeTimer);
        escapeTimer = null;
      }
    };
    session.snapshotListeners.add(onSnap);
    return () => {
      session.snapshotListeners.delete(onSnap);
      if (escapeTimer !== null) {
        clearTimeout(escapeTimer);
        escapeTimer = null;
      }
    };
  }, [session, enableStallReport]);

  // Periodic position checkpoint — POST /checkpoint every 30 s while PLAYING.
  //
  // The server uses these reports to detect client–server drift (e.g. a player
  // that fell behind by >30 s) without requiring admin auth. The endpoint is
  // purely observational on the server side — it never mutates the orchestrator.
  // Enabling on viewer surfaces (enableStallReport=true); disabled on admin
  // preview panels (enableStallReport=false) to avoid polluting drift logs with
  // operator scrubbing activity.
  useEffect(() => {
    if (!session || !enableStallReport) return;
    const CHECKPOINT_INTERVAL_MS = 30_000;
    let checkpointTimer: ReturnType<typeof setInterval> | null = null;

    const startCheckpoint = () => {
      if (checkpointTimer !== null) return;
      checkpointTimer = setInterval(() => {
        const snap = session.snapshot;
        if (snap.state !== "PLAYING") return;
        const itemId = snap.lastServerSnapshot?.current?.id ?? null;
        if (!itemId || session.adapter === null) return;
        // Derive positionSecs from the active buffer's video element.
        const activeId = snap.activeBufferId;
        const activeBuf = activeId === "A" ? session.bufA : session.bufB;
        const positionSecs = activeBuf?.el.currentTime ?? null;
        if (positionSecs === null || !Number.isFinite(positionSecs)) return;
        void fetch(`${baseUrl}/checkpoint`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemId, positionSecs }),
          signal: AbortSignal.timeout(8_000),
        }).catch(() => { /* best-effort — non-fatal */ });
      }, CHECKPOINT_INTERVAL_MS);
    };

    const stopCheckpoint = () => {
      if (checkpointTimer !== null) {
        clearInterval(checkpointTimer);
        checkpointTimer = null;
      }
    };

    const onSnap = (s: PlayerSnapshot) => {
      if (s.state === "PLAYING") startCheckpoint();
      else stopCheckpoint();
    };

    session.snapshotListeners.add(onSnap);
    // Start immediately if already PLAYING when the effect mounts.
    if (session.snapshot.state === "PLAYING") startCheckpoint();

    return () => {
      session.snapshotListeners.delete(onSnap);
      stopCheckpoint();
    };
  }, [session, baseUrl, enableStallReport]);

  // Detach video elements on unmount.  Transport + machine stay alive so the
  // session remains synchronised with the server between navigations.
  useEffect(() => {
    if (!session) return;
    return () => {
      detachElements(session);
    };
  }, [session]);

  // Sleep-wake & network-online reconnect (web equivalent of mobile AppState).
  useEffect(() => {
    if (!session) return;
    const handleVisible = () => {
      if (document.visibilityState !== "visible") return;
      session.machine.send({ type: "online" });
      // Only force-reconnect if the socket is actually dead or absent.
      // Skipping this when healthy prevents the "Reconnecting" flash that
      // appeared on every tab-switch even when the WS was still alive.
      if (!session.transport.isHealthy()) {
        session.transport.forceReconnect();
      }
    };
    const handleOnline = () => {
      // Network just came back — always reconnect regardless of socket state
      // because the underlying TCP connection is certainly broken.
      session.transport.forceReconnect();
      session.machine.send({ type: "online" });
    };
    const handleOffline = () => {
      session.machine.send({ type: "offline" });
    };
    // Note: we intentionally do NOT listen to `window focus` here.
    // Both `visibilitychange` and `focus` fire on tab-switch, causing a
    // double forceReconnect that races itself. `visibilitychange` is the
    // correct event for detecting tab wake-ups on all modern browsers and
    // TV platforms (Tizen, WebOS). The health check above also ensures we
    // don't reconnect on every focus event when the socket is fine.
    document.addEventListener("visibilitychange", handleVisible);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      document.removeEventListener("visibilitychange", handleVisible);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [session]);

  // Attach video elements once both refs are available.
  const tryAttach = useCallback(() => {
    if (!session || !enabled) return;
    const a = elsRef.current.A;
    const b = elsRef.current.B;
    if (!a || !b) return;
    attachElements(session, a, b, optsRef.current.attachHls);
  }, [session, enabled]);

  // Stable ref callbacks — defined with useCallback so React sees the same
  // function identity across renders and does NOT null-then-reset the ref on
  // every parent re-render. Without this, every re-render of any ancestor
  // triggers React to call attach.A(null) then attach.A(el), which in turn
  // calls detachElements + attachElements on each re-render, causing a
  // brief HLS teardown / black-frame flash each time and producing spurious
  // "buffer-error" events in the FSM.
  const attachA = useCallback(
    (el: HTMLVideoElement | null) => {
      elsRef.current.A = el;
      if (el) tryAttach();
      else if (session) detachElements(session);
    },
    [session, tryAttach],
  );
  const attachB = useCallback(
    (el: HTMLVideoElement | null) => {
      elsRef.current.B = el;
      if (el) tryAttach();
      else if (session) detachElements(session);
    },
    [session, tryAttach],
  );

  return {
    snapshot,
    connected,
    attach: { A: attachA, B: attachB },
  };
}
