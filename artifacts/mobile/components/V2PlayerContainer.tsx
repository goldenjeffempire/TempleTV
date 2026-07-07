/**
 * V2PlayerContainer — Expo/React Native broadcast surface backed by
 * `@workspace/player-core`'s React Native bindings.
 *
 * Architecture:
 *   • Two `<Video>` (expo-av) buffers are mounted permanently. Neither ever
 *     unmounts; we only `bind`/`play`/`pause`/`unbind` via store updates.
 *   • Active buffer renders on top (zIndex 2, audible); inactive sits behind
 *     muted, ready for hand-off.
 *   • Real device events (`onLoad`, `onPlaybackStatusUpdate`, `onError`) are
 *     piped back into the FSM as `buffer-ready` / `buffer-ended` /
 *     `buffer-error` so the machine stays in sync with reality.
 *
 * Offline resilience (added May 2026):
 *   • isBuffering watchdog: if expo-av's `isBuffering` flag stays true for
 *     >15 s while the buffer should be active and playing, the watchdog fires
 *     `buffer-error` so the FSM can attempt recovery instead of silently
 *     stalling on a weak-network segment fetch.
 *   • Network recovery: `useNetworkContext()` drives an immediate
 *     `forceReconnect()` + `notifyOnline()` the moment connectivity is
 *     detected — complementing the AppState-based foreground reconnect.
 *   • Network-aware banner: "You're offline" vs "Reconnecting to broadcast…"
 *     depending on whether the device has no signal or just a dead WS socket.
 *   • progressUpdateIntervalMillis=500 for sub-second stall detection.
 *
 * HLS live-timeline fixes (May 2026):
 *   • Actual-duration clamping: expo-av's `onLoad` durationMillis is captured
 *     as ground truth. For VOD HLS, playFromPositionAsync is clamped to
 *     (actualDurationMs - HLS_END_GUARD_MS) to prevent out-of-range seeks that
 *     cause AVPlayer/ExoPlayer to snap to the end and immediately fire didJustFinish,
 *     creating the "single segment replaying" loop.
 *   • End-guard margin: HLS_END_GUARD_MS (8 000 ms) > HLS_QUICK_FINISH_THRESHOLD_MS
 *     (5 000 ms) guarantees every clamped seek lands ≥ 8 s before the encoded end —
 *     closing the 2–5 s gap that caused spurious quick-finish loops with the old
 *     2 000 ms guard.
 *   • Live vs VOD detection: if durationMillis is undefined/Infinity (live HLS),
 *     playAsync() is used instead of playFromPositionAsync() — the native player
 *     attaches to the live edge automatically.
 *   • Quick-finish retry corrected: live HLS retries via playAsync() (not
 *     playFromPositionAsync(0)), which was seeking to the oldest DVR segment
 *     and trailing further behind the live edge on every spurious retry.
 *   • Drift-correction seek guard: small anchor recalibrations (< 8 s drift)
 *     are suppressed when the playhead is already near the target, preventing
 *     AVPlayer/ExoPlayer from dropping its download buffer on every keepalive.
 *     Only genuine drifts (server restart, timezone mis-sync, > 8 s gap) seek.
 *   • Quick-finish guard: if didJustFinish fires within HLS_QUICK_FINISH_THRESHOLD_MS
 *     of playback start, it's a spurious finish (bad seek). Retried up to
 *     HLS_MAX_QUICK_FINISH_RETRIES times before escalating to buffer-ended.
 *   • Live-sync interval: playAsync() called every HLS_LIVE_SYNC_INTERVAL_MS on
 *     active+playing HLS buffers to re-latch to the live edge and refresh the
 *     manifest on DVR-windowed streams. No-op on VOD HLS (already playing).
 *
 * Android/ExoPlayer "Tuning in…" overlay stuck fix (May 2026):
 *   • Root cause: RECOVERING_PRIMARY rebinds the same item URL (retry 1 or 2).
 *     expo-av's Video component does NOT re-fire onLoad when the source prop
 *     string is unchanged — so buffer-ready was never reported for the new
 *     bindRevision, leaving the FSM stuck in RECOVERING_PRIMARY indefinitely
 *     while audio from the original successful load continued playing.
 *   • Fix: `lastLoadedUrlRef` tracks the URL of the last successful onLoad.
 *     When bindRevision bumps with the same URL (same-URL recovery), the reset
 *     effect immediately fires buffer-ready for the new revision and preserves
 *     actualDurationMsRef (same video, same duration). New URLs get the full
 *     reset and wait for onLoad as before.
 *   • Secondary fix: `onReadyForDisplay` wired as a secondary buffer-ready
 *     signal. On Android, onLoad fires on metadata decode; onReadyForDisplay
 *     fires on first video-frame render (can be 100–500 ms later). The
 *     lastReportedRevision guard prevents double-firing — onLoad wins normally,
 *     onReadyForDisplay picks up the slack if onLoad fired without emitting
 *     buffer-ready (e.g. revision mismatch during a rapid re-bind).
 *   • Live-sync interval increased: HLS_LIVE_SYNC_INTERVAL_MS 15 s → 30 s.
 *     The 15 s re-latch was causing perceptible micro-stalls on weak Android
 *     connections; 30 s matches the standard live HLS target segment duration.
 *
 * Recovery spiral fix (May 2026):
 *   • Root cause: RECOVERING_PRIMARY same-URL fast-path fires buffer-ready →
 *     play effect calls playFromPositionAsync(N) → ExoPlayer flushes its
 *     download buffer and re-fetches segments at position N → slow-network
 *     fetch exceeds BUFFERING_STALL_THRESHOLD_MS → buffer-error → RECOVERING
 *     → same-URL fast-path → playFromPositionAsync(N) → stall → infinite loop.
 *     Result: player permanently shows "Tuning in…" while audio plays.
 *   • Fix: `isSameUrlRecoveryRef` (one-shot ref) is set in the reset effect
 *     when a same-URL recovery is detected. The play effect checks this flag:
 *     if set, it calls playAsync() instead of playFromPositionAsync(). This
 *     resumes ExoPlayer from its already-buffered position without a buffer
 *     flush. The HLS live-sync interval (30 s) re-latches broadcast timeline
 *     position without seeking. The flag is consumed (cleared) immediately
 *     after use so subsequent drift corrections take the normal seek path.
 *
 * Silent load-failure timeout (May 2026):
 *   • Root cause: Android ExoPlayer occasionally fails to fire onLoad or
 *     onError (manifest parse failure, codec negotiation deadlock, manifest
 *     fetch timing out before the first byte arrives). Without a timeout the
 *     FSM stays in PREPARING_ACTIVE or RECOVERING indefinitely.
 *   • Fix: `loadTimeoutRef` starts LOAD_TIMEOUT_MS (12 s) after a new URL is
 *     bound to an active+playing buffer. If onLoad has not fired by then,
 *     buffer-error is emitted, triggering normal FSM recovery. The timeout is
 *     cancelled on onLoad (success) or when bindRevision changes (new source).
 *
 * HLS content-type hint (May 2026):
 *   • Added `overrideFileExtensionWithValue: 'm3u8'` to the expo-av source
 *     object for HLS items. Some ExoPlayer 2.x builds fall back to progressive
 *     download when the manifest URL has query params that obscure the .m3u8
 *     extension, causing manifest parse failures and a permanently black video
 *     surface while audio continues from the demuxed audio track.
 *
 * Used by `app/player.tsx` for the live HLS path (v2 broadcast).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, AppState, Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { ResizeMode, Video, type AVPlaybackStatus } from "expo-av";
import { useV2BroadcastNative } from "@workspace/player-core/react-native";
import type { MobileBufferState } from "@workspace/player-core/adapters/mobile";
import { useNetworkContext } from "@/context/NetworkContext";
import { enqueueTelemetry, flushTelemetryBuffer } from "@/lib/telemetryBuffer";
import { hydrationReady, isHydrationDone } from "@/lib/mobileBroadcastStorage";
import { waitForAudioSession } from "@/lib/audio-session";
import {
  isInPictureInPictureMode,
  updatePipParams,
} from "../modules/expo-pip-android/src";

// Audio session (playsInSilentModeIOS, staysActiveInBackground, DoNotMix
// interruption mode) is configured globally in app/_layout.tsx at app boot.
// Do NOT call Audio.setAudioModeAsync here — it is a global API and would
// override the app-wide policy on every player mount.

/**
 * How long (ms) expo-av's `isBuffering` flag must stay true on the active
 * playing buffer before the watchdog declares a network stall and fires
 * `buffer-error`. This triggers the FSM's recovery path (rebind → failover →
 * skip) rather than waiting indefinitely for segment data that may never
 * arrive on a very weak or interrupted connection.
 *
 * 15 s balances:
 *   • HLS: enough time for a slow connection to fetch the next segment. A
 *     single 2 MB segment on 3G (≈ 1 Mbit/s effective) takes 16 s in the
 *     worst case; even at 2 Mbit/s it's 8 s. The old 10 s value fired on
 *     perfectly healthy streams during momentary cell-tower congestion.
 *   • Transient rebuffer pauses on a healthy connection (usually < 2 s)
 *   • Must stay > LocalVideoPlayer.STALL_FAIL_MS (15 s) so both paths are
 *     consistent — users on web and RN see the same stall tolerance.
 *   • Fast recovery on genuinely bad sources: 15 s is still much faster than
 *     the OS-level TCP keepalive timeout (> 60 s on Android/iOS).
 */
const BUFFERING_STALL_THRESHOLD_MS = 15_000;
// Reduced from 12 s → 8 s: mobile networks on ExoPlayer can silently fail
// to load a manifest (no onLoad, no onError). A shorter first-cycle timeout
// means the FSM escalates to the next retry attempt faster, reducing the
// total stuck-time from up to 36 s (3 × 12 s) to up to 24 s (3 × 8 s).
// Still chosen below BUFFERING_STALL_THRESHOLD_MS (15 s) so a genuine
// buffering stall fires the watchdog before the load timeout can double-fire.

/**
 * How many milliseconds of actual playback must occur before a `didJustFinish`
 * event is treated as a genuine natural end rather than a spurious "quick finish".
 *
 * A quick finish (< threshold) indicates a bad seek position — typically:
 *   1. VOD HLS where positionSecs > actual encoded duration → AVPlayer snaps to
 *      the last frame and fires didJustFinish in < 1 s.
 *   2. Live HLS where the DVR window is exhausted before the manifest refresh
 *      arrives → player reaches the last cached segment and fires didJustFinish.
 *
 * In both cases the right recovery is to retry rather than HANDOFF (which would
 * rebind the same item with a worse position, looping).
 */
// Lowered from 5 000 ms to 3 000 ms: genuine stream endings near 5 s were
// being misclassified as spurious "quick finishes" and triggering extra retries.
// The HLS_END_GUARD_MS (8 000 ms) provides enough clearance above this threshold
// that clamped seeks can never land within the new 3 s quick-finish window.
// Additionally, the didJustFinish guard now requires positionMillis > 0 to
// exclude the zero-play edge case where ExoPlayer fires didJustFinish before
// reporting any position (e.g. after a stale seek on a newly-loaded manifest).
const HLS_QUICK_FINISH_THRESHOLD_MS = 3_000;

// ── Manifest-driven quick-finish threshold cache ─────────────────────────────
// Maps HLS playlist URL → EXT-X-TARGETDURATION (seconds). Populated lazily on
// the first bind of any HLS URL; shared across all BroadcastBuffer instances so
// a second buffer binding the same URL skips the network fetch. Module-level
// (not useState) so it persists across component unmount/remount cycles.
// Capped at 256 entries to prevent unbounded growth in long app sessions where
// many different HLS URLs cycle through the broadcast queue.
const hlsTargetDurationCache = new Map<string, number>();
const HLS_MANIFEST_CACHE_MAX = 256;

/**
 * Minimum margin (ms) between the seek target and the actual encoded end of
 * the VOD HLS content. Must be strictly greater than HLS_QUICK_FINISH_THRESHOLD_MS
 * (5 000 ms) to guarantee that every clamped seek lands far enough from the end
 * that the player can play at least that many milliseconds before firing
 * didJustFinish — ensuring no clamped seek ever triggers the quick-finish guard.
 *
 * 8 000 ms = HLS_QUICK_FINISH_THRESHOLD_MS + 3 000 ms safety margin.
 *
 * Without this margin the window between the old 2 000 ms guard and the
 * 5 000 ms quick-finish threshold (3 000 ms) was wide enough that seeks landing
 * 2–5 s from the encoded end produced a "single segment replay" loop:
 *   seek to end-3s → play 3s → quick-finish → retry from 0 → desync.
 */
const HLS_END_GUARD_MS = 8_000;

/**
 * Maximum consecutive "quick finish" retries before escalating to buffer-ended.
 * Prevents an infinite retry loop on a source that is genuinely broken (e.g.
 * a corrupt HLS playlist that always ends in < 5 s regardless of start position).
 */
const HLS_MAX_QUICK_FINISH_RETRIES = 2;

/**
 * Maximum position drift (ms) between a drift-correction seek target and the
 * current playhead before a re-seek is actually issued on VOD HLS.
 *
 * The player-core machine emits drift-correction `play` intents when the
 * server's cycle anchor shifts by > 5 s (e.g. after a server restart or
 * checkpoint restore). On web this is cheap (a single currentTime assignment).
 * On mobile, every `playFromPositionAsync` causes AVPlayer/ExoPlayer to:
 *   1. Drop its current download buffer
 *   2. Re-request the segment containing the new position
 *   3. Stall visibly for 0.5–2 s while the new segment downloads
 *
 * Suppressing re-seeks when the playhead is already within 8 s of the target
 * preserves smooth playback for small anchor recalibrations while still
 * correcting large drifts (server restart, timezone mis-sync, > 8 s gap).
 */
const HLS_SMALL_DRIFT_SKIP_MS = 8_000;

/**
 * How often (ms) to call `playAsync()` on an active+playing HLS buffer.
 *
 * For live HLS streams (dynamic playlist): AVPlayer/ExoPlayer manage the live
 * edge automatically, but a device that has been backgrounded, throttled, or
 * on a congested link can drift behind the live window.  Calling `playAsync()`
 * every 30 s re-latches the player to the current live edge without disrupting
 * smooth playback if already at the edge (the call is a no-op in that case).
 *
 * 30 s matches the standard HLS target segment duration for live streams and
 * avoids the brief audio stall that ExoPlayer/AVPlayer can produce when
 * re-seeking to the live edge more aggressively (every 15 s caused perceptible
 * micro-stalls on weak Android connections during congested periods).
 *
 * For VOD HLS: `playAsync()` is always a no-op on a playing video — it only
 * ensures `shouldPlay = true`, which is already true.  No seek occurs.
 */
const HLS_LIVE_SYNC_INTERVAL_MS = 30_000;

/**
 * How far before the active buffer's end (ms) to emit a `buffer-near-end`
 * event to the machine. This is the client-side complement to the server's
 * `preload` frame (also 120 s). Emitting near-end from the player guarantees
 * the machine proactively loads the next item into the inactive buffer even
 * when the server's preload frame arrives late — e.g. during a transport
 * reconnect or a slow-link snapshot delay.
 *
 * Set to 120 s to match `PRELOAD_LEAD_MS` in `lib/player-core/src/machine.ts`
 * (and the server's `BROADCAST_PRELOAD_LEAD_MS` default) so the server preload
 * frame, machine HANDOFF logic, and this client-side fallback all fire at the
 * same lead time. Only fires once per bind revision (guarded by
 * `nearEndReportedRef`) and only for VOD content with a finite duration.
 * Live HLS has no fixed end point so near-end detection is skipped for it.
 */
