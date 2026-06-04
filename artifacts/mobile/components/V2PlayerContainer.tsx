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
 *     >20 s while the buffer should be active and playing, the watchdog fires
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
 *   • Drift-correction seek guard: small anchor recalibrations (< 30 s drift)
 *     are suppressed when the playhead is already near the target, preventing
 *     AVPlayer/ExoPlayer from dropping its download buffer on every keepalive.
 *     Only genuine drifts (server restart, timezone mis-sync, > 30 s gap) seek.
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
 *   • Fix: `loadTimeoutRef` starts LOAD_TIMEOUT_MS (25 s) after a new URL is
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
import { ActivityIndicator, AppState, Image, StyleSheet, Text, View } from "react-native";
import { ResizeMode, Video, type AVPlaybackStatus } from "expo-av";
import { useV2BroadcastNative } from "@workspace/player-core/react-native";
import type { MobileBufferState } from "@workspace/player-core/adapters/mobile";
import { useNetworkContext } from "@/context/NetworkContext";
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
const HLS_QUICK_FINISH_THRESHOLD_MS = 5_000;

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
 * Suppressing re-seeks when the playhead is already within 30 s of the target
 * preserves smooth playback for small anchor recalibrations while still
 * correcting large drifts (server restart, timezone mis-sync, > 30 s gap).
 */
const HLS_SMALL_DRIFT_SKIP_MS = 30_000;

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
 * Maximum time (ms) to wait for expo-av's `onLoad` to fire after a new
 * source is bound to an active+playing buffer before declaring a load failure.
 *
 * This is a safety net for cases where Android ExoPlayer fails to fire
 * `onLoad` or `onError` (silent failure modes seen with certain HLS manifests
 * or codec configurations). Without this timeout the FSM stays stuck in
 * PREPARING_ACTIVE or RECOVERING indefinitely — audio may play (from a prior
 * successful load) but "Tuning in…" never clears.
 *
 * 12 s: chosen BELOW BUFFERING_STALL_THRESHOLD_MS (15 s) so the two
 * watchdogs target different failure classes without racing each other.
 * LOAD_TIMEOUT catches "ExoPlayer never emitted isBuffering=true" (silent
 * codec / manifest failures). BUFFERING_STALL catches "isBuffering=true
 * but no frames arrive" (partial content, slow segment download). Both
 * can be active simultaneously but LOAD_TIMEOUT fires first and clears
 * the stall watchdog via the error path. Reduced from 25 s to recover
 * twice as fast on completely silent ExoPlayer silent failures.
 */
