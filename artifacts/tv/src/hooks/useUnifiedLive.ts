import { useMemo } from "react";
import type { LiveStatus } from "../lib/api";
import { useLiveFailureFor } from "../lib/liveFailureSignal";
import { useLiveStatus } from "./useData";
import { useLiveSync } from "./useLiveSync";

/**
 * Single source of truth for "what is the platform broadcasting LIVE
 * right now?" Combines two independent signals:
 *
 *   1. `useLiveSync()` — SSE-driven broadcast sync stream. Carries the
 *      admin's explicit "Activate live stream" override
 *      (`liveOverride.youtubeVideoId` / `liveOverride.hlsStreamUrl`).
 *      This is the authoritative answer the moment an admin toggles
 *      a stream from the dashboard.
 *
 *   2. `useLiveStatus()` — 30 s poll of `/api/youtube/live/status`,
 *      which scrapes the @templetvjctm channel to detect when YouTube
 *      itself flips the channel into a live broadcast. This is the
 *      fallback for the (vast majority of) cases where no admin override
 *      is configured and the channel just goes live organically.
 *
 * Priority: an admin override always wins. Only when no override is
 * active do we fall back to the YouTube channel scrape. This mirrors the
 * exact resolution `<Player>` performs internally via `useLiveSync` —
 * keeping `LiveHero`, the channel-grid `__live__` row, and the player
 * page perfectly in sync.
 *
 * Returns the same `LiveStatus` shape `useLiveStatus()` returns so
 * existing consumers (LiveHero, BroadcastOnAirStrip, the Home onPlay
 * handler) need no further changes — they just see a fresher, broader
 * signal that includes admin overrides.
 *
 * `source` is exposed for diagnostics / future UI (e.g., a small "manual"
 * vs "auto" indicator in the admin live-monitor); production UI ignores it.
 */
export interface UnifiedLiveStatus extends LiveStatus {
  source: "override" | "channel" | null;
  /** True when the active live videoId is currently in cool-down after a
   *  reported iframe failure. Consumers can ignore this — we already flip
   *  `isLive` to false when it's set — but it's useful for diagnostics
   *  (e.g., logging "fell back to broadcast queue due to live failure"). */
  failed?: boolean;
}

export function useUnifiedLive(): UnifiedLiveStatus {
  const polledStatus = useLiveStatus();
  const sync = useLiveSync();

  // Resolve the candidate live videoId BEFORE consulting the failure
  // signal so the signal subscription is keyed off the right ID. Override
  // wins; otherwise the channel scrape's videoId.
  const overrideVideoId = sync.liveOverride?.youtubeVideoId ?? null;
  const overrideHls = sync.liveOverride?.hlsStreamUrl ?? null;
  const overrideActive = !!sync.liveOverride && (!!overrideVideoId || !!overrideHls);
  const candidateVideoId = overrideActive ? overrideVideoId : (polledStatus?.videoId ?? null);
  const failed = useLiveFailureFor(candidateVideoId);

  return useMemo<UnifiedLiveStatus>(() => {
    // If the YouTube live iframe was reported as failed for the candidate
    // videoId on this device, suppress isLive so every consumer (LiveHero,
    // channel-grid `__live__` row, and the player) falls through to the
    // broadcast queue together. Suppression auto-lifts after the cool-down
    // (see liveFailureSignal.FAILURE_TTL_MS).
    if (failed) {
      return {
        isLive: false,
        videoId: candidateVideoId,
        title: sync.liveOverride?.title ?? polledStatus?.title ?? null,
        checkedAt: Date.now(),
        detectionMethod: "live-failed-fallback",
        source: null,
        failed: true,
      };
    }

    if (overrideActive) {
      return {
        isLive: true,
        videoId: overrideVideoId,
        title: sync.liveOverride?.title ?? polledStatus?.title ?? null,
        checkedAt: sync.serverTimeMs ?? Date.now(),
        detectionMethod: "admin-override",
        source: "override",
      };
    }

    if (polledStatus?.isLive) {
      return {
        ...polledStatus,
        source: "channel",
      };
    }

    // Neither override nor channel scrape says we're live. Surface the
    // most recent polled snapshot so consumers that key off `checkedAt`
    // still see a non-null payload (matching the prior `useLiveStatus`
    // contract — null means "still checking", not "not live").
    return polledStatus
      ? { ...polledStatus, source: null }
      : {
          isLive: false,
          videoId: null,
          title: null,
          checkedAt: Date.now(),
          detectionMethod: "unknown",
          source: null,
        };
  }, [
    sync.liveOverride,
    sync.serverTimeMs,
    polledStatus,
    overrideActive,
    overrideVideoId,
    candidateVideoId,
    failed,
  ]);
}
