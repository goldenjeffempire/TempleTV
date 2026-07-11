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
 *     orchestrator transitions into PLAYING state while the app is open.
 *
 * ─── Critical design rules ───────────────────────────────────────────────────
 *
 * RULE 1 — segments via ref, NOT in effect deps.
 *   The `segments` array from useSegments() must be read through `segmentsRef`
 *   inside the effect, NOT listed as a dep. Listing `segments` in the dep
 *   array caused the entire effect (all timers, subscriptions, SSE connections)
 *   to be TORN DOWN AND RE-CREATED on every tab switch or navigation event.
 *   On re-creation, `checkForLive()` and `checkV2Broadcast()` fired immediately,
 *   which could trigger `router.push("/player")` on every tab change — even
 *   when the user had no intention of watching anything.
 *
 * RULE 2 — cold start = baseline only (no auto-navigate).
 *   The first V2 poll establishes what "currently playing" means; it NEVER
 *   triggers auto-navigation. Navigation fires only on the TRANSITION from
 *   non-playing → playing while the app is already open. If the broadcast was
 *   already running before the user opened the app, they should be able to
 *   choose where to go — they are not automatically ejected to the player.
 *
 * RULE 3 — navigation debounce.
 *   A `lastNavAtRef` prevents duplicate `router.push("/player")` calls within
 *   NAV_DEBOUNCE_MS (3 s). SSE events arrive in bursts; without this guard
 *   multiple near-simultaneous signals could stack navigation calls on the
 *   Expo Router queue and loop the player screen.
 *
 * Other behaviours:
 *   - Both paths guard against ejecting users already on the player screen.
 *   - YouTube checks collapse rapid SSE bursts with a 1.5 s throttle.
 *   - V2 polling is adaptive: 10 s when not-PLAYING, 60 s when PLAYING.
 *   - After 3 consecutive V2 failures, the interval doubles (max 120 s).
 *   - AppState "active" resets throttles and fires an immediate check.
 */
