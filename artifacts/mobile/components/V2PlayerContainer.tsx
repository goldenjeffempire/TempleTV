/**
 * V2PlayerContainer — Expo/React Native broadcast surface backed by
 * `@workspace/player-core`'s React Native bindings.
 *
 * Architecture:
 *   • Two expo-video players (A and B) are created once per BroadcastBuffer
 *     instance via `useVideoPlayer`. Neither ever recreates; sources are swapped
 *     with `player.replaceAsync(source)` so the decoder is reused.
 *   • Active buffer renders on top (zIndex 2, audible); inactive sits behind
 *     muted, ready for hand-off.
 *   • Real device events (statusChange/sourceLoad/playToEnd/timeUpdate) are
 *     piped back into the FSM as `buffer-ready` / `buffer-ended` /
 *     `buffer-error` so the machine stays in sync with reality.
 *
 * Offline resilience (added May 2026):
 *   • Buffering watchdog: if expo-video's `status === "loading"` stays true for
 *     >15 s while the buffer should be active and playing, the watchdog fires
 *     `buffer-error` so the FSM can attempt recovery instead of silently
 *     stalling on a weak-network segment fetch.
 *   • Network recovery: `useNetworkContext()` drives an immediate
 *     `forceReconnect()` + `notifyOnline()` the moment connectivity is
 *     detected — complementing the AppState-based foreground reconnect.
 *   • Network-aware banner: "You're offline" vs "Reconnecting to broadcast…"
 *     depending on whether the device has no signal or just a dead WS socket.
 *   • timeUpdateEventInterval=0.5 for sub-second stall detection.
 *
 * HLS live-timeline fixes (May 2026):
 *   • Actual-duration clamping: expo-video's `sourceLoad` duration is captured
 *     as ground truth. For VOD HLS, currentTime is clamped to
 *     (actualDurationSecs - HLS_END_GUARD_MS/1000) to prevent out-of-range seeks that
 *     cause AVPlayer/ExoPlayer to snap to the end and immediately fire playToEnd,
 *     creating the "single segment replaying" loop.
 *   • End-guard margin: HLS_END_GUARD_MS (8 000 ms) > HLS_QUICK_FINISH_THRESHOLD_MS
 *     (5 000 ms) guarantees every clamped seek lands ≥ 8 s before the encoded end.
 *   • Live vs VOD detection: if duration is 0/Infinity (live HLS),
 *     player.play() is used instead of setting currentTime — the native player
 *     attaches to the live edge automatically.
 *   • Quick-finish retry corrected: live HLS retries via player.play() (not
 *     setting currentTime to 0), which was seeking to the oldest DVR segment.
 *   • Drift-correction seek guard: small anchor recalibrations (< 8 s drift)
 *     are suppressed when the playhead is already near the target.
 *   • Quick-finish guard: if playToEnd fires within HLS_QUICK_FINISH_THRESHOLD_MS
 *     of playback start, it's a spurious finish (bad seek). Retried up to
 *     HLS_MAX_QUICK_FINISH_RETRIES times before escalating to buffer-ended.
 *   • Live-sync interval: player.play() called every HLS_LIVE_SYNC_INTERVAL_MS on
 *     active+playing HLS buffers to re-latch to the live edge.
 *
 * Memory safety (primary goal — eliminates OOM crashes):
 *   • EXACTLY two VideoPlayer instances per BroadcastBuffer pair, created once
 *     at mount via useVideoPlayer, never recreated. Sources are swapped via
 *     player.replaceAsync() to reuse the decoder without allocating new players.
 *   • On unmount, player.replace(null) drops all decoder/buffer references.
 *   • All player calls guarded by isMountedRef so nothing fires after release.
 *
 * Used by `app/player.tsx` for the live HLS path (v2 broadcast).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, AppState, Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import type { VideoSource } from "expo-video";
import * as Sentry from "@sentry/react-native";
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
 * How long (ms) the buffering state must persist on the active
 * playing buffer before the watchdog declares a network stall and fires
 * `buffer-error`. This triggers the FSM's recovery path (rebind → failover →
 * skip) rather than waiting indefinitely for segment data that may never
 * arrive on a very weak or interrupted connection.
 */
const BUFFERING_STALL_THRESHOLD_MS = 15_000;

/**
 * How many milliseconds of actual playback must occur before a `playToEnd`
 * event is treated as a genuine natural end rather than a spurious "quick finish".
 */
const HLS_QUICK_FINISH_THRESHOLD_MS = 3_000;

// ── Manifest-driven quick-finish threshold cache ─────────────────────────────
const hlsTargetDurationCache = new Map<string, number>();
const HLS_MANIFEST_CACHE_MAX = 256;

/**
 * Minimum margin (ms) between the seek target and the actual encoded end of
 * the VOD HLS content. Must be strictly greater than HLS_QUICK_FINISH_THRESHOLD_MS.
 */
const HLS_END_GUARD_MS = 8_000;

/**
 * Maximum consecutive "quick finish" retries before escalating to buffer-ended.
 */
const HLS_MAX_QUICK_FINISH_RETRIES = 2;

/**
 * Maximum position drift (ms) between a drift-correction seek target and the
 * current playhead before a re-seek is actually issued on VOD HLS.
 */
