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
  /**
   * Optional factory that returns the current auth token (or null/undefined
   * when unauthenticated). When provided, POST /report-stall and /natural-end
   * requests include an `Authorization: Bearer` header so the server can
   * attribute telemetry signals to authenticated sessions.
   *
   * On anonymous surfaces omit or return null — the server accepts both.
   */
  getAuthToken?: () => string | null | undefined;
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
  /**
   * User-initiated "Tap to reconnect" handler.
   *
   * Resets the FSM's retry budget and issues a fresh `bind` + `play` for
   * the current broadcast item, then transitions to PREPARING_ACTIVE.
   * Also reconnects the WS transport (debounced) so the machine receives
   * an up-to-date server snapshot immediately after rebinding.
   *
   * Unlike `forceReconnect()` (WS-only), this actually reloads the video
   * buffer — fixing the stuck RECOVERING_PRIMARY state where pressing
   * "Tap to reconnect" previously had no visible effect on the player.
   */
  forceRebind: () => void;
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
  fatalAttemptCount: 0,
  fatalEnteredAtMs: null,
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
   * Clears any session-level timers (escapeValveTimer) that live in the
   * getOrCreateSession closure and are NOT reachable by machine.destroy()
   * or transport.stop(). Called by the janitor on eviction to prevent
   * ghost timeouts from keeping the RN event loop alive after teardown.
   */
  cleanup: () => void;
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
  /**
   * Mutable ref for the optional auth token getter. Wired by the hook from
   * UseV2BroadcastNativeOptions.getAuthToken so natural-end and report-stall
   * callbacks always use the freshest token without re-creating closures.
   */
  _authGetterRef: { current: (() => string | null | undefined) | undefined };
}

/** Singleton sessions keyed by baseUrl. Transport persists across React
 * navigations so remounts get instant-resume instead of BOOTSTRAP. A
 * background janitor (see startJanitor) evicts sessions that have had zero
 * subscribers for SESSION_IDLE_EVICT_MS so backgrounded apps don't keep a
 * dead WebSocket and FSM in memory forever. */
const sessions = new Map<string, { session: NativeSession; lastIdleAtMs: number | null; lastUsedAt: number }>();

const SESSION_IDLE_EVICT_MS = 5 * 60 * 1000;
/**
 * Hard maximum age (ms) for any session entry in the singleton map — 24 hours.
 * Belt-and-suspenders beyond the 5-min idle eviction: sessions on always-on
 * devices that somehow kept hookCount > 0 (e.g. due to a navigation bug that
 * never calls the hook cleanup) are force-evicted after 24 hours to prevent
 * unbounded Map growth and memory leaks on kiosk-style deployments.
 */
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/** setInterval handle for the janitor sweep. Null when no sessions exist. */
let janitorInterval: ReturnType<typeof setInterval> | null = null;

// ── Lightweight Sentry breadcrumb helper ────────────────────────────────────
// Uses a lazy require so the player-core vendor library does not take a hard
// compile-time dependency on @sentry/react-native. Falls back silently when
// Sentry is unavailable (web builds, unit tests, TV surface).
function _breadcrumb(
  category: string,
  message: string,
  level: "info" | "warning" | "error" = "info",
  data?: Record<string, unknown>,
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
    // require is available via Metro's CommonJS shim; the lib tsconfig does not
    // include @types/node but TypeScript no longer flags it as an error in RN
    // 0.81+ — the @ts-expect-error directive was intentionally removed.
    const S = (require as (id: string) => unknown)("@sentry/react-native") as {
      addBreadcrumb: (b: { category: string; message: string; level: string; data?: Record<string, unknown> }) => void;
    };
    S.addBreadcrumb({ category, message, level, data });
  } catch {
    // Sentry not available
  }
}

function evictSession(baseUrl: string, entry: { session: NativeSession; lastIdleAtMs: number | null; lastUsedAt: number }): void {
  try {
    entry.session.cleanup();
    entry.session.machine.destroy();
    entry.session.machineUnsub();
    entry.session.transport.stop?.();
  } catch {
    /* best-effort */
  }
  sessions.delete(baseUrl);
}

