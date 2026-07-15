import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as Sentry from "@sentry/react-native";
import { useColors } from "@/hooks/useColors";
import { usePlayer } from "@/context/PlayerContext";
import {
  loadAndPlayTrack,
  pauseTrackPlayer,
  resumeTrackPlayer,
  seekTrackPlayer,
  stopTrackPlayer,
  isTrackPlayerSetup,
} from "@/services/nowPlaying";
import { postPlaybackTelemetryDelta } from "@/services/broadcast";
import { useVideoPlayer, VideoView } from "expo-video";
import type { VideoPlayer as ExpoVideoPlayer } from "expo-video";

/** Strip query params/tokens from a URL for safe Sentry reporting. */
function sanitizeUrl(url: string): string {
  try { return new URL(url).origin + new URL(url).pathname; } catch { return url.split("?")[0] ?? url; }
}

/** Minimal interface for an hls.js Hls instance (lazily required on web). */
interface HlsInstance {
  loadSource(url: string): void;
  attachMedia(media: HTMLVideoElement): void;
  detachMedia(): void;
  destroy(): void;
  startLoad(startPosition?: number): void;
  recoverMediaError(): void;
  on(event: string, callback: (event: unknown, data?: unknown) => void): void;
  off(event: string, callback: (event: unknown, data?: unknown) => void): void;
}
interface HlsConstructor {
  new (config?: Record<string, unknown>): HlsInstance;
  isSupported?(): boolean;
  default?: HlsConstructor;
  ErrorTypes?: Record<string, string>;
}

function LocalAudioModeCard({
  thumbnailUrl,
  title,
  isPlaying,
  loading,
  onToggle,
}: {
  thumbnailUrl?: string;
  title?: string;
  isPlaying: boolean;
  loading: boolean;
  onToggle?: () => void;
}) {
  const c = useColors();
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const waveAnims = [
    useRef(new Animated.Value(0.3)).current,
    useRef(new Animated.Value(0.6)).current,
    useRef(new Animated.Value(0.4)).current,
    useRef(new Animated.Value(0.8)).current,
    useRef(new Animated.Value(0.5)).current,
  ];

  useEffect(() => {
    if (!isPlaying) {
      rotateAnim.stopAnimation();
      waveAnims.forEach((a) => a.stopAnimation());
      return;
    }
    const ND = Platform.OS !== "web";
    const rotate = Animated.loop(
      Animated.timing(rotateAnim, { toValue: 1, duration: 12000, useNativeDriver: ND }),
    );
    const waves = waveAnims.map((anim, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 80),
          Animated.timing(anim, { toValue: 1, duration: 400 + i * 60, useNativeDriver: ND }),
          Animated.timing(anim, { toValue: 0.15, duration: 400 + i * 60, useNativeDriver: ND }),
        ]),
      ),
    );
    rotate.start();
    waves.forEach((w) => w.start());
    return () => {
      rotate.stop();
      waves.forEach((w) => w.stop());
    };
  }, [isPlaying]);

  const spin = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });

  return (
    <View style={[audioStyles.card, { backgroundColor: "rgba(21,19,26,0.95)" }]}>
      <View style={[audioStyles.badge, { backgroundColor: "rgba(106,13,173,0.25)", borderColor: "rgba(106,13,173,0.4)" }]}>
        <Feather name="headphones" size={11} color="#B47FEB" />
        <Text style={[audioStyles.badgeText, { color: "#B47FEB" }]}>AUDIO MODE</Text>
      </View>

      <Animated.View style={{ transform: [{ rotate: spin }] }}>
        <View style={audioStyles.discOuter}>
          <View style={audioStyles.discMid}>
            {thumbnailUrl ? (
              <Image source={{ uri: thumbnailUrl }} style={audioStyles.discImage} />
            ) : (
              <View style={[audioStyles.discImage, { backgroundColor: "rgba(106,13,173,0.2)", alignItems: "center", justifyContent: "center" }]}>
                <Feather name="radio" size={28} color="rgba(106,13,173,0.6)" />
              </View>
            )}
            <View style={[audioStyles.discCenter, { backgroundColor: "#000" }]}>
              {loading ? (
                <ActivityIndicator color="#6A0DAD" size="small" />
              ) : (
                <Feather name={isPlaying ? "headphones" : "pause"} size={14} color="#6A0DAD" />
              )}
            </View>
          </View>
        </View>
      </Animated.View>

      {isPlaying && (
        <View style={audioStyles.waveRow}>
          {waveAnims.map((anim, i) => (
            <Animated.View key={i} style={[audioStyles.waveBar, { opacity: anim }]} />
          ))}
        </View>
      )}

      {title ? (
        <View style={audioStyles.meta}>
          <Text style={audioStyles.metaTitle} numberOfLines={2}>{title}</Text>
          <Text style={audioStyles.metaArtist}>JCTM</Text>
        </View>
      ) : null}

      {onToggle && (
        <Pressable
          onPress={onToggle}
          style={({ pressed }: { pressed: boolean }) => [audioStyles.switchBtn, { opacity: pressed ? 0.7 : 1 }]}
        >
          <Feather name="video" size={13} color="#B47FEB" />
          <Text style={audioStyles.switchBtnText}>Switch to Video</Text>
        </Pressable>
      )}
    </View>
  );
}

interface LocalVideoPlayerProps {
  videoUrl: string;
  hlsMasterUrl?: string;
  thumbnailUrl?: string;
  title?: string;
  autoPlay?: boolean;
  onEnd?: () => void;
  onError?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  startPositionMs?: number;
  /** Use COVER resize mode (cinematic crop) instead of CONTAIN. Useful for broadcast/live hero-style presentation. */
  coverMode?: boolean;
  /** Override the computed player height. When not provided, the component derives height from screen width at 9:16. */
  playerHeightOverride?: number;
  /**
   * Round 6: when true, this player is rendering a "live broadcast" stream
   * (a station-driven queue item, not an on-demand sermon the user chose).
   * Native and web chrome — the timeline scrubber, time readout, and
   * fullscreen seek hotkeys — are suppressed so the broadcast cannot be
   * scrubbed or rewound. Play/pause is still possible via the in-app
   * overlay; the directive only forbids time-position UI and seek.
   */
  isBroadcastLive?: boolean;
  /**
   * Round 7 (broadcast continuity): URL of the *next* item the broadcast
   * queue will air after `videoUrl`. When provided, the web player loads
   * it silently into the inactive A/B slot so the eventual cut feels like
   * a real TV channel transition — no spinner, no black frame, no
   * manifest fetch delay. Safe to omit for non-broadcast playback.
   */
  nextVideoUrl?: string;
  nextHlsMasterUrl?: string;
  /**
   * Engine-level backup HLS URL. When provided, the parent player
   * (player.tsx `handleBroadcastError`) will redirect to this URL before
   * running the broken-item skip. This prop is forwarded here so future
   * in-component failover logic (web slot swap, native reload) can access
   * the value without threading it through additional callbacks.
   */
  failoverHlsUrl?: string;
  /** Called periodically during playback with current position and duration in seconds. */
  onProgress?: (positionSecs: number, durationSecs: number) => void;
  /**
   * Called once when the video loads and its natural dimensions are known.
   * Receives the aspect ratio (width / height). Use this to dynamically resize
   * the player shell to match the actual content — avoids hardcoded 16:9 for
   * vertical, square, or ultrawide sources.
   */
  onAspectRatioChange?: (ratio: number) => void;
  /**
   * When true the container grows to fill its parent (flex:1) rather than
   * using a fixed height derived from playerHeightOverride / screen width.
   * Use this inside a full-screen Modal where the parent already constrains
   * the height and passing a pixel value would fight the layout engine.
   */
  fillContainer?: boolean;
  /**
   * Playback rate multiplier (0.5–2.0). Default 1.0 (normal speed).
   * Only applies to native (iOS/Android) expo-av Video. Ignored on web
   * (web applies rate directly via the HTMLVideoElement.playbackRate API).
   * Ignored for live/broadcast content — seeking and rate changes are
   * suppressed on live surfaces intentionally.
   */
  rate?: number;
}

