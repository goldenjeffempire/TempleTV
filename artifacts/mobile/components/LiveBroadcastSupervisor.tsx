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
 *
 * Adaptive polling:
 *   V2 state polling interval is adaptive — faster (10 s) when the last
 *   known mode is not PLAYING (we want to detect transitions quickly), and
 *   slower (60 s) when the broadcast is already PLAYING (stable, SSE
 *   handles real-time updates on web; WS transport handles it on native).
 *
 * Network-aware restart:
 *   AppState "active" events reset the throttle window so the very first
 *   foreground check is immediate. A consecutive-failure counter backs off
 *   V2 polls after 3 failures (API unreachable) and resets on success to
 *   avoid hammering a temporarily unreachable server.
 */
export function LiveBroadcastSupervisor() {
  const { isLive, playLive, isBroadcastMode } = usePlayer();
  const segments = useSegments();
  const lastLiveVideoRef = useRef<string | null>(null);
  const isLiveRef = useRef(isLive);
  const isBroadcastModeRef = useRef(isBroadcastMode);
  const lastCheckRef = useRef(0);
  const prevV2ModeRef = useRef<string | null>(null);

  // Adaptive-polling state
  const v2FailStreak = useRef(0);
  const v2IntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    //
    // Adaptive interval:
    //   Reschedules itself via v2IntervalRef after each poll so the interval
    //   can be changed dynamically:
    //     • 10 s when mode is not PLAYING (fast — want to catch transitions)
    //     • 60 s when PLAYING (stable — WS transport handles real-time)
    //     • 30 s when mode unknown / first boot
    //   After 3 consecutive failures, we double the interval (up to 120 s)
    //   to avoid hammering a temporarily unreachable server.
    const checkV2Broadcast = async () => {
      try {
        const base = getApiBase();
        if (!base || cancelled) return;

        const res = await fetch(`${base}/api/broadcast-v2/state`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok || cancelled) {
          v2FailStreak.current++;
          return;
        }

        // The REST payload nests the snapshot under `state` (see
        // broadcast-v2/io/rest.routes.ts GET /state → `{ state: snapshot }`).
        // V2Snapshot itself has no PLAYING/IDLE "mode" enum matching this
        // code's expectations — its `mode` field is "queue" | "override" |
        // "failover" | "offline_hold". This poller's real question is
        // "is something on air right now", which is answered by
        // `current !== null` (queue item playing) or `override !== null`
        // (operator/YouTube override active) — NOT by comparing against a
        // "PLAYING" string that never appears in the payload. Reading
        // `data.mode` directly (one level too shallow, and the wrong enum)
        // meant `mode` was always "UNKNOWN" and this transition-detector
        // never fired, silently disabling the auto-navigate-to-player safety
        // net for the V2 broadcast path.
        const data = (await res.json()) as {
          state?: { current?: unknown; override?: unknown; mode?: string };
        };
        if (cancelled) return;

        // Success — reset failure streak
        v2FailStreak.current = 0;

        const snap = data.state;
        const isOnAir = !!snap && (snap.current != null || snap.override != null);
        const mode = isOnAir ? "PLAYING" : (snap ? "IDLE" : "UNKNOWN");
        const prev = prevV2ModeRef.current;

        // Persist the new mode before any early-return so subsequent checks
        // always compare against the latest known state.
        prevV2ModeRef.current = mode;

        // First poll: establish baseline. If the broadcast is ALREADY live
        // when the app cold-starts, navigate immediately instead of staying
        // silent until the next transition (previously this branch never
        // navigated on cold start even when already on-air).
        if (prev === null) {
          if (mode === "PLAYING" && !onPlayer()) {
            router.push({
              pathname: "/player",
              params: {
                isLive: "true",
                title: BROADCAST_TITLE,
                preacher: BROADCAST_PREACHER,
              },
            });
          }
          return;
        }

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
      } catch {
        v2FailStreak.current++;
      } finally {
        // Reschedule with adaptive interval
        if (!cancelled) scheduleV2Poll();
      }
    };

    /**
     * Schedule the next V2 poll with an interval derived from the current
     * broadcast state and failure streak.
     */
    const scheduleV2Poll = () => {
      if (v2IntervalRef.current !== null) return; // already scheduled
      const mode = prevV2ModeRef.current;
      let baseMs: number;
      if (mode === "PLAYING") {
        baseMs = 60_000; // stable — slow down
      } else if (mode === null) {
        baseMs = 15_000; // first boot — moderate
      } else {
        baseMs = 10_000; // non-playing — fast to catch transitions
      }
      // Exponential backoff on failures (capped at 2× base, max 120 s)
      const failPenalty = v2FailStreak.current >= 3
        ? Math.min(baseMs, 60_000)
        : 0;
      const intervalMs = Math.min(baseMs + failPenalty, 120_000);

      v2IntervalRef.current = setTimeout(() => {
        v2IntervalRef.current = null;
        if (!cancelled) void checkV2Broadcast();
      }, intervalMs);
    };

    // ── Initial checks ────────────────────────────────────────────────────────
    void checkForLive();
    void checkV2Broadcast();

    // ── YouTube safety poll — 60 s ────────────────────────────────────────────
    // V2 polling is self-rescheduling (adaptive). YouTube uses a fixed interval
    // since SSE handles real-time and the 60 s is just a safety net.
    const ytInterval = setInterval(checkForLive, 60_000);

    // ── SSE subscription — react only to genuine live-state events ────────────
    const subscription = subscribeBroadcastEvents({
      "broadcast-control-updated": checkForLive,
      "broadcast-schedule-updated": () => {
        void checkForLive();
        // Reset the adaptive V2 poll interval so we check sooner after a
        // schedule change (the broadcast might transition to PLAYING).
        if (v2IntervalRef.current !== null) {
          clearTimeout(v2IntervalRef.current);
          v2IntervalRef.current = null;
        }
        void checkV2Broadcast();
      },
      "yt-status": checkForLive,
      "override-expired": () => {
        void checkForLive();
        if (v2IntervalRef.current !== null) {
          clearTimeout(v2IntervalRef.current);
          v2IntervalRef.current = null;
        }
        void checkV2Broadcast();
      },
      status: checkForLive,
    });

    // ── Foreground recovery ───────────────────────────────────────────────────
    // Bypass the 1.5 s throttle so the very first foreground check is immediate.
    // Also cancel any pending V2 poll timer and fire immediately so mode
    // transitions that happened while backgrounded are detected right away.
    const appStateSub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active") {
        lastCheckRef.current = 0; // reset YouTube throttle
        v2FailStreak.current = 0; // reset backoff on foreground

        // Cancel pending V2 timer → fire immediately
        if (v2IntervalRef.current !== null) {
          clearTimeout(v2IntervalRef.current);
          v2IntervalRef.current = null;
        }

        void checkForLive();
        void checkV2Broadcast();
      }
    });

    return () => {
      cancelled = true;
      clearInterval(ytInterval);
      if (v2IntervalRef.current !== null) {
        clearTimeout(v2IntervalRef.current);
        v2IntervalRef.current = null;
      }
      subscription?.close();
      appStateSub.remove();
    };
  }, [playLive, segments]);

  return null;
}
