/**
 * React Native bindings for player-core.
 *
 * Web's `useV2Broadcast` hook can't be reused because it directly attaches
 * HTML <video> elements via `createWebAdapter`. RN has no DOM, so we wire
 * the FSM to `createMobileAdapter` instead and surface a per-buffer store
 * that an Expo `<VideoView>` (or expo-av `<Video>`) can subscribe to.
 *
 * Transport: WS-first (works in RN). SSE fallback in transport.ts is
 * skipped — `EventSource` is undefined on RN — and the transport gracefully
 * stays on the WS path.
 *
 * Platform neutrality: this file deliberately does NOT import `react-native`
 * itself. RN-specific concerns (AppState change → forceReconnect, screen
 * keep-awake, audio mode) live in the consumer container component. The
 * hook exposes a `forceReconnect()` and `notifyOnline()` so the container
 * can drive them from `AppState.addEventListener('change', …)` without the
 * library taking a hard dep on react-native (keeps the workspace install
 * graph clean and avoids RN/web type collisions in tooling).
 *
 * Singleton session map:
 * Like the web hook, each `baseUrl` maps to a single long-lived session
 * (machine + adapter + transport). Navigating away from the player does NOT
 * stop the transport — the hook just removes its React listeners. This gives
 * "instant resume" (zero BOOTSTRAP latency) when the player screen remounts
 * after a navigation, matching the behaviour of the web hook.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { PlayerMachine } from "./machine.js";
import { V2Transport } from "./transport.js";
import { createMobileAdapter, type MobileAdapter, type MobileAdapterStore } from "./adapters/mobile.js";
import type { PlayerEvent, PlayerSnapshot } from "./types.js";

export interface UseV2BroadcastNativeOptions {
  baseUrl: string;
  enabled?: boolean;
}

export interface UseV2BroadcastNativeResult {
  snapshot: PlayerSnapshot;
  connected: boolean;
  buffers: MobileAdapterStore;
  /** Buffer components call these on real device events so the FSM stays honest. */
  reportBufferEvent: MobileAdapter["reportEvent"];
  /**
   * Force-drop the WS and reconnect immediately, resetting backoff.
   * Consumer should call this when RN AppState transitions to "active"
   * after a background sleep — the OS may have silently severed the
   * underlying socket without surfacing an `onclose` to JS.
   */
  forceReconnect: () => void;
  /** Tell the FSM the device is back online (e.g. AppState→active). */
  notifyOnline: () => void;
}

const EMPTY_STORE: MobileAdapterStore = {
  A: { item: null, playing: false, active: true, positionSecs: 0, muted: false, bindRevision: 0 },
  B: { item: null, playing: false, active: false, positionSecs: 0, muted: true, bindRevision: 0 },
  revision: 0,
};

const EMPTY_SNAPSHOT: PlayerSnapshot = {
  state: "BOOTSTRAP",
  activeBufferId: "A",
  bufferA: null,
  bufferB: null,
  lastServerSnapshot: null,
  lastSequence: 0,
};

// ── Singleton session ────────────────────────────────────────────────────────

interface NativeSession {
  machine: PlayerMachine;
  adapter: MobileAdapter;
  transport: V2Transport;
  snapshot: PlayerSnapshot;
  connected: boolean;
  /** React state-setter listeners for snapshot updates. */
  snapshotListeners: Set<(s: PlayerSnapshot) => void>;
  /** React state-setter listeners for connection changes. */
  connectedListeners: Set<(c: boolean) => void>;
  /** Cleanup returned by machine.subscribe(). */
  machineUnsub: () => void;
  /**
   * Count of active useV2BroadcastNative hook instances subscribed to this
   * session. The janitor uses this — NOT snapshotListeners.size — to decide
   * whether a session is idle and eligible for eviction.
   *
   * Why needed: getOrCreateSession() registers two permanent session-level
   * listeners (stallListener, escapeValveListener) in snapshotListeners so
   * they fire exactly once per SKIP_PENDING event regardless of how many
   * hook instances are active. These permanent listeners keep
   * snapshotListeners.size ≥ 2 at all times, which would prevent the janitor
   * from ever detecting an idle session if it checked size > 0. hookCount
   * tracks only hook-registered listeners so the janitor can evict sessions
   * whose React consumers have all unmounted.
   */
  hookCount: number;
  /**
   * Debounce timer for forceReconnect calls.
   *
   * Multiple V2PlayerContainer instances (e.g. a muted Hero on the home tab
   * and the full Player screen) share the same singleton session. Both mount
   * an AppState listener that calls forceReconnect() on foreground — both
   * fire in the same JS tick. Without debouncing, the second call clears the
   * reconnect timer the first call just scheduled and emits onConnectionChange
   * a second time, causing a spurious connected=false React state update.
   *
   * A 50 ms debounce window collapses all same-tick calls into one actual
   * transport.forceReconnect() invocation while remaining fast enough that
   * the reconnect feels instantaneous to the user.
   */
  forceReconnectDebounce: ReturnType<typeof setTimeout> | null;
}

