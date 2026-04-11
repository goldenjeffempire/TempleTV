import { router } from "expo-router";
import React, { useEffect, useRef } from "react";
import { usePlayer } from "@/context/PlayerContext";
import { checkBroadcastCurrent } from "@/services/broadcast";
import { checkLiveStatus } from "@/services/youtube";

export function LiveBroadcastSupervisor() {
  const { isLive, playLive } = usePlayer();
  const lastLiveVideoRef = useRef<string | null>(null);
  const isLiveRef = useRef(isLive);
  isLiveRef.current = isLive;

  useEffect(() => {
    let cancelled = false;

    const checkForInterrupt = async () => {
      try {
        const [liveStatus, broadcastStatus] = await Promise.all([
          checkLiveStatus(true),
          checkBroadcastCurrent(),
        ]);
        if (cancelled) return;

        const scheduledLive = broadcastStatus?.activeSchedule?.contentType === "live";
        const liveVideoChanged = !!liveStatus.videoId && liveStatus.videoId !== lastLiveVideoRef.current;
        const shouldInterrupt = liveStatus.isLive || scheduledLive;

        if (shouldInterrupt && (!isLiveRef.current || liveVideoChanged)) {
          lastLiveVideoRef.current = liveStatus.videoId ?? lastLiveVideoRef.current;
          playLive();
          router.push({
            pathname: "/player",
            params: {
              live: "true",
              title: liveStatus.title ?? broadcastStatus?.activeSchedule?.title ?? "Temple TV Live",
              preacher: "Temple TV JCTM",
              ...(liveStatus.videoId ? { videoId: liveStatus.videoId } : {}),
            },
          });
        }
      } catch {}
    };

    checkForInterrupt();
    const interval = setInterval(checkForInterrupt, 20000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [playLive]);

  return null;
}