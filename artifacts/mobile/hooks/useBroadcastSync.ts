/**
 * useBroadcastSync — Mobile adapter for the new BroadcastEngine.
 *
 * Rebuilt from scratch. Derives connection URLs from EXPO_PUBLIC_API_URL /
 * EXPO_PUBLIC_DOMAIN (via getApiBase()), applies absolute-URL normalisation
 * to relative /api/… paths returned by the server, and delegates the full
 * connection lifecycle to the shared BroadcastEngine via useBroadcastSync.
 *
 * New in this rebuild:
 *  • liveStatusUrl: wired to /api/youtube/live/status so the engine's
 *    LiveStreamController polls independently every 45 s (cold-start coverage
 *    before the WS handshake completes).
 *  • OMEGA signal handling: EMERGENCY_BROADCAST, FAILOVER_ACTIVATED, etc.
 *    all processed by the engine's StateSyncService (previously SSE-only).
 *  • Triple-buffer slot hint (nextNextItem) for pre-warming the 3rd slot.
 *  • SSE sidecar silently skipped on native (EventSource unavailable) —
 *    the WS engine alone handles broadcast sync for Expo Go / device builds.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { useBroadcastSync as useBroadcastSyncCore } from "@workspace/broadcast-sync";
import type { BroadcastSyncState } from "@workspace/broadcast-types";
import { getApiBase } from "@/lib/apiBase";

function apiBaseToWsUrl(base: string): string {
  if (!base) return "";
  return base
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://")
    .replace(/\/?$/, "") + "/api/playback/ws";
}

function makeNormalizeUrl(base: string): (url: string) => string {
  return (url: string) => {
    if (!url || !base) return url;
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    return `${base.replace(/\/$/, "")}${url.startsWith("/") ? url : `/${url}`}`;
  };
}

/**
 * Connect to the playback WebSocket and return continuously-updated
 * BroadcastSyncState. Drop-in replacement for the legacy SSE+polling
 * pattern used by radio.tsx and index.tsx.
 *
 * URLs are stable (EXPO_PUBLIC_* env vars baked at build time) so the
 * useMemo dependencies never trigger a reconnect mid-session.
 *
 * iOS WS zombie recovery: AppState listener increments `reconnectKey`
 * after the app has been backgrounded for >10 s. Appending the key as a
 * query param changes the WS URL, causing the engine to tear down the
 * half-open socket and open a fresh connection. The 10 s threshold is
 * conservative — it avoids spurious reconnects for brief interruptions
 * (Notification Centre, Control Centre) while still catching the common
 * case where iOS suspends the network stack during background.
 */
export function useBroadcastSync(): BroadcastSyncState {
  const apiBase = getApiBase();

  const [reconnectKey, setReconnectKey] = useState(0);
  const backgroundAtRef = useRef<number>(0);
  // Tracks when the last WS/SSE frame arrived. Updated from actual sync-state
  // changes (any data push from the engine proves the socket is alive) and also
  // reset on foreground return. Used by the heartbeat-absence watchdog below.
  //
  // IMPORTANT: this ref is updated directly during render (not in an effect)
  // because we compare the new syncState.serverTimeMs against the previous
  // value stored in syncTimestampRef. Updating a ref in render is safe and
  // idiomatic — it's synchronous, does not trigger re-renders, and gives the
  // watchdog interval an up-to-date timestamp without an extra render cycle.
  const lastHeartbeatMsRef = useRef<number>(Date.now());
  // Tracks the last serverTimeMs we saw, so we can detect changes.
  const syncTimestampRef = useRef<number>(0);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background" || next === "inactive") {
        backgroundAtRef.current = Date.now();
      } else if (next === "active") {
        if (Date.now() - backgroundAtRef.current > 10_000) {
          setReconnectKey((k) => k + 1);
        }
        // Reset heartbeat timer on foreground so the watchdog doesn't
        // immediately fire due to the gap that accumulated during background.
        lastHeartbeatMsRef.current = Date.now();
      }
    });
    return () => sub.remove();
  }, []);

  // iOS heartbeat-absence watchdog — catches half-open WS zombies on iOS
  // that drop connectivity without firing an AppState change (e.g. the
  // device is not truly backgrounded but the cellular radio silently dropped
  // the TCP connection — common on iOS 16+ with aggressive connection pruning).
  //
  // Timeout raised to 90 s (was 30 s): lastHeartbeatMsRef is now updated from
  // real sync-state changes, so the watchdog only fires when genuinely no frame
  // has arrived for 90 s — ruling out the previous false-positive reconnects on
  // healthy connections where the ref was never updated from actual WS frames.
  useEffect(() => {
    // Timeout threshold: 90 s of silence = zombie connection.
    const HEARTBEAT_TIMEOUT_MS = 90_000;
    // Poll interval is intentionally shorter (30 s) so detection latency is
    // 90–120 s rather than 90–180 s.  Without this the interval could align
    // so the connection dies 1 ms after a check and goes undetected for
    // a full extra 90 s cycle (worst-case 3× the threshold).
    const POLL_INTERVAL_MS = 30_000;
    const timer = setInterval(() => {
      if (Date.now() - lastHeartbeatMsRef.current > HEARTBEAT_TIMEOUT_MS) {
        lastHeartbeatMsRef.current = Date.now(); // reset before reconnect
        setReconnectKey((k) => k + 1);
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const wsUrl        = useMemo(
    () => apiBase ? `${apiBaseToWsUrl(apiBase)}${reconnectKey > 0 ? `?rk=${reconnectKey}` : ""}` : "",
    [apiBase, reconnectKey],
  );
  const stateUrl     = useMemo(() => apiBase ? `${apiBase}/api/playback/state`          : "", [apiBase]);
  const liveStatusUrl = useMemo(() => apiBase ? `${apiBase}/api/youtube/live/status`    : "", [apiBase]);
  const sseUrl       = useMemo(() => apiBase ? `${apiBase}/api/broadcast/events?platform=mobile` : "", [apiBase]);
  const normalizeUrl = useMemo(() => makeNormalizeUrl(apiBase), [apiBase]);

  const syncState = useBroadcastSyncCore({ wsUrl, stateUrl, liveStatusUrl, sseUrl, normalizeUrl });

  // Update the heartbeat tracker from real sync-state changes so the watchdog
  // doesn't reconnect a healthy WS. Any change in serverTimeMs proves the engine
  // received a WS/SSE frame. We compare inside render (ref update, no setState)
  // so the effect interval always reads a fresh timestamp.
  if (syncState.serverTimeMs && syncState.serverTimeMs !== syncTimestampRef.current) {
    syncTimestampRef.current = syncState.serverTimeMs;
    lastHeartbeatMsRef.current = Date.now();
  }

  return syncState;
}
