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
import type { PlayerSnapshot, V2Item, V2Override } from "./types.js";

export interface UseV2BroadcastOptions {
  baseUrl: string;
  attachHls?: (video: HTMLVideoElement, url: string) => () => void;
  /**
   * Optional external YouTube handler (e.g., an iframe overlay on TV/web).
   * When provided and the active item is a YouTube source, the adapter calls
   * this instead of loading the YouTube URL natively (which always fails).
   * The callback receives the <video> element (for positioning/sizing hints)
   * and the YouTube URL, and must return a cleanup function.
   * If omitted, YouTube sources are still handled safely (no native load
   * attempt, watchdog stalls are silently ignored in LIVE_OVERRIDE_ACTIVE).
   */
  attachYouTube?: (video: HTMLVideoElement, url: string) => () => void;
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
  /**
   * Immediately drops the current WS/SSE connection and reconnects with
   * jittered backoff reset. Use this to recover from FATAL state without
   * triggering a full page reload — the transport self-heals once the
   * server is reachable.
   */
  forceReconnect: () => void;
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
    if (!session.adapter) continue;
    // releaseAdapter pauses / unbinds all buffers via the adapter while
    // preserving any buffer whose <video> element is currently in a PiP
    // window — allowing the live stream to continue uninterrupted while
    // the UI navigates away from the player surface (e.g. back to Home).
    //
    // When the user plays a new VOD the caller (App.tsx play()) exits PiP
    // first via document.exitPictureInPicture() so releaseAdapter sees no
    // PiP element and performs the full unbind as before.
    releaseAdapter(session, /* preservePiP */ true);
  }
}

/** Sessions idle this long with zero subscribers are torn down. */
const SESSION_IDLE_EVICT_MS = 5 * 60 * 1000;
let janitorInterval: ReturnType<typeof setInterval> | null = null;

// ── PiP stream preservation ─────────────────────────────────────────────────
// When a video buffer is in a PiP window at detach time, we skip calling its
// HLS cleanup (which would immediately freeze the PiP stream) and instead
// store the cleanup reference here. cleanupPiPReservedStream() is called by
// the `leavepictureinpicture` handler in usePictureInPicture.ts (normal PiP
// close) and also by pauseAllBroadcastSessions() → releaseAdapter when the
// same session is detached without a PiP element (stale-reservation guard).
let _pipReservedEl: HTMLVideoElement | null = null;
let _pipReservedDetach: (() => void) | null = null;

/**
 * Destroy the HLS stream that was preserved for a PiP window.
 *
 * Call this when the PiP window closes (`leavepictureinpicture` event) so the
 * orphaned HLS instance is torn down promptly rather than downloading segments
 * until the tab is unloaded.
 *
 * Also called by `releaseAdapter()` when it detects the previously reserved
 * element is no longer `document.pictureInPictureElement` (stale reservation
 * guard — covers the edge case where PiP closed without our listener firing).
 */
export function cleanupPiPReservedStream(): void {
  const el     = _pipReservedEl;
  const detach = _pipReservedDetach;
  _pipReservedEl     = null;
  _pipReservedDetach = null;
  if (detach) { try { detach(); } catch { /* ignore */ } }
  if (el) {
    try { el.pause(); } catch { /* ignore */ }
    try { el.removeAttribute("src"); el.load(); } catch { /* ignore */ }
  }
}

/**
 * Shared helper — release a session's adapter buffers while optionally
 * preserving the PiP video element so its HLS stream continues in the OS
 * PiP window.
 *
 * preservePiP = true (default)
 *   The buffer whose <video> element is currently
 *   `document.pictureInPictureElement` is NOT unbound; instead its HLS detach
 *   function is saved to `_pipReservedDetach` for cleanup on PiP close.
 *   Used by detachElements() (Hero remount after PiP nav-back) and
 *   pauseAllBroadcastSessions() (back-button navigation while PiP active).
 *
 * When no buffer is in PiP the function behaves identically to the old
 * "unbind everything" path — no behaviour change for the common case.
 */