const NEAR_END_PRELOAD_LEAD_MS = 120_000;

/**
 * Maximum time (ms) to wait for expo-av's `onLoad` to fire after a new
 * source is bound to an active+playing buffer before declaring a load failure.
 *
 * This is a safety net for cases where Android ExoPlayer fails to fire
 * `onLoad` or `onError` (silent failure modes seen with certain HLS manifests
 * or codec configurations). Without this timeout the FSM stays stuck in
 * PREPARING_ACTIVE or RECOVERING indefinitely — audio may play (from a prior
 * successful load) but "Tuning in…" never clears.
 *
 * 8 s: chosen BELOW BUFFERING_STALL_THRESHOLD_MS (15 s) so the two
 * watchdogs target different failure classes without racing each other.
 * LOAD_TIMEOUT catches "ExoPlayer never emitted isBuffering=true" (silent
 * codec / manifest failures). BUFFERING_STALL catches "isBuffering=true
 * but no frames arrive" (partial content, slow segment download). Both
 * can be active simultaneously but LOAD_TIMEOUT fires first and clears
 * the stall watchdog via the error path. Reduced from 12 s → 8 s so that
 * silent ExoPlayer manifest failures cycle through all 3 retry attempts
 * in ~24 s total instead of ~36 s, shortening the stuck-player window.
 */
const LOAD_TIMEOUT_MS = 8_000;

interface Props {
  baseUrl: string;
  channelId?: string;
  /** Called when the FSM enters FATAL — parent can route to a fallback UI. */
  onFatal?: () => void;
  /**
   * Force-mute audio regardless of adapter store. Use for thumbnail-style
   * previews (e.g. homepage hero) where audio would conflict with the rest
   * of the page.
   */
  muted?: boolean;
  /**
   * Suppress the large centered tuning/off-air overlay and reconnecting
   * banner so the surface can be used as a small inline preview without a
   * full-screen takeover. Tap-through is the parent's responsibility.
   * Also implies suppressEvents=true.
   */
  minimal?: boolean;
  /**
   * When true, suppress all FSM buffer event reporting and watchdog arming
   * from this container's BroadcastBuffer pair. Use when a second
   * V2PlayerContainer instance is the "primary" FSM driver and this one is
   * view-only:
   *   - Inline (muted) player while the fullscreen Modal player is active.
   * Setting minimal=true implies suppressEvents=true automatically.
   */
  suppressEvents?: boolean;
  /**
   * When provided, directly overrides the derived `suppressEvents` value
   * (`minimal || !!suppressEvents`) passed to both BroadcastBuffer instances.
   *
   * Primary use-case — the homepage hero (minimal=true, muted):
   *   • suppressEventsOverride=false (player screen NOT open, isBroadcastMode=false):
   *     Hero's BroadcastBuffers drive the FSM normally (BOOTSTRAP → PLAYING).
   *     The HLS stream is loaded and the FSM advances to PLAYING while the user
   *     browses the home tab — so Watch Now has an already-PLAYING session ready.
   *   • suppressEventsOverride=true (player screen IS open, isBroadcastMode=true):
   *     Hero's BroadcastBuffers yield FSM control to the player screen's instance.
   *     Hero Videos continue playing (muted) as a background warm-up layer but do
   *     not compete with the player for buffer-ready / buffer-error events.
   *
   * When undefined the existing `minimal || !!suppressEvents` logic applies
   * (backward-compatible default).
   */
  suppressEventsOverride?: boolean;
  /**
   * Reactive PiP-mode flag from the parent screen. When provided, the
   * YouTube-override-in-PiP exit effect becomes reactive to PiP *entry*, so it
   * fires onFatal both when an override starts during PiP AND when PiP is
   * entered while an override is already active. Falls back to the imperative
   * isInPictureInPictureMode() when omitted.
   */
  isInPip?: boolean;
}

function sourceUrl(state: MobileBufferState, excludeYouTube: boolean): string | null {
  const item = state.item;
  if (!item) return null;
  if ("source" in item) {
    // Hero preview path (excludeYouTube=true) refuses to bind a YouTube
    // source — expo-av cannot play YouTube URLs anyway, and policy keeps
    // the homepage hero a "platform broadcast only" surface. The parent
    // can fall back to a thumbnail; full-screen player has its own
    // YouTube iframe path.
    if (excludeYouTube && item.source.kind === "youtube") return null;
    return item.source.url;
  }
  // V2Override is also kind-aware; same rule applies.
  if (excludeYouTube && item.kind === "youtube") return null;
  return item.url;
}

/**
 * Returns true when the current buffer item is an HLS source (V2Item with
 * source.kind === "hls", or V2Override with kind === "hls").
 *
 * HLS sources on mobile require a different playback strategy from MP4/DASH:
 *   - Position clamping (VOD HLS): playFromPositionAsync must never seek past
 *     the actual encoded duration or AVPlayer/ExoPlayer immediately fires
 *     didJustFinish, creating a single-segment replay loop.
 *   - Live-edge sync (live HLS): periodic playAsync() re-latches the player
 *     to the live edge when it drifts behind the DVR window.
 *   - Quick-finish detection: spurious didJustFinish from a bad seek should
 *     be retried from position 0 instead of triggering HANDOFF.
 */
function isHlsSource(state: MobileBufferState): boolean {
  const item = state.item;
  if (!item) return false;
  if ("source" in item) return item.source.kind === "hls";
  return item.kind === "hls";
}

interface BufferProps {
  bufferId: "A" | "B";
  state: MobileBufferState;
  reportBufferEvent: ReturnType<typeof useV2BroadcastNative>["reportBufferEvent"];
  forceMuted?: boolean;
  excludeYouTube?: boolean;
  /**
   * When true, ALL FSM event reporting (buffer-ready, buffer-error,
   * buffer-ended) and watchdog arming (load timeout, buffering stall,
   * quick-finish retry) are suppressed. Use for view-only instances that
   * share the singleton session but must NOT compete with the primary
   * player instance for FSM control:
   *   - Hero homepage preview (minimal=true) — purely decorative; the
   *     Player screen owns the FSM when both are simultaneously mounted.
   *   - Inline (muted) BroadcastHlsPlayer while the fullscreen Modal's
   *     BroadcastHlsPlayer is active — prevents the inline buffers from
   *     firing spurious buffer-error/buffer-ready to the shared FSM.
   */
  suppressEvents?: boolean;
  /**
   * True when the FSM is actively waiting for this buffer to report
   * readiness (PREPARING_ACTIVE, RECOVERING_PRIMARY, RECOVERING_FAILOVER).
   * False when the FSM is already PLAYING or in any other non-waiting state.
   *
   * Gates the load-timeout and buffering-stall watchdogs so a freshly-
   * mounted consumer (e.g. the Player screen opening while the Hero's
   * singleton session is already PLAYING) cannot accidentally fire
   * buffer-error into a healthy PLAYING session. Without this guard,
   * the 12-second load timeout or 15-second buffering watchdog fires
   * against the fresh Video elements and triggers an unnecessary
   * RECOVERING_PRIMARY cycle that disrupts the live broadcast.
   *
   * Stored in a ref (fsmIsWaitingRef) inside BroadcastBuffer so the
   * value is current inside timeout/async callbacks without causing
   * those timers to be re-created on every snapshot update.
   */
  fsmIsWaiting: boolean;
  /**
   * Called when the native player renders its first video frame
   * (`onReadyForDisplay`). The parent uses this to keep the poster
   * visible until actual pixels appear on screen, eliminating the
   * 100–500 ms black flash that occurs between the FSM entering PLAYING
   * (overlay dismissed) and ExoPlayer/AVPlayer painting frame 1.
   */
  onVideoReady?: () => void;
}