/** Singleton sessions keyed by baseUrl. Transport persists across React
 * navigations so remounts get instant-resume instead of BOOTSTRAP. A
 * background janitor (see startJanitor) evicts sessions that have had zero
 * subscribers for SESSION_IDLE_EVICT_MS so backgrounded apps don't keep a
 * dead WebSocket and FSM in memory forever. */
const sessions = new Map<string, { session: NativeSession; lastIdleAtMs: number | null }>();

const SESSION_IDLE_EVICT_MS = 5 * 60 * 1000;
let janitorInterval: ReturnType<typeof setInterval> | null = null;

function startJanitor(): void {
  if (janitorInterval !== null) return;
  if (typeof setInterval === "undefined") return;
  janitorInterval = setInterval(() => {
    const now = Date.now();
    for (const [baseUrl, entry] of sessions) {
      // Use hookCount — not snapshotListeners.size — to detect idle sessions.
      // snapshotListeners always contains the two permanent session-level
      // listeners (stallListener, escapeValveListener) added at session creation,
      // so its size is always ≥ 2 and the janitor would never evict.
      const hasListeners = entry.session.hookCount > 0;
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
          // references. Without this call those timers fire into dead state
          // and keep the RN event loop alive unnecessarily — same issue as
          // the web hook janitor that already calls machine.destroy().
          entry.session.machine.destroy();
          entry.session.machineUnsub();
          entry.session.transport.stop?.();
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
  (janitorInterval as unknown as { unref?: () => void }).unref?.();
}

function getOrCreateSession(baseUrl: string): NativeSession {
  const existing = sessions.get(baseUrl);
  if (existing) {
    existing.lastIdleAtMs = null;
    return existing.session;
  }

  // Forward-declare so the machine's IntentHandler closure can reference it.
  let session!: NativeSession;

  const machine = new PlayerMachine((intent) => session.adapter.apply(intent));
  const adapter = createMobileAdapter((event: PlayerEvent) => machine.send(event));

  const transport = new V2Transport({
    baseUrl,
    onPlayerEvent: (e: PlayerEvent) => machine.send(e),
    onConnectionChange: (c: boolean) => {
      session.connected = c;
      for (const l of session.connectedListeners) l(c);
    },
    // Keep machine clock in sync with server time so resolvePositionSecs()
    // uses server-calibrated wall-clock instead of the device's local clock.
    // This is the primary driver of admin↔mobile broadcast position sync.
    onClockCalibration: (offsetMs: number) => machine.setClockOffsetMs(offsetMs),
  });

  // Wire machine → transport: when the active buffer ends with no preloaded
  // inactive item the machine calls this to request a fresh snapshot
  // immediately, cutting the SYNCING window from ≤8 s (keep-alive) to <1 s.
  machine.setNeedSnapshotCallback(() => transport.requestSnapshot());

  // Wire machine → server: when a video ends naturally before its scheduled
  // durationSecs slot expires, notify the server so it advances its cycle
  // anchor immediately.  Without this, every connected player gets pulled
  // back onto the just-finished item by the next server snapshot.
  machine.setNaturalEndCallback((itemId: string) => {
    // Retry with backoff — the server MUST receive this signal or it keeps
    // presenting the ended item as `current`, causing every client's 30 s
    // post-natural-end guard to block the next item for up to half a minute.
    // The endpoint is item-level idempotent, so repeated POSTs are safe.
    //
    // Guard: check transport.isStopped before each retry and before calling
    // requestSnapshot() (parity with react.ts).  Without this, sessions
    // evicted by the janitor (machine.destroy() + transport.stop()) keep
    // firing POST /natural-end and requestSnapshot() indefinitely — one stale
    // setTimeout chain per natural video end that happened while the session
    // was still alive — draining battery and generating server noise on mobile.
    const naturalEndRetryDelays = [2_000, 4_000, 8_000];
    const doPost = (attempt: number): void => {
      if (transport.isStopped) return;
      void fetch(`${baseUrl}/natural-end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId }),
        signal: AbortSignal.timeout(8_000),
      }).catch(() => {
        if (transport.isStopped) return;
        if (attempt < naturalEndRetryDelays.length) {
          setTimeout(() => doPost(attempt + 1), naturalEndRetryDelays[attempt]);
        } else {
          // All retries exhausted — fetch a fresh snapshot so the machine
          // can evaluate the server's current state and clear the 30 s guard
          // as soon as the server advances on its own drift-poll tick.
          // Guard: mirrors the pre-POST isStopped check — prevents zombie
          // requestSnapshot() calls on evicted RN sessions (battery drain +
          // server noise from repeated POST /natural-end on mobile).
          if (!transport.isStopped) transport.requestSnapshot();
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
    adapter,
    transport,
    snapshot: EMPTY_SNAPSHOT,
    connected: false,
    snapshotListeners: new Set(),
    connectedListeners: new Set(),
    machineUnsub,
    hookCount: 0,
    forceReconnectDebounce: null,
  };

  // ── Session-level stall reporter (one per session, not per hook call) ────
  //
  // When the FSM reaches SKIP_PENDING (all local retries exhausted), POST to
  // the server so it marks the URL bad and advances the queue. This must run
  // EXACTLY ONCE per session, not once per useV2BroadcastNative call.
  //
  // Why session-level: useV2BroadcastNative is called by multiple consumers
  // simultaneously — HeroSection in index.tsx (to read snapshot state) AND
  // V2PlayerContainer (to drive the A/B buffers), and potentially a second
  // V2PlayerContainer for the Player screen when both are mounted. Each hook
  // call adds its own snapshotListeners entry. If this effect lived in the
  // hook body it would fire N × POST requests for the same itemId on every
  // SKIP_PENDING transition, where N = number of active consumers. Moving it
  // here to session creation ensures exactly one POST per stalled item, which
  // keeps the server's rate limiter healthy on weak-signal devices where
  // SKIP_PENDING cycles can occur frequently.
  let stallLastReportedId: string | null = null;
  const stallListener = (s: PlayerSnapshot) => {
    if (s.state !== "SKIP_PENDING") return;
    const itemId = s.lastServerSnapshot?.current?.id ?? null;
    if (!itemId || itemId === stallLastReportedId) return;
    stallLastReportedId = itemId;
    void fetch(`${baseUrl}/report-stall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId }),
      signal: AbortSignal.timeout(8_000),
    }).catch(() => {
      // Best-effort — reset guard so the next snapshot cycle can retry.
      stallLastReportedId = null;
    });
  };

  // ── Session-level SKIP_PENDING escape valve (one per session) ─────────────
  //
  // Force-reconnect after 8 s if the machine stays stuck in SKIP_PENDING
  // (report-stall POST failed or the server's skip snapshot was dropped mid-
  // flight). Must run exactly once per session for the same reason as the
  // stall reporter above — multiple hook callers must not arm duplicate timers
  // that all fire transport.forceReconnect() at the same moment. The debounce
  // on forceReconnect() would collapse them into one call, but the duplicate
  // timer overhead and log noise are unnecessary.
  let escapeValveTimer: ReturnType<typeof setTimeout> | null = null;
  const escapeValveListener = (s: PlayerSnapshot) => {
    if (s.state === "SKIP_PENDING") {
      if (escapeValveTimer === null) {
        escapeValveTimer = setTimeout(() => {
          escapeValveTimer = null;
          // transport.stopped guard is inside forceReconnect() — safe to call
          // even if the session is being evicted by the janitor.
          transport.forceReconnect();
        }, 8_000);
      }
    } else if (escapeValveTimer !== null) {
      clearTimeout(escapeValveTimer);
      escapeValveTimer = null;
    }
  };

  sessions.set(baseUrl, { session, lastIdleAtMs: null });
  // Register session-level listeners AFTER the session Map entry exists so
  // a synchronous machine snapshot (theoretically possible) finds the entry.
  session.snapshotListeners.add(stallListener);
  session.snapshotListeners.add(escapeValveListener);
  startJanitor();
  return session;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useV2BroadcastNative(opts: UseV2BroadcastNativeOptions): UseV2BroadcastNativeResult {
  const { baseUrl, enabled = true } = opts;

  // Get (or lazily create) the singleton session for this baseUrl.
  const session = enabled ? getOrCreateSession(baseUrl) : null;

  const [snapshot, setSnapshot] = useState<PlayerSnapshot>(
    () => session?.snapshot ?? EMPTY_SNAPSHOT,
  );
  const [connected, setConnected] = useState<boolean>(session?.connected ?? false);

  // Subscribe to live session state changes.
  // Cleanup only removes the listeners — transport & machine stay running.
  // NOTE: The stall reporter and SKIP_PENDING escape valve are wired at the
  // session level (inside getOrCreateSession) rather than here. This ensures
  // they fire exactly once per session regardless of how many components call
  // useV2BroadcastNative for the same baseUrl simultaneously (HeroSection +
  // V2PlayerContainer(Hero) + V2PlayerContainer(Player) = 3 callers in a
  // typical live-viewing session).
  useEffect(() => {
    if (!session) return;
    // Track active hook instances so the janitor can detect when no React
    // consumers remain (hookCount === 0) and evict the idle session.
    // snapshotListeners.size cannot be used for this because it always
    // includes the permanent session-level stallListener + escapeValveListener.
    session.hookCount++;
    const onSnap = (s: PlayerSnapshot) => setSnapshot(s);
    const onConn = (c: boolean) => setConnected(c);
    session.snapshotListeners.add(onSnap);
    session.connectedListeners.add(onConn);
    // Sync immediately — state may have changed while the component was unmounted.
    setSnapshot(session.snapshot);
    setConnected(session.connected);
    return () => {
      session.hookCount--;
      session.snapshotListeners.delete(onSnap);
      session.connectedListeners.delete(onConn);
    };
  }, [session]);

  // ── Stable useSyncExternalStore callbacks ──────────────────────────────────
  // Both lambdas must be stable references across renders.
  // useSyncExternalStore re-subscribes whenever the subscribe function changes
  // identity, which would remove and re-add the adapter listener on every
  // render — causing a spurious notification burst that triggers downstream
  // BroadcastBuffer effects. Wrapping with useCallback([session]) pins them
  // to the lifetime of the singleton session (stable across navigations).
  const storeSubscribe = useCallback(
    (cb: () => void) => session?.adapter.subscribe(() => cb()) ?? (() => {}),
    [session],
  );
  const storeGetSnapshot = useCallback(
    () => session?.adapter.getStore() ?? EMPTY_STORE,
    [session],
  );

  const buffers = useSyncExternalStore(storeSubscribe, storeGetSnapshot, () => EMPTY_STORE);

  // ── Stable callback references ──────────────────────────────────────────────
  // All three must be stable across renders so that:
  //
  //  • reportBufferEvent → BroadcastBuffer wraps it in useCallback([reportBufferEvent])
  //    to produce `emit`. A new reportBufferEvent reference each render causes a
  //    new `emit`, which re-triggers the play-effect and fires a spurious
  //    playFromPositionAsync() on MP4/non-HLS buffers even when nothing in the
  //    broadcast changed. The web hook (react.ts) documents the exact same hazard
  //    for its ref-callbacks ("prevents spurious HLS teardown/black-frame flash").
  //
  //  • forceReconnect / notifyOnline → listed in V2PlayerContainer's AppState
  //    useEffect dep-array. New references each render cause the effect to teardown
  //    and re-register the AppState listener on every snapshot update, creating
  //    churn and a brief window where app-foregrounding is not handled.
  const reportBufferEvent = useCallback(
    (...args: Parameters<MobileAdapter["reportEvent"]>) =>
      session?.adapter.reportEvent(...args),
    [session],
  );

  /**
   * Debounced forceReconnect: collapses multiple calls within 50 ms into
   * one transport.forceReconnect() invocation. This prevents the spurious
   * double-disconnect that occurs when both a muted Hero V2PlayerContainer
   * (home tab, cached by Expo Router) and the active Player V2PlayerContainer
   * each fire their AppState "active" handler in the same JS tick on
   * app foreground.
   */
  const forceReconnect = useCallback(() => {
    if (!session) return;
    if (session.forceReconnectDebounce !== null) {
      clearTimeout(session.forceReconnectDebounce);
    }
    session.forceReconnectDebounce = setTimeout(() => {
      session.forceReconnectDebounce = null;
      session.transport.forceReconnect();
    }, 50);
  }, [session]);

  const notifyOnline = useCallback(
    () => session?.machine.send({ type: "online" }),
    [session],
  );

  return {
    snapshot,
    connected,
    buffers,
    reportBufferEvent,
    forceReconnect,
    notifyOnline,
  };
}