function releaseAdapter(session: BroadcastSession, preservePiP = true): void {
  const { adapter, bufA, bufB } = session;
  if (!adapter) return;

  // Stale-reservation guard: if a stream was previously preserved for PiP
  // but PiP is no longer active on that element, clean it up now.
  if (_pipReservedEl) {
    const currentPipEl =
      typeof document !== "undefined"
        ? (document.pictureInPictureElement as HTMLVideoElement | null)
        : null;
    if (_pipReservedEl !== currentPipEl) cleanupPiPReservedStream();
  }

  let pipBufferId: "A" | "B" | null = null;
  if (preservePiP && typeof document !== "undefined") {
    const pipEl = document.pictureInPictureElement as HTMLVideoElement | null;
    if (pipEl) {
      if      (bufA?.el === pipEl) pipBufferId = "A";
      else if (bufB?.el === pipEl) pipBufferId = "B";
    }
  }

  try {
    // destroy() removes all DOM event listeners (via AbortController) so stale
    // buffer-ready / buffer-error events cannot fire into the FSM after detach.
    adapter.destroy();

    if (pipBufferId === "A") {
      // Preserve buffer A: skip its unbind so HLS keeps streaming in PiP.
      // Save its detach fn so cleanupPiPReservedStream() can call it later.
      _pipReservedEl     = bufA!.el;
      _pipReservedDetach = bufA!.detach ?? null;
      bufA!.detach       = undefined; // prevent double-call if adapter is referenced again
      adapter.apply({ type: "unbind", bufferId: "B" });
    } else if (pipBufferId === "B") {
      _pipReservedEl     = bufB!.el;
      _pipReservedDetach = bufB!.detach ?? null;
      bufB!.detach       = undefined;
      adapter.apply({ type: "unbind", bufferId: "A" });
    } else {
      adapter.apply({ type: "unbind", bufferId: "A" });
      adapter.apply({ type: "unbind", bufferId: "B" });
    }
  } catch { /* ignore — element may already be detached */ }

  session.adapter = null;
  session.bufA    = null;
  session.bufB    = null;
}

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
          // destroy() clears internal timers (sourceExpiryTimer,
          // fatalRecoveryTimer) on the PlayerMachine before we drop all
          // references. Without this call those timers fire into dead
          // state and keep the Node/RN event loop alive unnecessarily.
          entry.session.machine.destroy();
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
  attachYouTube?: (video: HTMLVideoElement, url: string) => () => void,
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
    { send: (e) => machine.send(e), attachHls, attachYouTube },
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
  // Delegates to releaseAdapter (preservePiP = true) so that any buffer whose
  // <video> element is currently in the OS PiP window is NOT unbound — its HLS
  // stream continues running and the PiP window keeps showing live video while
  // the Hero surface remounts with fresh video elements.
  releaseAdapter(session, /* preservePiP */ true);
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
    // Mirror resolvePositionSecs() from machine.ts:
    //   • Only HLS supports wall-clock seeking. MP4/YouTube/DASH always play
    //     from position 0 — seeking a non-faststart MP4 requires costly moov-atom
    //     discovery that routinely exhausts the stall watchdog and triggers
    //     RECOVERING_PRIMARY on SPA remount.
    //   • For HLS, cap at (durationSecs − 10) to prevent seek-past-end on VOD
    //     HLS items with overestimated durationSecs. Without this cap, a video
    //     playing in its final 10 s would be seeked past its encoded end on the
    //     next SPA remount, immediately firing onended and creating the "single
    //     segment replay" loop that was fixed on mobile (HLS_END_GUARD_MS) but
    //     not in this web-side replay path.
    const sourceKind: string = "source" in activeItem
      ? (activeItem as V2Item).source.kind
      : (activeItem as V2Override).kind;
    let positionSecs = 0;
    if (sourceKind === "hls" && startsAtMs) {
      const elapsed = Math.max(0, (nowMs - startsAtMs) / 1000);
      const dur = "durationSecs" in activeItem
        ? (activeItem as V2Item).durationSecs
        : 0;
      positionSecs = dur > 0 ? Math.min(elapsed, Math.max(0, dur - 10)) : elapsed;
    }
    adapter({ type: "play", bufferId: activeId, positionSecs });
  }

  // Pre-seed the inactive buffer so the next transition has zero black frames.
  if (inactiveItem) {
    adapter({ type: "bind", bufferId: inactiveId, item: inactiveItem });
  }
}

// ── React hook ──────────────────────────────────────────────────────────────

export function useV2Broadcast(opts: UseV2BroadcastOptions): UseV2BroadcastResult {
  const { baseUrl, attachHls, attachYouTube, enabled = true, enableStallReport = true } = opts;

  // Keep latest option values in a ref so callbacks don't need to be
  // recreated when they change.
  const optsRef = useRef({ attachHls, attachYouTube, enableStallReport });
  optsRef.current = { attachHls, attachYouTube, enableStallReport };

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
  // than 8 s (report-stall POST silently failed, or the server's skip
  // snapshot was lost in transit), force-reconnect the transport to fetch
  // a fresh snapshot.  This breaks the deadlock where the transport is
  // technically "connected" but delivering stale frames.
  // Reduced from 20 s → 8 s: 20 s of dead air per stalled item is too long
  // for 24/7 broadcast — a stall is always recoverable within 2 tick cycles.
  useEffect(() => {
    if (!session || !enableStallReport) return;
    let escapeTimer: ReturnType<typeof setTimeout> | null = null;
    // Track current SKIP_PENDING item so the timer callback can re-report it.
    // The primary stall-reporter (above) guards against duplicate same-session
    // reports via lastReportedId; the escape valve re-reports unconditionally
    // so the server's per-item skip-count increments even when that guard
    // blocked an earlier attempt — eventually triggering auto-suspension.
    let pendingItemId: string | null = null;
    const onSnap = (s: PlayerSnapshot) => {
      if (s.state === "SKIP_PENDING") {
        pendingItemId = s.lastServerSnapshot?.current?.id ?? null;
        if (escapeTimer === null) {
          escapeTimer = setTimeout(() => {
            escapeTimer = null;
            if (pendingItemId) {
              void fetch(`${baseUrl}/report-stall`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ itemId: pendingItemId }),
                signal: AbortSignal.timeout(5_000),
              }).catch(() => {});
            }
            session.transport.forceReconnect();
          }, 8_000);
        }
      } else if (escapeTimer !== null) {
        clearTimeout(escapeTimer);
        escapeTimer = null;
        pendingItemId = null;
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
  }, [session, baseUrl, enableStallReport]);

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
    attachElements(session, a, b, optsRef.current.attachHls, optsRef.current.attachYouTube);
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

  // Stable forceReconnect — lets callers (e.g. TV FATAL overlay) trigger an
  // immediate transport reconnect without a full page reload. Uses the session
  // reference so the function identity is stable across re-renders.
  const forceReconnect = useCallback(() => {
    session?.transport.forceReconnect();
  }, [session]);

  return {
    snapshot,
    connected,
    attach: { A: attachA, B: attachB },
    forceReconnect,
  };
}
