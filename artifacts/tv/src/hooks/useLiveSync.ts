/**
 * useLiveSync — TV broadcast sync, thin wrapper over @workspace/broadcast-sync.
 *
 * The BroadcastEngine (rebuilt from scratch) handles:
 *  • WebSocket connection (OMEGA protocol) with full-jitter exponential backoff
 *  • HTTP snapshot polling every 30 s + on every (re)connect
 *  • SSE sidecar for library/schedule revision bumps
 *  • OMEGA signal dispatch (EMERGENCY_BROADCAST, PROGRAM_CHANGED, etc.)
 *  • FIFO QueueManager projecting current/next/nextNext + live timing
 *  • LiveStreamController: YouTube live detection via both server push and
 *    an independent client poll every 45 s (cold-start coverage)
 *  • FailoverHandler: primary → failoverHlsUrl → skip
 *
 * Hook count preserved: 4 useMemo calls (one per URL), matching the previous
 * implementation's hook-call count so HMR continues to work without order errors.
 */

import { useMemo } from "react";
import { useBroadcastSync } from "@workspace/broadcast-sync";
import type { BroadcastNextItem, BroadcastSyncState } from "@workspace/broadcast-types";
import { resolveApiOrigin } from "../lib/api";

export type { BroadcastNextItem, BroadcastSyncState };

export function useLiveSync(): BroadcastSyncState {
  const origin = useMemo(resolveApiOrigin, []);

  const wsUrl = useMemo(() => {
    if (!origin) return "";
    return origin
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://") + "/api/playback/ws";
  }, [origin]);

  const stateUrl = useMemo(
    () => (origin ? `${origin}/api/playback/state` : ""),
    [origin],
  );

  const liveStatusUrl = useMemo(
    () => (origin ? `${origin}/api/youtube/live/status` : ""),
    [origin],
  );

  const sseUrl = useMemo(
    () => (origin ? `${origin}/api/broadcast/events?platform=tv` : ""),
    [origin],
  );

  return useBroadcastSync({ wsUrl, stateUrl, liveStatusUrl, sseUrl });
}