const HLS_SMALL_DRIFT_SKIP_MS = 8_000;

/**
 * How often (ms) to call `player.play()` on an active+playing HLS buffer
 * to re-latch to the live edge.
 */
const HLS_LIVE_SYNC_INTERVAL_MS = 30_000;

/**
 * How far before the active buffer's end (ms) to emit a `buffer-near-end`
 * event to the machine.
 */
const NEAR_END_PRELOAD_LEAD_MS = 120_000;

/**
 * Maximum time (ms) to wait for expo-video's `statusChange → readyToPlay` to
 * fire after a new source is bound to an active+playing buffer before declaring
 * a load failure.
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
   * from this container's BroadcastBuffer pair.
   */
  suppressEvents?: boolean;
  /**
   * When provided, directly overrides the derived `suppressEvents` value
   * (`minimal || !!suppressEvents`) passed to both BroadcastBuffer instances.
   */
  suppressEventsOverride?: boolean;
  /**
   * Reactive PiP-mode flag from the parent screen.
   */
  isInPip?: boolean;
}

function sourceUrl(state: MobileBufferState, excludeYouTube: boolean): string | null {
  const item = state.item;
  if (!item) return null;
  if ("source" in item) {
    if (excludeYouTube && item.source.kind === "youtube") return null;
    return item.source.url;
  }
  if (excludeYouTube && item.kind === "youtube") return null;
  return item.url;
}

function isHlsSource(state: MobileBufferState): boolean {
  const item = state.item;
  if (!item) return false;
  if ("source" in item) return item.source.kind === "hls";
  return item.kind === "hls";
}