const BroadcastBuffer = React.memo(function BroadcastBuffer({
  bufferId,
  state,
  reportBufferEvent,
  forceMuted = false,
  excludeYouTube = false,
  suppressEvents = false,
  fsmIsWaiting = false,
  onVideoReady,
}: BufferProps) {
  const ref = useRef<Video>(null);
  const url = sourceUrl(state, excludeYouTube);

  // Whether the current item is an HLS source — drives different seek/finish
  // handling compared to MP4/DASH. Stable within a bind revision.
  const isHls = isHlsSource(state);

  // ── Manifest-driven quick-finish threshold ────────────────────────────────
  // Start at the static fallback; updated asynchronously once we've parsed the
  // HLS playlist's EXT-X-TARGETDURATION header for the current URL.
  // Stored in a ref (not state) so updates don't trigger a re-render.
  const quickFinishThresholdMsRef = useRef(HLS_QUICK_FINISH_THRESHOLD_MS);

  useEffect(() => {
    // Reset to fallback on every URL change so stale thresholds from a previous
    // source never carry over to a different stream.
    quickFinishThresholdMsRef.current = HLS_QUICK_FINISH_THRESHOLD_MS;
    if (!isHls || !url) return;

    // Cache hit — apply immediately without a network request.
    const cached = hlsTargetDurationCache.get(url);
    if (cached !== undefined) {
      quickFinishThresholdMsRef.current = Math.max(cached * 1_000, HLS_QUICK_FINISH_THRESHOLD_MS);
      return;
    }

    // Async fetch of the HLS manifest to read EXT-X-TARGETDURATION.
    // Non-blocking: if the fetch fails or takes too long the fallback threshold
    // is used for this session; a future rebind will retry.
    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5_000);

    fetch(url, { signal: controller.signal })
      .then((r) => r.text())
      .then((text) => {
        if (cancelled) return;
        const match = text.match(/#EXT-X-TARGETDURATION:(\d+)/);
        if (!match) return;
        const targetSec = parseInt(match[1] ?? "", 10);
        if (!isFinite(targetSec) || targetSec <= 0) return;
        // Evict oldest entry if cache is full (LRU-lite — evict first inserted).
        if (hlsTargetDurationCache.size >= HLS_MANIFEST_CACHE_MAX) {
          const firstKey = hlsTargetDurationCache.keys().next().value;
          // firstKey is string | undefined from MapIterator; the undefined guard
          // above narrows it but TS can't prove it through Map.delete — cast it.
          if (firstKey !== undefined) hlsTargetDurationCache.delete(firstKey as string);
        }
        hlsTargetDurationCache.set(url, targetSec);
        quickFinishThresholdMsRef.current = Math.max(targetSec * 1_000, HLS_QUICK_FINISH_THRESHOLD_MS);
      })
      .catch(() => {
        // Best-effort — keep the static fallback threshold.
      })
      .finally(() => clearTimeout(timeoutId));

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, isHls]);

  // Track the last bind revision that produced a buffer-ready report rather
  // than the URL string. URL-based dedup caused RECOVERING_PRIMARY to silently
  // swallow the onLoad event when the same URL was rebound after a failure,
  // leaving the FSM stuck in RECOVERING_PRIMARY until the watchdog fired.
  const lastReportedRevision = useRef<number>(-1);

  // Guards the one-per-bind-revision `buffer-near-end` event. Once emitted for
  // the current bindRevision, no further near-end events are sent until the
  // next bind. This prevents flooding the machine with near-end on every 500 ms
  // status tick while the playhead stays inside the preload window. Reset to
  // `false` at the start of every bindRevision useEffect.
  const nearEndReportedRef = useRef(false);

  // Keep suppressEvents in a ref so the stable `emit` callback below can
  // read the CURRENT value without appearing in its useCallback dep array.
  // This avoids recreating `emit` (and thereby re-running the play useEffect)
  // every time the parent toggles suppressEvents (e.g. on fullscreen toggle).
  const suppressEventsRef = useRef(suppressEvents);
  suppressEventsRef.current = suppressEvents;

  // Keep fsmIsWaiting in a ref so timeout callbacks (load timeout, buffering
  // stall watchdog) read the CURRENT value without appearing in their dep
  // arrays. This avoids re-creating the timers on every snapshot update.
  //
  // Why this matters: the load-timeout and buffering-stall watchdogs must NOT
  // arm when the FSM is already PLAYING (e.g. Player screen freshly mounting
  // while Hero was playing). In that case the Video elements are cold-starting
  // but the FSM is healthy — a spurious buffer-error after 12 s / 15 s would
  // kick the FSM into RECOVERING_PRIMARY and disrupt an otherwise live stream.
  const fsmIsWaitingRef = useRef(fsmIsWaiting);
  fsmIsWaitingRef.current = fsmIsWaiting;

  // Stable wrapper around reportBufferEvent that becomes a no-op while
  // suppressEvents is true.  All FSM event calls below use `emit` so
  // view-only instances (hero preview, muted inline player while the
  // fullscreen Modal is active) cannot interfere with the shared FSM.
  const emit = useCallback(
    (...args: Parameters<typeof reportBufferEvent>) => {
      if (!suppressEventsRef.current) reportBufferEvent(...args);
    },
    [reportBufferEvent],
  );

  // Track the URL that expo-av successfully loaded (onLoad fired). Used to
  // detect same-URL recovery rebinds (RECOVERING_PRIMARY/FAILOVER with the
  // same item) where expo-av won't re-fire onLoad because the source prop
  // string hasn't changed. In that case we immediately fire buffer-ready for
  // the new bindRevision so the FSM exits recovery without waiting for a load
  // event that will never come — while audio continues from the prior load.
  const lastLoadedUrlRef = useRef<string | null>(null);

  // Tracks the bindRevision for which onLoad has fired. This prevents
  // playFromPositionAsync being called before expo-av has finished loading
  // the new source — without this guard the FSM emits a `play` intent
  // (positionSecs ≥ 0) right after the `bind` intent, and the imperative
  // call on an unloaded <Video> rejects, firing a spurious buffer-error
  // that triggers an unnecessary RECOVERING_PRIMARY cycle.
  // Using React state (not a ref) so the play effect re-runs automatically
  // when onLoad fires and sets the loaded revision.
  const [loadedRevision, setLoadedRevision] = useState(-1);
  // Ref mirror so stable callbacks (handleError, onPlaybackStatusUpdate) read
  // the *current* loadedRevision without it appearing in their dep arrays.
  const loadedRevisionRef = useRef(-1);
  loadedRevisionRef.current = loadedRevision;
  // Ref mirror for state.bindRevision — same reason.  Together with
  // loadedRevisionRef these let handleError and onPlaybackStatusUpdate apply
  // the "pre-load guard" without going stale across bind-revision changes.
  const bindRevisionRef = useRef(state.bindRevision);
  bindRevisionRef.current = state.bindRevision;

  // ── HLS playback tracking ───────────────────────────────────────────────

  /**
   * Actual video duration (ms) as reported by expo-av / AVPlayer after the
   * source is loaded. This is the ground-truth duration from the native
   * media pipeline, independent of the server's `durationSecs` DB field
   * (which may over- or under-estimate for newly-uploaded or mis-probed
   * videos). Null = not yet known or live HLS (infinite duration).
   */
  const actualDurationMsRef = useRef<number | null>(null);

  /**
   * Wall-clock timestamp (Date.now()) when the most recent
   * playFromPositionAsync / playAsync call was issued for this buffer.
   * Used by the quick-finish guard: if didJustFinish fires within
   * HLS_QUICK_FINISH_THRESHOLD_MS of starting, it's a spurious finish
   * (bad seek position) rather than a genuine natural end.
   */
  const playStartMsRef = useRef<number | null>(null);

  /**
   * Count of consecutive "quick finish" events on this buffer's current
   * bind revision. After HLS_MAX_QUICK_FINISH_RETRIES consecutive quick
   * finishes we escalate to buffer-ended so the FSM can skip a source
   * that is genuinely broken regardless of seek position.
   */
  const hlsQuickFinishCountRef = useRef(0);

  /**
   * Most-recently reported playback position (positionMillis from
   * onPlaybackStatusUpdate). Used by the drift-correction seek guard in the
   * play effect: if the current playhead is already within HLS_SMALL_DRIFT_SKIP_MS
   * of the requested target, the re-seek is suppressed to avoid the stall caused
   * by AVPlayer/ExoPlayer dropping its buffer on every small anchor recalibration.
   * Reset to null on each new bind revision so the initial seek always fires.
   */
  const playheadMsRef = useRef<number | null>(null);

  /**
   * Set to `true` when the current bind-revision reset is a same-URL recovery
   * (RECOVERING_PRIMARY/FAILOVER rebinding the same source URL). In this case
   * the play effect MUST use `playAsync()` instead of `playFromPositionAsync()`
   * for HLS, because:
   *
   *   1. ExoPlayer already has the HLS manifest and some segments in memory
   *      from the prior successful load — calling `playAsync()` resumes
   *      playback from where it is without flushing the download buffer.
   *
   *   2. `playFromPositionAsync(N)` forces ExoPlayer to discard its buffer
   *      and re-fetch segments starting at position N. When N is far into
   *      a large VOD HLS file, this fetch can exceed BUFFERING_STALL_THRESHOLD_MS
   *      on a slow connection — triggering another buffer-error → RECOVERING_PRIMARY
   *      → same-URL fast-path → playFromPositionAsync(N) → stall → loop (the
   *      "recovery spiral" that keeps the player stuck on "Tuning in…").
   *
   *   3. Using `playAsync()` instead breaks the spiral: ExoPlayer resumes from
   *      its buffered position (or re-attaches to the live edge for live HLS)
   *      without a buffer flush, and the live-sync interval (HLS_LIVE_SYNC_INTERVAL_MS)
   *      re-latches position to the broadcast timeline within 30 s.
   *
   * Cleared to false after the play effect consumes it (one-shot).
   */
  const isSameUrlRecoveryRef = useRef(false);

  /**
   * Safety-net load timeout for silent Android ExoPlayer failures.
   *
   * Fires LOAD_TIMEOUT_MS after a new URL is bound to an active+playing
   * buffer if `onLoad` has not yet confirmed the source is ready. Covers:
   *   - Manifest fetch silently hanging (no error event from ExoPlayer)
   *   - Codec negotiation deadlock (no callback, no error, isBuffering false)
   *   - HLS playlist parse failure that doesn't surface as `onError`
   *
   * Cleared immediately when `onLoad` fires (normal path) or when bindRevision
   * changes again (the old timeout is irrelevant for the new source).
   */
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── isBuffering stall watchdog ──────────────────────────────────────────
  // expo-av sets isBuffering=true whenever the player is waiting for the
  // network to deliver enough data to resume playback. On weak or
  // interrupted connections this can stall indefinitely without ever
  // surfacing an error event. The watchdog converts a prolonged buffering
  // state into an explicit buffer-error so the FSM can recover.
  const bufferingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pending quick-finish retry timer. Cancelled when bindRevision changes so
  // a 1 s retry that was scheduled for the OLD source never fires against the
  // NEW one and seeks it back to position 0, causing a desync loop.
  const quickFinishRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable ref-only helper — useCallback with [] so it never recreates.
  // clearBufferingWatchdog is captured by handleVideoError below; if it were a
  // plain function it would be a new reference on every BroadcastBuffer render,
  // causing handleVideoError to also recreate and defeating React.memo on the
  // Video element's onError prop.
  const clearBufferingWatchdog = useCallback(() => {
    if (bufferingWatchdogRef.current) {
      clearTimeout(bufferingWatchdogRef.current);
      bufferingWatchdogRef.current = null;
    }
  }, []);

  // Stable ref-only helper — same pattern as clearBufferingWatchdog.
  //
  // Must be a useCallback (not a plain function) so it is a stable reference
  // that can appear in the dependency arrays of handleVideoError and handleError
  // without causing those callbacks to be re-created on every render.
  //
  // Why this matters: when expo-av fires onError, BOTH the load timeout AND
  // the error emission fire independently unless the timeout is cancelled in
  // the same tick as the error handler. Without a stable clearLoadTimeout ref,
  // we cannot safely include it in handleVideoError/handleError deps, leaving
  // a ghost 8-second timer that emits a second spurious buffer-error after the
  // FSM has already started recovering — potentially interrupting the recovery
  // with another RECOVERING_PRIMARY cycle.
  const clearLoadTimeout = useCallback(() => {
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
  }, []);

  const clearQuickFinishRetry = useCallback(() => {
    if (quickFinishRetryTimerRef.current) {
      clearTimeout(quickFinishRetryTimerRef.current);
      quickFinishRetryTimerRef.current = null;
    }
  }, []);

  // Stable onError handler for the expo-av <Video> element.
  //
  // BroadcastBuffer is wrapped in React.memo to prevent re-renders on every
  // 500 ms progress-update tick from the parent. But React.memo only works
  // when ALL props are stable references. Passing an inline lambda for
  // onError — `(error) => { clearBufferingWatchdog(); emit(...) }` — would
  // create a new function reference on every BroadcastBuffer render, defeating
  // memo on the inner <Video> and causing unnecessary re-renders.
  //
  // Both `emit` (useCallback in BroadcastBuffer), `clearBufferingWatchdog`, and
  // `clearLoadTimeout` (useCallbacks above) are stable; `bufferId` never changes
  // within a mounted BroadcastBuffer instance. So this callback is effectively
  // permanent for the lifetime of the component instance — one per A/B buffer.
  //
  // clearLoadTimeout is included because expo-av can fire onError on Android
  // BEFORE onLoad completes. Without cancelling the load timeout here, both the
  // error handler AND the 8-second load-timeout fire buffer-error to the FSM,
  // producing a double RECOVERING_PRIMARY that can overlap with the first
  // recovery's bind-revision update and leave the player stuck in a recovery loop.
  const handleVideoError = useCallback((error: unknown) => {
    clearBufferingWatchdog();
    clearLoadTimeout();
    emit({
      type: "buffer-error",
      bufferId,
      error: typeof error === "string" ? error : "media-error",
    });
  }, [clearBufferingWatchdog, clearLoadTimeout, emit, bufferId]);

  // Reset all per-bind tracking when a new source is bound (new bindRevision).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- url and reportBufferEvent
  // intentionally omitted: url derives from state.item which always changes in
  // lockstep with bindRevision; reportBufferEvent is a stable function reference.
  useEffect(() => {
    clearBufferingWatchdog();
    clearQuickFinishRetry();
    playStartMsRef.current = null;
    playheadMsRef.current = null;
    hlsQuickFinishCountRef.current = 0;
    // Reset the near-end preload guard so the new item can fire buffer-near-end
    // when its playhead enters the NEAR_END_PRELOAD_LEAD_MS window.
    nearEndReportedRef.current = false;

    // ── Same-URL recovery fast-path ──────────────────────────────────────
    // RECOVERING_PRIMARY/FAILOVER often rebinds the SAME URL (same item,
    // fresh bindRevision). expo-av's Video component won't re-fire onLoad
    // when the source prop string is unchanged, so the normal path of
    // "wait for onLoad → fire buffer-ready" will never complete, leaving
    // the FSM stuck in RECOVERING_* while audio from the original load
    // continues playing — the "Tuning in…" overlay that never clears bug.
    //
    // If expo-av already loaded this exact URL (lastLoadedUrlRef matches),
    // we know the native player is still healthy. Immediately fire
    // buffer-ready for the new revision so the FSM can exit recovery and
    // re-issue the play intent (which will seek to the wall-clock position).
    // actualDurationMsRef stays valid — same video, same duration.
    if (url !== null && url === lastLoadedUrlRef.current) {
      isSameUrlRecoveryRef.current = true;
      // No load timeout needed — expo-av already has this source loaded.
      clearLoadTimeout();
      setLoadedRevision(state.bindRevision);
      if (lastReportedRevision.current !== state.bindRevision) {
        lastReportedRevision.current = state.bindRevision;
        emit({ type: "buffer-ready", bufferId });
      }
    } else {
      isSameUrlRecoveryRef.current = false;
      // New URL (or initial bind with no prior successful load) — full
      // reset; wait for onLoad before the play effect can seek.
      setLoadedRevision(-1);
      actualDurationMsRef.current = null;
      // ── Silent-failure load timeout ─────────────────────────────────
      // Android ExoPlayer can fail to fire onLoad or onError in certain
      // edge cases (manifest parse failure, codec negotiation deadlock,
      // network timeout before the first byte of the manifest arrives).
      // Without this timeout the FSM stays stuck in PREPARING_ACTIVE or
      // RECOVERING indefinitely with no recovery path.
      //
      // Only arm for active+playing buffers — preloading the inactive
      // buffer silently is expected and should not trigger recovery.
      // suppressEvents: do NOT arm the watchdog on view-only instances
      // (hero preview, muted inline player). Their Videos loading slowly
      // in the background must not fire spurious buffer-error to the FSM.
      //
      // fsmIsWaiting: only arm when the FSM is genuinely waiting for this
      // buffer to signal readiness (PREPARING_ACTIVE / RECOVERING_*). When
      // the FSM is already PLAYING — e.g. Player screen freshly mounting
      // while the Hero singleton session was already broadcasting — the
      // new Video elements are cold-starting but the FSM is healthy. Arming
      // the watchdog here would fire buffer-error after 12 s if HLS is slow
      // to load on the fresh elements, kicking the FSM into RECOVERING_PRIMARY
      // and disrupting a perfectly live stream.
      clearLoadTimeout();
      // Use suppressEventsRef.current (not the raw prop closure) so this
      // bindRevision effect — which only re-runs on bindRevision changes —
      // observes the CURRENT suppressEvents value at the moment the timeout
      // would be armed, not the stale value captured when the effect closure
      // was created.  Without this fix, toggling suppressEvents (e.g. when
      // fullscreen opens/closes between two bind revisions) leaves the guard
      // with a stale false value and arms the watchdog on a suppressed instance,
      // causing spurious buffer-error → RECOVERING_PRIMARY on the fullscreen
      // stream.
      // Guard: only arm the load timeout when there is actually a URL for
      // expo-av to load. YouTube overrides have url=null (the native Video
      // element is deliberately absent — the player shows a branded overlay
      // instead). Arming the timeout with url=null means it always fires after
      // LOAD_TIMEOUT_MS (onLoad can never fire without a Video element), which
      // drives the FSM from LIVE_OVERRIDE_ACTIVE → RECOVERING_PRIMARY → tries
      // to load the raw YouTube watch URL → ExoPlayer errors → SKIP_PENDING →
      // dead air until the escape-valve reconnect fires.
      if (!suppressEventsRef.current && state.playing && state.active && fsmIsWaitingRef.current && url !== null) {
        loadTimeoutRef.current = setTimeout(() => {
          loadTimeoutRef.current = null;
          emit({ type: "buffer-error", bufferId, error: "load-timeout" });
        }, LOAD_TIMEOUT_MS);
      }
    }
  }, [state.bindRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cancel all watchdogs and pending timers on unmount.
  useEffect(() => {
    return () => {
      clearBufferingWatchdog();
      clearQuickFinishRetry();
      clearLoadTimeout();
    };
  }, []);

  // ── Play effect ─────────────────────────────────────────────────────────
  // Drive playback against the imperative expo-av API.
  // Guard: only call playFromPositionAsync/playAsync once onLoad has confirmed
  // the source is ready for this bind revision.  Pause calls are safe at any
  // time so they don't need the same guard.
  useEffect(() => {
    const v = ref.current;
    if (!v || !url) return;
    if (state.playing) {
      if (loadedRevision !== state.bindRevision) return; // not ready yet — wait for onLoad

      // Hero preview (forceMuted) — re-assert mute BEFORE every imperative
      // play call to close the Android ExoPlayer race: ExoPlayer can briefly
      // open the audio pipeline on playAsync/playFromPositionAsync before the
      // native isMuted flag has been acknowledged from the JS side.
      // setIsMutedAsync + setVolumeAsync are fire-and-forget (non-blocking);
      // ExoPlayer queues them before the play call in its internal command
      // queue, so muting takes effect at the same audio frame that playback
      // starts — no audible gap.
      if (forceMuted) {
        v.setIsMutedAsync(true).catch(() => {});
        v.setVolumeAsync(0).catch(() => {});
      }

      if (isHls) {
        const actualMs = actualDurationMsRef.current;
        // Distinguish live HLS (no fixed duration) from VOD HLS:
        //   Live HLS: durationMillis is undefined/Infinity from expo-av.
        //   VOD HLS:  durationMillis is a finite positive number.
        const isLiveHls = actualMs === null || !isFinite(actualMs) || actualMs <= 0;

        if (isLiveHls || isSameUrlRecoveryRef.current) {
          // ── Live HLS path or same-URL recovery ────────────────────────
          // Live HLS: playAsync() attaches AVPlayer/ExoPlayer to the live
          // edge of the dynamic playlist. Calling playFromPositionAsync()
          // on a live stream either fails (no seekable range in manifest)
          // or snaps to the oldest cached segment, trailing further behind
          // the live edge on every retry.
          //
          // Same-URL recovery: RECOVERING_PRIMARY/FAILOVER rebinds the
          // same URL. ExoPlayer still has the manifest and segments in
          // memory from the prior load. Using playAsync() resumes from
          // the buffered position without flushing ExoPlayer's download
          // buffer. playFromPositionAsync(N) would flush+re-fetch segments
          // at position N — on slow networks this refetch can exceed
          // BUFFERING_STALL_THRESHOLD_MS, triggering another buffer-error
          // → RECOVERING → playFromPositionAsync → stall → loop (the
          // "Tuning in…" stuck spiral). playAsync() breaks the spiral.
          // The HLS live-sync interval re-latches position within 30 s.
          isSameUrlRecoveryRef.current = false; // consume one-shot flag
          playStartMsRef.current = Date.now();
          v.playAsync().catch(() => {
            emit({ type: "buffer-error", bufferId, error: "play-failed" });
          });
        } else {
          // ── VOD HLS path ───────────────────────────────────────────────
          // Clamp the requested position to (actualMs - HLS_END_GUARD_MS) to
          // prevent seeking past the last segment of the encoded content.
          //
          // Why this matters: if the DB row's durationSecs overestimates the
          // actual video length (e.g. a 30-min file catalogued as 86400 s
          // because the duration probe failed at upload), positionSecs from
          // the machine can be >> the encoded duration. AVPlayer then either:
          //   a) snaps to the last frame and fires didJustFinish within ~1 s, or
          //   b) raises a seek error (buffer-error path).
          // Both create a rapid HANDOFF→rebind→worse-position→repeat loop —
          // the "single HLS segment replaying" symptom on mobile.
          //
          // HLS_END_GUARD_MS (8 000 ms) > HLS_QUICK_FINISH_THRESHOLD_MS (5 000 ms)
          // by a 3 s safety margin, guaranteeing that even when clamping kicks in
          // the player has at least 8 s to play before a natural didJustFinish —
          // far above the quick-finish threshold so no clamped seek triggers the
          // retry loop.
          const clampedMs = Math.min(
            state.positionSecs * 1000,
            Math.max(0, actualMs - HLS_END_GUARD_MS),
          );

          // ── Drift-correction seek guard ────────────────────────────────
          // The machine emits a new `play` intent (updating state.positionSecs)
          // whenever the server's cycle anchor shifts by > 5 s — for example,
          // after a server restart, checkpoint restore, or keepalive arriving
          // just after a REST snapshot during a transport reconnect. On web
          // this is a free currentTime assignment. On mobile every
          // playFromPositionAsync causes AVPlayer/ExoPlayer to drop its
          // download buffer and stall for 0.5–2 s while re-fetching the
          // segment at the new position.
          //
          // Suppress the re-seek when the playhead is already within
          // HLS_SMALL_DRIFT_SKIP_MS (8 s) of the target — the viewer is
          // watching the correct content and the minor desync is imperceptible.
          // Allow the seek when the drift is large (> 8 s), which indicates a
          // genuine broadcast restart or a severely skewed device clock.
          //
          // The guard requires playStartMsRef to be set (i.e. we have already
          // sought at least once for this bind revision) so the INITIAL seek
          // always fires unconditionally and lands at the correct timeline position.
          const currentPlayheadMs = playheadMsRef.current;
          const nearTarget =
            currentPlayheadMs !== null &&
            playStartMsRef.current !== null &&
            Math.abs(clampedMs - currentPlayheadMs) < HLS_SMALL_DRIFT_SKIP_MS;

          if (!nearTarget) {
            playStartMsRef.current = Date.now();
            v.playFromPositionAsync(clampedMs).catch(() => {
              emit({ type: "buffer-error", bufferId, error: "play-failed" });
            });
          }
        }
      } else {
        // ── MP4 / DASH / non-HLS path ──────────────────────────────────
        // Apply the same drift-correction seek guard used for VOD HLS.
        // For MP4 faststart (direct Range-request streaming), repeated
        // seeks on small anchor shifts still cause ExoPlayer to discard
        // its prefetched byte range and issue a new Range request, which
        // produces a visible 100–300 ms rebuffer stall on weak connections.
        // Skip the re-seek when the playhead is already within
        // HLS_SMALL_DRIFT_SKIP_MS (8 s) of the target — the viewer is
        // watching the correct content and the minor desync is not visible.
        // The initial seek (playStartMsRef === null) always fires so the
        // player starts at the correct broadcast position.
        const targetMs = state.positionSecs * 1000;
        const currentPlayheadMs = playheadMsRef.current;
        const nearTarget =
          currentPlayheadMs !== null &&
          playStartMsRef.current !== null &&
          Math.abs(targetMs - currentPlayheadMs) < HLS_SMALL_DRIFT_SKIP_MS;

        if (!nearTarget) {
          playStartMsRef.current = Date.now();
          v.playFromPositionAsync(targetMs).catch(() => {
            emit({ type: "buffer-error", bufferId, error: "play-failed" });
          });
        }
      }
    } else {
      v.pauseAsync().catch(() => {});
    }
  }, [state.playing, state.positionSecs, state.bindRevision, loadedRevision, url, bufferId, emit, isHls]);

  // ── HLS live-sync interval ──────────────────────────────────────────────
  // For HLS buffers that are active and playing, call playAsync() every
  // HLS_LIVE_SYNC_INTERVAL_MS to keep the player at the live edge.
  //
  // For live HLS: a device backgrounded, throttled, or recovering from a
  // brief signal drop can drift behind the live window. Without periodic
  // re-latching the player may exhaust the current DVR window and fire
  // didJustFinish even though the stream is still running.
  //
  // For VOD HLS: playAsync() on an already-playing video is a no-op
  // (it only asserts shouldPlay=true without seeking). Safe to call.
  //
  // For forceMuted instances (hero preview): re-assert isMuted + volume=0
  // immediately BEFORE each playAsync tick. playAsync() can briefly re-open
  // the ExoPlayer/AVPlayer audio pipeline even while the player is already
  // running; re-asserting mute here prevents that window from ever being
  // audible.
  useEffect(() => {
    if (!isHls || !state.playing || !state.active) return;
    const t = setInterval(() => {
      const v = ref.current;
      if (!v) return;
      if (forceMuted) {
        v.setIsMutedAsync(true).catch(() => {});
        v.setVolumeAsync(0).catch(() => {});
      }
      v.playAsync().catch(() => {});
    }, HLS_LIVE_SYNC_INTERVAL_MS);
    return () => clearInterval(t);
  }, [isHls, state.playing, state.active, forceMuted]);

  // Mute follows the adapter store (only the active buffer is audible),
  // unless `forceMuted` is set by the parent — used by the homepage hero
  // preview which must never play audio.
  const effectiveMuted = forceMuted || state.muted;
  // Synchronise native muted state whenever effectiveMuted changes.
  // For forceMuted instances (hero preview) we ALSO zero the volume as a
  // belt-and-suspenders guard: AVPlayer/ExoPlayer can have a brief window
  // between setIsMutedAsync resolving and the audio pipeline actually
  // going silent. volume=0 + isMuted=true together close that window on
  // every platform, and volume persists across play/pause transitions.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.setIsMutedAsync(effectiveMuted).catch(() => {});
    if (forceMuted) v.setVolumeAsync(0).catch(() => {});
  }, [effectiveMuted, forceMuted]);

  // Stable error handler — placed here (before the early return below) so it
  // unconditionally follows the Rules of Hooks.  Captures only stable refs.
  //
  // clearLoadTimeout is included alongside clearBufferingWatchdog because
  // ExoPlayer can fire onError BEFORE onLoad, leaving the 8-second load
  // timeout still running. When the error propagates through the FSM (→
  // RECOVERING_PRIMARY → new bindRevision), the bind-revision effect will arm
  // a fresh load timeout for the recovery bind. The old ghost timeout would
  // then fire ~8 s later against the new bind revision, emitting a second
  // buffer-error and interrupting an otherwise healthy recovery with an
  // extra RECOVERING_PRIMARY cycle. Cancel it in the same synchronous tick
  // as the error emission so the ghost can never fire.
  const handleError = useCallback(
    (error: unknown) => {
      clearBufferingWatchdog();
      clearLoadTimeout();
      // ── Pre-load guard ────────────────────────────────────────────────
      // When the FSM is already PLAYING (fsmIsWaiting=false) and this Video
      // element has not yet fired onLoad for the current bind revision
      // (loadedRevisionRef !== bindRevisionRef), the error is a transient
      // setup artefact from a freshly-mounted consumer — e.g. the Player
      // screen opening while the Hero singleton session is streaming.
      // ExoPlayer can emit a brief onError during codec negotiation or the
      // initial manifest probe, even for a URL that loads successfully a
      // moment later.  Propagating this error drives the shared FSM into
      // RECOVERING_PRIMARY, interrupting the Hero's live video.
      //
      // Safe to suppress: the load-timeout watchdog (armed only when
      // fsmIsWaiting=true) will catch genuinely broken sources.  Once
      // onLoad fires (loadedRevisionRef catches up), all subsequent errors
      // are from a running pipeline and must be propagated.
      if (!fsmIsWaitingRef.current && loadedRevisionRef.current !== bindRevisionRef.current) return;
      emit({
        type: "buffer-error",
        bufferId,
        error: typeof error === "string" ? error : "media-error",
      });
    },
    [clearBufferingWatchdog, clearLoadTimeout, emit, bufferId],
  );

  if (!url) {
    return <View style={[styles.video, { zIndex: state.active ? 2 : 1 }]} />;
  }

  // Build the expo-av source object.
  //
  // For HLS sources, `overrideFileExtensionWithValue: 'm3u8'` guarantees
  // Android ExoPlayer recognises the content type as HLS even when the URL
  // passes through a proxy path that doesn't end in `.m3u8` (e.g.
  // `/api/hls/videoId/v0/playlist.m3u8?token=…` with a long query string).
  // Without the hint, some ExoPlayer 2.x builds fall back to progressive
  // download mode, causing manifest parse failures or segment looping that
  // produce a permanently black video surface while audio continues.
  //
  // For MP4 sources (mp4_faststart or mp4_raw), `overrideFileExtensionWithValue:
  // 'mp4'` is included for the same reason: when the URL passes through the
  // media-proxy (e.g. `/api/v1/media-proxy?url=…`) the path has no extension,
  // and ExoPlayer may mis-classify the stream.  For local upload URLs that
  // already end in `.mp4` the hint is a no-op; for proxied URLs it prevents
  // ExoPlayer falling back to a progressive streaming mode that disables
  // Range-based seeking and can produce distorted or blurred frames because
  // the moov atom is fetched out of sequence.
  const avSource = isHls
    ? { uri: url, overrideFileExtensionWithValue: "m3u8" as const }
    : { uri: url, overrideFileExtensionWithValue: "mp4" as const };

  return (
    <Video
      ref={ref}
      source={avSource}
      style={[styles.video, { zIndex: state.active ? 2 : 1 }]}
      resizeMode={ResizeMode.CONTAIN}
      shouldPlay={false}
      isMuted={effectiveMuted}
      volume={forceMuted ? 0 : 1}
      progressUpdateIntervalMillis={500}
      // @ts-expect-error allowsExternalPlayback was removed from expo-av
      // 16.x types but the underlying AVPlayer prop is still valid on iOS
      // (AirPlay / HDMI output). Keeping it intentionally.
      allowsExternalPlayback={true}
      onLoad={(loadStatus) => {
        // Capture the actual encoded duration from the native media pipeline.
        // This is the ground-truth duration — independent of the server's
        // durationSecs DB field which may be inaccurate for newly-uploaded or
        // mis-probed videos. For live HLS streams, durationMillis is either
        // undefined or Infinity (no fixed duration).
        if (loadStatus.isLoaded) {
          const dur = loadStatus.durationMillis;
          actualDurationMsRef.current =
            dur !== undefined && isFinite(dur) && dur > 0 ? dur : null;
        }
        // Record the URL expo-av loaded so the bind-revision reset effect
        // can fast-path same-URL recovery rebinds (RECOVERING_PRIMARY with
        // the same item) without waiting for an onLoad that will never come.
        lastLoadedUrlRef.current = url;
        // Mark this bind revision as loaded so the play useEffect can
        // proceed (it guards on loadedRevision === state.bindRevision).
        setLoadedRevision(state.bindRevision);
        if (lastReportedRevision.current !== state.bindRevision) {
          lastReportedRevision.current = state.bindRevision;
          emit({ type: "buffer-ready", bufferId });
        }
        // Source loaded successfully — disarm both watchdogs.
        clearBufferingWatchdog();
        clearLoadTimeout();
      }}
      onReadyForDisplay={() => {
        // Android/ExoPlayer fires this when the first VIDEO FRAME is ready
        // to render — which can be later than onLoad (metadata ready) on
        // some Android devices. On iOS/AVPlayer the two events fire together.
        //
        // Using this as a secondary buffer-ready signal ensures the FSM's
        // PLAYING transition (and overlay dismissal) coincides with actual
        // video being visible, not just audio being audible. The
        // lastReportedRevision guard prevents double-firing: if onLoad
        // already reported buffer-ready for this revision, this is a no-op.
        //
        // We also do three defensive bookkeeping actions here:
        //
        //   1. Update lastLoadedUrlRef: on some ExoPlayer builds the React
        //      bridge delivers onReadyForDisplay before flushing onLoad on
        //      the same frame (frame-first delivery order). Without this
        //      update, the next same-URL recovery rebind would see a stale
        //      lastLoadedUrlRef and fall through to the full reset path,
        //      waiting for an onLoad that will never come.
        //
        //   2. Clear load timeout: first-frame render proves ExoPlayer is
        //      healthy — there is no need to wait for the load timeout to
        //      fire a spurious buffer-error that would trigger an unnecessary
        //      RECOVERING_PRIMARY cycle.
        //
        //   3. Clear buffering watchdog: first-frame render also means
        //      ExoPlayer is not stalled (isBuffering:true state). Disarming
        //      prevents a late watchdog firing after healthy startup.
        //
        //   4. Notify parent via onVideoReady: the parent tracks this to
        //      keep the poster visible until actual pixels appear, eliminating
        //      the 100–500 ms black flash between FSM→PLAYING and first frame.
        if (url) lastLoadedUrlRef.current = url;
        clearLoadTimeout();
        clearBufferingWatchdog();
        setLoadedRevision(state.bindRevision);
        if (lastReportedRevision.current !== state.bindRevision) {
          lastReportedRevision.current = state.bindRevision;
          emit({ type: "buffer-ready", bufferId });
        }
        onVideoReady?.();
      }}
      onPlaybackStatusUpdate={(status: AVPlaybackStatus) => {
        if (!status.isLoaded) {
          if (status.error) {
            // Pre-load guard: mirror of the handleError guard above.  If the
            // FSM is already PLAYING and this Video hasn't completed onLoad
            // for the current bind revision, suppress the error so a freshly-
            // mounted consumer (Player screen opening while Hero is streaming)
            // doesn't trigger a spurious RECOVERING_PRIMARY cycle.
            const isPreLoadError =
              !fsmIsWaitingRef.current &&
              loadedRevisionRef.current !== bindRevisionRef.current;
            if (!isPreLoadError) {
              // Cancel the load timeout in the same synchronous tick as the
              // error emission to prevent a ghost double-fire: ExoPlayer can
              // report an error here (isLoaded=false path) AND also via
              // onError, both before onLoad has fired. If the load timeout
              // were left running, it would emit a second buffer-error ~8 s
              // later against the recovery bind that the FSM already set up,
              // triggering an extra RECOVERING_PRIMARY cycle.
              clearLoadTimeout();
              emit({ type: "buffer-error", bufferId, error: status.error });
            }
          }
          clearBufferingWatchdog();
          return;
        }
        // Track current playhead position for the drift-correction seek guard
        // in the play effect. positionMillis is reported every 500 ms
        // (progressUpdateIntervalMillis). We only record values > 0 to avoid
        // overwriting a valid position with the initial 0 ms before the first
        // segment arrives or after a seek completes.
        if (typeof status.positionMillis === "number" && status.positionMillis > 0) {
          playheadMsRef.current = status.positionMillis;
        }

        // ── Near-end preload trigger ──────────────────────────────────────────
        // Client-side complement to the server's 120 s `preload` frame.
        //
        // The machine already responds to server-sent preload frames (see
        // `onPreload` in machine.ts) by binding the inactive buffer to the next
        // queue item ~120 s before the current one ends. However, if the
        // transport is reconnecting, the server's preload frame arrives late, or
        // the snapshot is cached, this 120 s signal can be absent — leaving the
        // inactive buffer unloaded right up until the active buffer fires
        // `buffer-ended`, producing a visible black-screen gap between items.
        //
        // When the active buffer's remaining time enters the 120 s window, emit
        // `buffer-near-end` to the machine. The machine's `onBufferNearEnd()`
        // will bind the inactive buffer to `server.next` if it isn't already
        // loaded — guaranteeing the handoff buffer is warming regardless of
        // whether the server's preload frame arrived.
        //
        // Guards:
        //   - `state.active`: only the ACTIVE buffer drives preloads. The
        //     inactive buffer loading in the background must NOT emit near-end —
        //     the machine would misinterpret it as the active content ending.
        //   - `!suppressEventsRef.current`: suppressed (view-only) consumers
        //     (hero preview while fullscreen is open) must not interfere with
        //     the shared FSM owned by the primary consumer.
        //   - `nearEndReportedRef.current`: fire once per bind revision only.
        //     The 500 ms status cadence would otherwise flood the machine with
        //     identical events for the entire 120 s preload window.
        //   - Finite `durationMillis > 0`: live HLS has `durationMillis = null`
        //     or `Infinity`. Near-end detection is meaningless for live streams
        //     whose playlist has no fixed end point — the server manages live
        //     transitions via explicit snapshot frames.
        if (
          status.isLoaded &&
          state.active &&
          !suppressEventsRef.current &&
          !nearEndReportedRef.current &&
          typeof status.durationMillis === "number" &&
          isFinite(status.durationMillis) &&
          status.durationMillis > 0 &&
          typeof status.positionMillis === "number" &&
          status.positionMillis > 0
        ) {
          const remainingMs = status.durationMillis - status.positionMillis;
          if (remainingMs > 0 && remainingMs < NEAR_END_PRELOAD_LEAD_MS) {
            nearEndReportedRef.current = true;
            emit({ type: "buffer-near-end", bufferId });
          }
        }

        // ── isPlaying fast-path (Android ExoPlayer audio-before-onLoad fix) ──
        // Android ExoPlayer sometimes starts playing audio before expo-av's
        // React bridge fires the `onLoad` callback. In that case `isPlaying`
        // becomes true and positionMillis starts advancing while the FSM is
        // still in PREPARING_ACTIVE — leaving "Tuning in…" on screen even
        // though the stream is actively outputting media.
        //
        // If the player is actively playing (not buffering, positionMillis > 0)
        // but buffer-ready has never been reported for this bind revision, fire
        // it now. This is safe because:
        //   1. `status.isLoaded` guarantees ExoPlayer has reached STATE_READY.
        //   2. `status.isPlaying && !status.isBuffering` guarantees it is
        //      producing frames / audio, not just pre-rolling in a paused state.
        //   3. The `lastReportedRevision` guard prevents double-firing —
        //      if onLoad already sent buffer-ready this branch is a no-op.
        //
        // Effect: the "Tuning in…" overlay clears as soon as ExoPlayer starts
        // playing, even if the React bridge delivery of onLoad is delayed.
        if (
          status.isLoaded &&
          status.isPlaying &&
          !status.isBuffering &&
          lastReportedRevision.current !== state.bindRevision
        ) {
          if (url) lastLoadedUrlRef.current = url;
          setLoadedRevision(state.bindRevision);
          lastReportedRevision.current = state.bindRevision;
          clearLoadTimeout();
          emit({ type: "buffer-ready", bufferId });
        }

        // ── First-frame readiness fallback (poster-lift safety net) ──────────
        // `onReadyForDisplay` is the PRIMARY signal that lifts the poster
        // (sets videoReady=true in the parent). But it is unreliable across the
        // expo-av matrix: some ExoPlayer builds never fire it, and others fire
        // it *before* onLoad where the buffer-ready dedup guard above swallows
        // the onVideoReady call. In both cases videoReady would stay false
        // forever, freezing the poster over actually-playing video — or, when
        // the item has no thumbnail, leaving a bare black screen.
        //
        // When the active buffer is genuinely producing frames
        // (isLoaded + isPlaying + !isBuffering) the first frame is on screen by
        // definition, so lift the poster regardless of which buffer-ready path
        // fired. setVideoReady(true) in the parent is idempotent, so calling
        // this on the 500 ms status cadence is cheap and React bails out once
        // the state is already true.
        if (status.isLoaded && status.isPlaying && !status.isBuffering) {
          onVideoReady?.();
        }

        // ── Hero preview permanent-mute enforcement ──────────────────────
        // 500 ms status ticks give us a periodic check: if the native player
        // has somehow drifted to unmuted (audio session reset by OS, focus
        // change, or any brief playAsync race that slipped through the
        // pre-call guards above), snap it back to muted + volume=0
        // immediately. This is the last line of defence — the earlier guards
        // (isMuted prop, setIsMutedAsync in the muting effect, pre-call
        // setIsMutedAsync in the play effect and HLS live-sync interval)
        // should prevent the drift from happening; this check catches any
        // that still slips through on unusual ExoPlayer builds.
        if (forceMuted && status.isLoaded && status.isMuted === false) {
          ref.current?.setIsMutedAsync(true).catch(() => {});
          ref.current?.setVolumeAsync(0).catch(() => {});
        }

        if (status.didJustFinish && (status.positionMillis ?? 0) > 0) {
          clearBufferingWatchdog();

          // ── HLS quick-finish guard ──────────────────────────────────
          // For HLS sources on the active buffer, didJustFinish can fire
          // spuriously in two situations:
          //
          //   1. VOD HLS — seek past the encoded end: positionSecs from the
          //      machine exceeds the actual video duration (server durationSecs
          //      wrong). AVPlayer snaps to the last frame and fires
          //      didJustFinish within ~1 s of playFromPositionAsync.
          //
          //   2. Live HLS — DVR window exhausted: player reached the end of
          //      fetched segments before the next manifest refresh arrived.
          //
          // In both cases the correct action is to retry from position 0
          // (safe in-bounds start) rather than reporting buffer-ended, which
          // would trigger HANDOFF → rebind → larger positionSecs → worse loop.
          //
          // After HLS_MAX_QUICK_FINISH_RETRIES consecutive quick-finishes we
          // escalate to buffer-ended so the FSM can skip a genuinely broken
          // source (corrupt manifest / permanently empty DVR) instead of
          // looping forever.
          if (isHls && state.active) {
            const playDurationMs =
              playStartMsRef.current !== null
                ? Date.now() - playStartMsRef.current
                : Infinity;
            // Use the manifest-driven threshold (updated async after URL bind)
            // so segments with a long EXT-X-TARGETDURATION don't produce false
            // "quick finish" positives during the first segment's playback.
            if (playDurationMs < quickFinishThresholdMsRef.current) {
              hlsQuickFinishCountRef.current += 1;
              if (hlsQuickFinishCountRef.current > HLS_MAX_QUICK_FINISH_RETRIES) {
                // Exhausted retries — escalate to buffer-ended.
                hlsQuickFinishCountRef.current = 0;
                emit({ type: "buffer-ended", bufferId });
              } else {
                // Retry: brief delay gives the HLS manifest time to refresh
                // and avoids a tight CPU-spin retry loop.
                //
                // Live HLS: use playAsync() — calling playFromPositionAsync(0)
                // on a live stream either fails (no seekable range in a
                // dynamic playlist) or snaps to the oldest buffered segment,
                // trailing further behind the live edge on every retry.
                //
                // VOD HLS: playFromPositionAsync(0) restarts from the
                // beginning. On the next real-time snapshot the machine will
                // issue a fresh drift-corrected seek to the correct timeline
                // position once the video is loaded.
                const actualMsRetry = actualDurationMsRef.current;
                const isLiveRetry = actualMsRetry === null || !isFinite(actualMsRetry) || actualMsRetry <= 0;
                playStartMsRef.current = Date.now();
                // Store the timer handle so the bindRevision reset effect can
                // cancel it if the source changes before the 1 s delay fires.
                // Without this, the retry would call playFromPositionAsync(0)
                // on the NEW source, seeking it back to position 0.
                quickFinishRetryTimerRef.current = setTimeout(() => {
                  quickFinishRetryTimerRef.current = null;
                  const retryPromise = isLiveRetry
                    ? ref.current?.playAsync()
                    : ref.current?.playFromPositionAsync(0);
                  retryPromise?.catch(() => {
                    emit({
                      type: "buffer-error",
                      bufferId,
                      error: "hls-retry-failed",
                    });
                  });
                }, 1_000);
              }
              return;
            }
            // Played long enough — genuine natural end. Reset quick-finish
            // counter and fall through to the normal buffer-ended path.
            hlsQuickFinishCountRef.current = 0;
          }

          emit({ type: "buffer-ended", bufferId });
          return;
        }
        // ── isBuffering watchdog ──────────────────────────────────────
        // Only arm the watchdog when this buffer is the active one AND the
        // adapter wants it to be playing. Inactive preload buffers buffering
        // in the background is expected and desirable — don't interfere.
        // suppressEvents: do NOT arm the watchdog on view-only instances —
        // their isBuffering state (often true while backgrounded) must never
        // trigger FSM recovery for the primary player instance.
        //
        // loadedRevision guard: do NOT arm when this Video element has not
        // yet fired onLoad for the current bind revision. A freshly-mounted
        // Video (e.g. Player screen opening while Hero's singleton session
        // was already PLAYING) starts in isBuffering=true while the FSM is
        // PLAYING — the old fsmIsWaitingRef.current guard suppressed the
        // watchdog here correctly, but it also prevented the watchdog from
        // arming during genuine mid-stream stalls (network drop during
        // PLAYING), leaving the player frozen indefinitely with no recovery
        // path. Using loadedRevisionRef.current === bindRevisionRef.current
        // instead distinguishes the two cases:
        //
        //   • Fresh mount (loadedRevision=-1 ≠ bindRevision=N): Video has
        //     not yet completed onLoad — isBuffering=true is expected and
        //     harmless. Do NOT arm the watchdog.
        //
        //   • Genuine stall (loadedRevision=N = bindRevision=N): Video
        //     previously loaded this exact source, so isBuffering=true is
        //     a real network stall. ARM the watchdog so the FSM can recover.
        //
        // This correctly handles all FSM states: PLAYING, RECOVERING_PRIMARY
        // (same-URL fast-path immediately sets loadedRevision=bindRevision),
        // and LIVE_OVERRIDE_ACTIVE. The load-timeout watchdog (still gated
        // on fsmIsWaitingRef) remains the catch-all for silent ExoPlayer
        // failures before onLoad ever fires.
        if (status.isBuffering && state.playing && state.active && !suppressEventsRef.current && loadedRevisionRef.current === bindRevisionRef.current) {
          if (!bufferingWatchdogRef.current) {
            bufferingWatchdogRef.current = setTimeout(() => {
              bufferingWatchdogRef.current = null;
              emit({
                type: "buffer-error",
                bufferId,
                error: "buffering-timeout",
              });
            }, BUFFERING_STALL_THRESHOLD_MS);
          }
        } else {
          // Not buffering, not the active playing buffer, suppressed, or
          // Video not yet loaded for the current bind revision — disarm.
          clearBufferingWatchdog();
        }
      }}
      onError={handleVideoError}
    />
  );
});