function runJanitor(): void {
  const now = Date.now();
  for (const [baseUrl, entry] of sessions) {
    // Use hookCount — not snapshotListeners.size — to detect idle sessions.
    // snapshotListeners always contains the two permanent session-level
    // listeners (stallListener, escapeValveListener) added at session creation,
    // so its size is always ≥ 2 and the janitor would never evict.
    const hasListeners = entry.session.hookCount > 0;

    // ── Hard max-age sweep (24 h) ─────────────────────────────────────────
    // Evict sessions older than SESSION_MAX_AGE_MS regardless of hookCount.
    // This is a safety net for always-on / kiosk devices where a navigation
    // bug might keep hookCount > 0 indefinitely without anyone watching.
    // On real broadcast surfaces the user will briefly see a BOOTSTRAP flash
    // (< 1 s) before the fresh session reconnects — acceptable vs a memory
    // leak that accumulates for days.
    if (now - entry.lastUsedAt > SESSION_MAX_AGE_MS) {
      evictSession(baseUrl, entry);
      continue;
    }

    if (hasListeners) {
      entry.lastIdleAtMs = null;
      continue;
    }
    if (entry.lastIdleAtMs === null) {
      entry.lastIdleAtMs = now;
      continue;
    }

    // ── Idle eviction (5 min) ─────────────────────────────────────────────
    if (now - entry.lastIdleAtMs >= SESSION_IDLE_EVICT_MS) {
      evictSession(baseUrl, entry);
    }
  }
  // Stop the interval when no sessions remain.
  if (sessions.size === 0 && janitorInterval !== null) {
    clearInterval(janitorInterval);
    janitorInterval = null;
  }
}

function startJanitor(): void {
  if (janitorInterval !== null) return;
  if (typeof setInterval === "undefined") return;
  janitorInterval = setInterval(runJanitor, 60_000);
}