/** Strip query params / tokens from a URL for safe Sentry logging. */
function safeUrl(url: string | null): string {
  if (!url) return "(none)";
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

interface BufferProps {
  bufferId: "A" | "B";
  state: MobileBufferState;
  reportBufferEvent: ReturnType<typeof useV2BroadcastNative>["reportBufferEvent"];
  forceMuted?: boolean;
  excludeYouTube?: boolean;
  suppressEvents?: boolean;
  fsmIsWaiting: boolean;
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
  // ── Mount guard ─────────────────────────────────────────────────────────
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const url = sourceUrl(state, excludeYouTube);
  const isHls = isHlsSource(state);

  // ── expo-video player — created ONCE for the lifetime of this component ──
  // useVideoPlayer is called unconditionally (Rules of Hooks).
  // Source changes use player.replaceAsync(), never a new player instance.
  const player = useVideoPlayer(null, (p) => {
    p.muted = true; // start silent; mute/volume synced in effects below
    p.loop = false;
    p.allowsExternalPlayback = true;
    p.timeUpdateEventInterval = 0.5; // 500 ms, matches old progressUpdateIntervalMillis
  });

  // Release player resources on unmount (drop decoder + buffer refs).
  useEffect(() => {
    return () => {
      try {
        // replace(null) drops the decoder and all media buffer memory.
        player.replace(null, true /* disableWarning */);
      } catch {
        // Ignore — player may already be in an idle state.
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Manifest-driven quick-finish threshold ────────────────────────────────
  const quickFinishThresholdMsRef = useRef(HLS_QUICK_FINISH_THRESHOLD_MS);

  useEffect(() => {
    quickFinishThresholdMsRef.current = HLS_QUICK_FINISH_THRESHOLD_MS;
    if (!isHls || !url) return;

    const cached = hlsTargetDurationCache.get(url);
    if (cached !== undefined) {
      quickFinishThresholdMsRef.current = Math.max(cached * 1_000, HLS_QUICK_FINISH_THRESHOLD_MS);
      return;
    }

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
        if (hlsTargetDurationCache.size >= HLS_MANIFEST_CACHE_MAX) {
          const firstKey = hlsTargetDurationCache.keys().next().value;
          if (firstKey !== undefined) hlsTargetDurationCache.delete(firstKey as string);
        }
        hlsTargetDurationCache.set(url, targetSec);
        quickFinishThresholdMsRef.current = Math.max(targetSec * 1_000, HLS_QUICK_FINISH_THRESHOLD_MS);
      })
      .catch(() => {})
      .finally(() => clearTimeout(timeoutId));

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, isHls]);

  const lastReportedRevision = useRef<number>(-1);
  const nearEndReportedRef = useRef(false);

  const suppressEventsRef = useRef(suppressEvents);
  suppressEventsRef.current = suppressEvents;

  const fsmIsWaitingRef = useRef(fsmIsWaiting);
  fsmIsWaitingRef.current = fsmIsWaiting;

  const emit = useCallback(
    (...args: Parameters<typeof reportBufferEvent>) => {
      if (!suppressEventsRef.current) reportBufferEvent(...args);
    },
    [reportBufferEvent],
  );

  // Track the URL that expo-video successfully loaded.
  const lastLoadedUrlRef = useRef<string | null>(null);

  // Tracks the bindRevision for which sourceLoad has fired.
  const [loadedRevision, setLoadedRevision] = useState(-1);
  const loadedRevisionRef = useRef(-1);
  loadedRevisionRef.current = loadedRevision;
  const bindRevisionRef = useRef(state.bindRevision);
  bindRevisionRef.current = state.bindRevision;

  // ── HLS playback tracking ───────────────────────────────────────────────
  const actualDurationSecsRef = useRef<number | null>(null);
  const playStartMsRef = useRef<number | null>(null);
  const hlsQuickFinishCountRef = useRef(0);

  /**
   * Most-recently reported playback position in seconds.
   * Reset to null on each new bind revision so the initial seek always fires.
   */
  const playheadSecsRef = useRef<number | null>(null);

  /**
   * One-shot flag: set when a same-URL recovery is detected so the play
   * effect uses player.play() instead of setting currentTime (avoids
   * ExoPlayer buffer flush → stall spiral).
   */
  const isSameUrlRecoveryRef = useRef(false);

  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufferingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickFinishRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearBufferingWatchdog = useCallback(() => {
    if (bufferingWatchdogRef.current) {
      clearTimeout(bufferingWatchdogRef.current);
      bufferingWatchdogRef.current = null;
    }
  }, []);

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

  // ── Source loading effect ─────────────────────────────────────────────────
  // When url changes, call player.replaceAsync() to swap the media source
  // WITHOUT creating a new player instance. This preserves the ExoPlayer /
  // AVPlayer instance and its memory, only swapping the media track.
  useEffect(() => {
    if (!isMountedRef.current) return;

    const source: VideoSource = url
      ? isHls
        ? { uri: url, contentType: "hls" as const }
        : { uri: url, contentType: "progressive" as const }
      : null;

    Sentry.addBreadcrumb({
      category: "expo-video",
      message: `[${bufferId}] replaceAsync start`,
      data: { url: safeUrl(url), bindRevision: state.bindRevision },
      level: "info",
    });

    player.replaceAsync(source).then(() => {
      if (!isMountedRef.current) return;
      Sentry.addBreadcrumb({
        category: "expo-video",
        message: `[${bufferId}] replaceAsync success`,
        data: { url: safeUrl(url) },
        level: "info",
      });
    }).catch((err: unknown) => {
      if (!isMountedRef.current) return;
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { "expo-video": bufferId },
        extra: { url: safeUrl(url), op: "replaceAsync" },
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, isHls]);

  // ── Reset all per-bind tracking when a new source is bound ───────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isMountedRef.current) return;
    clearBufferingWatchdog();
    clearQuickFinishRetry();
    playStartMsRef.current = null;
    playheadSecsRef.current = null;
    hlsQuickFinishCountRef.current = 0;
    nearEndReportedRef.current = false;

    // ── Same-URL recovery fast-path ──────────────────────────────────────
    // expo-video (like expo-av) may not re-fire sourceLoad when the same URL
    // is replayed after a failure. If we already loaded this exact URL,
    // immediately fire buffer-ready for the new revision.
    if (url !== null && url === lastLoadedUrlRef.current) {
      isSameUrlRecoveryRef.current = true;
      clearLoadTimeout();
      setLoadedRevision(state.bindRevision);
      if (lastReportedRevision.current !== state.bindRevision) {
        lastReportedRevision.current = state.bindRevision;
        Sentry.addBreadcrumb({
          category: "expo-video",
          message: `[${bufferId}] same-URL recovery: emit buffer-ready`,
          data: { url: safeUrl(url), bindRevision: state.bindRevision },
          level: "info",
        });
        emit({ type: "buffer-ready", bufferId });
      }
    } else {
      isSameUrlRecoveryRef.current = false;
      setLoadedRevision(-1);
      actualDurationSecsRef.current = null;
      clearLoadTimeout();
      // Arm silent-failure load timeout for active+playing buffers.
      if (!suppressEventsRef.current && state.playing && state.active && fsmIsWaitingRef.current && url !== null) {
        loadTimeoutRef.current = setTimeout(() => {
          if (!isMountedRef.current) return;
          loadTimeoutRef.current = null;
          Sentry.addBreadcrumb({
            category: "expo-video",
            message: `[${bufferId}] load timeout fired`,
            data: { url: safeUrl(url), bindRevision: state.bindRevision },
            level: "warning",
          });
          emit({ type: "buffer-error", bufferId, error: "load-timeout" });
        }, LOAD_TIMEOUT_MS);
      }
    }
  }, [state.bindRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cancel all watchdogs and timers on unmount.
  useEffect(() => {
    return () => {
      clearBufferingWatchdog();
      clearQuickFinishRetry();
      clearLoadTimeout();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Stable error emitter ─────────────────────────────────────────────────
  const handleError = useCallback(
    (error: unknown) => {
      if (!isMountedRef.current) return;
      clearBufferingWatchdog();
      clearLoadTimeout();
      if (!fsmIsWaitingRef.current && loadedRevisionRef.current !== bindRevisionRef.current) return;
      const errMsg = error instanceof Error ? error.message : typeof error === "string" ? error : "media-error";
      Sentry.captureException(error instanceof Error ? error : new Error(errMsg), {
        tags: { "expo-video": bufferId },
        extra: { url: safeUrl(url), op: "playback-error" },
      });
      emit({
        type: "buffer-error",
        bufferId,
        error: errMsg,
      });
    },
    [clearBufferingWatchdog, clearLoadTimeout, emit, bufferId, url],
  );

  // ── expo-video event listeners ────────────────────────────────────────────
  // Register all event listeners in a single effect, cleaned up on unmount.
  useEffect(() => {
    if (!isMountedRef.current) return;

    // sourceLoad: equivalent to expo-av's onLoad — fires when metadata is ready
    const sourceLoadSub = player.addListener("sourceLoad", (payload) => {
      if (!isMountedRef.current) return;
      const dur = payload.duration;
      actualDurationSecsRef.current =
        dur !== undefined && isFinite(dur) && dur > 0 ? dur : null;

      lastLoadedUrlRef.current = url;
      const currentBindRev = bindRevisionRef.current;
      setLoadedRevision(currentBindRev);
      clearLoadTimeout();
      clearBufferingWatchdog();

      if (lastReportedRevision.current !== currentBindRev) {
        lastReportedRevision.current = currentBindRev;
        Sentry.addBreadcrumb({
          category: "expo-video",
          message: `[${bufferId}] sourceLoad → buffer-ready`,
          data: { url: safeUrl(url), durationSecs: dur, bindRevision: currentBindRev },
          level: "info",
        });
        emit({ type: "buffer-ready", bufferId });
      }
    });

    // statusChange: replaces parts of onPlaybackStatusUpdate and onError
    const statusChangeSub = player.addListener("statusChange", (payload) => {
      if (!isMountedRef.current) return;
      const { status, error } = payload;

      if (status === "error") {
        clearBufferingWatchdog();
        clearLoadTimeout();
        if (!fsmIsWaitingRef.current && loadedRevisionRef.current !== bindRevisionRef.current) return;
        const errMsg = error?.message ?? "media-error";
        Sentry.captureException(new Error(errMsg), {
          tags: { "expo-video": bufferId },
          extra: { url: safeUrl(url), op: "statusChange-error", status },
        });
        emit({ type: "buffer-error", bufferId, error: errMsg });
        return;
      }

      if (status === "readyToPlay") {
        // Secondary buffer-ready signal (equivalent to onReadyForDisplay).
        // onFirstFrameRender on VideoView is the primary; this catches cases
        // where sourceLoad fired without emitting buffer-ready (revision mismatch).
        if (url) lastLoadedUrlRef.current = url;
        clearLoadTimeout();
        clearBufferingWatchdog();
        const currentBindRev = bindRevisionRef.current;
        setLoadedRevision(currentBindRev);
        if (lastReportedRevision.current !== currentBindRev) {
          lastReportedRevision.current = currentBindRev;
          Sentry.addBreadcrumb({
            category: "expo-video",
            message: `[${bufferId}] statusChange readyToPlay → buffer-ready`,
            data: { url: safeUrl(url), bindRevision: currentBindRev },
            level: "info",
          });
          emit({ type: "buffer-ready", bufferId });
        }
      }

      // Buffering watchdog: arm when actively loading (status === "loading")
      // while this is the active+playing buffer.
      if (status === "loading" && state.playing && state.active && !suppressEventsRef.current && loadedRevisionRef.current === bindRevisionRef.current) {
        if (!bufferingWatchdogRef.current) {
          bufferingWatchdogRef.current = setTimeout(() => {
            if (!isMountedRef.current) return;
            bufferingWatchdogRef.current = null;
            Sentry.addBreadcrumb({
              category: "expo-video",
              message: `[${bufferId}] buffering stall timeout`,
              data: { url: safeUrl(url) },
              level: "warning",
            });
            emit({ type: "buffer-error", bufferId, error: "buffering-timeout" });
          }, BUFFERING_STALL_THRESHOLD_MS);
        }
      } else if (status !== "loading") {
        clearBufferingWatchdog();
      }
    });

    // playingChange: replaces isPlaying fast-path in onPlaybackStatusUpdate
    const playingChangeSub = player.addListener("playingChange", (payload) => {
      if (!isMountedRef.current) return;
      const { isPlaying } = payload;

      // isPlaying fast-path: if playing but buffer-ready never reported, fire it now
      if (isPlaying && lastReportedRevision.current !== bindRevisionRef.current) {
        if (url) lastLoadedUrlRef.current = url;
        const currentBindRev = bindRevisionRef.current;
        setLoadedRevision(currentBindRev);
        lastReportedRevision.current = currentBindRev;
        clearLoadTimeout();
        Sentry.addBreadcrumb({
          category: "expo-video",
          message: `[${bufferId}] playingChange isPlaying=true → buffer-ready (fast-path)`,
          data: { url: safeUrl(url), bindRevision: currentBindRev },
          level: "info",
        });
        emit({ type: "buffer-ready", bufferId });
      }

      // poster lift: first frame is on screen when actively playing
      if (isPlaying) {
        onVideoReady?.();
      }
    });

    // timeUpdate: replaces onPlaybackStatusUpdate for position tracking and
    // near-end preload trigger.
    const timeUpdateSub = player.addListener("timeUpdate", (payload) => {
      if (!isMountedRef.current) return;
      const positionSecs = payload.currentTime;

      // Track playhead for drift-correction seek guard
      if (typeof positionSecs === "number" && positionSecs > 0) {
        playheadSecsRef.current = positionSecs;
      }

      // Near-end preload trigger
      if (
        state.active &&
        !suppressEventsRef.current &&
        !nearEndReportedRef.current &&
        positionSecs > 0
      ) {
        const durationSecs = actualDurationSecsRef.current;
        if (durationSecs !== null && isFinite(durationSecs) && durationSecs > 0) {
          const remainingMs = (durationSecs - positionSecs) * 1000;
          if (remainingMs > 0 && remainingMs < NEAR_END_PRELOAD_LEAD_MS) {
            nearEndReportedRef.current = true;
            emit({ type: "buffer-near-end", bufferId });
          }
        }
      }

      // Hero preview permanent-mute enforcement on position ticks
      if (forceMuted && !player.muted) {
        try {
          player.muted = true;
          player.volume = 0;
        } catch {
          // Ignore — player may be transitioning
        }
      }

      // Buffering watchdog: arm if player is not producing frames
      // (bufferedPosition === 0 while supposed to be playing).
      // Equivalently, disarm if we're actually getting position advances.
      if (positionSecs > 0) {
        clearBufferingWatchdog();
      }
    });

    // playToEnd: replaces didJustFinish in onPlaybackStatusUpdate
    const playToEndSub = player.addListener("playToEnd", () => {
      if (!isMountedRef.current) return;
      clearBufferingWatchdog();

      const positionSecs = playheadSecsRef.current ?? 0;
      if (positionSecs <= 0) {
        // Zero-play finish — treat as spurious, ignore
        return;
      }

      if (isHls && state.active) {
        const playDurationMs =
          playStartMsRef.current !== null
            ? Date.now() - playStartMsRef.current
            : Infinity;
        if (playDurationMs < quickFinishThresholdMsRef.current) {
          hlsQuickFinishCountRef.current += 1;
          if (hlsQuickFinishCountRef.current > HLS_MAX_QUICK_FINISH_RETRIES) {
            hlsQuickFinishCountRef.current = 0;
            Sentry.addBreadcrumb({
              category: "expo-video",
              message: `[${bufferId}] quick-finish exhausted retries → buffer-ended`,
              data: { url: safeUrl(url), playDurationMs },
              level: "warning",
            });
            emit({ type: "buffer-ended", bufferId });
          } else {
            const actualSecRetry = actualDurationSecsRef.current;
            const isLiveRetry = actualSecRetry === null || !isFinite(actualSecRetry) || actualSecRetry <= 0;
            playStartMsRef.current = Date.now();
            Sentry.addBreadcrumb({
              category: "expo-video",
              message: `[${bufferId}] quick-finish retry ${hlsQuickFinishCountRef.current}`,
              data: { url: safeUrl(url), playDurationMs, isLiveRetry },
              level: "info",
            });
            quickFinishRetryTimerRef.current = setTimeout(() => {
              if (!isMountedRef.current) return;
              quickFinishRetryTimerRef.current = null;
              try {
                if (isLiveRetry) {
                  player.play();
                } else {
                  player.currentTime = 0;
                  player.play();
                }
              } catch (retryErr) {
                emit({ type: "buffer-error", bufferId, error: "hls-retry-failed" });
                Sentry.captureException(retryErr instanceof Error ? retryErr : new Error(String(retryErr)), {
                  tags: { "expo-video": bufferId },
                  extra: { url: safeUrl(url), op: "quick-finish-retry" },
                });
              }
            }, 1_000);
          }
          return;
        }
        hlsQuickFinishCountRef.current = 0;
      }

      Sentry.addBreadcrumb({
        category: "expo-video",
        message: `[${bufferId}] playToEnd → buffer-ended`,
        data: { url: safeUrl(url) },
        level: "info",
      });
      emit({ type: "buffer-ended", bufferId });
    });

    return () => {
      sourceLoadSub.remove();
      statusChangeSub.remove();
      playingChangeSub.remove();
      timeUpdateSub.remove();
      playToEndSub.remove();
    };
  // Re-register listeners when player, url, isHls, or state identity changes.
  // state.active and state.playing are read via closure from the outer scope.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, url, isHls, bufferId, emit, clearBufferingWatchdog, clearLoadTimeout, onVideoReady, forceMuted, state.active, state.playing]);

  // ── Play effect ─────────────────────────────────────────────────────────
  // Drive playback against the imperative expo-video API.
  useEffect(() => {
    if (!isMountedRef.current) return;
    if (!url) return;

    if (state.playing) {
      if (loadedRevision !== state.bindRevision) return; // not ready yet

      // Hero preview: re-assert mute BEFORE every play call
      if (forceMuted) {
        try {
          player.muted = true;
          player.volume = 0;
        } catch {
          // Ignore
        }
      }

      try {
        if (isHls) {
          const actualSecs = actualDurationSecsRef.current;
          const isLiveHls = actualSecs === null || !isFinite(actualSecs) || actualSecs <= 0;

          if (isLiveHls || isSameUrlRecoveryRef.current) {
            isSameUrlRecoveryRef.current = false;
            playStartMsRef.current = Date.now();
            Sentry.addBreadcrumb({
              category: "expo-video",
              message: `[${bufferId}] play (live HLS / same-URL recovery)`,
              data: { url: safeUrl(url) },
              level: "info",
            });
            player.play();
          } else {
            // VOD HLS: clamp and drift-guard
            const clampedSecs = Math.min(
              state.positionSecs,
              Math.max(0, actualSecs - HLS_END_GUARD_MS / 1000),
            );
            const currentPlayheadSecs = playheadSecsRef.current;
            const nearTarget =
              currentPlayheadSecs !== null &&
              playStartMsRef.current !== null &&
              Math.abs(clampedSecs - currentPlayheadSecs) < HLS_SMALL_DRIFT_SKIP_MS / 1000;

            if (!nearTarget) {
              playStartMsRef.current = Date.now();
              Sentry.addBreadcrumb({
                category: "expo-video",
                message: `[${bufferId}] play VOD HLS seek`,
                data: { url: safeUrl(url), clampedSecs },
                level: "info",
              });
              player.currentTime = clampedSecs;
              player.play();
            }
          }
        } else {
          // MP4 / DASH / non-HLS path
          const targetSecs = state.positionSecs;
          const currentPlayheadSecs = playheadSecsRef.current;
          const nearTarget =
            currentPlayheadSecs !== null &&
            playStartMsRef.current !== null &&
            Math.abs(targetSecs - currentPlayheadSecs) < HLS_SMALL_DRIFT_SKIP_MS / 1000;

          if (!nearTarget) {
            playStartMsRef.current = Date.now();
            Sentry.addBreadcrumb({
              category: "expo-video",
              message: `[${bufferId}] play MP4 seek`,
              data: { url: safeUrl(url), targetSecs },
              level: "info",
            });
            player.currentTime = targetSecs;
            player.play();
          }
        }
      } catch (playErr) {
        Sentry.captureException(playErr instanceof Error ? playErr : new Error(String(playErr)), {
          tags: { "expo-video": bufferId },
          extra: { url: safeUrl(url), op: "play" },
        });
        emit({ type: "buffer-error", bufferId, error: "play-failed" });
      }
    } else {
      try {
        player.pause();
      } catch {
        // Ignore pause errors — player may already be paused
      }
    }
  }, [state.playing, state.positionSecs, state.bindRevision, loadedRevision, url, bufferId, emit, isHls, player, forceMuted]);

  // ── HLS live-sync interval ──────────────────────────────────────────────
  useEffect(() => {
    if (!isHls || !state.playing || !state.active) return;
    const t = setInterval(() => {
      if (!isMountedRef.current) return;
      try {
        if (forceMuted) {
          player.muted = true;
          player.volume = 0;
        }
        player.play();
      } catch {
        // Ignore — player may be transitioning
      }
    }, HLS_LIVE_SYNC_INTERVAL_MS);
    return () => clearInterval(t);
  }, [isHls, state.playing, state.active, forceMuted, player]);

  // ── Mute sync effect ─────────────────────────────────────────────────────
  const effectiveMuted = forceMuted || state.muted;
  useEffect(() => {
    if (!isMountedRef.current) return;
    try {
      player.muted = effectiveMuted;
      if (forceMuted) player.volume = 0;
      else player.volume = 1;
    } catch {
      // Ignore — player may be transitioning
    }
  }, [effectiveMuted, forceMuted, player]);

  // ── Early return: no URL — render empty placeholder ───────────────────────
  if (!url) {
    return <View style={[styles.video, { zIndex: state.active ? 2 : 1 }]} />;
  }

  return (
    <VideoView
      player={player}
      style={[styles.video, { zIndex: state.active ? 2 : 1 }]}
      contentFit="contain"
      nativeControls={false}
      allowsPictureInPicture={false}
      onFirstFrameRender={() => {
        // Primary "first frame visible" signal — equivalent to onReadyForDisplay.
        if (!isMountedRef.current) return;
        if (url) lastLoadedUrlRef.current = url;
        clearLoadTimeout();
        clearBufferingWatchdog();
        const currentBindRev = bindRevisionRef.current;
        setLoadedRevision(currentBindRev);
        if (lastReportedRevision.current !== currentBindRev) {
          lastReportedRevision.current = currentBindRev;
          Sentry.addBreadcrumb({
            category: "expo-video",
            message: `[${bufferId}] onFirstFrameRender → buffer-ready`,
            data: { url: safeUrl(url), bindRevision: currentBindRev },
            level: "info",
          });
          emit({ type: "buffer-ready", bufferId });
        }
        onVideoReady?.();
      }}
    />
  );
});

// ── Midnight Prayers channel switching (module-level singleton) ───────────────

interface MPScheduleConfig {
  enabled: boolean;
  startHour: number;
  endHour: number;
  timezone?: string;
}

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
  const [, rerender] = useState(0);

  useEffect(() => {
    const singleton = _getOrCreateMpSingleton(mainBaseUrl);
    const notify = () => rerender((n) => n + 1);
    singleton.listeners.add(notify);
    return () => {
      singleton.listeners.delete(notify);
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

  // Audio session gate
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

  const { isOnline, justRecovered } = useNetworkContext();

  const fatalFiredRef = useRef(false);
  const prevSnapshotStateRef = useRef(snapshot.state);
  useEffect(() => {
    const prevState = prevSnapshotStateRef.current;
    prevSnapshotStateRef.current = snapshot.state;

    if (__DEV__ && prevState !== snapshot.state) {
      const label = minimal ? "hero" : suppressEvents ? "inline/suppressed" : "primary";
      console.log(
        `[V2PlayerContainer] FSM: ${prevState ?? "—"} → ${snapshot.state}`,
        `(${label}, connected=${connected}, baseUrl=${baseUrl})`,
      );
      if (snapshot.state === "FATAL") {
        console.error(
          "[V2PlayerContainer] FSM entered FATAL",
          `attempts=${snapshot.fatalAttemptCount ?? 0}`,
          `firedOnFatal=${!suppressEvents && !minimal}`,
        );
      }
    }

    if (snapshot.state === "FATAL" && prevState !== "FATAL" && !fatalFiredRef.current) {
      fatalFiredRef.current = true;
      if (!suppressEvents && !minimal) onFatal?.();
    }
    if (snapshot.state !== "FATAL") fatalFiredRef.current = false;
  }, [snapshot.state, onFatal, suppressEvents, minimal, connected, baseUrl]);

  // RN AppState bridge
  useEffect(() => {
    let last = AppState.currentState;
    let mounted = true;
    const sub = AppState.addEventListener("change", (next) => {
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

  // Network recovery bridge
  useEffect(() => {
    if (justRecovered) {
      notifyOnline();
      forceReconnect();
      if (!suppressEvents) {
        const base = effectiveBaseUrl.replace(/\/api\/broadcast-v2$/, "");
        void flushTelemetryBuffer(base);
      }
    }
  }, [justRecovered, notifyOnline, forceReconnect, suppressEvents, effectiveBaseUrl]);

  // ── Playback telemetry ────────────────────────────────────────────────────
  const snapshotStateRef = useRef(snapshot.state);
  snapshotStateRef.current = snapshot.state;

  useEffect(() => {
    if (suppressEvents) return;

    const INTERVAL_MS = 60_000;
    const id = setInterval(() => {
      if (snapshotStateRef.current === "PLAYING") {
        enqueueTelemetry({ platform: "mobile", decoded: 60 * 30, dropped: 0 });
        const base = effectiveBaseUrl.replace(/\/api\/broadcast-v2$/, "");
        void flushTelemetryBuffer(base);
      }
    }, INTERVAL_MS);

    return () => clearInterval(id);
  }, [suppressEvents, effectiveBaseUrl]);

  const server = snapshot.lastServerSnapshot;

  // ── Loading phase tracker ─────────────────────────────────────────────────
  const PHASE_STEP_MS = 5_000;
  const [loadingPhase, setLoadingPhase] = useState(0);

  // ── FATAL retry countdown ─────────────────────────────────────────────────
  const [fatalRetrySecsLeft, setFatalRetrySecsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (snapshot.state !== "FATAL" || snapshot.fatalEnteredAtMs == null) {
      setFatalRetrySecsLeft(null);
      return;
    }
    // machine.ts: FATAL_AUTO_RECOVERY_MS = 10_000, FATAL_BACKOFF_MAX_MS = 240_000
    // Schedule: 10s → 20s → 40s → 80s → 160s → 240s (cap)
    const backoffMs = Math.min(
      10_000 * Math.pow(2, Math.max(0, (snapshot.fatalAttemptCount ?? 1) - 1)),
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.state]);

  // ── Active buffer identity ────────────────────────────────────────────────
  const activeBufferId = buffers.A.active ? "A" : "B";

  // ── YouTube-override detection ────────────────────────────────────────────
  const activeItem = buffers[activeBufferId].item;
  const isYouTubeOverride =
    snapshot.state === "LIVE_OVERRIDE_ACTIVE" &&
    (
      (activeItem !== null &&
       !("source" in activeItem) &&
       activeItem.kind === "youtube") ||
      server?.override?.kind === "youtube"
    );

  // ── PiP buffer-swap re-entry (Android) ───────────────────────────────
  const prevActiveBufferIdRef = useRef<"A" | "B">(activeBufferId);
  useEffect(() => {
    if (prevActiveBufferIdRef.current === activeBufferId) return;
    prevActiveBufferIdRef.current = activeBufferId;
    if (!isInPictureInPictureMode()) return;
    updatePipParams(16, 9, true, false, null, true).catch(() => {});
  }, [activeBufferId]);

  // ── YouTube-override-in-PiP exit ──────────────────────────────────────
  const youtubeInPipExitFiredRef = useRef(false);
  useEffect(() => {
    if (minimal || suppressEvents) return;
    const inPip = isInPip ?? isInPictureInPictureMode();
    if (isYouTubeOverride && inPip) {
      if (!youtubeInPipExitFiredRef.current) {
        youtubeInPipExitFiredRef.current = true;
        onFatal?.();
      }
    } else {
      youtubeInPipExitFiredRef.current = false;
    }
  }, [isYouTubeOverride, isInPip, minimal, suppressEvents, onFatal]);

  // ── First-frame readiness gate ────────────────────────────────────────
  const [videoReady, setVideoReady] = useState(false);
  const handleVideoReady = useCallback(() => setVideoReady(true), []);
  useEffect(() => {
    const isPlayingFamily =
      snapshot.state === "PLAYING" ||
      snapshot.state === "HANDOFF" ||
      snapshot.state === "PREPARING_NEXT" ||
      snapshot.state === "LIVE_OVERRIDE_ACTIVE";
    if (!isPlayingFamily) setVideoReady(false);
  }, [snapshot.state]);
  const activeBindRevision = buffers[activeBufferId].bindRevision;
  useEffect(() => {
    setVideoReady(false);
  }, [activeBindRevision]);

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
  interface OverlayContent {
    main: string;
    sub: string;
    showSpinner: boolean;
    upNext?: string;
    youtubeUrl?: string | null;
    youtubeThumbnailUrl?: string | null;
    onRetry?: () => void;
  }
  const overlayContent = useMemo<OverlayContent | null>(() => {
    if (isYouTubeOverride) {
      const overrideTitle = server?.override?.title;
      const overrideUrl = server?.override?.url ?? null;
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

    if (snapshot.state === "OFFLINE_HOLD") {
      return {
        main: isOnline ? "Reconnecting…" : "No Internet Connection",
        sub: isOnline
          ? "Re-establishing broadcast link"
          : "Will reconnect automatically when signal returns",
        showSpinner: true,
      };
    }

    if (snapshot.state === "BOOTSTRAP" && !server) {
      return {
        main: "Connecting to Broadcast",
        sub: "Establishing secure connection…",
        showSpinner: true,
        onRetry: loadingPhase >= 2 ? forceRebind : undefined,
      };
    }

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

    if (snapshot.state === "LIVE_OVERRIDE_ACTIVE" && videoReady) return null;

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

    return null;
  }, [snapshot.state, server, isOnline, isYouTubeOverride, videoReady, forceRebind, fatalRetrySecsLeft, loadingPhase]);

  const posterUrl = useMemo(() => {
    const t = server?.current?.thumbnailUrl ?? server?.next?.thumbnailUrl ?? null;
    return t && t.length > 0 ? t : null;
  }, [server]);

  const posterFadeAnim = useRef(new Animated.Value(1)).current;
  const prevPosterUrl = useRef<string | null>(null);

  const isTransientState =
    snapshot.state === "PREPARING_ACTIVE" ||
    snapshot.state === "RECOVERING_PRIMARY" ||
    snapshot.state === "RECOVERING_FAILOVER" ||
    snapshot.state === "SKIP_PENDING" ||
    snapshot.state === "SYNCING" ||
    (snapshot.state === "LIVE_OVERRIDE_ACTIVE" && !videoReady) ||
    (snapshot.state === "BOOTSTRAP" && !!server);

  const showPosterContent = (!!overlayContent || !videoReady || isTransientState) && !!posterUrl;

  useEffect(() => {
    if (posterUrl !== prevPosterUrl.current) {
      prevPosterUrl.current = posterUrl;
      posterFadeAnim.stopAnimation();
      posterFadeAnim.setValue(1);
      return;
    }
    if (showPosterContent) {
      posterFadeAnim.stopAnimation();
      posterFadeAnim.setValue(1);
    } else if (posterUrl) {
      Animated.timing(posterFadeAnim, {
        toValue: 0,
        duration: 350,
        useNativeDriver: true,
      }).start();
    }
  }, [showPosterContent, posterUrl, posterFadeAnim]);

  const fsmIsWaiting =
    snapshot.state === "PREPARING_ACTIVE" ||
    snapshot.state === "RECOVERING_PRIMARY" ||
    snapshot.state === "RECOVERING_FAILOVER" ||
    snapshot.state === "LIVE_OVERRIDE_ACTIVE";

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

  const bannerText = isOnline
    ? "Reconnecting to broadcast…"
    : "You're offline — will reconnect automatically";

  const suppressBanner =
    !!overlayContent ||
    isTransientState ||
    snapshot.state === "PLAYING" ||
    snapshot.state === "HANDOFF" ||
    snapshot.state === "PREPARING_NEXT" ||
    snapshot.state === "LIVE_OVERRIDE_ACTIVE";

  return (
    <View style={styles.root}>
      {posterUrl && !minimal && (
        <Image
          source={{ uri: posterUrl }}
          style={styles.ambient}
          blurRadius={25}
          accessible={false}
        />
      )}

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

      {!videoReady && !overlayContent && !minimal && !!posterUrl && (
        <View style={styles.firstFrameLoading} pointerEvents="none">
          <ActivityIndicator color="rgba(255,255,255,0.75)" size="small" />
        </View>
      )}

      {!videoReady && !overlayContent && !minimal && !posterUrl && (
        <View style={styles.firstFrameLoadingCentered} pointerEvents="none">
          <ActivityIndicator color="rgba(255,255,255,0.85)" size="large" />
        </View>
      )}

      {isTransientState && !overlayContent && !minimal && (
        <View style={styles.tuningIndicator} pointerEvents="none">
          <Animated.View style={[styles.tuningDot, { opacity: tuningPulse }]} />
          <Text style={styles.tuningDotLabel}>LIVE</Text>
        </View>
      )}

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
