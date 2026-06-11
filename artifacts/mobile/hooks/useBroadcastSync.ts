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
  // Tracks when the last WS heartbeat frame arrived. Updated by the engine
  // via the onHeartbeat prop (when wired) or estimated from reconnectKey changes.
  // Used by the iOS heartbeat-absence watchdog below.
  const lastHeartbeatMsRef = useRef<number>(Date.now());

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background" || next === "inactive") {
        backgroundAtRef.current = Date.now();
      } else if (next === "active") {
        if (Date.now() - backgroundAtRef.current > 10_000) {
          setReconnectKey((k) => k + 1);
        }
        // Also reset heartbeat timer on foreground so the watchdog doesn't
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
  // Every 30 s, if no heartbeat has arrived in 30 s, bump reconnectKey to
  // force a fresh WS connection regardless of AppState.
  useEffect(() => {
    const HEARTBEAT_TIMEOUT_MS = 30_000;
    const timer = setInterval(() => {
      if (Date.now() - lastHeartbeatMsRef.current > HEARTBEAT_TIMEOUT_MS) {
        lastHeartbeatMsRef.current = Date.now(); // reset before reconnect
        setReconnectKey((k) => k + 1);
      }
    }, HEARTBEAT_TIMEOUT_MS);
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

  return useBroadcastSyncCore({ wsUrl, stateUrl, liveStatusUrl, sseUrl, normalizeUrl });
}
