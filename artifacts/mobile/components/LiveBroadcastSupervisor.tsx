import { router, useSegments } from "expo-router";
import React, { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { usePlayer } from "@/context/PlayerContext";
import { subscribeBroadcastEvents } from "@/services/broadcast";
import { checkLiveStatus } from "@/services/youtube";
import { getApiBase } from "@/lib/apiBase";
import { BROADCAST_TITLE, BROADCAST_PREACHER } from "@/lib/broadcastIdentity";

/**
 * LiveBroadcastSupervisor — monitors for genuine LIVE events and navigates
 * to the player automatically.
 *
 * Watches two independent signal sources:
 *
 *  1. YouTube Live (via checkLiveStatus) — when the church streams live on
 *     YouTube and the admin activates the YouTube override.
 *
 *  2. V2 HLS broadcast mode (via /api/broadcast-v2/state) — when the V2
 *     orchestrator enters PLAYING state for the first time in a session
 *     (i.e. transitions from IDLE/LOADING to PLAYING). This covers the
 *     primary broadcast path where the admin queues HLS content.
 *
 * Both paths guard against ejecting users already on the player screen
 * and collapse rapid SSE bursts with a 1.5 s throttle.
 */
export function LiveBroadcastSupervisor() {
  const { isLive, playLive, isBroadcastMode } = usePlayer();
  const segments = useSegments();
  const lastLiveVideoRef = useRef<string | null>(null);
  const isLiveRef = useRef(isLive);
  const isBroadcastModeRef = useRef(isBroadcastMode);
  const lastCheckRef = useRef(0);
  const prevV2ModeRef = useRef<string | null>(null);

  isLiveRef.current = isLive;
  isBroadcastModeRef.current = isBroadcastMode;

  useEffect(() => {
    let cancelled = false;

    // ── Helper: is the user already on the player screen? ────────────────────
    const onPlayer = () => segments.includes("player" as never);

    // ── 1. YouTube live detection ─────────────────────────────────────────────
    //
    // Burst-coalesce throttle: a single admin action fans out into 3 SSE events
    // within ~100 ms. 1.5 s collapses bursts while propagating real changes in
    // under 2 s instead of waiting for the 60 s safety poll.
    const checkForLive = async () => {
      const now = Date.now();
      if (now - lastCheckRef.current < 1_500) return;
      lastCheckRef.current = now;

      try {
        const liveStatus = await checkLiveStatus(true);
        if (cancelled) return;

        if (!liveStatus.isLive) return;

        const liveVideoChanged =
          !!liveStatus.videoId && liveStatus.videoId !== lastLiveVideoRef.current;

        if (!isLiveRef.current || liveVideoChanged) {
          lastLiveVideoRef.current = liveStatus.videoId ?? lastLiveVideoRef.current;

          if (onPlayer() && (isLiveRef.current || isBroadcastModeRef.current) && !liveVideoChanged) return;

          playLive();
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

    // ── 2. V2 HLS broadcast mode detection ───────────────────────────────────
    //
    // Polls /api/broadcast-v2/state and navigates to the player the first time
    // the orchestrator transitions into PLAYING mode within this app session.
    //
    // Guards:
    //   - prevV2ModeRef starts as null → first successful poll stores the mode
    //     WITHOUT navigating (avoids cold-start ejection when the broadcast was
    //     already running before the app opened).
    //   - Only fires on the null→PLAYING or non-PLAYING→PLAYING transition.
    //   - Skips navigation if the user is already on the player.
    const checkV2Broadcast = async () => {
      try {
        const base = getApiBase();
        if (!base || cancelled) return;

        const res = await fetch(`${base}/api/broadcast-v2/state`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok || cancelled) return;

        const data = (await res.json()) as { mode?: string; sequence?: number };
        if (cancelled) return;

        const mode = data.mode ?? "UNKNOWN";
        const prev = prevV2ModeRef.current;

        // Persist the new mode before any early-return so subsequent checks
        // always compare against the latest known state.
        prevV2ModeRef.current = mode;

        // First poll: establish baseline without triggering navigation.
        if (prev === null) return;

        // Transition into PLAYING from a non-playing state.
        if (mode === "PLAYING" && prev !== "PLAYING") {
          if (onPlayer()) return;
          router.push({
            pathname: "/player",
            params: {
              isLive: "true",
              title: BROADCAST_TITLE,
              preacher: BROADCAST_PREACHER,
            },
          });
        }
      } catch {}
    };

    // ── Initial checks ────────────────────────────────────────────────────────
    checkForLive();
    checkV2Broadcast();

    // ── Polling intervals ─────────────────────────────────────────────────────
    // YouTube: 60 s — SSE events handle real-time, poll is safety net.
    // V2 state: 30 s — lighter endpoint, catches mode changes between SSE events.
    const ytInterval = setInterval(checkForLive, 60_000);
    const v2Interval = setInterval(checkV2Broadcast, 30_000);

    // ── SSE subscription — react only to genuine live-state events ────────────
    const subscription = subscribeBroadcastEvents({
      "broadcast-control-updated": checkForLive,
      "broadcast-schedule-updated": () => {
        checkForLive();
        checkV2Broadcast();
      },
      "yt-status": checkForLive,
      "override-expired": () => {
        checkForLive();
        checkV2Broadcast();
      },
      status: checkForLive,
    });

    // ── Foreground recovery ───────────────────────────────────────────────────
    // Bypass the 1.5 s throttle so the very first foreground check is immediate.
    const appStateSub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active") {
        lastCheckRef.current = 0;
        checkForLive();
        checkV2Broadcast();
      }
    });

    return () => {
      cancelled = true;
      clearInterval(ytInterval);
      clearInterval(v2Interval);
      subscription?.close();
      appStateSub.remove();
    };
  }, [playLive, segments]);

  return null;
}