// ── Midnight Prayers channel switching (module-level singleton) ───────────────
//
// All V2PlayerContainer instances that share the same mainBaseUrl (e.g. the
// Hero preview on the home screen and the full Player screen) subscribe to a
// single shared state object.  This guarantees that the channel switch from
// /api/broadcast-v2 → /api/midnight-prayers fires for EVERY consumer at the
// exact same moment so they all keep using the same singleton FSM session key
// without the brief desync window that the previous per-instance approach
// could produce (Hero switching before Player, or vice versa, during the 60 s
// poll window).

interface MPScheduleConfig {
  enabled: boolean;
  startHour: number;
  endHour: number;
  timezone?: string;
}

/**
 * Returns the local hour (0–23) in the given IANA timezone using
 * Intl.DateTimeFormat. Falls back to device local time on unsupported TZ.
 * React Native's Hermes engine supports Intl on Android ≥26 / iOS ≥13.
 */
function getLocalHourInTz(tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    return parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10) % 24;
  } catch {
    return new Date().getHours();
  }
}

/**
 * Returns true when the current station-local time falls within the
 * midnight prayer window [startHour, endHour).
 *
 * Uses the server-configured IANA timezone (cfg.timezone) so that all
 * viewers worldwide see the switch at the same moment regardless of their
 * device's local timezone. This mirrors the server-side isWindowActive()
 * check in window-utils.ts — both must stay in sync.
 */
