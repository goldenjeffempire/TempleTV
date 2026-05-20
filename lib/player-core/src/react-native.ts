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

import { useEffect, useState, useSyncExternalStore } from "react";
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
}

/** Singleton sessions keyed by baseUrl. Never deleted — transport persists
 * across React navigations so remounts get instant-resume instead of BOOTSTRAP. */
const sessions = new Map<string, NativeSession>();

function getOrCreateSession(baseUrl: string): NativeSession {
  const existing = sessions.get(baseUrl);
  if (existing) return existing;

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
          // can evaluate the server's current state and clear the 30 s guard
          // as soon as the server advances on its own drift-poll tick.
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
    adapter,
    transport,
    snapshot: EMPTY_SNAPSHOT,
    connected: false,
    snapshotListeners: new Set(),
    connectedListeners: new Set(),
    machineUnsub,
  };

  sessions.set(baseUrl, session);
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
  useEffect(() => {
    if (!session) return;
    const onSnap = (s: PlayerSnapshot) => setSnapshot(s);
    const onConn = (c: boolean) => setConnected(c);
    session.snapshotListeners.add(onSnap);
    session.connectedListeners.add(onConn);
    // Sync immediately — state may have changed while the component was unmounted.
    setSnapshot(session.snapshot);
    setConnected(session.connected);
    return () => {
      session.snapshotListeners.delete(onSnap);
      session.connectedListeners.delete(onConn);
    };
  }, [session]);

  // Stall reporter: when the FSM reaches SKIP_PENDING (all local retries
  // exhausted), tell the server to mark the URL bad and advance the queue.
  // Mirrors the equivalent effect in react.ts. Without this mobile players
  // are permanently stuck in SKIP_PENDING on a broken source — no report
  // means the server never removes the item from rotation.
  useEffect(() => {
    if (!session) return;
    let lastReportedId: string | null = null;
    const onSnap = (s: PlayerSnapshot) => {
      if (s.state !== "SKIP_PENDING") return;
      const itemId = s.lastServerSnapshot?.current?.id ?? null;
      if (!itemId || itemId === lastReportedId) return;
      lastReportedId = itemId;
      void fetch(`${baseUrl}/report-stall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId }),
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
  }, [session, baseUrl]);

  // SKIP_PENDING escape valve: matches the web hook — force-reconnect after
  // 20 s if the machine stays stuck in SKIP_PENDING (report-stall POST
  // failed, or the server's skip snapshot was dropped mid-flight).
  useEffect(() => {
    if (!session) return;
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
  }, [session]);

  // Subscribe to mobile adapter store via useSyncExternalStore for
  // fine-grained buffer updates without triggering a full re-render.
  const buffers = useSyncExternalStore(
    (cb) => session?.adapter.subscribe(() => cb()) ?? (() => {}),
    () => session?.adapter.getStore() ?? EMPTY_STORE,
    () => EMPTY_STORE,
  );

  return {
    snapshot,
    connected,
    buffers,
    reportBufferEvent: (event) => session?.adapter.reportEvent(event),
    forceReconnect: () => session?.transport.forceReconnect(),
    notifyOnline: () => session?.machine.send({ type: "online" }),
  };
}