const LOAD_TIMEOUT_MS = 12_000;

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

  // Track the last bind revision that produced a buffer-ready report rather
  // than the URL string. URL-based dedup caused RECOVERING_PRIMARY to silently
  // swallow the onLoad event when the same URL was rebound after a failure,
  // leaving the FSM stuck in RECOVERING_PRIMARY until the watchdog fired.
  const lastReportedRevision = useRef<number>(-1);

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

  function clearBufferingWatchdog() {
    if (bufferingWatchdogRef.current) {
      clearTimeout(bufferingWatchdogRef.current);
      bufferingWatchdogRef.current = null;
    }
  }

  function clearQuickFinishRetry() {
    if (quickFinishRetryTimerRef.current) {
      clearTimeout(quickFinishRetryTimerRef.current);
      quickFinishRetryTimerRef.current = null;
    }
  }

  function clearLoadTimeout() {
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
  }

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
      if (!suppressEvents && state.playing && state.active && fsmIsWaitingRef.current) {
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
          // HLS_SMALL_DRIFT_SKIP_MS (30 s) of the target — the viewer is
          // watching the correct content and the minor desync is imperceptible.
          // Allow the seek when the drift is large (> 30 s), which indicates a
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
        v.playFromPositionAsync(state.positionSecs * 1000).catch(() => {
          emit({ type: "buffer-error", bufferId, error: "play-failed" });
        });
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
  useEffect(() => {
    if (!isHls || !state.playing || !state.active) return;
    const t = setInterval(() => {
      ref.current?.playAsync().catch(() => {});
    }, HLS_LIVE_SYNC_INTERVAL_MS);
    return () => clearInterval(t);
  }, [isHls, state.playing, state.active]);

  // Mute follows the adapter store (only the active buffer is audible),
  // unless `forceMuted` is set by the parent — used by the homepage hero
  // preview which must never play audio.
  const effectiveMuted = forceMuted || state.muted;
  useEffect(() => {
    ref.current?.setIsMutedAsync(effectiveMuted).catch(() => {});
  }, [effectiveMuted]);

  if (!url) {
    return <View style={[styles.video, { zIndex: state.active ? 2 : 1 }]} />;
  }

  // Build the expo-av source object. For HLS sources, include
  // `overrideFileExtensionWithValue: 'm3u8'` to guarantee Android
  // ExoPlayer recognises the content type as HLS even when the URL
  // passes through a proxy path that doesn't end in `.m3u8` (e.g.
  // `/api/hls/videoId/v0/playlist.m3u8?token=…` with a long query
  // string). Without the hint, some ExoPlayer 2.x builds fall back to
  // progressive download mode, causing manifest parse failures or
  // segment looping that produce a permanently black video surface
  // while audio continues from the demuxed audio track.
  const avSource = isHls
    ? { uri: url, overrideFileExtensionWithValue: "m3u8" as const }
    : { uri: url };

  return (
    <Video
      ref={ref}
      source={avSource}
      style={[styles.video, { zIndex: state.active ? 2 : 1 }]}
      resizeMode={ResizeMode.CONTAIN}
      shouldPlay={false}
      isMuted={effectiveMuted}
      progressUpdateIntervalMillis={500}
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
            emit({ type: "buffer-error", bufferId, error: status.error });
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

        if (status.didJustFinish) {
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
            if (playDurationMs < HLS_QUICK_FINISH_THRESHOLD_MS) {
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
        if (status.isBuffering && state.playing && state.active && !suppressEventsRef.current && fsmIsWaitingRef.current) {
          // fsmIsWaiting guard: do NOT arm when the FSM is already PLAYING.
          // A freshly-mounted Video (e.g. Player screen opening while Hero's
          // singleton session was broadcasting) starts in isBuffering=true.
          // Without this guard the 15 s stall watchdog fires buffer-error
          // and drives the FSM into RECOVERING_PRIMARY — disrupting a live
          // stream that was healthy before the new consumer mounted.
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
          // Not buffering, not the active playing buffer, suppressed, or FSM
          // not waiting for this buffer's signal — disarm.
          clearBufferingWatchdog();
        }
      }}
      onError={(error) => {
        clearBufferingWatchdog();
        emit({
          type: "buffer-error",
          bufferId,
          error: typeof error === "string" ? error : "media-error",
        });
      }}
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
}

function isInMpWindow(cfg: MPScheduleConfig): boolean {
  if (!cfg.enabled) return false;
  const h = new Date().getHours();
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
    fetch(`${apiOrigin}/api/midnight-prayers/config`)
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
  isInPip,
}: Props) {
  void _channelId;
  const effectiveBaseUrl = useMidnightPrayersSwitch(baseUrl);
  const { snapshot, connected, buffers, reportBufferEvent, forceReconnect, notifyOnline } =
    useV2BroadcastNative({ baseUrl: effectiveBaseUrl });

  // Network context — drives network-aware banner text and immediate
  // reconnect on signal recovery (complements the AppState-based nudge).
  const { isOnline, justRecovered } = useNetworkContext();

  const fatalFiredRef = useRef(false);
  useEffect(() => {
    if (snapshot.state === "FATAL" && !fatalFiredRef.current) {
      fatalFiredRef.current = true;
      onFatal?.();
    }
    if (snapshot.state !== "FATAL") fatalFiredRef.current = false;
  }, [snapshot.state, onFatal]);

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
  useEffect(() => {
    if (justRecovered) {
      notifyOnline();
      forceReconnect();
    }
  }, [justRecovered, notifyOnline, forceReconnect]);

  const server = snapshot.lastServerSnapshot;

  // ── Loading phase tracker ─────────────────────────────────────────────────
  // Tracks how long the player has been in a transient loading state and
  // advances a `loadingPhase` counter every PHASE_STEP_MS. This drives
  // contextual message rotation: early phases show specific status text;
  // later phases shift to "still working" language so the user knows we
  // haven't frozen. The counter resets to 0 whenever we leave a loading state.
  const PHASE_STEP_MS = 5_000;
  const [loadingPhase, setLoadingPhase] = useState(0);
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
  // When the admin activates a YouTube live override, the machine transitions
  // to LIVE_OVERRIDE_ACTIVE and binds the V2Override (kind: "youtube") to the
  // active buffer. expo-av cannot play YouTube URLs — attempting to load one
  // causes onError to fire immediately, sending buffer-error into the FSM and
  // triggering RECOVERING_PRIMARY → RECOVERING_FAILOVER → SKIP_PENDING → FATAL.
  //
  // We detect this condition and exclude YouTube from both BroadcastBuffer
  // instances (same guard used by minimal/hero) to prevent the recovery spiral.
  // A dedicated overlay is shown instead so the viewer understands what's live.
  const activeItem = buffers[activeBufferId].item;
  const isYouTubeOverride =
    snapshot.state === "LIVE_OVERRIDE_ACTIVE" &&
    activeItem !== null &&
    !("source" in activeItem) &&   // V2Override has .kind directly, not .source.kind
    activeItem.kind === "youtube";

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
    updatePipParams(16, 9, true).catch(() => {});
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
  interface OverlayContent { main: string; sub: string; showSpinner: boolean; upNext?: string }
  const overlayContent = useMemo<OverlayContent | null>(() => {
    const p = loadingPhase;

    if (snapshot.state === "FATAL") {
      return { main: "Playback Error", sub: "Please try again in a moment.", showSpinner: false };
    }
    // YouTube live override — expo-av cannot play YouTube URLs so we surface a
    // branded overlay rather than attempting to load it. The buffer is idle
    // (excludeYouTube=true prevents any load), so no spinner is needed.
    if (isYouTubeOverride) {
      const overrideTitle = server?.override?.title;
      return {
        main: overrideTitle ?? "Live YouTube Broadcast",
        sub: "This broadcast is streaming live on YouTube",
        showSpinner: false,
      };
    }
    // HLS/RTMP override — show a loading overlay until the first video frame
    // renders (videoReady=true). LIVE_OVERRIDE_ACTIVE is a persistent state
    // that does not transition to PLAYING when the override starts playing,
    // so we gate on videoReady (first-frame signal) rather than FSM state to
    // know when the override is actually visible. Once videoReady=true the
    // overlay disappears and the native video surface is revealed.
    if (snapshot.state === "LIVE_OVERRIDE_ACTIVE") {
      if (videoReady) return null;
      return {
        main: p === 0 ? "Switching to Live Override" : "Loading Override…",
        sub: p === 0 ? "Broadcasting live from override source" : "Please wait…",
        showSpinner: true,
      };
    }
    if (server?.failover.active) {
      const reason = server.failover.reason ?? "Failover stream active";
      return { main: reason, sub: "On standby", showSpinner: false };
    }
    if (snapshot.state === "OFFLINE_HOLD") {
      return {
        main: isOnline ? "Reconnecting…" : "No Internet Connection",
        sub: isOnline ? "Re-establishing broadcast link" : "Will reconnect automatically when signal returns",
        showSpinner: true,
      };
    }
    // BOOTSTRAP — transport not yet connected, no server snapshot yet.
    if (snapshot.state === "BOOTSTRAP") {
      return {
        main: p === 0 ? "Connecting to Broadcast" : "Connecting…",
        sub: p === 0
          ? "Establishing secure connection"
          : p === 1
          ? "Reaching broadcast server"
          : "Taking a bit longer than usual — please wait",
        showSpinner: true,
      };
    }
    // SYNCING — transport connected, waiting for first server snapshot.
    if (snapshot.state === "SYNCING") {
      if (server && !server.current && !server.override) {
        return {
          main: "Temple TV is Off-Air",
          sub: "We'll be back shortly — stay tuned",
          showSpinner: false,
        };
      }
      return {
        main: p === 0 ? "Loading Live Stream" : "Synchronizing Broadcast…",
        sub: p === 0
          ? "Fetching broadcast data"
          : p === 1
          ? "Almost ready to play"
          : "Still loading — almost there",
        showSpinner: true,
      };
    }
    // PREPARING_ACTIVE — item bound to active buffer, waiting for buffer-ready.
    if (snapshot.state === "PREPARING_ACTIVE") {
      return {
        main: p === 0 ? "Preparing Video" : p === 1 ? "Buffering Stream…" : "Loading…",
        sub: p === 0
          ? "Buffering live stream"
          : p === 1
          ? "Loading video segments"
          : p === 2
          ? "This is taking a moment — please wait"
          : "Still buffering — hang tight",
        showSpinner: true,
      };
    }
    // Active playback — no overlay.
    if (
      snapshot.state === "PLAYING" ||
      snapshot.state === "HANDOFF" ||
      snapshot.state === "PREPARING_NEXT"
    ) return null;
    // Recovery states.
    if (snapshot.state === "RECOVERING_PRIMARY") {
      return {
        main: p === 0 ? "Reconnecting…" : "Retrying Stream…",
        sub: p === 0 ? "Retrying stream source" : "Attempting stream recovery",
        showSpinner: true,
      };
    }
    if (snapshot.state === "RECOVERING_FAILOVER") {
      return {
        main: "Switching to Backup",
        sub: "Loading failover stream",
        showSpinner: true,
      };
    }
    if (snapshot.state === "SKIP_PENDING") {
      return {
        main: "Loading Next Broadcast",
        sub: "Preparing next item in queue",
        showSpinner: true,
      };
    }
    // Remaining states: genuinely off-air when no content.
    if (server && !server.current && !server.override) {
      const nextTitle = server.next?.title;
      return {
        main: "Temple TV is Off-Air",
        sub: "We'll be back shortly — stay tuned",
        showSpinner: false,
        upNext: nextTitle && nextTitle.length > 0 ? nextTitle : undefined,
      };
    }
    return null;
  }, [snapshot.state, server, loadingPhase, isOnline, isYouTubeOverride, videoReady]);

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
  // Show poster while there is an overlay (tuning/off-air/reconnecting)
  // OR while the video frame is not yet ready (prevents black flash).
  const showPoster = (!!overlayContent || !videoReady) && !!posterUrl;

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

  // Banner text: distinguish "no signal" from "WS disconnected" so viewers
  // understand whether to wait for auto-reconnect (WS) or move somewhere
  // with better coverage (no signal).
  const bannerText = isOnline
    ? "Reconnecting to broadcast…"
    : "You're offline — will reconnect automatically";

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

      {/* Sharp poster — shown only in overlay states (tuning/off-air/reconnecting) */}
      {showPoster && !minimal && (
        <Image
          source={{ uri: posterUrl! }}
          style={styles.poster}
          resizeMode="contain"
          accessible={false}
        />
      )}

      <BroadcastBuffer
        bufferId="A"
        state={buffers.A}
        reportBufferEvent={reportBufferEvent}
        forceMuted={muted}
        excludeYouTube={minimal || isYouTubeOverride}
        suppressEvents={minimal || !!suppressEvents}
        fsmIsWaiting={fsmIsWaiting}
        onVideoReady={buffers.A.active ? handleVideoReady : undefined}
      />
      <BroadcastBuffer
        bufferId="B"
        state={buffers.B}
        reportBufferEvent={reportBufferEvent}
        forceMuted={muted}
        excludeYouTube={minimal || isYouTubeOverride}
        suppressEvents={minimal || !!suppressEvents}
        fsmIsWaiting={fsmIsWaiting}
        onVideoReady={buffers.B.active ? handleVideoReady : undefined}
      />

      {!connected && !minimal && (
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
});
