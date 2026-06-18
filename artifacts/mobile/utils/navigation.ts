import { router } from "expo-router";
import type { Sermon } from "@/types";

/**
 * Navigate to the player route for a VOD sermon. All users — authenticated
 * or guest — navigate immediately; no auth gate is shown before playback.
 * Auth is retained for optional features (history sync, favourites, alerts)
 * which are surfaced as non-blocking prompts inside the player after the
 * video has started.
 */
export function navigateToSermon(
  sermon: Sermon,
  extraParams: Record<string, string> = {},
) {
  const baseParams: Record<string, string> = {
    id: sermon.id,
    title: sermon.title,
    preacher: sermon.preacher,
    duration: sermon.duration,
    thumbnailUrl: sermon.thumbnailUrl,
    category: sermon.category,
    description: sermon.description ?? "",
    ...extraParams,
  };

  const params: Record<string, string> =
    sermon.videoSource === "local"
      ? {
          ...baseParams,
          hlsUrl: sermon.hlsMasterUrl ?? "",
          localVideoUrl: sermon.localVideoUrl ?? "",
        }
      : { ...baseParams, youtubeId: sermon.youtubeId };

  router.push({ pathname: "/player", params });
}

/**
 * Navigate to the live broadcast or any explicit /player params. All users
 * — authenticated or guest — navigate immediately. No auth gate is shown
 * before playback.
 */
export function navigateToPlayer(
  params: Record<string, string>,
) {
  router.push({ pathname: "/player", params });
}
