import { router } from "expo-router";
import type { Sermon } from "@/types";
import { gatePlayback } from "@/utils/auth-gate";

/**
 * Navigate to the player route, gated by authentication. If the user
 * is signed in (or auth state is still rehydrating), the navigation
 * fires immediately. Otherwise the AuthGateModal is opened with the
 * exact same target so playback resumes seamlessly after sign-in.
 */
export function navigateToSermon(
  sermon: Sermon,
  extraParams: Record<string, string> = {},
) {
  const baseParams: Record<string, string> = {
    title: sermon.title,
    preacher: sermon.preacher,
    duration: sermon.duration,
    thumbnail: sermon.thumbnailUrl,
    category: sermon.category,
    ...extraParams,
  };

  const params: Record<string, string> =
    sermon.videoSource === "local" && sermon.localVideoUrl
      ? { ...baseParams, localVideoUrl: sermon.localVideoUrl }
      : { ...baseParams, videoId: sermon.youtubeId };

  gatePlayback(
    {
      pathname: "/player",
      params,
      reason: `Sign up free to watch "${sermon.title}" and unlock the full sermon library.`,
    },
    () => router.push({ pathname: "/player", params }),
  );
}

/**
 * Navigate to the live broadcast (or any explicit /player params),
 * gated by authentication. Use this for hero CTAs, MiniPlayer taps,
 * and radio plays so non-authed users see the sign-up modal instead
 * of bouncing straight into the player route.
 */
export function navigateToPlayer(
  params: Record<string, string>,
  reason?: string,
) {
  gatePlayback(
    { pathname: "/player", params, reason },
    () => router.push({ pathname: "/player", params }),
  );
}