export function LocalVideoPlayer({
  videoUrl,
  hlsMasterUrl,
  thumbnailUrl,
  title,
  autoPlay = true,
  onEnd,
  onError,
  onPlay,
  onPause,
  startPositionMs = 0,
  coverMode = false,
  playerHeightOverride,
  isBroadcastLive = false,
  nextVideoUrl,
  nextHlsMasterUrl,
  failoverHlsUrl: _failoverHlsUrl,
  onProgress,
  onAspectRatioChange,
  fillContainer = false,
  rate = 1.0,
}: LocalVideoPlayerProps) {
  const effectiveUrl = hlsMasterUrl || videoUrl;
  // Computed next-item URL for the inactive A/B slot. Mirrors
  // `effectiveUrl` selection: prefer HLS, fall back to plain MP4.
  const effectiveNextUrl = nextHlsMasterUrl || nextVideoUrl || null;
  const c = useColors();
  const { width } = useWindowDimensions();
  const { updatePlayback, playerPlayRef, playerPauseRef, playerSeekRef, isPlaying, dataSaver, isRadioMode, toggleRadioMode } = usePlayer();
  const [loading, setLoading] = useState(true);
  const retryCountRef = useRef(0);
  // expo-video: useVideoPlayer must be called unconditionally (Rules of Hooks).
  // Pass null as initial source; source is set via player.replaceAsync() in an effect below.
  const nativePlayer = useVideoPlayer(null, (p) => {
    p.allowsExternalPlayback = true;
    p.timeUpdateEventInterval = 0.5; // replaces progressUpdateIntervalMillis={500}
    p.loop = false;
  });
  const isMountedRef = useRef(true);
  const transitionOpacity = useRef(new Animated.Value(1)).current;
  const rntp = Platform.OS !== "web" && isTrackPlayerSetup();

  // ── Web A/B double-buffered playback ───────────────────────────────────
  // Two <video> elements stay mounted at all times so a queue advance can
  // be a 1-frame cut to a slot that already has the upcoming item primed,
  // rather than a teardown-and-reload of the only video element. The
  // active slot is visible / audible; the inactive slot is hidden /
  // muted but holding a decoded first frame of `effectiveNextUrl`.
  const webVideoRefA = useRef<HTMLVideoElement | null>(null);
  const webVideoRefB = useRef<HTMLVideoElement | null>(null);
  const webHlsRefA = useRef<HlsInstance | null>(null);
  const webHlsRefB = useRef<HlsInstance | null>(null);
  // Per-slot fatal-error retry budget for hls.js. Reset to 0 each time a
  // fresh URL is loaded into the slot; capped at 3 attempts per fresh load
  // before escalating to onError. Mirrors the TV player's recovery budget.
  const webRetryRefA = useRef(0);
  const webRetryRefB = useRef(0);
  const webLoadedUrlA = useRef<string | null>(null);
  const webLoadedUrlB = useRef<string | null>(null);
  const [webActiveSlot, setWebActiveSlot] = useState<"A" | "B">("A");
  const webActiveSlotRef = useRef<"A" | "B">("A");
  useEffect(() => { webActiveSlotRef.current = webActiveSlot; }, [webActiveSlot]);
  // Compatibility shim: external callers (player context play/pause/seek
  // refs) need a stable handle to "the currently visible video element".
  // We keep this in sync with the active slot below.
  const webVideoRef = useRef<HTMLVideoElement | null>(null);
  // Web-only: watchdog timer that surfaces a stalled-load failure if the
  // <video> element makes no progress within WEB_LOAD_WATCHDOG_MS. Without
  // this, CORS-blocked or stalled requests would hang the loading veil
  // indefinitely. Mirrors the TV HlsVideoPlayer's watchdog behaviour.
  const webLoadWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const WEB_LOAD_WATCHDOG_MS = 15_000;
  const [webNeedsPlayGesture, setWebNeedsPlayGesture] = useState(false);

  // ── Network-aware "Reconnecting…" state (web only) ─────────────────────
  // Set when the active web slot's hls.js engine fires a NETWORK_ERROR
  // while `navigator.onLine === false`. While true, the player keeps the
  // last decoded frame visible (no veil flicker, no skip), surfaces a
  // small "Reconnecting…" pill, and waits for the `online` event below
  // to reset retries and call hls.startLoad() on the active engine.
  // Native (expo-av) handles this via the broader handleBroadcastError
  // gate in app/player.tsx, which is already isOnline-aware.
  const [webOfflineWaiting, setWebOfflineWaiting] = useState(false);
  const webOfflineWaitingRef = useRef(false);
  useEffect(() => { webOfflineWaitingRef.current = webOfflineWaiting; }, [webOfflineWaiting]);
  const webOfflineRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // (online-recovery effect declared after the slot ref helpers below,
  // because it needs setWebRetries which is declared down there.)

  // ── Mid-playback stall watchdog ────────────────────────────────────────
  // Distinct from the web-load watchdog above (which only catches "video
  // never started loading at all"). This one catches the third failure mode:
  // playback HAS started, the video element thinks it's playing, but no
  // frames are advancing. The browser/expo-av won't fire `error` for this —
  // it's just a quiet stall (slow CDN, momentary network dip, edge of a
  // corrupt segment). Without intervention the viewer sees a frozen frame
  // forever and the "channel" effectively stops broadcasting.
  //
  // The watchdog tracks the last observed positionMillis and the wall-clock
  // time at which it changed. A separate 1s interval checks whether playback
  // has been "stuck" for more than STALL_NUDGE_MS while the player thinks
  // it's playing. First stall: nudge the position by 100ms to force the
  // buffer to re-prime. Persistent stall (>STALL_FAIL_MS): give up and call
  // onError, which routes through the existing broken-item skip and rolls
  // the channel forward to the next queue item.
  const lastProgressMsRef = useRef(-1);
  const lastProgressAtRef = useRef(0);
  const stallNudgesRef = useRef(0);
  // nativeIsPlayingRef mirrors nativePlayer.playing as observed via playingChange events,
  // read by the watchdog tick. We use a ref so the 1s interval doesn't need to be
  // torn down and recreated whenever the playing state changes.
  const nativeIsPlayingRef = useRef(false);
  // onErrorRef lets the stall watchdog always call the latest onError without
  // being listed as a dep.  If onError were in the dep array it would force
  // the effect to tear down and re-run on every parent render (the caller
  // often passes an inline lambda), resetting lastProgressAtRef.current to
  // Date.now() and making the stall clock unable to ever reach STALL_NUDGE_MS.
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  const STALL_NUDGE_MS = 8_000;
  // 15 s before declaring a stall fatal — on 3G / congested LTE a single HLS
  // segment can legitimately take 12–14 s to start delivering bytes. The old
  // 10 s value caused premature "broken item" skips for perfectly healthy
  // streams under weak-signal conditions, leaving viewers on a black screen.
  const STALL_FAIL_MS = 15_000;
  const MAX_STALL_NUDGES = 2;

  const getWebVideo = useCallback((slot: "A" | "B"): HTMLVideoElement | null =>
    slot === "A" ? webVideoRefA.current : webVideoRefB.current, []);
  const getWebHls = useCallback((slot: "A" | "B"): HlsInstance | null =>
    slot === "A" ? webHlsRefA.current : webHlsRefB.current, []);
  const setWebHls = useCallback((slot: "A" | "B", h: HlsInstance | null) => {
    if (slot === "A") webHlsRefA.current = h; else webHlsRefB.current = h;
  }, []);
  const getWebLoadedUrl = useCallback((slot: "A" | "B"): string | null =>
    slot === "A" ? webLoadedUrlA.current : webLoadedUrlB.current, []);
  const setWebLoadedUrl = useCallback((slot: "A" | "B", u: string | null) => {
    if (slot === "A") webLoadedUrlA.current = u; else webLoadedUrlB.current = u;
  }, []);
  const getWebRetries = useCallback((slot: "A" | "B"): number =>
    slot === "A" ? webRetryRefA.current : webRetryRefB.current, []);
  const setWebRetries = useCallback((slot: "A" | "B", n: number) => {
    if (slot === "A") webRetryRefA.current = n; else webRetryRefB.current = n;
  }, []);
  const otherWebSlot = (slot: "A" | "B"): "A" | "B" => slot === "A" ? "B" : "A";

  // ── Online recovery (web only) ─────────────────────────────────────────
  // Restart the active and inactive web slots' hls.js engines when the
  // device flips back online, then dismiss the "Reconnecting…" pill. The
  // browser keeps the last decoded frame on the <video> element until
  // startLoad picks back up, so the transition from offline-waiting back
  // to playing is seamless — no veil flicker, no skip.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (typeof window === "undefined") return;
    const handleOnline = () => {
      if (!webOfflineWaitingRef.current) return;
      if (webOfflineRetryRef.current) {
        clearTimeout(webOfflineRetryRef.current);
        webOfflineRetryRef.current = null;
      }
      const active = webActiveSlotRef.current;
      const activeHls = active === "A" ? webHlsRefA.current : webHlsRefB.current;
      try { activeHls?.startLoad(); } catch { /* noop */ }
      const inactiveHls = active === "A" ? webHlsRefB.current : webHlsRefA.current;
      try { inactiveHls?.startLoad(); } catch { /* noop */ }
      setWebRetries(active, 0);
      setWebOfflineWaiting(false);
    };
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("online", handleOnline);
      if (webOfflineRetryRef.current) {
        clearTimeout(webOfflineRetryRef.current);
        webOfflineRetryRef.current = null;
      }
    };
  }, [setWebRetries]);

  const playerHeight = playerHeightOverride ?? Math.round(width * (9 / 16));

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (Platform.OS === "web") return; // web path wires refs via the active-slot effect below
    if (isRadioMode && rntp) {
      playerPlayRef.current = () => { resumeTrackPlayer().catch(() => {}); };
      playerPauseRef.current = () => { pauseTrackPlayer().catch(() => {}); };
      playerSeekRef.current = (t: number) => { seekTrackPlayer(t).catch(() => {}); };
    } else {
      // expo-video: play/pause are synchronous; currentTime = seconds for seek.
      playerPlayRef.current = () => {
        try {
          if (isMountedRef.current) nativePlayer.play();
        } catch (err) {
          Sentry.captureException(err, { tags: { module: "expo-video" } });
        }
      };
      playerPauseRef.current = () => {
        try {
          if (isMountedRef.current) nativePlayer.pause();
        } catch (err) {
          Sentry.captureException(err, { tags: { module: "expo-video" } });
        }
      };
      playerSeekRef.current = (t: number) => {
        try {
          if (isMountedRef.current) nativePlayer.currentTime = t;
        } catch (err) {
          Sentry.captureException(err, { tags: { module: "expo-video" } });
        }
      };
    }
  }, [isRadioMode, rntp, playerPlayRef, playerPauseRef, playerSeekRef, nativePlayer]);

  useEffect(() => {
    if (!isRadioMode || !rntp || !effectiveUrl || Platform.OS === "web") return;

    setLoading(true);
    loadAndPlayTrack({
      id: effectiveUrl,
      url: effectiveUrl,
      title: title ?? "Now Playing",
      artist: "JCTM Ministries",
      artwork: thumbnailUrl,
      isLiveStream: false,
    })
      .then(() => { if (isMountedRef.current) setLoading(false); })
      .catch(() => { if (isMountedRef.current) setLoading(false); });

    return () => {
      stopTrackPlayer().catch(() => {});
    };
  }, [isRadioMode, rntp, effectiveUrl, title, thumbnailUrl]);

  useEffect(() => {
    if (!isRadioMode || !rntp || Platform.OS === "web") return;
    if (isPlaying) {
      resumeTrackPlayer().catch(() => {});
    } else {
      pauseTrackPlayer().catch(() => {});
    }
  }, [isPlaying, isRadioMode, rntp]);

  // ── Native source loading effect (expo-video) ─────────────────────────
  // When effectiveUrl changes (or on first mount), load it into nativePlayer
  // via replaceAsync so the decoder gets a clean start. In radio mode we
  // release the source to free decoder memory while audio-only is active.
  // Guarded by isMountedRef so it never fires after unmount.
  useEffect(() => {
    if (Platform.OS === "web") return;

    const loadSource = async () => {
      try {
        if (isRadioMode) {
          // Free decoder resources while audio-only mode is active.
          Sentry.addBreadcrumb({ category: "video-player", message: "radio-mode: releasing native player source", level: "info" });
          await nativePlayer.replaceAsync(null);
          return;
        }
        if (!effectiveUrl) return;
        if (!isMountedRef.current) return;
        setLoading(true);
        retryCountRef.current = 0;
        Sentry.addBreadcrumb({ category: "video-player", message: `source load start: ${sanitizeUrl(effectiveUrl)}`, level: "info" });
        await nativePlayer.replaceAsync({ uri: effectiveUrl });
        if (!isMountedRef.current) return;
        // Apply playback rate (ignored for live/broadcast).
        if (!isBroadcastLive) {
          try { nativePlayer.playbackRate = rate; } catch { /* noop */ }
        }
        // Seek to start position if requested.
        if (startPositionMs > 0) {
          try { nativePlayer.currentTime = startPositionMs / 1000; } catch { /* noop */ }
        }
        if (autoPlay) {
          try { nativePlayer.play(); } catch { /* noop */ }
        }
        Sentry.addBreadcrumb({ category: "video-player", message: `source load success: ${sanitizeUrl(effectiveUrl)}`, level: "info" });
      } catch (err) {
        if (!isMountedRef.current) return;
        Sentry.addBreadcrumb({ category: "video-player", message: `source load failure: ${sanitizeUrl(effectiveUrl)}`, level: "error" });
        Sentry.captureException(err, { tags: { module: "expo-video" }, extra: { url: sanitizeUrl(effectiveUrl) } });
        setLoading(false);
        onErrorRef.current?.();
      }
    };

    void loadSource();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveUrl, isRadioMode, autoPlay, isBroadcastLive, rate, startPositionMs]);

  // ── Native player event listeners (expo-video) ─────────────────────────
  // Wire statusChange, playingChange, timeUpdate, playToEnd, videoTrackChange
  // to reproduce all the behaviour previously driven by onPlaybackStatusUpdate.
  useEffect(() => {
    if (Platform.OS === "web") return;

    // statusChange: loading spinner management and error/retry logic.
    const statusSub = nativePlayer.addListener("statusChange", ({ status, error }) => {
      if (!isMountedRef.current) return;
      if (status === "readyToPlay") {
        if (loading) {
          setLoading(false);
          Animated.timing(transitionOpacity, {
            toValue: 0,
            duration: 350,
            useNativeDriver: true,
          }).start();
        }
        Sentry.addBreadcrumb({ category: "video-player", message: "status: readyToPlay", level: "info" });
      } else if (status === "error") {
        const errMsg = error?.message ?? "unknown";
        Sentry.addBreadcrumb({ category: "video-player", message: `status: error — ${errMsg}`, level: "error" });
        Sentry.captureException(new Error(`expo-video player error: ${errMsg}`), {
          tags: { module: "expo-video" },
          extra: { url: sanitizeUrl(effectiveUrl) },
        });
        if (retryCountRef.current < 2) {
          retryCountRef.current += 1;
          setLoading(true);
          Sentry.addBreadcrumb({ category: "video-player", message: `retry attempt ${retryCountRef.current}`, level: "warning" });
          const retryPositionSecs = lastProgressMsRef.current > 0
            ? lastProgressMsRef.current / 1000
            : startPositionMs / 1000;
          setTimeout(async () => {
            if (!isMountedRef.current) return;
            try {
              await nativePlayer.replaceAsync({ uri: effectiveUrl });
              if (!isMountedRef.current) return;
              if (retryPositionSecs > 0) nativePlayer.currentTime = retryPositionSecs;
              nativePlayer.play();
            } catch (retryErr) {
              if (!isMountedRef.current) return;
              Sentry.captureException(retryErr, { tags: { module: "expo-video" } });
              setLoading(false);
              onErrorRef.current?.();
            }
          }, 700);
        } else {
          setLoading(false);
          onErrorRef.current?.();
        }
      }
    });

    // playingChange: fire onPlay/onPause callbacks and track nativeIsPlayingRef
    // for the stall watchdog.
    const playingSub = nativePlayer.addListener("playingChange", ({ isPlaying: nowPlaying }) => {
      if (!isMountedRef.current) return;
      nativeIsPlayingRef.current = nowPlaying;
      if (nowPlaying) {
        onPlay?.();
      } else {
        onPause?.();
      }
    });

    // timeUpdate: progress reporting and stall watchdog tracking.
    const timeSub = nativePlayer.addListener("timeUpdate", ({ currentTime, bufferedPosition: _buf }) => {
      if (!isMountedRef.current) return;
      const durationSecs = nativePlayer.duration ?? 0;
      updatePlayback(currentTime, durationSecs);
      if (durationSecs > 0) onProgress?.(currentTime, durationSecs);

      // Stall watchdog: record forward motion (in ms to match lastProgressMsRef convention).
      const posMs = Math.round(currentTime * 1000);
      if (posMs !== lastProgressMsRef.current) {
        lastProgressMsRef.current = posMs;
        lastProgressAtRef.current = Date.now();
        if (stallNudgesRef.current > 0) stallNudgesRef.current = 0;
      }
    });

    // playToEnd: fire onEnd callback.
    const endSub = nativePlayer.addListener("playToEnd", () => {
      if (!isMountedRef.current) return;
      onEnd?.();
    });

    // videoTrackChange: report aspect ratio when a video track becomes available.
    const trackSub = nativePlayer.addListener("videoTrackChange", ({ videoTrack }) => {
      if (!isMountedRef.current) return;
      if (videoTrack && videoTrack.size.width > 0 && videoTrack.size.height > 0) {
        onAspectRatioChange?.(videoTrack.size.width / videoTrack.size.height);
      }
    });

    return () => {
      statusSub.remove();
      playingSub.remove();
      timeSub.remove();
      endSub.remove();
      trackSub.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativePlayer, effectiveUrl, startPositionMs, onEnd, onPlay, onPause, onAspectRatioChange, transitionOpacity, updatePlayback]);

  // ── Native player unmount cleanup ──────────────────────────────────────
  useEffect(() => {
    if (Platform.OS === "web") return;
    return () => {
      Sentry.addBreadcrumb({ category: "video-player", message: "player releasing on unmount", level: "info" });
      try { nativePlayer.replaceAsync(null).catch(() => {}); } catch { /* noop */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mid-playback stall watchdog effect ────────────────────────────────
  // Reset progress refs whenever the URL changes (queue advance, manual
  // pick, etc.) so a fresh item starts from a clean slate. Then run a 1Hz
  // tick that decides: nothing-to-do, nudge, or escalate-to-onError.
  // Disabled when the player is paused, loading, or the host context says
  // playback is paused — those are legitimate "no progress" reasons that
  // should never trip the watchdog.
  useEffect(() => {
    lastProgressMsRef.current = -1;
    lastProgressAtRef.current = Date.now();
    stallNudgesRef.current = 0;
    const tick = setInterval(() => {
      if (!isMountedRef.current) return;
      if (loading) return;
      if (!isPlaying) return;
      // On native, use nativeIsPlayingRef (driven by playingChange events).
      // On web, use the active slot's paused state.
      if (Platform.OS !== "web" && !nativeIsPlayingRef.current) return;
      const stalledFor = Date.now() - lastProgressAtRef.current;
      if (stalledFor < STALL_NUDGE_MS) return;
      if (stalledFor >= STALL_FAIL_MS || stallNudgesRef.current >= MAX_STALL_NUDGES) {
        // Persistent stall — give up on this item. The broadcast handler's
        // 2-in-30s rule will skip the item; a one-off stall in user-pick
        // mode just triggers the host's recover path, which is a safe
        // soft-refetch.
        if (__DEV__) console.warn("[LocalVideoPlayer] stall watchdog escalating to onError after", stalledFor, "ms");
        Sentry.addBreadcrumb({ category: "video-player", message: `stall watchdog escalating after ${stalledFor}ms`, level: "warning" });
        stallNudgesRef.current = 0;
        lastProgressAtRef.current = Date.now();
        onErrorRef.current?.();
        return;
      }
      // Soft recovery: nudge currentTime forward by 100ms to force the
      // buffer pipeline to re-prime. This costs the viewer nothing
      // perceptible and recovers from the vast majority of transient
      // stalls (slow CDN edge, momentary network dip, brief decode hiccup).
      stallNudgesRef.current += 1;
      const nudgeSecs = ((lastProgressMsRef.current >= 0 ? lastProgressMsRef.current : 0) + 100) / 1000;
      if (__DEV__) console.warn("[LocalVideoPlayer] stall watchdog nudging at", lastProgressMsRef.current, "ms (attempt", stallNudgesRef.current, ")");
      Sentry.addBreadcrumb({ category: "video-player", message: `stall watchdog nudge #${stallNudgesRef.current} at ${lastProgressMsRef.current}ms`, level: "warning" });
      if (Platform.OS === "web") {
        const v = getWebVideo(webActiveSlotRef.current);
        if (v) {
          try { v.currentTime = nudgeSecs; } catch {}
          v.play?.().catch(() => {});
        }
      } else {
        try {
          if (isMountedRef.current) {
            nativePlayer.currentTime = nudgeSecs;
            nativePlayer.play();
          }
        } catch { /* noop — player may be releasing */ }
      }
    }, 1_000);
    return () => clearInterval(tick);
  // onError is intentionally omitted from the dep array — we call it via
  // onErrorRef instead.  Including the raw prop would force this effect to
  // tear down and re-run on every parent render (callers often pass inline
  // lambdas), resetting lastProgressAtRef.current to Date.now() each time and
  // making the stall clock unable to ever reach STALL_NUDGE_MS.
  }, [effectiveUrl, loading, isPlaying, getWebVideo, nativePlayer]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Web A/B watchdog & helpers ───────────────────────────────────────
  const clearWebWatchdog = useCallback(() => {
    if (webLoadWatchdog.current) {
      clearTimeout(webLoadWatchdog.current);
      webLoadWatchdog.current = null;
    }
  }, []);

  // Load `url` into the given slot. `mode === "active"` means this slot is
  // (or will become) the visible/audible one — autoplay + watchdog +
  // seekToStart are applied. `mode === "preload"` silently primes the
  // hidden slot with the next item: muted, paused, holding metadata so the
  // eventual swap is a 1-frame cut, not a buffering pause.
  const loadIntoWebSlot = useCallback((slot: "A" | "B", url: string, mode: "active" | "preload") => {
    if (Platform.OS !== "web") return;
    const video = getWebVideo(slot);
    if (!video) return;

    // If this slot already holds the requested URL, nothing to do — most
    // commonly hit when the swap path runs and the inactive slot already
    // has the upcoming item primed.
    if (getWebLoadedUrl(slot) === url) {
      if (mode === "active") {
        // Re-activating an already-loaded slot: just play.
        try { if (autoPlay) void video.play(); } catch { /* noop */ }
      }
      return;
    }

    // Tear down any prior hls instance bound to this slot before rebinding.
    // detachMedia() first: releases the MSE SourceBuffer cleanly so the new
    // loadSource() does not inherit a dead MediaSource from the old instance.
    const prev = getWebHls(slot);
    if (prev) { try { prev.detachMedia(); prev.destroy(); } catch { /* noop */ } setWebHls(slot, null); }

    setWebLoadedUrl(slot, url);
    // Fresh URL into this slot ⇒ reset its hls.js retry budget so the new
    // stream gets a full 3-attempt recovery window of its own.
    setWebRetries(slot, 0);
    video.muted = mode === "preload";

    const armWatchdog = () => {
      if (mode !== "active") return;
      clearWebWatchdog();
      webLoadWatchdog.current = setTimeout(() => {
        if (video.readyState >= 2) return;
        if (__DEV__ && typeof console !== "undefined" && console.warn) {
          console.warn("[LocalVideoPlayer] web load watchdog fired — stalled", url);
        }
        if (isMountedRef.current) { setLoading(false); onError?.(); }
      }, WEB_LOAD_WATCHDOG_MS);
    };

    const safePlay = () => {
      if (mode !== "active" || !autoPlay) return;
      const r = video.play();
      if (r && typeof r.then === "function") {
        r.then(() => {
          if (isMountedRef.current) setWebNeedsPlayGesture(false);
        }).catch((err: unknown) => {
          if (err instanceof Error && err.name === "NotAllowedError" && isMountedRef.current) {
            setWebNeedsPlayGesture(true);
            setLoading(false);
            clearWebWatchdog();
          } else if (__DEV__ && typeof console !== "undefined" && console.warn) {
            console.warn("[LocalVideoPlayer] web video.play() rejected:", err);
          }
        });
      }
    };

    const seekToStart = () => {
      if (mode === "active" && startPositionMs > 0) {
        try { video.currentTime = startPositionMs / 1000; } catch { /* noop */ }
      }
    };

    const isPlainVideo = /\.(mp4|webm|ogg|mov|avi|mkv|m4v)(\?[^#]*)?$/i.test(url);

    if (isPlainVideo) {
      video.src = url;
      try { video.load(); } catch { /* noop */ }
      armWatchdog();
      const onReady = () => {
        seekToStart();
        safePlay();
        video.removeEventListener("loadedmetadata", onReady);
      };
      video.addEventListener("loadedmetadata", onReady, { once: true });
      if (mode === "active") safePlay();
      return;
    }

    // HLS path
    let Hls: HlsConstructor | undefined;
    try { Hls = require("hls.js"); } catch { return; }
    const HlsClass = Hls?.default ?? Hls;
    if (!HlsClass) return;

    if (HlsClass.isSupported && HlsClass.isSupported()) {
      const hls = new HlsClass({
        startLevel: -1,
        lowLatencyMode: false,
        // Off-main-thread MSE demuxing reduces jank on mobile browsers.
        // Must be false on web: Metro transforms hls.js with hermes-stable
        // profile, so __HLS_WORKER_BUNDLE__.toString() produces source that
        // V8's Worker engine cannot parse (SyntaxError: Unexpected identifier).
        // Main-thread mode has identical correctness; Worker is a perf hint only.
        enableWorker: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 30 * 1_000 * 1_000,
        // ABR oscillation damping (mirrors TV player tuning).
        abrBandwidthFactor: 0.85,
        abrBandwidthUpFactor: 0.7,
        abrEwmaFastLive: 3,
        abrEwmaSlowLive: 9,
        // Stall nudge recovery.
        nudgeOffset: 0.2,
        nudgeMaxRetry: 3,
        highBufferWatchdogPeriod: 2,
        manifestLoadingMaxRetry: 4,
        manifestLoadingRetryDelay: 1_000,
        levelLoadingMaxRetry: 4,
        levelLoadingRetryDelay: 500,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 500,
        fragLoadingMaxRetryTimeout: 64_000,
        xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = false; },
      });
      setWebHls(slot, hls);
      hls.loadSource(url);
      hls.attachMedia(video);
      armWatchdog();
      hls.on("hlsManifestParsed", () => {
        seekToStart();
        safePlay();
      });
      hls.on("hlsError", (_e: unknown, rawData: unknown) => {
        const data = rawData as Record<string, unknown> | undefined;
        if (!data?.["fatal"]) return;
        // Preload-mode failures must NEVER surface to the user: just
        // tear down the slot. The next queue advance will fall back to a
        // cold load through the active path.
        if (mode === "preload") {
          // detachMedia() first so hls.js releases the MSE SourceBuffer
          // cleanly before the instance is discarded; destroy() alone can
          // leave the <video> element bound to a dead MediaSource on some
          // browsers, causing a stale-state error on the next loadSource().
          try { hls.detachMedia(); hls.destroy(); } catch { /* noop */ }
          setWebHls(slot, null);
          setWebLoadedUrl(slot, null);
          // Blank the <video> src so the element holds no stale URL or
          // buffer state; the next cold-load through the active path starts
          // from a completely clean slate.
          try { video.src = ""; video.load(); } catch { /* noop */ }
          return;
        }
        // Active-loaded slot that has since been swapped out (queue
        // advanced before this error fired): the user is no longer
        // watching this video, so stay quiet.
        if (webActiveSlotRef.current !== slot) return;
        if (__DEV__ && typeof console !== "undefined" && console.warn) {
          console.warn("[LocalVideoPlayer] fatal hls error on slot", slot, ":", data.type, data.details);
        }
        // Mirror the TV player's progressive recovery: a 3-attempt budget
        // per fresh URL. NETWORK errors → hls.startLoad() (re-fetch the
        // failed segment); MEDIA errors → hls.recoverMediaError() (flush
        // the decoder and rebuild the buffer). Only escalate to onError
        // after the budget is exhausted or for non-recoverable types.
        const retries = getWebRetries(slot);
        const NETWORK_ERROR = HlsClass.ErrorTypes?.NETWORK_ERROR ?? "networkError";
        const MEDIA_ERROR = HlsClass.ErrorTypes?.MEDIA_ERROR ?? "mediaError";
        // Network-aware: if the device is offline, the right behavior is
        // to PAUSE on the last visible frame and wait for `online`, NOT
        // to consume the retry budget and skip the item. The window-
        // level `online` listener below resets retries and calls
        // hls.startLoad() the moment connectivity returns. Setting the
        // offline-waiting flag also hides the loading veil and surfaces
        // the "Reconnecting…" pill.
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        if (data.type === NETWORK_ERROR && (offline || webOfflineWaitingRef.current)) {
          webOfflineWaitingRef.current = true;
          setWebOfflineWaiting(true);
          clearWebWatchdog();
          // Schedule a backoff retry; if we're still offline when it
          // fires, the next NETWORK_ERROR will land us right back here.
          if (webOfflineRetryRef.current) clearTimeout(webOfflineRetryRef.current);
          webOfflineRetryRef.current = setTimeout(() => {
            try { hls.startLoad(); } catch { /* noop */ }
          }, 4_000);
          return;
        }
        if (data.type === NETWORK_ERROR && retries < 3) {
          setWebRetries(slot, retries + 1);
          try { hls.startLoad(); } catch { /* noop */ }
          armWatchdog();
          return;
        }
        if (data.type === MEDIA_ERROR && retries < 3) {
          setWebRetries(slot, retries + 1);
          try { hls.recoverMediaError(); } catch { /* noop */ }
          armWatchdog();
          return;
        }
        // Last grace check: if the device flipped offline between the
        // budget-exhausted moment and this read, treat as offline-wait
        // rather than skipping the item.
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          webOfflineWaitingRef.current = true;
          setWebOfflineWaiting(true);
          clearWebWatchdog();
          return;
        }
        clearWebWatchdog();
        if (isMountedRef.current) { setLoading(false); onError?.(); }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      armWatchdog();
      const onReady = () => {
        seekToStart();
        safePlay();
        video.removeEventListener("loadedmetadata", onReady);
      };
      video.addEventListener("loadedmetadata", onReady, { once: true });
      if (mode === "active") safePlay();
    } else {
      video.src = url;
      armWatchdog();
      const onReady = () => {
        seekToStart();
        safePlay();
        video.removeEventListener("loadedmetadata", onReady);
      };
      video.addEventListener("loadedmetadata", onReady, { once: true });
      if (mode === "active") safePlay();
    }
  }, [autoPlay, startPositionMs, onError, getWebVideo, getWebHls, setWebHls, getWebLoadedUrl, setWebLoadedUrl, getWebRetries, setWebRetries, clearWebWatchdog]);

  // Pause and silence the slot we are leaving so it stops competing for
  // the audio device and the decoder.
  const quiesceWebSlot = useCallback((slot: "A" | "B") => {
    const v = getWebVideo(slot);
    if (!v) return;
    try { v.pause(); } catch { /* noop */ }
    v.muted = true;
  }, [getWebVideo]);

  // Promote the other slot to active: unmute, ensure context refs point
  // at it, and play. Assumes the slot has already been loaded via
  // loadIntoWebSlot(other, _, "preload"). If the other slot's URL doesn't
  // match the requested target, the caller should fall back to a cold
  // load on the active slot instead of swapping.
  const swapWebSlots = useCallback(() => {
    const cur = webActiveSlotRef.current;
    const other = otherWebSlot(cur);
    const otherVideo = getWebVideo(other);
    if (!otherVideo) return false;
    quiesceWebSlot(cur);
    otherVideo.muted = false;
    webActiveSlotRef.current = other;
    setWebActiveSlot(other);
    if (autoPlay) {
      const r = otherVideo.play();
      if (r && typeof r.then === "function") r.catch(() => { /* handled by listener effect */ });
    }
    return true;
  }, [autoPlay, getWebVideo, quiesceWebSlot]);

  // Tracks a URL staged on the inactive slot during a cold-path channel
  // change. The pending-promotion effect below watches it and swaps when
  // the staged slot reports it can play, so the visible slot keeps its
  // last frame on screen during the manifest fetch instead of going black.
  const webPendingPromotionUrlRef = useRef<string | null>(null);
  const [webPendingTick, setWebPendingTick] = useState(0);

  // ── Effect: drive the *active* slot to play `effectiveUrl` ────────────
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!effectiveUrl) return;
    const cur = webActiveSlotRef.current;
    const other = otherWebSlot(cur);
    // Fast path: the inactive slot already has the requested URL primed
    // from a previous preload. Swap to it instantly.
    if (getWebLoadedUrl(other) === effectiveUrl && getWebVideo(other)) {
      webPendingPromotionUrlRef.current = null;
      swapWebSlots();
      return;
    }
    // Cold path. To avoid blacking out the visible slot while a fresh
    // manifest loads, route the load through the INACTIVE slot first
    // (preload mode), then promote it once the slot reports it can play.
    // The active slot keeps showing its current frame until the swap
    // occurs — no spinner, no black frame between videos.
    //
    // First-ever start (no previous frame) goes straight onto the active
    // slot so the loading overlay can show normally.
    const curVideo = getWebVideo(cur);
    const hasPreviousFrame = !!curVideo && curVideo.readyState >= 2 && !!getWebLoadedUrl(cur);
    if (!hasPreviousFrame) {
      webPendingPromotionUrlRef.current = null;
      loadIntoWebSlot(cur, effectiveUrl, "active");
      return;
    }
    webPendingPromotionUrlRef.current = effectiveUrl;
    if (getWebLoadedUrl(other) !== effectiveUrl) {
      loadIntoWebSlot(other, effectiveUrl, "preload");
    }
    // Bump tick so the promotion watcher re-runs even if effectiveUrl
    // is reassigned to the same string mid-load.
    setWebPendingTick((t) => t + 1);
  }, [effectiveUrl, loadIntoWebSlot, swapWebSlots, getWebLoadedUrl, getWebVideo]);

  // ── Pending-promotion watcher ────────────────────────────────────────
  // Mirrors the TV player's pending-promotion logic: when a cold-path
  // URL is staged on the inactive web slot, promote it the moment the
  // slot's <video> reports it can play. Until then, the active slot
  // keeps its last frame visible so the viewer never sees a black gap.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const target = webPendingPromotionUrlRef.current;
    if (!target) return;
    const inactive = otherWebSlot(webActiveSlotRef.current);
    const v = getWebVideo(inactive);
    if (!v) return;
    if (getWebLoadedUrl(inactive) === target && v.readyState >= 2) {
      webPendingPromotionUrlRef.current = null;
      swapWebSlots();
      return;
    }
    let done = false;
    const tryPromote = () => {
      if (done) return;
      if (getWebLoadedUrl(inactive) !== target) return;
      if (v.readyState < 2) return;
      done = true;
      webPendingPromotionUrlRef.current = null;
      swapWebSlots();
    };
    v.addEventListener("loadeddata", tryPromote);
    v.addEventListener("canplay", tryPromote);
    v.addEventListener("playing", tryPromote);
    // Safety net: if the inactive slot can't get ready, fall back to a
    // hard cold-load on the active slot so the viewer at least sees the
    // new stream eventually.
    const fallback = setTimeout(() => {
      if (done) return;
      if (webPendingPromotionUrlRef.current !== target) return;
      done = true;
      webPendingPromotionUrlRef.current = null;
      loadIntoWebSlot(webActiveSlotRef.current, target, "active");
    }, WEB_LOAD_WATCHDOG_MS);
    return () => {
      v.removeEventListener("loadeddata", tryPromote);
      v.removeEventListener("canplay", tryPromote);
      v.removeEventListener("playing", tryPromote);
      clearTimeout(fallback);
    };
  }, [effectiveUrl, webPendingTick, webActiveSlot, getWebVideo, getWebLoadedUrl, swapWebSlots, loadIntoWebSlot]);

  // ── Effect: silently preload `effectiveNextUrl` into the inactive slot
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!effectiveNextUrl) return;
    const inactive = otherWebSlot(webActiveSlotRef.current);
    // Don't trample the active slot if (somehow) the next URL equals the
    // currently playing URL.
    if (getWebLoadedUrl(webActiveSlotRef.current) === effectiveNextUrl) return;
    loadIntoWebSlot(inactive, effectiveNextUrl, "preload");
  }, [effectiveNextUrl, webActiveSlot, loadIntoWebSlot, getWebLoadedUrl]);

  // ── Effect: native (iOS/Android) next-item warm fetch ────────────────
  // expo-av on native doesn't expose a second-player preload primitive the
  // way the web A/B slot does, so we approximate "the bytes are already on
  // the device when the queue advances" by issuing a small Range GET for
  // the first ~2 MB of the next item. That:
  //   • warms the CDN edge (signed S3 URL gets cached at the POP)
  //   • warms the device's HTTP cache for HLS manifests / first segment
  //   • triggers DNS + TLS handshake so the next stream starts on a hot
  //     connection instead of negotiating from cold
  // Best-effort: aborts cleanly on unmount or URL change, swallows errors.
  // Delayed 2 s so it doesn't compete with the active item's startup
  // bandwidth on slow connections.
  useEffect(() => {
    if (Platform.OS === "web") return;
    if (!effectiveNextUrl) return;
    const controller = new AbortController();
    const id = setTimeout(() => {
      fetch(effectiveNextUrl, {
        method: "GET",
        headers: { Range: "bytes=0-2097151" },
        signal: controller.signal,
      }).catch(() => {});
    }, 2000);
    return () => {
      clearTimeout(id);
      controller.abort();
    };
  }, [effectiveNextUrl]);

  // ── Effect: keep the legacy `webVideoRef` and player-context refs
  // pointed at whichever slot is currently active.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const v = getWebVideo(webActiveSlot);
    webVideoRef.current = v;
    if (v) {
      playerPlayRef.current = () => v.play().catch(() => {});
      playerPauseRef.current = () => { v.pause(); };
      playerSeekRef.current = (t: number) => { try { v.currentTime = t; } catch { /* noop */ } };
    }
  }, [webActiveSlot, getWebVideo, playerPlayRef, playerPauseRef, playerSeekRef]);

  // ── Effect: playback-quality telemetry → /broadcast/playback-telemetry ─
  // Every 5 s, read the active web video's cumulative frame counters via
  // HTMLVideoElement.getVideoPlaybackQuality() and POST the delta. This is
  // the only signal the api-server cannot measure on its own — without it,
  // the `droppedFrameRate` field on the admin live-monitor's stream-health
  // SSE channel is permanently null. Telemetry is best-effort: any failure
  // (no API, no method, paused video, slot swap) is silent, and the player
  // never sees a UI side-effect. Slot swaps and counter-resets re-baseline
  // so the next sample doesn't emit a synthetic spike.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const TELEMETRY_INTERVAL_MS = 5_000;
    let baselineSlot: "A" | "B" = webActiveSlotRef.current;
    let baselineDecoded = 0;
    let baselineDropped = 0;

    const tick = () => {
      const slot = webActiveSlotRef.current;
      const v = getWebVideo(slot);
      if (!v || typeof v.getVideoPlaybackQuality !== "function") return;
      let q: VideoPlaybackQuality;
      try { q = v.getVideoPlaybackQuality(); } catch { return; }
      const total = q.totalVideoFrames ?? 0;
      const dropped = q.droppedVideoFrames ?? 0;
      // Re-baseline (and skip emission) when the active slot changes or
      // the cumulative counters appear to have reset (new media element /
      // src change). Without this, a slot swap would emit a giant spike
      // equal to the entire previous video's frame count.
      if (slot !== baselineSlot || total < baselineDecoded || dropped < baselineDropped) {
        baselineSlot = slot;
        baselineDecoded = total;
        baselineDropped = dropped;
        return;
      }
      const dDec = total - baselineDecoded;
      const dDrop = dropped - baselineDropped;
      baselineDecoded = total;
      baselineDropped = dropped;
      if (dDec > 0 || dDrop > 0) {
        void postPlaybackTelemetryDelta("mobile", dDec, dDrop);
      }
    };

    const id = setInterval(tick, TELEMETRY_INTERVAL_MS);
    return () => clearInterval(id);
  }, [getWebVideo]);

  // ── Effect: cleanup hls instances on unmount ─────────────────────────
  useEffect(() => () => {
    clearWebWatchdog();
    if (webHlsRefA.current) { try { webHlsRefA.current.destroy(); } catch {} webHlsRefA.current = null; }
    if (webHlsRefB.current) { try { webHlsRefB.current.destroy(); } catch {} webHlsRefB.current = null; }
  }, [clearWebWatchdog]);

  if (Platform.OS !== "web") {
    if (isRadioMode) {
      return (
        <LocalAudioModeCard
          thumbnailUrl={thumbnailUrl}
          title={title}
          isPlaying={isPlaying}
          loading={loading}
        />
      );
    }

    // ── Native render path: expo-video VideoView ───────────────────────────
    // nativePlayer is created once via useVideoPlayer (above). Source loading,
    // event handling, and lifecycle cleanup are all managed by the effects above.
    // VideoView just renders the player's output surface — no source prop needed.
    return (
      <View style={[styles.container, fillContainer ? { flex: 1 } : { height: playerHeight }]}>
        <VideoView
          player={nativePlayer}
          style={StyleSheet.absoluteFill}
          contentFit={coverMode ? "cover" : "contain"}
          // Native controls suppressed for live broadcast (no scrubbing/seek UI).
          nativeControls={!isBroadcastLive}
          allowsPictureInPicture={false}
          onFirstFrameRender={() => {
            // Dismiss the loading overlay on first rendered frame —
            // a more reliable signal than status=readyToPlay on some devices.
            if (isMountedRef.current && loading) {
              setLoading(false);
              Animated.timing(transitionOpacity, {
                toValue: 0,
                duration: 350,
                useNativeDriver: true,
              }).start();
            }
          }}
        />
        {/* Loading veil with thumbnail — fades out on first frame. */}
        <Animated.View
          style={[styles.overlay, { opacity: transitionOpacity, pointerEvents: "none" }]}
        >
          {thumbnailUrl && (
            <Image source={{ uri: thumbnailUrl }} style={styles.thumbnail} contentFit="contain" />
          )}
          <View style={[styles.loadingCenter, { backgroundColor: "rgba(0,0,0,0.5)" }]}>
            <ActivityIndicator color={c.primary} size="large" />
            <Text style={[styles.loadingText, { color: "rgba(255,255,255,0.6)" }]}>
              {dataSaver && !coverMode ? "Loading (data saver)..." : "Loading..."}
            </Text>
          </View>
        </Animated.View>
        {/* ABR badge */}
        {hlsMasterUrl && !loading && !coverMode && (
          <View style={[styles.modeBadge, { right: 12, left: undefined }]}>
            <Feather name="layers" size={12} color="#FFF" />
            <Text style={styles.modeBadgeText}>ABR</Text>
          </View>
        )}
        {/* Data-saver badge */}
        {dataSaver && !coverMode && (
          <View style={styles.modeBadge}>
            <Feather name="wifi-off" size={12} color="#FFF" />
            <Text style={styles.modeBadgeText}>Data saver</Text>
          </View>
        )}
      </View>
    );
  }

  // Web HLS player using hls.js — A/B double-buffered.
  // Both <video> elements stay mounted at all times. The "active" slot is
  // visible/audible and drives the player-context callbacks; the inactive
  // slot is hidden, muted, and silently primed with the upcoming queue
  // item via the preload effect above. On `effectiveUrl` change we either
  // (a) swap to the inactive slot if it already has the requested URL —
  // a 1-frame cut, no manifest fetch, no spinner — or (b) cold-load the
  // active slot. In radio mode the active slot is hidden behind the audio
  // card overlay; we keep both elements alive so the audio source survives.
  const renderSlotVideo = (slot: "A" | "B") => {
    const isActive = webActiveSlot === slot;
    return React.createElement("video", {
      key: `slot-${slot}`,
      ref: (el: HTMLVideoElement | null) => {
        if (slot === "A") webVideoRefA.current = el;
        else webVideoRefB.current = el;
        // The active-slot tracking effect above keeps webVideoRef and the
        // player-context refs (play/pause/seek) pointed at the visible
        // element, so we don't wire them inline here.
      },
      controls: isActive && !isRadioMode && !isBroadcastLive,
      playsInline: true,
      preload: "auto",
      // Intentionally NOT setting `crossOrigin` — see prior comment.
      style: {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        // object-contain: show the full video frame without any cropping.
        // background is intentionally NOT set here — the ambient blur layer
        // beneath this element shows through the transparent letterbox/
        // pillarbox areas, replacing harsh black bars with a cinematic glow.
        objectFit: "contain",
        display: "block",
        // Hide the inactive slot. We keep it laid out (not display:none) so
        // its decoder pipeline stays warm and the swap is a real 1-frame
        // cut rather than a re-mount.
        opacity: isActive ? 1 : 0,
        pointerEvents: isActive ? "auto" : "none",
        zIndex: isActive ? 2 : 1,
      },
      // Only the active slot drives external callbacks. The inactive slot
      // firing onEnded/onPlay would cascade into the broadcast handler and
      // tear down the very transition we're trying to make seamless.
      onPlay: isActive ? () => { setLoading(false); onPlay?.(); } : undefined,
      onPause: isActive ? () => onPause?.() : undefined,
      onEnded: isActive ? () => onEnd?.() : undefined,
      onError: isActive ? () => onError?.() : undefined,
      onTimeUpdate: isActive
        ? (e: React.SyntheticEvent<HTMLVideoElement>) => {
            const v = e.target as HTMLVideoElement;
            if (v.duration) updatePlayback(v.currentTime, v.duration);
          }
        : undefined,
      onLoadedMetadata: isActive
        ? (e: React.SyntheticEvent<HTMLVideoElement>) => {
            const v = e.target as HTMLVideoElement;
            if (v.videoWidth > 0 && v.videoHeight > 0) {
              onAspectRatioChange?.(v.videoWidth / v.videoHeight);
            }
          }
        : undefined,
    });
  };

  return (
    <View style={[styles.container, !isRadioMode && (fillContainer ? { flex: 1 } : { height: playerHeight })]}>
      {/* A/B video stack — always mounted, hidden offscreen in radio mode */}
      <View
        style={
          isRadioMode
            ? { position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }
            : { flex: 1, position: "relative" }
        }
      >
        {/* Cinematic ambient background (web path only) — fills letterbox/
            pillarbox areas produced by object-contain with a blurred,
            darkened version of the thumbnail. Video elements render their
            letterbox areas as transparent (no background set), so this
            div's ambient glow shows through the margins instead of black.
            React.createElement avoids JSX-in-tsx restrictions for a plain
            HTML div inside a React Native View on web.                      */}
        {thumbnailUrl && React.createElement("div", {
          "aria-hidden": true,
          key: "ambient-bg",
          style: {
            position: "absolute" as const,
            inset: 0,
            zIndex: 0,
            backgroundImage: `url(${thumbnailUrl})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            filter: "blur(48px) brightness(0.2) saturate(1.4)",
            transform: "scale(1.15)",
            pointerEvents: "none" as const,
          },
        })}
        {renderSlotVideo("A")}
        {renderSlotVideo("B")}
      </View>

      {/* Radio mode audio card overlay */}
      {isRadioMode && (
        <LocalAudioModeCard
          thumbnailUrl={thumbnailUrl}
          title={title}
          isPlaying={isPlaying}
          loading={false}
          onToggle={toggleRadioMode}
        />
      )}

      {/* HLS / ABR badge — only in video mode and non-broadcast mode */}
      {!isRadioMode && !coverMode && (
        <View style={[styles.modeBadge, { right: 12, left: undefined }]}>
          <Feather name="layers" size={12} color="#FFF" />
          <Text style={styles.modeBadgeText}>
            {hlsMasterUrl ? "HLS ABR" : "MP4"}
          </Text>
        </View>
      )}

      {/* Web loading veil — shown while the video is buffering on first
          load. Unlike native, the web <video> element has no built-in
          loading state visible to the user, so without this the player
          shell is just a black box until the first frame arrives.
          Dismissed when the active slot fires its `onPlay` event, which
          sets `loading = false`. */}
      {loading && !webNeedsPlayGesture && (
        <View
          style={{
            ...StyleSheet.absoluteFill,
            pointerEvents: "none",
            zIndex: 9,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "#000",
          }}
        >
          {!!thumbnailUrl && (
            <Image
              source={{ uri: thumbnailUrl }}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
            />
          )}
          <View style={{
            backgroundColor: "rgba(0,0,0,0.55)",
            borderRadius: 40,
            padding: 14,
          }}>
            <ActivityIndicator size="large" color="#DC2626" />
          </View>
        </View>
      )}

      {/* Reconnecting pill — surfaced when hls.js reports NETWORK_ERROR
          while the device is offline. The last decoded frame stays
          visible behind the pill so the viewer sees "we're holding for
          you", not a black screen. Auto-dismisses on `online`. */}
      {!isRadioMode && webOfflineWaiting && (
        <View
          style={{
            position: "absolute",
            pointerEvents: "none",
            top: 12,
            alignSelf: "center",
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingVertical: 7,
            paddingHorizontal: 14,
            borderRadius: 999,
            backgroundColor: "rgba(13,17,23,0.82)",
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.10)",
            zIndex: 11,
          }}
        >
          <ActivityIndicator size="small" color="#FFC97A" />
          <Text style={{ color: "#FFC97A", fontSize: 12.5, fontWeight: "600" }}>
            Reconnecting…
          </Text>
        </View>
      )}

      {/* Autoplay-policy overlay — surfaced when the browser blocks the
          initial play() call. Tapping calls play() again from a real user
          gesture, which always succeeds. Without this overlay the video
          would appear loaded but stuck on its first frame with no UX. */}
      {!isRadioMode && webNeedsPlayGesture && (
        <Pressable
          onPress={() => {
            const v = webVideoRef.current;
            if (!v) return;
            const r = v.play();
            if (r && typeof r.then === "function") {
              r.then(() => setWebNeedsPlayGesture(false)).catch(() => {});
            } else {
              setWebNeedsPlayGesture(false);
            }
          }}
          style={{
            position: "absolute",
            top: 0, left: 0, right: 0, bottom: 0,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.55)",
          }}
        >
          <View style={{
            width: 72, height: 72, borderRadius: 36,
            backgroundColor: "#DC2626",
            alignItems: "center", justifyContent: "center",
          }}>
            <Feather name="play" size={32} color="#FFF" />
          </View>
          <Text style={{ color: "#FFF", marginTop: 12, fontWeight: "600" }}>
            Tap to start playback
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Tinted broadcast surround — matches the parent player container's
  // #15131A so the video element sits inside a single continuous TV-screen
  // surround, no harsh seam between wrapper and inner element.
  container: { flex: 1, backgroundColor: "#15131A", position: "relative", overflow: "hidden" },
  thumbnail: { ...StyleSheet.absoluteFill, width: "100%", height: "100%" },
  overlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
    // Same tinted surround as `container` above — keeps the loading-state
    // overlay visually continuous with the player chassis.
    backgroundColor: "#15131A",
  },
  overlayCenter: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  loadingCenter: {
    position: "absolute",
    alignItems: "center",
    gap: 10,
    padding: 20,
    borderRadius: 12,
  },
  loadingText: { fontSize: 13, fontFamily: "Inter_400Regular" },
  playButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: 4,
  },
  tapHint: { color: "rgba(255,255,255,0.5)", fontSize: 12, fontFamily: "Inter_400Regular" },
  modeBadge: {
    position: "absolute",
    left: 12,
    bottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.62)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
  },
  modeBadgeText: { color: "#FFF", fontSize: 11, fontFamily: "Inter_600SemiBold" },
});

const audioStyles = StyleSheet.create({
  card: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingVertical: 20,
    paddingHorizontal: 16,
    minHeight: 240,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
  },
  badgeText: { fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1.2 },
  discOuter: {
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 2,
    borderColor: "rgba(106,13,173,0.5)",
    padding: 6,
  },
  discMid: {
    flex: 1,
    borderRadius: 64,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    backgroundColor: "rgba(106,13,173,0.15)",
  },
  discImage: { width: "100%", height: "100%", borderRadius: 64 },
  discCenter: {
    position: "absolute",
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  waveRow: { flexDirection: "row", alignItems: "center", gap: 3, height: 20 },
  waveBar: { width: 3, height: 18, borderRadius: 2, backgroundColor: "#6A0DAD" },
  meta: { alignItems: "center", gap: 3, paddingHorizontal: 24 },
  metaTitle: { fontSize: 15, fontFamily: "Inter_700Bold", color: "#FFF", textAlign: "center", lineHeight: 20 },
  metaArtist: { fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.5)", textAlign: "center" },
  switchBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(106,13,173,0.5)",
    backgroundColor: "rgba(106,13,173,0.15)",
  },
  switchBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#B47FEB" },
});