function isInMpWindow(cfg: MPScheduleConfig): boolean {
  if (!cfg.enabled) return false;
  const tz = cfg.timezone ?? "Africa/Lagos";
  const h = getLocalHourInTz(tz);
  return cfg.endHour > cfg.startHour
    ? h >= cfg.startHour && h < cfg.endHour
    : h >= cfg.startHour || h < cfg.endHour;
}

interface _MpSingleton {
  cfg: MPScheduleConfig | null;
  inWindow: boolean;
  listeners: Set<() => void>;
  fetchInterval: ReturnType<typeof setInterval>;
  windowInterval: ReturnType<typeof setInterval> | null;
}

const _mpSingletons = new Map<string, _MpSingleton>();

function _getOrCreateMpSingleton(mainBaseUrl: string): _MpSingleton {
  const existing = _mpSingletons.get(mainBaseUrl);
  if (existing) return existing;

  const singleton: _MpSingleton = {
    cfg: null,
    inWindow: false,
    listeners: new Set(),
    // Placeholder — overwritten immediately below before any async work.
    fetchInterval: undefined as unknown as ReturnType<typeof setInterval>,
    windowInterval: null,
  };
  _mpSingletons.set(mainBaseUrl, singleton);

  const notifyAll = () => singleton.listeners.forEach((fn) => fn());

  const checkWindow = () => {
    if (!singleton.cfg) return;
    const next = isInMpWindow(singleton.cfg);
    if (next !== singleton.inWindow) {
      singleton.inWindow = next;
      notifyAll();
    }
  };

  const fetchConfig = () => {
    const apiOrigin = mainBaseUrl.replace(/\/api\/broadcast-v2.*/, "");
    fetch(`${apiOrigin}/api/midnight-prayers/config`, {
      signal: AbortSignal.timeout(5_000),
    })
      .then((r) => (r.ok ? (r.json() as Promise<MPScheduleConfig>) : null))
      .then((data) => {
        if (!data) return;
        singleton.cfg = data;
        // Start the per-minute window check once we have a valid config.
        if (!singleton.windowInterval) {
          singleton.windowInterval = setInterval(checkWindow, 60_000);
        }
        const next = isInMpWindow(data);
        if (next !== singleton.inWindow) {
          singleton.inWindow = next;
          notifyAll();
        }
      })
      .catch(() => { /* stay on main channel */ });
  };

  fetchConfig();
  singleton.fetchInterval = setInterval(fetchConfig, 60_000);

  return singleton;
}

function useMidnightPrayersSwitch(mainBaseUrl: string): string {
  // Trigger a re-render whenever the singleton broadcasts a change.
  const [, rerender] = useState(0);

  useEffect(() => {
    const singleton = _getOrCreateMpSingleton(mainBaseUrl);
    const notify = () => rerender((n) => n + 1);
    singleton.listeners.add(notify);
    return () => {
      singleton.listeners.delete(notify);
      // When the last consumer detaches, tear down the singleton's timers
      // and remove the entry from the map.  The next mount will re-create
      // it fresh (another fetchConfig() call + fresh intervals), so there
      // is no observable difference in behaviour — only the intervals are
      // cleaned up instead of leaking forever across long app sessions where
      // the user navigates away from every surface that uses this hook.
      if (singleton.listeners.size === 0) {
        clearInterval(singleton.fetchInterval);
        if (singleton.windowInterval !== null) {
          clearInterval(singleton.windowInterval);
          singleton.windowInterval = null;
        }
        _mpSingletons.delete(mainBaseUrl);
      }
    };
  }, [mainBaseUrl]);

  const singleton = _mpSingletons.get(mainBaseUrl);
  if (!singleton?.cfg || !singleton.inWindow) return mainBaseUrl;
  return mainBaseUrl.replace(/\/api\/broadcast-v2.*/, "/api/midnight-prayers");
}

