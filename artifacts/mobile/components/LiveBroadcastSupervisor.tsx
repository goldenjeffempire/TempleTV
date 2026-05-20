import { router, useSegments } from "expo-router";
import React, { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { usePlayer } from "@/context/PlayerContext";
import { subscribeBroadcastEvents } from "@/services/broadcast";
import { checkLiveStatus } from "@/services/youtube";
import { BROADCAST_TITLE, BROADCAST_PREACHER } from "@/lib/broadcastIdentity";

/**
 * LiveBroadcastSupervisor — monitors for genuine LIVE events (YouTube live
 * or an admin-triggered live override) and navigates to the player.
 *
 * Intentionally does NOT react to `broadcast-current-updated` because that
 * event fires every ~2 s from the transition ticker and is not a live signal.
 * Reacts only to explicit control/status events and polls every 60 s.
 */
export function LiveBroadcastSupervisor() {
  const { isLive, playLive, isBroadcastMode } = usePlayer();
  const segments = useSegments();
  const lastLiveVideoRef = useRef<string | null>(null);
  const isLiveRef = useRef(isLive);
  const isBroadcastModeRef = useRef(isBroadcastMode);
  const lastCheckRef = useRef(0);
  isLiveRef.current = isLive;
  isBroadcastModeRef.current = isBroadcastMode;

  useEffect(() => {
    let cancelled = false;

    const checkForLive = async () => {
      // Burst-coalesce throttle: a single admin action ("Activate live")
      // fans out into 3 SSE events back-to-back — `broadcast-control-
      // updated`, `status`, and (since the cinematic-hero sync fix in
      // §15) `broadcast-current-updated` via `invalidateBroadcastCache`.
      // All three arrive within ~50–100 ms. We want exactly ONE
      // `checkLiveStatus(true)` call per burst (it hits the YouTube
      // Data API, which is quota-limited).
      //
      // The previous 10 s window was a 100×-too-wide overshoot: any
      // legitimate live event that fired within 10 s of ANY prior
      // check (including the initial mount-time check at line 69) was
      // dropped, leaving the user up to ~55 s stale until the 60 s
      // safety poll caught up. 1.5 s is 30× the burst window — still
      // collapses bursts, but a real state change after the initial
      // mount check now propagates in <2 s instead of <60 s.
      const now = Date.now();
      if (now - lastCheckRef.current < 1_500) return;
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

          // Don't forcibly eject the user if they are already on the live player.
          // Also guard the HLS broadcast mode: if the user is watching the v2
          // HLS broadcast (isBroadcastMode=true) and YouTube live starts with
          // the same videoId, don't interrupt — they are already on live content.
          const onPlayer = segments.includes("player" as never);
          if (onPlayer && (isLiveRef.current || isBroadcastModeRef.current) && !liveVideoChanged) return;

          playLive();
          // Round 9c: pass the channel identity rather than the per-program
          // title so the route, share-sheet, and any pre-render glance stay
          // consistent with the broadcast-clean directive.
          router.push({
            pathname: "/player",
            params: {
              isLive: "true",
              title: BROADCAST_TITLE,
              preacher: BROADCAST_PREACHER,
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

    // Foreground recovery: a live stream may have started while the user was
    // away. Bypass the 10s throttle so the very first foreground check is
    // immediate — important after long backgrounds where a deploy or live
    // event was missed.
    const appStateSub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active") {
        lastCheckRef.current = 0;
        checkForLive();
      }
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      subscription?.close();
      appStateSub.remove();
    };
  }, [playLive, segments]);

  return null;
}
