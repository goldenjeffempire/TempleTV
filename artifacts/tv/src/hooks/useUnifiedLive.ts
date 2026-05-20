/**
 * useUnifiedLive — Single source of truth for "what is the platform
 * broadcasting LIVE right now?"
 *
 * Rebuild note: the LiveStreamController inside the new BroadcastEngine
 * now runs an independent 45-second client poll in addition to receiving
 * server-push live signals. As a result, `sync.ytLive` and `sync.ytVideoId`
 * are populated on cold-start without waiting for an SSE handshake.
 *
 * This hook merges three independent signals:
 *
 *   1. `useLiveSync()` (BroadcastEngine)
 *      — Admin "Go Live" override  (liveOverride)
 *      — Server-push YouTube detection  (sync.ytLive / sync.ytVideoId)
 *      — Client-side YouTube poll (LiveStreamController, 45 s interval)
 *      → This is the authoritative, instant source.
 *
 *   2. `useLiveStatus()` — 30-second HTTP poll of /api/youtube/live/status.
 *      Acts as a final cross-check and cold-start fallback for the brief
 *      window before the engine's internal poll completes.
 *
 *   3. `useLiveFailureFor()` — per-device iframe-failure cool-down.
 *      When an embedded YouTube player fails on this device, isLive is
 *      suppressed for FAILURE_TTL_MS so the queue plays instead.
 *
 * Priority: admin override > SSE push > client poll > HTTP poll.
 *
 * Returns the same `UnifiedLiveStatus` shape as before — all consumers
 * (LiveHero, BroadcastOnAirStrip, Home's onPlay handler) are unchanged.
 */

import { useMemo } from "react";
import type { LiveStatus } from "../lib/api";
import { useLiveFailureFor } from "../lib/liveFailureSignal";
import { useLiveStatus } from "./useData";
import { useLiveSync } from "./useLiveSync";

export interface UnifiedLiveStatus extends LiveStatus {
  source: "override" | "channel" | null;
  failed?: boolean;
}

export function useUnifiedLive(): UnifiedLiveStatus {
  const polledStatus = useLiveStatus();
  const sync = useLiveSync();

  const overrideVideoId = sync.liveOverride?.youtubeVideoId ?? null;
  const overrideHls     = sync.liveOverride?.hlsStreamUrl ?? null;
  const overrideActive  = !!sync.liveOverride && (!!overrideVideoId || !!overrideHls);

  const ytSseLive = sync.ytLive && !!sync.ytVideoId;

  const candidateVideoId = overrideActive
    ? overrideVideoId
    : (sync.ytVideoId ?? polledStatus?.videoId ?? null);

  const failed = useLiveFailureFor(candidateVideoId);

  return useMemo<UnifiedLiveStatus>(() => {
    // Suppress isLive for any videoId in per-device failure cool-down.
    if (failed) {
      return {
        isLive:          false,
        videoId:         candidateVideoId,
        title:           sync.liveOverride?.title ?? sync.ytTitle ?? polledStatus?.title ?? null,
        checkedAt:       Date.now(),
        detectionMethod: "live-failed-fallback",
        source:          null,
        failed:          true,
      };
    }

    // Admin override wins unconditionally.
    if (overrideActive) {
      return {
        isLive:          true,
        videoId:         overrideVideoId,
        title:           sync.liveOverride?.title ?? sync.ytTitle ?? polledStatus?.title ?? null,
        checkedAt:       sync.serverTimeMs ?? Date.now(),
        detectionMethod: "admin-override",
        source:          "override",
      };
    }

    // Server-push SSE channel signal (instant).
    if (ytSseLive) {
      return {
        isLive:          true,
        videoId:         sync.ytVideoId,
        title:           sync.ytTitle ?? polledStatus?.title ?? null,
        checkedAt:       sync.serverTimeMs ?? Date.now(),
        detectionMethod: "channel-sse",
        source:          "channel",
      };
    }

    // HTTP-polled channel status (30 s fallback).
    if (polledStatus?.isLive) {
      return { ...polledStatus, source: "channel" };
    }

    // Off-air: return the most recent polled snapshot (non-null).
    return polledStatus
      ? { ...polledStatus, source: null }
      : {
          isLive:          false,
          videoId:         null,
          title:           null,
          checkedAt:       Date.now(),
          detectionMethod: "unknown",
          source:          null,
        };
  }, [
    sync.liveOverride,
    sync.serverTimeMs,
    sync.ytLive,
    sync.ytVideoId,
    sync.ytTitle,
    polledStatus,
    overrideActive,
    overrideVideoId,
    ytSseLive,
    candidateVideoId,
    failed,
  ]);
}