// ── Component ─────────────────────────────────────────────────────────────────

export function V2PlayerContainer({
  baseUrl,
  channelId: _channelId = "main",
  onFatal,
  muted = false,
  minimal = false,
  suppressEvents = false,
  suppressEventsOverride,
  isInPip,
}: Props) {
  void _channelId;
  const effectiveBaseUrl = useMidnightPrayersSwitch(baseUrl);

  // ── Hydration gate ────────────────────────────────────────────────────────
  // Defer session creation until AsyncStorage hydration has completed.
  // On a cold-start deep-link the transport's initial `resume {sequence}` WS
  // message uses `lastSequence=0` when storage isn't hydrated yet, producing a
  // spurious BOOTSTRAP → re-request cycle visible to the user as an extra
  // loading spinner.  Gating `enabled` on `storageReady` ensures the session
  // (and its WebSocket) are created AFTER the persisted sequence is available.
  // Hydration typically completes in < 30 ms; `isHydrationDone()` makes the
  // initial state synchronously `true` for navigations to the player screen
  // after the first mount (avoiding any flash).
  const [storageReady, setStorageReady] = useState<boolean>(() => isHydrationDone());
  useEffect(() => {
    if (storageReady) return;
    let mounted = true;
    hydrationReady
      .then(() => { if (mounted) setStorageReady(true); })
      .catch(() => { if (mounted) setStorageReady(true); });
    return () => { mounted = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Audio session gate: ensure the root layout's Audio.setAudioModeAsync has
  // completed before the player session starts. On cold-start deep-links the
  // player screen can mount before the layout's useEffect fires; starting
  // playback before the audio session is configured causes silent failures
  // or "audio session already active" errors on iOS.
  const [audioSessionReady, setAudioSessionReady] = useState(false);
  useEffect(() => {
    let mounted = true;
    waitForAudioSession()
      .then(() => { if (mounted) setAudioSessionReady(true); })
      .catch(() => { if (mounted) setAudioSessionReady(true); });
    return () => { mounted = false; };
  }, []);

  const { snapshot, connected, buffers, reportBufferEvent, forceReconnect, forceRebind, notifyOnline } =
    useV2BroadcastNative({ baseUrl: effectiveBaseUrl, enabled: storageReady && audioSessionReady });

  // Network context — drives network-aware banner text and immediate
  // reconnect on signal recovery (complements the AppState-based nudge).
  const { isOnline, justRecovered } = useNetworkContext();

  const fatalFiredRef = useRef(false);
  // Track the previous FSM state so we only fire onFatal on a genuine
  // transition INTO FATAL (prevState !== "FATAL" → "FATAL"), not when the
  // component mounts while the singleton FSM is already in FATAL.
  //
  // Without this, the "FATAL navigation loop" occurs:
  //   1. Broadcast goes down → FSM enters FATAL → user is navigated to Home.
  //   2. User taps "Watch Now" again → Player screen mounts.
  //   3. FSM is still in FATAL (auto-retry hasn't fired yet — 30–60 s backoff).
  //   4. Effect fires immediately on mount → onFatal → router.back() before
  //      the FATAL overlay is visible or the auto-retry timer can fire.
  //   5. Loop: user can never stay on Player screen until broadcast resumes.
  //
  // With prevSnapshotStateRef initialised to snapshot.state at render time:
  //   • Mount-with-FATAL: prevState = "FATAL" → guard fails → no router.back().
  //     The FATAL overlay renders; the user can tap "Reconnect" or wait for
  //     the 30-s auto-retry to restore the stream.
  //   • Genuine in-session FATAL: prevState = "PLAYING"/"SYNCING"/… → guard
  //     passes → onFatal fires → router.back() (correct, stream truly lost).
  const prevSnapshotStateRef = useRef(snapshot.state);
  useEffect(() => {
    const prevState = prevSnapshotStateRef.current;
    prevSnapshotStateRef.current = snapshot.state;
    if (snapshot.state === "FATAL" && prevState !== "FATAL" && !fatalFiredRef.current) {
      fatalFiredRef.current = true;
      // Only the PRIMARY driver fires onFatal.  Suppressed instances (inline
      // player muted while fullscreen Modal is open) and minimal instances
      // (Hero preview) share the same singleton session and therefore see the
      // same FATAL state, but must NOT fire onFatal independently — doing so
      // causes two router.back() calls: one from the fullscreen player (correct)
      // and a second from the suppressed inline player (navigates one screen
      // too far, landing on the wrong tab or dismissing the app entirely).
      if (!suppressEvents && !minimal) onFatal?.();
    }
    if (snapshot.state !== "FATAL") fatalFiredRef.current = false;
  }, [snapshot.state, onFatal, suppressEvents, minimal]);

  // RN AppState bridge: when the app returns to foreground, force a fresh
  // WS handshake. iOS/Android suspend the JS runtime when backgrounded,
  // and the OS may drop the underlying socket silently — the JS-side
  // WebSocket object can stay in OPEN state for minutes after wake, never
  // emitting `onclose`. Without this nudge, the player would sit on a dead
  // socket and the queue/now-playing would freeze until the user does
  // something that triggers a network round-trip.
  useEffect(() => {
    let last = AppState.currentState;
    let mounted = true;
    const sub = AppState.addEventListener("change", (next) => {
      // Belt-and-braces guard: although sub.remove() in the cleanup below
      // unregisters this handler synchronously on unmount, some RN versions
      // can still flush a queued AppState change event after removal. The
      // mounted flag ensures we never poke transport methods on an already
      // torn-down hook, eliminating "setState on unmounted component" noise
      // and the associated WS keep-alive leak.
      if (!mounted) return;
      if (last !== "active" && next === "active") {
        notifyOnline();
        forceReconnect();
      }
      last = next;
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, [forceReconnect, notifyOnline]);

  // Network recovery bridge: when NetworkContext detects the device has
  // regained connectivity (justRecovered flips true for ~2.5 s), immediately
  // reconnect the transport and notify the FSM. This fires even when the app
  // stays in the foreground during a brief signal drop — the AppState handler
  // above only catches foreground re-entry, not mid-session recovery.
  // Also flushes any buffered telemetry events that were queued while offline.
  useEffect(() => {
    if (justRecovered) {
      notifyOnline();
      forceReconnect();
      // Flush buffered telemetry events accumulated while the device was offline.
      if (!suppressEvents) {
        const base = effectiveBaseUrl.replace(/\/api\/broadcast-v2$/, "");
        void flushTelemetryBuffer(base);
      }
    }
  }, [justRecovered, notifyOnline, forceReconnect, suppressEvents, effectiveBaseUrl]);

  // ── Playback telemetry ────────────────────────────────────────────────────
  // Report a heartbeat to /api/broadcast/playback-telemetry every 60 s while
  // the player is in the PLAYING state.  The server aggregates these signals
  // into a stall-rate and viewer-quality dashboard.
  //
  // expo-av does not expose per-frame decoded/dropped counts on React Native,
  // so we approximate:
  //   decoded  = 60 s × 30 fps  (nominal frame count for the window)
  //   dropped  = 0              (we track stalls separately via FSM events)
  //
  // This is intentionally best-effort: the interval is skipped on non-primary
  // consumers (suppressEvents=true) and clears on unmount, so there is no
  // double-counting risk from the Hero preview running alongside the Player.
  const snapshotStateRef = useRef(snapshot.state);
  snapshotStateRef.current = snapshot.state;

  useEffect(() => {
    if (suppressEvents) return; // Only the primary driver reports telemetry.

    const INTERVAL_MS = 60_000;
    const id = setInterval(() => {
      if (snapshotStateRef.current === "PLAYING") {
        // Enqueue into the offline-resilient buffer so telemetry events
        // are preserved and retried even when the device is temporarily
        // offline. The buffer flushes automatically on network recovery
        // (see the justRecovered effect below). When the device IS online
        // the buffer sends immediately on the next flush cycle.
        enqueueTelemetry({ platform: "mobile", decoded: 60 * 30, dropped: 0 });
        // Also attempt an immediate send; this is a no-op if offline —
        // the event stays buffered until flushTelemetryBuffer() is called.
        const base = effectiveBaseUrl.replace(/\/api\/broadcast-v2$/, "");
        void flushTelemetryBuffer(base);
      }
    }, INTERVAL_MS);

    return () => clearInterval(id);
  }, [suppressEvents, effectiveBaseUrl]);

  const server = snapshot.lastServerSnapshot;

  // ── Loading phase tracker ─────────────────────────────────────────────────
  // Tracks how long the player has been in a transient loading state and
  // advances a `loadingPhase` counter every PHASE_STEP_MS. This drives
  // contextual message rotation: early phases show specific status text;
  // later phases shift to "still working" language so the user knows we
  // haven't frozen. The counter resets to 0 whenever we leave a loading state.
  const PHASE_STEP_MS = 5_000;
  const [loadingPhase, setLoadingPhase] = useState(0);

  // ── FATAL retry countdown ─────────────────────────────────────────────────
  // Ticks every second while in FATAL state so the overlay shows the exact
  // seconds remaining until the next auto-retry, matching the server-side
  // exponential backoff schedule (30 s → 60 s → 120 s → 240 s max).
  // Mirrors the TV LiveBroadcastV2 implementation.
  const [fatalRetrySecsLeft, setFatalRetrySecsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (snapshot.state !== "FATAL" || snapshot.fatalEnteredAtMs == null) {
      setFatalRetrySecsLeft(null);
      return;
    }
    const backoffMs = Math.min(
      30_000 * Math.pow(2, Math.max(0, (snapshot.fatalAttemptCount ?? 1) - 1)),
      240_000,
    );
    const tick = () => {
      const remaining = backoffMs - (Date.now() - snapshot.fatalEnteredAtMs!);
      setFatalRetrySecsLeft(Math.max(0, Math.ceil(remaining / 1_000)));
    };
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [snapshot.state, snapshot.fatalEnteredAtMs, snapshot.fatalAttemptCount]);
  const phaseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isLoadingState =
    snapshot.state === "BOOTSTRAP" ||
    snapshot.state === "SYNCING" ||
    snapshot.state === "PREPARING_ACTIVE" ||
    snapshot.state === "RECOVERING_PRIMARY" ||
    snapshot.state === "RECOVERING_FAILOVER" ||
    snapshot.state === "SKIP_PENDING" ||
    snapshot.state === "OFFLINE_HOLD" ||
    // LIVE_OVERRIDE_ACTIVE: phase timer runs during override loading so the
    // loading overlay message can advance through phases ("Switching to Live
    // Override" → "Loading Override…" → "Please wait…").  YouTube overrides
    // use a static overlay that ignores loadingPhase so the timer is harmless.
    snapshot.state === "LIVE_OVERRIDE_ACTIVE";

  useEffect(() => {
    if (!isLoadingState) {
      setLoadingPhase(0);
      if (phaseTimerRef.current) {
        clearInterval(phaseTimerRef.current);
        phaseTimerRef.current = null;
      }
      return;
    }
    setLoadingPhase(0);
    phaseTimerRef.current = setInterval(() => {
      setLoadingPhase((p) => p + 1);
    }, PHASE_STEP_MS);
    return () => {
      if (phaseTimerRef.current) {
        clearInterval(phaseTimerRef.current);
        phaseTimerRef.current = null;
      }
    };
  // snapshot.state is the only meaningful dependency for reset/start
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.state]);

  // ── Active buffer identity ────────────────────────────────────────────────
  // Derived early (before overlayContent useMemo) because both the overlay
  // and the first-frame readiness gate need it.
  const activeBufferId = buffers.A.active ? "A" : "B";

  // ── YouTube-override detection ────────────────────────────────────────────
  // When the admin activates a YouTube live override (or the ytShuffle fallback
  // fires), the machine transitions to LIVE_OVERRIDE_ACTIVE and binds the
  // V2Override (kind: "youtube") to the active buffer. expo-av cannot play
  // YouTube URLs — attempting to load one causes onError to fire immediately,
  // triggering RECOVERING_PRIMARY → RECOVERING_FAILOVER → SKIP_PENDING → FATAL.
  //
  // Two detection paths — both must agree before we suppress expo-av:
  //
  //   1. Buffer-item path (reliable once FSM has bound the V2Override):
  //      checks buffers[activeBufferId].item directly.
  //
  //   2. Server-snapshot path (reliable immediately on state entry, BEFORE the
  //      FSM has had a chance to bind the item): checks server.override.kind.
  //      This is the critical fix for ytShuffle — without it, expo-av races to
  //      load the YouTube URL during the window between state entry and item
  //      binding, producing the native loading spinner indefinitely.
  //
  // Using OR so whichever path resolves first wins.
  const activeItem = buffers[activeBufferId].item;
  const isYouTubeOverride =
    snapshot.state === "LIVE_OVERRIDE_ACTIVE" &&
    (
      // Path 1: buffer item is already bound as a V2Override with kind "youtube"
      (activeItem !== null &&
       !("source" in activeItem) &&
       activeItem.kind === "youtube") ||
      // Path 2: server snapshot already reports youtube override — use this
      // immediately so expo-av never attempts to load the YouTube URL
      server?.override?.kind === "youtube"
    );

  // ── PiP buffer-swap re-entry (Android) ───────────────────────────────
  // When the broadcast performs an A/B handoff (item N ends → item N+1
  // starts), the previously-inactive buffer becomes active.  On Android,
  // PiP mode shows the entire Activity view hierarchy in a mini window —
  // the active buffer (higher zIndex) should naturally appear on top.
  // However, on some Android versions the system caches the surface ID
  // that was on top when PiP was first entered and doesn't auto-refresh it
  // during a handoff, leaving the PiP window frozen on the old buffer's
  // last frame while the audio from the new item plays.
  //
  // Calling `updatePipParams` (→ setPictureInPictureParams) after an A/B
  // swap signals Android to re-capture the current activity window content,
  // refreshing the PiP surface to reflect the new active buffer.
  // On API < 31 this is still a safe no-op — `setPictureInPictureParams`
  // is ignored before the seamless-resize API landed.
  const prevActiveBufferIdRef = useRef<"A" | "B">(activeBufferId);
  useEffect(() => {
    if (prevActiveBufferIdRef.current === activeBufferId) return;
    prevActiveBufferIdRef.current = activeBufferId;
    if (!isInPictureInPictureMode()) return;
    // Refresh Android PiP window to the new active buffer.
    // Pass null title + true isPlaying — this is a surface-refresh call only,
    // not a full state sync. The hook's isPlaying effect handles icon accuracy.
    updatePipParams(16, 9, true, false, null, true).catch(() => {});
  }, [activeBufferId]);

  // ── YouTube-override-in-PiP exit ──────────────────────────────────────
  // When a YouTube live override starts while the app is in a PiP window,
  // the native HLS buffers have no content to display (YouTube overrides
  // are excluded from expo-av) and the PiP window goes black or shows a
  // frozen frame.  expo-av's <Video> cannot render a YouTube WebView inside
  // a PiP surface on any platform.
  //
  // Signal the parent to navigate back to the foreground so the YouTube
  // iframe can render in the full player.  `onFatal` reuses the same "exit to
  // safety" navigation path already wired in player.tsx.
  //
  // The exit must fire for BOTH orderings: (a) an override starts while the
  // app is already in PiP, and (b) the app enters PiP while an override is
  // already active (e.g. player.tsx auto-enters PiP from portrait when the
  // app is backgrounded mid-override).  A rising-edge-on-override-only guard
  // missed case (b) entirely, leaving a black PiP window.  Reacting to a
  // reactive `isInPip` flag (passed by player.tsx) covers both; we fire once
  // per combined-active session via a ref and reset when either condition
  // clears so a later re-entry fires again.
  //
  // Only the primary FSM driver navigates — the hero (minimal) and the inline
  // muted instance (suppressEvents) are view-only and must not pop the stack.
  const youtubeInPipExitFiredRef = useRef(false);
  useEffect(() => {
    if (minimal || suppressEvents) return;
    const inPip = isInPip ?? isInPictureInPictureMode();
    if (isYouTubeOverride && inPip) {
      if (!youtubeInPipExitFiredRef.current) {
        youtubeInPipExitFiredRef.current = true;
        // Cancel the restore notification so it doesn't dangle after exit.
        // `onFatal` triggers router.back() in player.tsx which brings the
        // Activity to foreground and closes the PiP window naturally.
        onFatal?.();
      }
    } else {
      youtubeInPipExitFiredRef.current = false;
    }
  }, [isYouTubeOverride, isInPip, minimal, suppressEvents, onFatal]);

  // ── First-frame readiness gate ────────────────────────────────────────
  // Tracks whether the native player (ExoPlayer / AVPlayer) has rendered
  // its first video frame for the current item. Set to true when
  // `onReadyForDisplay` fires on the active buffer; reset to false
  // whenever the FSM leaves the PLAYING family of states (which signals
  // that the current item has changed or the stream is recovering).
  //
  // Why this matters: the FSM transitions to PLAYING as soon as
  // `buffer-ready` fires (which fires on `onLoad` — metadata ready).
  // On Android, ExoPlayer can take an additional 100–500 ms after onLoad
  // to render the first decoded frame (`onReadyForDisplay`). During that
  // window the overlay is already dismissed (FSM in PLAYING), but the
  // <Video> surface is still black. Without this gate the user sees a
  // brief black flash between the tuning overlay disappearing and the
  // first video frame appearing.
  //
  // By keeping the poster visible until `onReadyForDisplay` fires we
  // ensure there is always *something* on screen: the poster fades out
  // only when actual pixels are ready, matching Netflix / Apple TV+ UX.
  //
  // Declared before overlayContent so the memo can gate the HLS/RTMP
  // override loading overlay on first-frame availability.
  const [videoReady, setVideoReady] = useState(false);
  // Stable callback so BroadcastBuffer (React.memo) doesn't re-render on every
  // 500 ms position update. An inline lambda `() => setVideoReady(true)` would
  // create a new function reference each time V2PlayerContainer re-renders
  // (which happens every progressUpdateIntervalMillis = 500 ms from the buffer
  // state subscription), defeating the memo entirely for both buffer instances.
  const handleVideoReady = useCallback(() => setVideoReady(true), []);
  useEffect(() => {
    // Entering a non-active-playback state means the current item
    // changed, the stream is recovering, or we went off-air.
    // In all cases the next item will need to pass the first-frame
    // gate again before the poster is hidden.
    //
    // LIVE_OVERRIDE_ACTIVE is included in the playing family so that an
    // HLS/RTMP override can set videoReady=true when its first frame renders.
    // Without this, the state effect continuously resets videoReady=false
    // (because LIVE_OVERRIDE_ACTIVE is not PLAYING/HANDOFF/PREPARING_NEXT),
    // keeping the poster visible forever even after the override video plays.
    // The activeBindRevision effect still resets videoReady=false whenever a
    // new override is bound, so the first-frame gate works correctly.
    const isPlayingFamily =
      snapshot.state === "PLAYING" ||
      snapshot.state === "HANDOFF" ||
      snapshot.state === "PREPARING_NEXT" ||
      snapshot.state === "LIVE_OVERRIDE_ACTIVE";
    if (!isPlayingFamily) setVideoReady(false);
  }, [snapshot.state]);
  // Also reset when the active buffer's bind revision changes
  // (HANDOFF swaps A↔B; the newly active buffer may not have
  // rendered its first frame yet even if the previous buffer had).
  const activeBindRevision = buffers[activeBufferId].bindRevision;
  useEffect(() => {
    setVideoReady(false);
  }, [activeBindRevision]);

  // Stop the phase timer as soon as the HLS/RTMP override video is playing
  // (videoReady=true). LIVE_OVERRIDE_ACTIVE never transitions to PLAYING, so
  // the phase timer keeps running indefinitely while `isLoadingState` remains
  // true — even though overlayContent returns null (no overlay) once
  // videoReady=true. Clear the interval here to avoid a 5 s re-render loop
  // that drives no visible UI change and wastes battery on mobile.
  useEffect(() => {
    if (
      snapshot.state === "LIVE_OVERRIDE_ACTIVE" &&
      videoReady &&
      phaseTimerRef.current !== null
    ) {
      clearInterval(phaseTimerRef.current);
      phaseTimerRef.current = null;
    }
  }, [snapshot.state, videoReady]);

  // ── Overlay content ───────────────────────────────────────────────────────
  // Returns { main, sub, showSpinner } or null (no overlay).
  // Phases give users progressively more honest context as time passes —
  // "Preparing Video" (phase 0) → "Buffering…" (phase 1) → "Please wait…" (phase 2+).
  interface OverlayContent {
    main: string;
    sub: string;
    showSpinner: boolean;
    upNext?: string;
    /** When set, renders a "Watch on YouTube" deep-link button. */
    youtubeUrl?: string | null;
    /** YouTube thumbnail URL — shown as a card above the overlay text. */
    youtubeThumbnailUrl?: string | null;
    /**
     * When present, a "Tap to reconnect" button is shown below the sub-text.
     * Only set after the user has been stuck for several phase steps so we
     * don't offer a manual escape too eagerly (auto-recovery should win first).
     */
    onRetry?: () => void;
  }
  const overlayContent = useMemo<OverlayContent | null>(() => {
    // ── YouTube override: expo-av cannot play YouTube — branded overlay ───────
    // Keep first so subsequent checks don't have to guard against it.
    if (isYouTubeOverride) {
      const overrideTitle = server?.override?.title;
      const overrideUrl = server?.override?.url ?? null;
      // Extract video ID for thumbnail — handles both youtube.com/watch?v= and youtu.be/ forms
      let youtubeThumbnailUrl: string | null = null;
      if (overrideUrl) {
        const m = overrideUrl.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
        if (m) youtubeThumbnailUrl = `https://img.youtube.com/vi/${m[1]}/mqdefault.jpg`;
      }
      return {
        main: overrideTitle ?? "Live YouTube Broadcast",
        sub: "Airing on YouTube — tap below to watch",
        showSpinner: false,
        youtubeUrl: overrideUrl,
        youtubeThumbnailUrl,
      };
    }

    // ── FATAL: unrecoverable stream failure — always show ─────────────────────
    if (snapshot.state === "FATAL") {
      const secsLabel =
        fatalRetrySecsLeft == null
          ? ""
          : fatalRetrySecsLeft > 0
          ? ` Auto-retrying in ${fatalRetrySecsLeft}s.`
          : " Retrying now…";
      return {
        main: "Playback Error",
        sub: `Unable to load stream.${secsLabel}`,
        showSpinner: false,
        onRetry: forceRebind,
      };
    }

    // ── OFFLINE_HOLD: no internet — always show ───────────────────────────────
    if (snapshot.state === "OFFLINE_HOLD") {
      return {
        main: isOnline ? "Reconnecting…" : "No Internet Connection",
        sub: isOnline
          ? "Re-establishing broadcast link"
          : "Will reconnect automatically when signal returns",
        showSpinner: true,
      };
    }

    // ── BOOTSTRAP with no server snapshot yet: cold-start indicator ───────────
    // Once we have a server snapshot (server !== null), switch to poster-only
    // mode so the thumbnail is immediately visible during transport setup.
    if (snapshot.state === "BOOTSTRAP" && !server) {
      return {
        main: "Connecting to Broadcast",
        sub: "Establishing secure connection…",
        showSpinner: true,
        onRetry: loadingPhase >= 2 ? forceRebind : undefined,
      };
    }

    // ── SYNCING / LIVE_OVERRIDE_ACTIVE (first frame not yet visible) ──────────
    // If the server says off-air (no current, no override) and we know it for
    // certain, surface that rather than leaving a blank poster indefinitely.
    if (
      snapshot.state === "SYNCING" &&
      server &&
      !server.current &&
      !server.override
    ) {
      return {
        main: "Off-Air",
        sub: "We'll be back shortly — stay tuned",
        showSpinner: false,
      };
    }

    // ── HLS/RTMP override playing, video frame already visible ───────────────
    // Once the override's first frame fires (videoReady=true) there is nothing
    // to overlay — the Video element is visible. Keep null so the user sees
    // the live stream without obstruction.
    if (snapshot.state === "LIVE_OVERRIDE_ACTIVE" && videoReady) return null;

    // ── Genuinely off-air: settled state, no content anywhere ────────────────
    // Only shown when the FSM has settled into a non-transient state. Transient
    // states (PREPARING_ACTIVE, RECOVERING_*, SKIP_PENDING) are silent — they
    // show the poster and a subtle status dot instead of a blocking overlay.
    const TRANSIENT_STATES = new Set([
      "BOOTSTRAP",
      "SYNCING",
      "PREPARING_ACTIVE",
      "RECOVERING_PRIMARY",
      "RECOVERING_FAILOVER",
      "SKIP_PENDING",
      "LIVE_OVERRIDE_ACTIVE",
      "PLAYING",
      "HANDOFF",
      "PREPARING_NEXT",
    ]);
    if (
      server &&
      !server.current &&
      !server.override &&
      !TRANSIENT_STATES.has(snapshot.state)
    ) {
      const nextTitle = server.next?.title;
      return {
        main: "Off-Air",
        sub: "We'll be back shortly — stay tuned",
        showSpinner: false,
        upNext: nextTitle && nextTitle.length > 0 ? nextTitle : undefined,
      };
    }

    // ── Zero-loading UX: all other states show poster only ────────────────────
    // PREPARING_ACTIVE, RECOVERING_PRIMARY, RECOVERING_FAILOVER, SKIP_PENDING,
    // SYNCING (with content), LIVE_OVERRIDE_ACTIVE (awaiting first frame),
    // PLAYING, HANDOFF, PREPARING_NEXT — no blocking overlay, no spinner.
    // The poster + ambient background + pulsing status dot provide visual
    // continuity while the player tunes in silently.
    return null;
  }, [snapshot.state, server, isOnline, isYouTubeOverride, videoReady, forceRebind, fatalRetrySecsLeft, loadingPhase]);

  // Poster: show the upcoming/current sermon thumbnail behind the buffers
  // while the player is still tuning in, off-air, reconnecting, or in any
  // non-PLAYING state — AND until the active buffer's first video frame is
  // visible (first-frame gate above). Without this the user sees a black
  // box for 1–3 s on cold open or after every reconnect, and a brief black
  // flash when the tuning overlay clears before ExoPlayer paints frame 1.
  // We prefer the current item's thumb and fall back to `next` so the
  // surface is never bare when the queue is between items.
  const posterUrl = useMemo(() => {
    const t = server?.current?.thumbnailUrl ?? server?.next?.thumbnailUrl ?? null;
    return t && t.length > 0 ? t : null;
  }, [server]);
  // Animated opacity for the sharp poster image. Starts at 1 (fully opaque)
  // and fades to 0 over 350 ms when the video frame becomes ready AND the
  // overlay is gone — eliminating the instant pop-to-black that occurred when
  // the <Image> was unmounted synchronously the moment `videoReady` flipped.
  // Snaps back to 1 instantly (no duration) when a new poster should appear
  // (reconnect, off-air, item change) so the thumbnail is always sharp while
  // the player is loading the next clip. The component stays mounted whenever
  // `posterUrl` is non-null so the Animated value is never reset by an
  // unmount/remount cycle. `pointerEvents="none"` on the wrapping Animated.View
  // ensures the invisible faded poster never intercepts touch events.
  const posterFadeAnim = useRef(new Animated.Value(1)).current;
  const prevPosterUrl = useRef<string | null>(null);

  // True during any state where the player is silently loading/recovering
  // (zero-loading UX: poster shown, no blocking overlay, pulsing status dot).
  // Used to gate the poster visibility and banner suppression independently
  // of overlayContent (which is null for these states by design).
  const isTransientState =
    snapshot.state === "PREPARING_ACTIVE" ||
    snapshot.state === "RECOVERING_PRIMARY" ||
    snapshot.state === "RECOVERING_FAILOVER" ||
    snapshot.state === "SKIP_PENDING" ||
    snapshot.state === "SYNCING" ||
    // LIVE_OVERRIDE_ACTIVE before first frame: buffering silently
    (snapshot.state === "LIVE_OVERRIDE_ACTIVE" && !videoReady) ||
    // BOOTSTRAP once we have a snapshot: thumbnail visible while connecting
    (snapshot.state === "BOOTSTRAP" && !!server);

  // Include isTransientState so the poster always shows during silent
  // loading/recovery states — even when overlayContent is null and videoReady
  // is still true from the previous play session (e.g. RECOVERING_PRIMARY
  // where the old frame is frozen but the buffer is being rebuilt).
  const showPosterContent = (!!overlayContent || !videoReady || isTransientState) && !!posterUrl;

  useEffect(() => {
    // When the posterUrl changes (item transition), snap opacity back to 1 so
    // the new thumbnail is instantly visible while the next video is loading.
    if (posterUrl !== prevPosterUrl.current) {
      prevPosterUrl.current = posterUrl;
      posterFadeAnim.stopAnimation();
      posterFadeAnim.setValue(1);
      return; // opacity already at 1 — no need to evaluate showPosterContent further
    }
    if (showPosterContent) {
      // Overlay or first-frame wait — poster must be fully visible. Cancel any
      // in-progress fade-out and snap to opaque.
      posterFadeAnim.stopAnimation();
      posterFadeAnim.setValue(1);
    } else if (posterUrl) {
      // Video is live and overlay is gone — smoothly fade the poster out so
      // the transition from poster→video is perceptually seamless rather than
      // a hard cut.
      Animated.timing(posterFadeAnim, {
        toValue: 0,
        duration: 350,
        useNativeDriver: true,
      }).start();
    }
  }, [showPosterContent, posterUrl, posterFadeAnim]);

  // True when the FSM is actively waiting for an active-buffer signal
  // (PREPARING_ACTIVE → PLAYING, RECOVERING_* → PLAYING). Used to gate the
  // load-timeout and buffering-stall watchdogs inside BroadcastBuffer so that
  // a freshly-mounted secondary consumer (e.g. Player screen opening while the
  // Hero's singleton session is already PLAYING) cannot accidentally fire
  // buffer-error into a healthy session and trigger RECOVERING_PRIMARY.
  const fsmIsWaiting =
    snapshot.state === "PREPARING_ACTIVE" ||
    snapshot.state === "RECOVERING_PRIMARY" ||
    snapshot.state === "RECOVERING_FAILOVER" ||
    // LIVE_OVERRIDE_ACTIVE: arm the 12-second load-timeout and buffering-stall
    // watchdogs inside BroadcastBuffer so that a silent ExoPlayer failure to
    // load the HLS/RTMP override URL triggers buffer-error → RECOVERING_PRIMARY
    // instead of leaving the player stuck indefinitely.  The same-URL fast-path
    // in BroadcastBuffer (lastLoadedUrlRef) prevents the watchdog from firing
    // spuriously when a secondary consumer (Player screen) mounts while the
    // Hero already has the override playing — if the element fires onLoad
    // quickly the load-timeout is cleared before it can fire; if the URL truly
    // fails to load within 12 s the timeout is a legitimate recovery signal.
    snapshot.state === "LIVE_OVERRIDE_ACTIVE";

  // Pulsing opacity animation for the status dot — loops between 0.3 and 1
  // while the player is in a transient state, stops when playing.
  const tuningPulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(tuningPulse, { toValue: 0.3, duration: 700, useNativeDriver: true }),
        Animated.timing(tuningPulse, { toValue: 1.0, duration: 700, useNativeDriver: true }),
      ]),
    );
    if (isTransientState && !overlayContent) {
      anim.start();
    } else {
      anim.stop();
      tuningPulse.setValue(1);
    }
    return () => anim.stop();
  }, [isTransientState, overlayContent, tuningPulse]);

  // Banner text: distinguish "no signal" from "WS disconnected" so viewers
  // understand whether to wait for auto-reconnect (WS) or move somewhere
  // with better coverage (no signal).
  const bannerText = isOnline
    ? "Reconnecting to broadcast…"
    : "You're offline — will reconnect automatically";

  // During active playback the WebSocket can drop briefly (poor signal, cell
  // handoff, edge reconnect) without the video stuttering — the ExoPlayer /
  // expo-av buffer keeps delivering frames independently of the control
  // channel.  Firing the amber banner in these states alarms the viewer even
  // though nothing is wrong with what they see.  The V2Transport will
  // auto-reconnect in the background (dead-socket watchdog + jittered force-
  // reconnect); if the disconnect is sustained long enough for the FSM to
  // leave the playing family (e.g. enters RECOVERING_PRIMARY) the overlay
  // will surface the problem clearly without the banner.
  // Suppress the amber "Reconnecting…" banner whenever a full-screen overlay
  // is already visible (overlayContent !== null).  The overlay carries the same
  // — or richer — status information (spinner, sub-text, Up Next chip) so the
  // banner is redundant in those states and the two messages together create
  // confusing visual noise.  States affected: BOOTSTRAP, SYNCING (with content),
  // PREPARING_ACTIVE, RECOVERING_PRIMARY, RECOVERING_FAILOVER, SKIP_PENDING,
  // and OFFLINE_HOLD (which previously showed BOTH "No Internet Connection"
  // overlay AND the amber banner simultaneously).
  //
  // For the playing family (PLAYING / HANDOFF / PREPARING_NEXT /
  // LIVE_OVERRIDE_ACTIVE): overlayContent is null, so the original logic
  // still applies — the banner is suppressed to avoid alarming the viewer
  // when the WS drops briefly without disrupting the video.
  const suppressBanner =
    !!overlayContent ||
    // Suppress during all silent transient states — the poster provides
    // visual continuity; showing the amber reconnecting banner on top of it
    // creates conflicting signals ("something is wrong" vs "poster is fine").
    isTransientState ||
    snapshot.state === "PLAYING" ||
    snapshot.state === "HANDOFF" ||
    snapshot.state === "PREPARING_NEXT" ||
    snapshot.state === "LIVE_OVERRIDE_ACTIVE";

  return (
    <View style={styles.root}>
      {/* ── Cinematic ambient background ────────────────────────────────────
          Always-visible blurred version of the current item's thumbnail fills
          letterbox/pillarbox areas (produced by ResizeMode.CONTAIN) with a
          soft ambient glow instead of harsh black bars. Matches what Netflix
          and Apple TV+ do: content is never cropped but empty space is never
          empty either. blurRadius=25 is hardware-accelerated on iOS/Android.  */}
      {posterUrl && !minimal && (
        <Image
          source={{ uri: posterUrl }}
          style={styles.ambient}
          blurRadius={25}
          accessible={false}
        />
      )}

      {/* Sharp poster — fades in instantly on overlay/load states and fades
          out smoothly (350 ms) when the video frame becomes live and the
          overlay clears. Kept mounted whenever posterUrl is non-null so the
          Animated.Value is never reset by an unmount/remount cycle. */}
      {posterUrl && !minimal && (
        <Animated.View
          style={[styles.poster, { opacity: posterFadeAnim }]}
          pointerEvents="none"
        >
          <Image
            source={{ uri: posterUrl }}
            style={styles.posterInner}
            resizeMode="contain"
            accessible={false}
          />
        </Animated.View>
      )}

      <BroadcastBuffer
        bufferId="A"
        state={buffers.A}
        reportBufferEvent={reportBufferEvent}
        forceMuted={muted}
        excludeYouTube={minimal || isYouTubeOverride}
        suppressEvents={suppressEventsOverride !== undefined ? suppressEventsOverride : (minimal || !!suppressEvents)}
        fsmIsWaiting={fsmIsWaiting}
        onVideoReady={buffers.A.active ? handleVideoReady : undefined}
      />
      <BroadcastBuffer
        bufferId="B"
        state={buffers.B}
        reportBufferEvent={reportBufferEvent}
        forceMuted={muted}
        excludeYouTube={minimal || isYouTubeOverride}
        suppressEvents={suppressEventsOverride !== undefined ? suppressEventsOverride : (minimal || !!suppressEvents)}
        fsmIsWaiting={fsmIsWaiting}
        onVideoReady={buffers.B.active ? handleVideoReady : undefined}
      />

      {!connected && !minimal && !suppressBanner && (
        <View style={[styles.banner, !isOnline && styles.bannerOffline]}>
          <Text style={styles.bannerText}>{bannerText}</Text>
        </View>
      )}

      {overlayContent && !minimal && (
        <View style={styles.overlay}>
          {overlayContent.showSpinner && (
            <ActivityIndicator
              color="#fff"
              size="large"
              style={styles.overlaySpinner}
            />
          )}
          {overlayContent.youtubeThumbnailUrl ? (
            <Image
              source={{ uri: overlayContent.youtubeThumbnailUrl }}
              style={styles.overlayYtThumb}
              resizeMode="cover"
              accessible={false}
            />
          ) : null}
          <Text style={styles.overlayText}>{overlayContent.main}</Text>
          {overlayContent.sub ? (
            <Text style={styles.overlaySubText}>{overlayContent.sub}</Text>
          ) : null}
          {overlayContent.upNext ? (
            <View style={styles.upNextChip}>
              <Text style={styles.upNextLabel}>UP NEXT</Text>
              <Text style={styles.upNextTitle} numberOfLines={1}>
                {overlayContent.upNext}
              </Text>
            </View>
          ) : null}
          {overlayContent.youtubeUrl ? (
            <Pressable
              onPress={() => {
                if (overlayContent.youtubeUrl) {
                  void Linking.openURL(overlayContent.youtubeUrl);
                }
              }}
              style={({ pressed }) => [styles.overlayYtBtn, pressed && styles.overlayYtBtnPressed]}
              accessibilityRole="link"
              accessibilityLabel="Watch on YouTube"
            >
              <Text style={styles.overlayYtBtnText}>Watch on YouTube ▶</Text>
            </Pressable>
          ) : null}
          {overlayContent.onRetry ? (
            <Pressable
              onPress={overlayContent.onRetry}
              style={({ pressed }) => [styles.overlayRetryBtn, pressed && styles.overlayRetryBtnPressed]}
              accessibilityRole="button"
              accessibilityLabel="Reconnect to broadcast"
            >
              <Text style={styles.overlayRetryText}>Tap to reconnect</Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {/* First-frame loading indicator ─────────────────────────────────────
          Shown when the FSM is already PLAYING (so overlayContent is null and
          the full overlay is hidden) but this V2PlayerContainer's Video
          elements have not yet rendered their first frame — e.g. when the
          Player screen opens while the Hero's singleton session was already
          broadcasting. The poster covers the blank Video surface; this small
          spinner in the corner signals that the stream is buffering without
          blocking the poster with a dark scrim.
          Not shown for minimal/hero instances (suppressEvents=true covers them).
          Not shown when a full overlay is already displaying its own spinner. */}
      {!videoReady && !overlayContent && !minimal && !!posterUrl && (
        <View style={styles.firstFrameLoading} pointerEvents="none">
          <ActivityIndicator color="rgba(255,255,255,0.75)" size="small" />
        </View>
      )}

      {/* No-poster first-frame fallback ─────────────────────────────────────
          When the current item has no thumbnail there is no poster to cover
          the still-black <Video> surface during the first-frame window (FSM
          PLAYING but onReadyForDisplay not yet fired). Without this the viewer
          would see a bare black screen with no affordance. A centered spinner
          guarantees there is always a visible loading state until the first
          frame renders (videoReady). With the isPlaying poster-lift safety net
          above this window is brief, but the fallback prevents any black gap. */}
      {!videoReady && !overlayContent && !minimal && !posterUrl && (
        <View style={styles.firstFrameLoadingCentered} pointerEvents="none">
          <ActivityIndicator color="rgba(255,255,255,0.85)" size="large" />
        </View>
      )}

      {/* Tuning status dot — visible during all silent transient states
          (PREPARING_ACTIVE, RECOVERING_*, SKIP_PENDING, SYNCING with content).
          A tiny pulsing circle in the bottom-left corner signals the player is
          actively loading without blocking the poster with a dark scrim.
          Not shown in minimal/hero mode or when a full overlay is visible. */}
      {isTransientState && !overlayContent && !minimal && (
        <View style={styles.tuningIndicator} pointerEvents="none">
          <Animated.View style={[styles.tuningDot, { opacity: tuningPulse }]} />
          <Text style={styles.tuningDotLabel}>LIVE</Text>
        </View>
      )}

      {/* Manual reconnect — offered after extended transient state (≥15 s).
          Provides an escape hatch when auto-recovery is cycling without
          showing a blocking overlay. Not shown in minimal/hero mode. */}
      {isTransientState && !overlayContent && !minimal && loadingPhase >= 3 && (
        <Pressable
          onPress={forceRebind}
          style={styles.manualRetryBtn}
          accessibilityRole="button"
          accessibilityLabel="Reconnect to broadcast"
        >
          <Text style={styles.manualRetryText}>Tap to reconnect</Text>
        </Pressable>
      )}

      {/* Source quality badge — shown during active playback only.
          'hls'                      → "HLS"  (adaptive HLS manifest chain)
          'mp4' / 'mp4_faststart'    → "MP4"  (direct MP4 streaming)
          'mp4_raw'                  → "SD"   (un-optimised MP4, may buffer slowly)
          Hidden during overlays (tuning/off-air) and in minimal/hero mode.
          Hidden during overrides (youtube / live_override) since those are
          external sources whose quality the server can't classify.
          Note: the API now always emits "mp4" (faststart pipeline removed);
          "mp4_faststart" / "mp4_raw" kept for backward-compat with older frames. */}
      {videoReady && !overlayContent && !minimal && (() => {
        const sq = server?.sourceQuality;
        if (!sq || sq === "live_override" || sq === "youtube") return null;
        const label =
          sq === "hls"
            ? "HLS"
            : sq === "mp4" || sq === "mp4_faststart"
            ? "MP4"
            : "SD";
        return (
          <View style={styles.qualityBadge} pointerEvents="none">
            <Text style={styles.qualityBadgeText}>{label}</Text>
          </View>
        );
      })()}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
  },
  video: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
  },
  ambient: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
    zIndex: 0,
    // Raised from 0.35 → 0.45: stronger ambient fill makes letterbox/pillarbox
    // areas clearly branded rather than near-black, matching Netflix/Apple TV+ UX.
    opacity: 0.45,
    resizeMode: "cover",
  },
  poster: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
    zIndex: 5,
  },
  // Inner Image inside the Animated.View wrapper — fills the wrapper fully so
  // the opacity animation applies to the wrapper while the image itself
  // stays at full opacity within its own coordinate space.
  posterInner: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
  },
  banner: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(217, 119, 6, 0.92)",
    paddingVertical: 6,
    zIndex: 30,
  },
  bannerOffline: {
    backgroundColor: "rgba(100, 100, 100, 0.92)",
  },
  bannerText: {
    color: "#000",
    textAlign: "center",
    fontWeight: "600",
    fontSize: 13,
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
    // Slightly deeper scrim (0.7→0.78) so overlay text is legible over
    // bright sermon thumbnails without compromising ambient colour feel.
    backgroundColor: "rgba(0,0,0,0.78)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 20,
  },
  overlaySpinner: {
    marginBottom: 16,
  },
  firstFrameLoading: {
    position: "absolute",
    bottom: 12,
    right: 12,
    zIndex: 15,
  },
  firstFrameLoadingCentered: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 15,
  },
  overlayText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 0.4,
    textAlign: "center",
    marginHorizontal: 24,
  },
  overlaySubText: {
    color: "rgba(255,255,255,0.65)",
    fontSize: 13,
    fontWeight: "400",
    letterSpacing: 0.2,
    textAlign: "center",
    marginHorizontal: 24,
    marginTop: 6,
  },
  upNextChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 20,
    paddingVertical: 6,
    paddingHorizontal: 14,
    backgroundColor: "rgba(255,255,255,0.10)",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    maxWidth: "80%",
  },
  upNextLabel: {
    color: "rgba(255,255,255,0.45)",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    flexShrink: 0,
  },
  upNextTitle: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 12,
    fontWeight: "500",
    flexShrink: 1,
  },
  overlayRetryBtn: {
    marginTop: 24,
    paddingVertical: 10,
    paddingHorizontal: 22,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.30)",
  },
  overlayRetryBtnPressed: {
    backgroundColor: "rgba(255,255,255,0.25)",
  },
  overlayRetryText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  overlayYtThumb: {
    width: 180,
    height: 101,
    borderRadius: 8,
    marginBottom: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  overlayYtBtn: {
    marginTop: 18,
    paddingVertical: 11,
    paddingHorizontal: 26,
    backgroundColor: "#ff0000",
    borderRadius: 999,
  },
  overlayYtBtnPressed: {
    backgroundColor: "#cc0000",
  },
  overlayYtBtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  qualityBadge: {
    position: "absolute",
    bottom: 10,
    right: 10,
    zIndex: 15,
    paddingVertical: 2,
    paddingHorizontal: 6,
    backgroundColor: "rgba(0,0,0,0.50)",
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.20)",
  },
  qualityBadgeText: {
    color: "rgba(255,255,255,0.80)",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  tuningIndicator: {
    position: "absolute",
    bottom: 12,
    left: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    zIndex: 15,
  },
  tuningDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#fff",
  },
  tuningDotLabel: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 8,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  manualRetryBtn: {
    position: "absolute",
    bottom: 36,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 15,
  },
  manualRetryText: {
    color: "rgba(255,255,255,0.60)",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.3,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
});