export function LiveBroadcastSupervisor() {
  const { isLive, playLive, isBroadcastMode } = usePlayer();
  const segments = useSegments();

  // ── Refs for values the effect closure reads without re-running the effect ──
  const segmentsRef = useRef(segments);
  const isLiveRef = useRef(isLive);
  const isBroadcastModeRef = useRef(isBroadcastMode);

  // Update refs on every render so the effect always reads the latest values.
  segmentsRef.current = segments;
  isLiveRef.current = isLive;
  isBroadcastModeRef.current = isBroadcastMode;

  // ── YouTube live tracking ──────────────────────────────────────────────────
  const lastLiveVideoRef = useRef<string | null>(null);
  const lastCheckRef = useRef(0);

  // ── V2 state tracking ─────────────────────────────────────────────────────
  const prevV2ModeRef = useRef<string | null>(null);

  // ── Navigation debounce ───────────────────────────────────────────────────
  // Prevents stacked router.push("/player") calls from SSE bursts or rapid
  // successive checks. Any two navigations within NAV_DEBOUNCE_MS are collapsed.
  const NAV_DEBOUNCE_MS = 3_000;
  const lastNavAtRef = useRef(0);

  // ── Adaptive V2 polling ───────────────────────────────────────────────────
  const v2FailStreak = useRef(0);
  const v2IntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    // ── Helper: is the user already on the player screen? ────────────────────
    const onPlayer = () => segmentsRef.current.includes("player" as never);

    // ── Helper: navigate to live player (debounced) ───────────────────────────
    const navigateToPlayer = (params?: Record<string, string>) => {
      const now = Date.now();
      if (now - lastNavAtRef.current < NAV_DEBOUNCE_MS) {
        // Duplicate navigation suppressed — a recent push already handled this.
        if (__DEV__) {
          console.log(
            `[LiveBroadcastSupervisor] nav debounced (${now - lastNavAtRef.current}ms since last nav)`,
          );
        }
        return;
      }
      if (onPlayer()) {
        // User is already on the player — do not push again.
        return;
      }
      lastNavAtRef.current = now;
      router.push({
        pathname: "/player",
        params: {
          isLive: "true",
          title: BROADCAST_TITLE,
          preacher: BROADCAST_PREACHER,
          ...params,
        },
      });
    };

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

          // Already on player watching a live/broadcast — skip unless the video changed.
          if (
            onPlayer() &&
            (isLiveRef.current || isBroadcastModeRef.current) &&
            !liveVideoChanged
          ) return;

          playLive();
          navigateToPlayer(liveStatus.videoId ? { videoId: liveStatus.videoId } : undefined);
        }
      } catch {}
    };

    // ── 2. V2 HLS broadcast mode detection ───────────────────────────────────
    //
    // Polls /api/broadcast-v2/state and navigates to the player when the
    // orchestrator TRANSITIONS into PLAYING mode while the app is open.
    //
    // Guards:
    //   - prevV2ModeRef starts as null → first successful poll records the
    //     baseline mode WITHOUT navigating (cold-start rule — see RULE 2 above).
    //   - Navigation fires only on the non-PLAYING → PLAYING transition.
    //   - Skips navigation if the user is already on the player.
    //   - Subject to the NAV_DEBOUNCE_MS guard (see RULE 3 above).
    //
    // Adaptive interval:
    //   Reschedules itself via v2IntervalRef after each poll:
    //     • 10 s when mode is not PLAYING (fast — catch transitions quickly)
    //     • 60 s when PLAYING (stable — WS transport handles real-time updates)
    //     • 15 s when mode unknown / first boot
    //   After 3 consecutive failures, doubles the interval (up to 120 s).
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

        // The REST payload nests the snapshot under `state`:
        //   { state: { current, override, mode } }
        // "Is something on air" = current !== null (queue item) OR
        //   override !== null (operator/YouTube override).
        const data = (await res.json()) as {
          state?: { current?: unknown; override?: unknown; mode?: string };
        };
        if (cancelled) return;

        v2FailStreak.current = 0; // reset failure streak on success

        const snap = data.state;
        const isOnAir = !!snap && (snap.current != null || snap.override != null);
        const mode = isOnAir ? "PLAYING" : (snap ? "IDLE" : "UNKNOWN");
        const prev = prevV2ModeRef.current;

        // Always persist the new mode before any early-return.
        prevV2ModeRef.current = mode;

        if (__DEV__) {
          console.log(
            `[LiveBroadcastSupervisor] V2 mode: ${prev} → ${mode}`,
          );
        }

        // ── RULE 2: first poll = establish baseline, never navigate ───────────
        // If the broadcast was already live when the app opened, the user
        // lands on their default screen (Watch/Home) and chooses to navigate.
        // Auto-navigation fires only on a TRANSITION that happens while the
        // app is already running.
        if (prev === null) {
          if (__DEV__ && mode === "PLAYING") {
            console.log(
              "[LiveBroadcastSupervisor] Cold-start baseline: broadcast already PLAYING. " +
              "Not auto-navigating — user should choose where to go.",
            );
          }
          return;
        }

        // Transition into PLAYING from a non-playing state.
        if (mode === "PLAYING" && prev !== "PLAYING") {
          if (__DEV__) {
            console.log(
              `[LiveBroadcastSupervisor] V2 transition ${prev} → PLAYING — navigating to player`,
            );
          }
          navigateToPlayer();
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
    // ── IMPORTANT: `segments` is intentionally NOT in the dep array ───────────
    // Read RULE 1 at the top of this file before adding it. `segments` is
    // accessed via segmentsRef.current inside the effect closure, which always
    // holds the latest value without causing the effect to re-run on navigation.
    // `playLive` is useCallback([]) — stable — so this effect runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playLive]);

  return null;
}