function getOrCreateSession(baseUrl: string): NativeSession {
  // Normalize: strip trailing slashes so that `http://api/broadcast-v2` and
  // `http://api/broadcast-v2/` (a common React-side variation) always resolve
  // to the same session entry. Without this, each distinct trailing-slash
  // variant creates a separate machine + WebSocket + FSM instance, causing
  // duplicate live connections, split broadcast state, and battery drain.
  const key = baseUrl.replace(/\/+$/, "");
  const existing = sessions.get(key);
  if (existing) {
    existing.lastIdleAtMs = null;
    existing.lastUsedAt = Date.now();
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
    // Forward the session-level auth getter so the transport's drift reporter
    // (POST /report-position) includes an Authorization header for authenticated
    // sessions. Uses the mutable ref so token rotations are always reflected
    // without recreating the transport or its callbacks.
    getAuthToken: () => authGetterRef.current?.(),
  });

  // Wire machine → transport: when the active buffer ends with no preloaded
  // inactive item the machine calls this to request a fresh snapshot
  // immediately, cutting the SYNCING window from ≤8 s (keep-alive) to <1 s.
  machine.setNeedSnapshotCallback(() => transport.requestSnapshot());

  // Wire machine → server: when a video ends naturally before its scheduled
  // durationSecs slot expires, notify the server so it advances its cycle
  // anchor immediately.  Without this, every connected player gets pulled
  // back onto the just-finished item by the next server snapshot.
  // Mutable ref so the hook can wire the current auth token factory without
  // re-creating these callbacks (mirrors the web react.ts pattern).
  const authGetterRef: { current: (() => string | null | undefined) | undefined } = { current: undefined };

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
      const _nt = authGetterRef.current?.();
      const _nh: Record<string, string> = { "Content-Type": "application/json" };
      if (_nt) _nh["Authorization"] = `Bearer ${_nt}`;
      void fetch(`${baseUrl}/natural-end`, {
        method: "POST",
        headers: _nh,
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

  // Track the previous FSM state for Sentry breadcrumb transitions.
  let _prevState = "BOOTSTRAP";
  const machineUnsub = machine.subscribe((snap) => {
    // Emit a Sentry breadcrumb on every FSM state transition so crash reports
    // include the full playback history without needing custom event logging.
    // Cap breadcrumb volume: only emit when the state actually changes.
    if (snap.state !== _prevState) {
      _breadcrumb(
        "player.fsm",
        `${_prevState} → ${snap.state}`,
        snap.state === "FATAL" ? "error" : snap.state === "SKIP_PENDING" ? "warning" : "info",
        {
          itemId: snap.lastServerSnapshot?.current?.id ?? null,
          lastSequence: snap.lastSequence,
          fatalAttempts: snap.fatalAttemptCount,
        },
      );
      _prevState = snap.state;
    }
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
    _authGetterRef: authGetterRef,
    // Placeholder — overwritten below once the escapeValveTimer closure is set up.
    cleanup: () => {},
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
    _breadcrumb(
      "player.stall",
      `SKIP_PENDING reported for item ${itemId}`,
      "warning",
      { itemId, baseUrl },
    );
    // Jitter: spread POST /report-stall calls 0–5 s across the client fleet
    // so a mass-CDN-failure event that stalls thousands of devices simultaneously
    // doesn't produce a thundering herd that exhausts the server rate-limiter.
    void new Promise<void>((resolve) => setTimeout(resolve, Math.random() * 5_000)).then(() => {
      const _rst = authGetterRef.current?.();
      const _rsh: Record<string, string> = { "Content-Type": "application/json" };
      if (_rst) _rsh["Authorization"] = `Bearer ${_rst}`;
      return fetch(`${baseUrl}/report-stall`, {
        method: "POST",
        headers: _rsh,
        body: JSON.stringify({ itemId }),
        signal: AbortSignal.timeout(8_000),
      }).catch(() => {
        // Best-effort — reset guard after a short cooldown so the next
        // SKIP_PENDING cycle can retry.  Resetting immediately on every
        // failure (the previous behaviour) broke the "exactly once per item"
        // guarantee: on poor-signal devices where rapid SKIP_PENDING cycles
        // occur, each snapshot within the stall burst re-entered the guard
        // and fired another POST, producing a thundering herd that exhausted
        // the server's rate limiter and drained the device battery.
        // The 5 s cooldown means at most one retry per 5 s per stalled item —
        // enough for one more POST if the first truly failed, without flooding.
        setTimeout(() => { stallLastReportedId = null; }, 5_000);
      });
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

  // Expose a cleanup function so the janitor can clear session-level timers
  // that live in this closure and are NOT reachable via machine.destroy() or
  // transport.stop().  Without this, evicting a session leaves escapeValveTimer
  // alive for up to 8 s, keeping the RN event loop busy and calling
  // transport.forceReconnect() on a dead transport after eviction.
  session.cleanup = () => {
    if (escapeValveTimer !== null) {
      clearTimeout(escapeValveTimer);
      escapeValveTimer = null;
    }
    // stallLastReportedId and stallListener hold only primitive/function refs —
    // they are garbage-collected with the closure. No explicit clear needed.
  };

  sessions.set(key, { session, lastIdleAtMs: null, lastUsedAt: Date.now() });
  // Register session-level listeners AFTER the session Map entry exists so
  // a synchronous machine snapshot (theoretically possible) finds the entry.
  session.snapshotListeners.add(stallListener);
  session.snapshotListeners.add(escapeValveListener);
  startJanitor();
  return session;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useV2BroadcastNative(opts: UseV2BroadcastNativeOptions): UseV2BroadcastNativeResult {
  const { baseUrl, enabled = true, getAuthToken } = opts;

  // Get (or lazily create) the singleton session for this baseUrl.
  const session = enabled ? getOrCreateSession(baseUrl) : null;

  const [snapshot, setSnapshot] = useState<PlayerSnapshot>(
    () => session?.snapshot ?? EMPTY_SNAPSHOT,
  );
  const [connected, setConnected] = useState<boolean>(session?.connected ?? false);

  // Keep the session-level auth getter ref current with the hook option.
  useEffect(() => {
    if (!session) return;
    session._authGetterRef.current = getAuthToken;
  }, [session, getAuthToken]);

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

  /**
   * Debounced forceRebind: calls machine.requestManualRebind() to issue a
   * fresh bind + PREPARING_ACTIVE cycle, then reconnects the WS transport
   * so the machine immediately receives an up-to-date server snapshot.
   *
   * The 50 ms debounce collapses simultaneous calls from multiple mounted
   * V2PlayerContainer instances (Hero + Player screen) into a single
   * machine.requestManualRebind() invocation — same pattern as forceReconnect.
   */
  const forceRebind = useCallback(() => {
    if (!session) return;
    // Machine rebind — resets retry budget and issues a fresh bind/play intent.
    session.machine.requestManualRebind();
    // Transport reconnect — debounced so multiple simultaneous callers
    // (Hero + Player) collapse into one actual socket cycle.
    if (session.forceReconnectDebounce !== null) {
      clearTimeout(session.forceReconnectDebounce);
    }
    session.forceReconnectDebounce = setTimeout(() => {
      session.forceReconnectDebounce = null;
      session.transport.forceReconnect();
    }, 50);
  }, [session]);

  return {
    snapshot,
    connected,
    buffers,
    reportBufferEvent,
    forceReconnect,
    forceRebind,
    notifyOnline,
  };
}
