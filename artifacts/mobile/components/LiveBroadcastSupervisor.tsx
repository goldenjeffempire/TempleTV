import { router, useSegments } from "expo-router";
import React, { useEffect, useRef } from "react";
import { usePlayer } from "@/context/PlayerContext";
import { subscribeBroadcastEvents } from "@/services/broadcast";
import { checkLiveStatus } from "@/services/youtube";

/**
 * LiveBroadcastSupervisor — monitors for genuine LIVE events (YouTube live
 * or an admin-triggered live override) and navigates to the player.
 *
 * Intentionally does NOT react to `broadcast-current-updated` because that
 * event fires every ~2 s from the transition ticker and is not a live signal.
 * Reacts only to explicit control/status events and polls every 60 s.
 */
export function LiveBroadcastSupervisor() {
  const { isLive, playLive } = usePlayer();
  const segments = useSegments();
  const lastLiveVideoRef = useRef<string | null>(null);
  const isLiveRef = useRef(isLive);
  const lastCheckRef = useRef(0);
  isLiveRef.current = isLive;

  useEffect(() => {
    let cancelled = false;

    const checkForLive = async () => {
      // Throttle: don't check more than once every 10s even if SSE fires often
      const now = Date.now();
      if (now - lastCheckRef.current < 10_000) return;
      lastCheckRef.current = now;

      try {
        const liveStatus = await checkLiveStatus(true);
        if (cancelled) return;

        // Only interrupt for genuine YouTube live streams — NOT for scheduled
        // "live" content types which are regular pre-recorded broadcasts.
        if (!liveStatus.isLive) return;

        const liveVideoChanged =
          !!liveStatus.videoId && liveStatus.videoId !== lastLiveVideoRef.current;

        if (!isLiveRef.current || liveVideoChanged) {
          lastLiveVideoRef.current = liveStatus.videoId ?? lastLiveVideoRef.current;

          // Don't forcibly eject the user if they are already on the live player
          const onPlayer = segments.includes("player" as never);
          if (onPlayer && isLiveRef.current && !liveVideoChanged) return;

          playLive();
          router.push({
            pathname: "/player",
            params: {
              live: "true",
              title: liveStatus.title ?? "Temple TV Live",
              preacher: "Temple TV JCTM",
              ...(liveStatus.videoId ? { videoId: liveStatus.videoId } : {}),
            },
          });
        }
      } catch {}
    };

    checkForLive();
    // Poll every 60 s (down from 20 s) — SSE events handle the real-time cases
    const interval = setInterval(checkForLive, 60_000);

    // Only subscribe to events that signal a genuine live state change
    const subscription = subscribeBroadcastEvents({
      "broadcast-control-updated": checkForLive,
      "broadcast-schedule-updated": checkForLive,
      "yt-status": checkForLive,
      "override-expired": checkForLive,
      status: checkForLive,
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      subscription?.close();
    };
  }, [playLive, segments]);

  return null;
}
