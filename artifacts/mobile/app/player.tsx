import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

/**
 * Player Screen — Temple TV Mobile. Rebuilt from scratch.
 *
 * Routing:
 *   isLive + isHls    → BroadcastHlsPlayer  (MobilePlaybackEngine, A/B dual-buffer)
 *   isLive + isYoutube → YoutubePlayer       (YouTube live embed)
 *   VOD  + isHls      → LocalVideoPlayer    (single-buffer, full controls)
 *   VOD  + isYoutube  → YoutubePlayer       (YouTube VOD embed)
 *
 * Layout contract:
 *  • 16:9 black player block sits flush to the top of the viewport.
 *  • Back button and LIVE badge are absolutely positioned inside the player
 *    block, offset by safe-area insets so they clear the Dynamic Island.
 *  • All scrollable content below the player uses 16 px horizontal padding.
 *  • Sections are separated by hairline dividers, not empty gaps.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Alert,
  Animated,
  AppState,
  type AppStateStatus,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { parseBoolParam, parseNumberParam } from "@/lib/params";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from "expo-av";
import { usePictureInPicture } from "@/hooks/usePictureInPicture";
import * as ScreenOrientation from "expo-screen-orientation";
import { useColors } from "@/hooks/useColors";
import { YoutubePlayer } from "@/components/YoutubePlayer";
import { LocalVideoPlayer } from "@/components/LocalVideoPlayer";
import { LiveBadge } from "@/components/LiveBadge";
import { StreamStatusBadge } from "@/components/StreamStatusBadge";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useFavorites } from "@/hooks/useFavorites";
import { useWatchHistory } from "@/hooks/useWatchHistory";
import { useWatchProgress } from "@/hooks/useWatchProgress";
import { useBroadcastSync } from "@/hooks/useBroadcastSync";
import { useVideos } from "@/hooks/useVideos";
import {
  playbackQueue,
  getNextSermon,
  getPrevSermon,
} from "@/lib/playbackQueue";
import { VideoCard } from "@/components/VideoCard";
import { sendReaction, recordView, type ReactionType } from "@/services/api";
import type { Sermon } from "@/types";
import { ChatPanel } from "@/components/ChatPanel";
import { FloatingReactions, type FloatingReactionsHandle } from "@/components/FloatingReactions";
import { getApiBase } from "@/lib/apiBase";
import { useV2BroadcastNative } from "@workspace/player-core/react-native";
import { usePageSeo } from "@/hooks/usePageSeo";
import { usePlayer } from "@/context/PlayerContext";
import {
  ReactionButton,
  PrayerSection,
  FsScrubBar,
  formatTime,
  BroadcastHlsPlayer,
  BroadcastTimeRemaining,
  BroadcastUpNextStrip,
  CountdownOverlay,
} from "@/components/player";

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

// Derive the canonical site origin from build-time env vars so structured-data
// URLs are correct across dev, preview, and production builds.
// Falls back to the production domain when the env var is absent (native-only
// builds that don't set EXPO_PUBLIC_DOMAIN).
const SITE_ORIGIN: string = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${(process.env.EXPO_PUBLIC_DOMAIN as string).replace(/^https?:\/\//, "").replace(/\/$/, "")}`
  : "https://templetv.org.ng";

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function PlayerScreen() {
  const apiBase = getApiBase() ?? "";
  const params = useLocalSearchParams<{
    id?: string;
    title?: string;
    youtubeId?: string;
    hlsUrl?: string;
    thumbnailUrl?: string;
    isLive?: string;
    startPositionSecs?: string;
    videoId?: string;
    localVideoUrl?: string;
    hlsMasterUrl?: string;
    thumbnail?: string;
    broadcastMode?: string;
    startPositionMs?: string;
    radioOnly?: string;
    preacher?: string;
    duration?: string;
    category?: string;
    description?: string;
  }>();

  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const c = useColors();
  const { isOnline } = useNetworkStatus();

  // V2 broadcast snapshot — attaches to the singleton session (same WS/SSE
  // connection as V2PlayerContainer, zero extra connections). Reads live
  // state: current/next item, mode, off-air reason, source quality, and
  // whether the transport is currently connected.
  const { snapshot: v2Snapshot, connected: v2Connected } = useV2BroadcastNative({
    baseUrl: `${apiBase}/api/broadcast-v2`,
  });


  // Re-assert the audio mode on player mount. The root layout sets this
  // once at app boot, but iOS/Android can revoke audio focus when another
  // app (Spotify, a phone call, Siri) takes over. Re-asserting here makes
  // sure that when the user returns to the broadcast surface, audio is
  // routed back to the playback session and isn't muted by the system's
  // last-known interruption state. Errors are swallowed — a failure here
  // is non-fatal (audio still plays, just with default routing).
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        // Wait for the root layout's setupAudioSession() to finish before
        // re-asserting exclusive mode. On cold-start deep-links React runs
        // child effects before parent effects, so both can call
        // Audio.setAudioModeAsync() concurrently — which fails on iOS with
        // "Audio session already active". Sequencing them eliminates the race.
        const { waitForAudioSession } = await import("@/lib/audio-session");
        await waitForAudioSession();
        if (!mounted) return;
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: true,
          // DoNotMix (not DuckOthers): Temple TV audio takes exclusive focus.
          // DuckOthers would let phone calls, Spotify, etc. lower our volume
          // and eventually reclaim focus — unacceptable during a live service.
          // This re-asserts the same policy set in _layout.tsx's setupAudioSession
          // which iOS/Android may have revoked while another app held focus.
          interruptionModeIOS: InterruptionModeIOS.DoNotMix,
          interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
          shouldDuckAndroid: false,
          playThroughEarpieceAndroid: false,
        });
      } catch (err: unknown) {
        if (!mounted) return;
        // Log to Sentry so we can track OS-level audio-session revocation patterns.
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const S = require("@sentry/react-native") as {
            addBreadcrumb: (b: { category: string; message: string; level: string }) => void;
          };
          S.addBreadcrumb({
            category: "audio",
            message: `setAudioModeAsync failed on player mount: ${err instanceof Error ? err.message : String(err)}`,
            level: "warning",
          });
        } catch {
          // Sentry not available
        }
        // Single 500 ms retry — the OS may need a brief moment to release a
        // competing audio session (e.g. after a phone call or Siri dismissal)
        // before it will accept our reconfiguration.
        setTimeout(() => {
          if (!mounted) return;
          Audio.setAudioModeAsync({
            playsInSilentModeIOS: true,
            staysActiveInBackground: true,
            interruptionModeIOS: InterruptionModeIOS.DoNotMix,
            interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
            shouldDuckAndroid: false,
            playThroughEarpieceAndroid: false,
          }).catch(() => {});
        }, 500);
      }
    })();
    // Restore the global audio policy when this screen unmounts. The root
    // layout (setupAudioSession) establishes shouldDuckAndroid: true so OS
    // sounds (navigation prompts, notifications) and in-app radio can duck
    // Temple TV during lower-priority audio events. This screen tightens it
    // to false for exclusive broadcast focus. Without cleanup the session
    // remains in exclusive mode after the user leaves — radio and other
    // in-app audio lose the ability to duck correctly on Android.
    return () => {
      mounted = false;
      Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      }).catch(() => {});
    };
  }, []);

  // Audio session heartbeat — re-asserts audio mode when the app foregrounds.
  // Long background sessions (30+ min) can have audio focus revoked by the OS
  // while another app (navigation, phone call, Siri) held the audio session.
  // Without this, the user returns to the broadcast and gets silence until they
  // manually interact with the player.
  useEffect(() => {
    if (Platform.OS === "web") return undefined;
    const sub = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      if (nextState === "active") {
        Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: true,
          interruptionModeIOS: InterruptionModeIOS.DoNotMix,
          interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
          shouldDuckAndroid: false,
          playThroughEarpieceAndroid: false,
        }).catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  const { setIsBroadcastMode, isPlaying, playerPlayRef, playerPauseRef, playerSeekRef } = usePlayer();

  const videoId      = params.id ?? "live";
  const title        = params.title ?? "Now Playing";
  const youtubeId    = params.youtubeId ?? params.videoId ?? "";
  // Use || (not ??) so an empty-string hlsUrl falls through to localVideoUrl.
  // This enables MP4-first playback: when the caller passes localVideoUrl
  // only (no HLS master yet), the player plays MP4 directly rather than
  // treating "" as a set value and producing a broken source.
  const hlsUrl       = params.hlsUrl || params.hlsMasterUrl || params.localVideoUrl || "";
  const thumbnailUrl = params.thumbnailUrl ?? params.thumbnail ?? "";
  const preacher     = params.preacher ?? "JCTM Ministries";
  const duration     = params.duration ?? "";
  const category     = params.category ?? "";
  const description  = params.description ?? "";
  const isLive       = parseBoolParam(params.isLive) || parseBoolParam(params.broadcastMode);
  // True when the V2 broadcast engine owns the player slot (HLS channel or
  // the raw "isLive=true" deep-link with no explicit source URL). Excludes
  // the YouTube live path — that is handled by the LiveBroadcastSupervisor
  // which already calls playLive() and sets PlayerContext.isLive=true.
  const isBroadcastV2 = isLive && !( !!( params.youtubeId ?? params.videoId ) && !hlsUrl );

  // Derived V2 live metadata — conditional on isBroadcastV2 so VOD screens
  // never read stale broadcast state.
  const v2ServerSnap    = isBroadcastV2 ? (v2Snapshot.lastServerSnapshot ?? null) : null;
  const v2Current       = v2ServerSnap?.current       ?? null;
  const v2Next          = v2ServerSnap?.next           ?? null;
  const v2Mode          = v2ServerSnap?.mode           ?? null;
  const v2Override      = v2ServerSnap?.override       ?? null;
  const v2OffAirReason  = v2ServerSnap?.offAirReason   ?? null;
  const v2SourceQuality = v2ServerSnap?.sourceQuality  ?? null;
  // Live-updating title — V2 snapshot is authoritative; route params are the
  // bootstrap fallback until the first server frame arrives.
  const liveTitle = isBroadcastV2
    ? (v2Override?.title ?? v2Current?.title ?? title)
    : title;

  // Sync PlayerContext.isBroadcastMode with whether the V2 broadcast engine
  // is active. Without this, the MiniPlayer and any context consumer that
  // reads isBroadcastMode would never know the broadcast channel is playing —
  // the MiniPlayer would stay invisible the entire time.
  useEffect(() => {
    if (isBroadcastV2) {
      setIsBroadcastMode(true);
    }
    return () => {
      if (isBroadcastV2) {
        setIsBroadcastMode(false);
      }
    };
  }, [isBroadcastV2, setIsBroadcastMode]);

  const startPositionSecs = params.startPositionSecs
    ? parseNumberParam(params.startPositionSecs, 0)
    : params.startPositionMs
    ? parseNumberParam(params.startPositionMs, 0) / 1000
    : 0;

  const isYoutube = !!youtubeId && !hlsUrl;
  const isHls     = !!hlsUrl;

  // ── Library Prev/Next + autoplay countdown ───────────────────────────────
  // VOD-only feature. Live broadcasts always own their own queue (driven by
  // the station orchestrator) so prev/next/countdown stay hidden for them.
  const isVod = !isLive && (isYoutube || isHls);
  const queueSnapshot = useSyncExternalStore(
    playbackQueue.subscribe,
    playbackQueue.getSnapshot,
    playbackQueue.getSnapshot,
  );
  // The queue is only treated as "owned by this watch session" when its
  // pointer matches the currently-playing id AND that id exists in the
  // items array. This guards against three failure modes:
  //   • Deep-link / push notification arrival — the queue may still hold
  //     a stale snapshot from a previous library tap.
  //   • Continue Watching cards — they push to /player without seeding.
  //   • Library `extend()` keeps the items list current, but never moves
  //     the pointer, so an unseeded entry won't accidentally hijack it.
  // navigateToRelated (this screen) and navigateToSermon (library) are the
  // only paths that legitimately call `playbackQueue.set/setCurrent`, so
  // the comparison below is a reliable "did the user enter from a seeded
  // surface?" check.
  const queueIsSeededForThisVideo =
    isVod &&
    !!videoId &&
    videoId !== "live" &&
    queueSnapshot.currentId === videoId &&
    queueSnapshot.items.some((s) => s.id === videoId);

  const prevSermon = queueIsSeededForThisVideo ? getPrevSermon(queueSnapshot) : null;
  const nextSermon = queueIsSeededForThisVideo ? getNextSermon(queueSnapshot) : null;

  // Pre-resolve the upcoming HLS URL so we can hand it to LocalVideoPlayer's
  // A/B inactive slot. Only valid when the next item is HLS/local — the
  // YoutubePlayer surface has no preload primitive, so YT→YT advances will
  // hit a brief load spinner (acceptable: YT itself caches the first frame).
  const nextHlsForPreload = useMemo(() => {
    if (!nextSermon) return undefined;
    if (nextSermon.videoSource === "youtube") return undefined;
    return nextSermon.hlsMasterUrl ?? nextSermon.localVideoUrl ?? undefined;
  }, [nextSermon]);

  // Inject structured data (VideoObject or BroadcastEvent) for web-embedded
  // and PWA surfaces. This is a no-op on bare React Native / Expo Go — the
  // hook checks `typeof document` before writing to the DOM.
  usePageSeo(
    isLive
      ? {
          title: liveTitle || "Live Broadcast",
          description: "Watch our live worship broadcast",
          path: "/player",
          structuredData: {
            "@context": "https://schema.org",
            "@type": "BroadcastEvent",
            name: liveTitle || "Live Broadcast",
            description: "Watch our live worship broadcast",
            isLiveBroadcast: true,
            location: {
              "@type": "VirtualLocation",
              url: `${SITE_ORIGIN}/player`,
            },
            broadcaster: {
              "@type": "Organization",
              name: "JCTM",
              url: "https://templetv.org.ng",
            },
          },
        }
      : {
          title: title || "Sermon",
          description: description || `Watch ${title ?? "this sermon"} on JCTM`,
          path: `/player?id=${videoId}`,
          image: thumbnailUrl || undefined,
          structuredData: {
            "@context": "https://schema.org",
            "@type": "VideoObject",
            name: title,
            description: description || `Watch ${title} on JCTM Broadcasting`,
            thumbnailUrl: thumbnailUrl || undefined,
            creator: preacher ? { "@type": "Person", name: preacher } : undefined,
            publisher: {
              "@type": "Organization",
              name: "JCTM",
              url: "https://templetv.org.ng",
            },
          },
        },
  );

  const [showChat, setShowChat]         = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  // Detected aspect ratio of the loaded video (width / height). Defaults to
  // 16:9 so standard broadcasts / YouTube look correct before onLoad fires.
  // Updated by LocalVideoPlayer.onAspectRatioChange once the source loads.
  const [videoAspectRatio, setVideoAspectRatio] = useState(16 / 9);

  // ── Picture-in-Picture ────────────────────────────────────────────────────
  // Android-only. The manifest already declares android:supportsPictureInPicture
  // (via with-android-activity-flags.js). The hook wraps the expo-pip-android
  // native module which calls Activity.enterPictureInPictureMode().
  // autoEnterOnBackground=true arms system-driven auto-PiP on Android 12+
  // (setAutoEnterEnabled) and the AppState fallback on older devices, so the
  // video keeps playing in a mini window the moment the user presses Home —
  // the same behaviour as YouTube. The fullscreen Modal is reconciled on PiP
  // exit by the ghost-state guard below.
  const { isInPip, isSupported: isPipSupported, enterPip } = usePictureInPicture({
    aspectRatioWidth: Math.max(1, Math.round(videoAspectRatio * 9)),
    aspectRatioHeight: 9,
    autoEnterOnBackground: true,
    // Show a restore button inside the PiP overlay window AND a persistent
    // notification so the user can return to the full player from anywhere
    // without hunting for the app. Both are auto-dismissed when the player
    // returns to the foreground (native ActivityLifecycleCallbacks + JS cleanup).
    showRestoreButton: true,
  });

  // PiP-aware screen wake lock.
  // While the player screen is visible, prevent the screen from sleeping so
  // the user can watch without the display turning off — same as YouTube/Twitch.
  // When the app enters PiP the player is in the background; holding the wake
  // lock there wastes battery without benefit. Deactivate during PiP and
  // re-activate automatically when PiP exits (isInPip → false).
  useEffect(() => {
    if (isInPip) {
      deactivateKeepAwake();
      return;
    }
    void activateKeepAwakeAsync();
    return () => { deactivateKeepAwake(); };
  }, [isInPip]);

  // Last-known playback position (ms). Written by handleProgressWithPosition
  // so that entering/exiting fullscreen can seek the new player instance to
  // where the previous one stopped, giving a seamless visual transition.
  const currentPositionMsRef = useRef(0);

  // ── PiP → fullscreen ghost-state guard ───────────────────────────────────
  // Entering PiP from fullscreen keeps the Modal open while the video fills
  // the PiP window.  When the user taps the PiP overlay to return to the
  // full app, `isInPip` transitions true → false, but `isFullscreen` stays
  // true without this guard — leaving a ghost fullscreen Modal on top of
  // the restored portrait player.  Detect the PiP-exit edge and restore
  // normal portrait mode automatically.
  const prevIsInPipRef = useRef(false);
  useEffect(() => {
    if (prevIsInPipRef.current && !isInPip) {
      setIsFullscreen(false);
    }
    prevIsInPipRef.current = isInPip;
  }, [isInPip]);

  // Position snapshot taken the moment fullscreen is toggled. Passed as
  // startPositionMs to the new player instance inside the Modal.
  const [fsStartPositionMs, setFsStartPositionMs] = useState(0);

  // ── Fullscreen controls overlay state ────────────────────────────────────
  const [fsControlsVisible, setFsControlsVisible] = useState(true);
  const [fsCurrentSecs, setFsCurrentSecs]         = useState(0);
  const [fsDuration, setFsDuration]               = useState(0);
  const [fsScrubbing, setFsScrubbing]             = useState(false);
  const [fsScrubRatio, setFsScrubRatio]           = useState(0);
  const fsScrubbingRef    = useRef(false);
  const fsHideTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fsControlsOpacity = useRef(new Animated.Value(1)).current;

  // ── Floating reactions refs — one per surface ─────────────────────────────
  // Inline player (normal scroll view) and fullscreen modal each get their own
  // ref so emitted particles appear in the currently-visible surface.
  const reactionsRef   = useRef<FloatingReactionsHandle>(null);
  const fsReactionsRef = useRef<FloatingReactionsHandle>(null);

  const scheduleFsHide = useCallback(() => {
    if (fsHideTimerRef.current) clearTimeout(fsHideTimerRef.current);
    fsHideTimerRef.current = setTimeout(() => {
      Animated.timing(fsControlsOpacity, { toValue: 0, duration: 400, useNativeDriver: true }).start(() => {
        setFsControlsVisible(false);
      });
    }, 3000);
  }, [fsControlsOpacity]);

  const showFsControls = useCallback(() => {
    setFsControlsVisible(true);
    Animated.timing(fsControlsOpacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    scheduleFsHide();
  }, [fsControlsOpacity, scheduleFsHide]);

  const handleFsTap = useCallback(() => {
    if (fsControlsVisible) {
      if (fsHideTimerRef.current) clearTimeout(fsHideTimerRef.current);
      Animated.timing(fsControlsOpacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => {
        setFsControlsVisible(false);
      });
    } else {
      showFsControls();
    }
  }, [fsControlsVisible, fsControlsOpacity, showFsControls]);

  const handleFsPlayPause = useCallback(() => {
    showFsControls();
    if (isPlaying) playerPauseRef.current?.();
    else playerPlayRef.current?.();
  }, [isPlaying, playerPauseRef, playerPlayRef, showFsControls]);

  const handleFsScrub = useCallback((r: number) => {
    fsScrubbingRef.current = true;
    setFsScrubbing(true);
    setFsScrubRatio(r);
    if (fsHideTimerRef.current) clearTimeout(fsHideTimerRef.current); // keep visible while scrubbing
  }, []);

  const handleFsScrubEnd = useCallback((r: number) => {
    fsScrubbingRef.current = false;
    setFsScrubbing(false);
    if (fsDuration > 0) {
      const seekSecs = r * fsDuration;
      playerSeekRef.current?.(seekSecs);
      setFsCurrentSecs(seekSecs);
    }
    scheduleFsHide();
  }, [fsDuration, playerSeekRef, scheduleFsHide]);

  // Adaptive player height: respect the video's actual aspect ratio rather
  // than hardcoding 16:9.  Clamped to 60% of screen height in portrait —
  // raised from 55% to use the extra real-estate on modern tall phones
  // (19.5:9 aspect ratio) while still reserving the lower 40% for sermon
  // metadata, chat, and related videos. Vertical/square sources are still
  // capped so they don't push content below the fold.
  const MAX_PORTRAIT_HEIGHT = Math.round(height * 0.60);
  const playerHeight = isLandscape
    ? height
    : Math.min(Math.round(width / videoAspectRatio), MAX_PORTRAIT_HEIGHT);
  const handleAspectRatioChange = useCallback((ratio: number) => {
    // Clamp to sane range — ignore garbage values from corrupt streams.
    if (ratio > 0.1 && ratio < 10) setVideoAspectRatio(ratio);
  }, []);

  // Stable error handler for VOD LocalVideoPlayer.  Without memoisation every
  // 500 ms progress-update render creates a new function reference, which lands
  // in LocalVideoPlayer's stall-watchdog dep array and resets the stall clock
  // every half-second — making the watchdog unable to fire.
  const handleVodError = useCallback(() => {
    Alert.alert(
      "Playback Error",
      "This video could not be played. It may still be processing or the file is unavailable.",
      [{ text: "OK" }],
    );
  }, []);

  // Declared before handleProgressWithPosition to avoid a block-scoped
  // hoisting error (useCallback is not hoisted like a function declaration).
  const { saveProgress } = useWatchProgress();

  const handleProgress = useCallback(
    (positionSecs: number, durationSecs: number) => {
      if (!videoId || videoId === "live" || isLive) return;
      saveProgress(videoId, positionSecs, durationSecs, {
        title,
        thumbnailUrl,
        youtubeId: isYoutube ? youtubeId : undefined,
        localVideoUrl: isHls ? hlsUrl : undefined,
        hlsMasterUrl: isHls ? hlsUrl : undefined,
      });
    },
    [videoId, isLive, saveProgress, title, thumbnailUrl, isYoutube, youtubeId, isHls, hlsUrl],
  );

  // Wraps handleProgress to also track current position for fullscreen hand-off
  // and to drive the fullscreen controls overlay (time display + scrub bar).
  const handleProgressWithPosition = useCallback(
    (positionSecs: number, durationSecs: number) => {
      currentPositionMsRef.current = Math.round(positionSecs * 1000);
      if (!fsScrubbingRef.current) setFsCurrentSecs(positionSecs);
      if (durationSecs > 0) setFsDuration(durationSecs);
      handleProgress(positionSecs, durationSecs);
    },
    [handleProgress],
  );

  // Tracks the *intent* of the most recent orientation request so that if
  // the user rapidly toggles fullscreen (e.g. taps Back during the async
  // lockAsync transition), a stale LANDSCAPE promise resolving after the
  // exit will not leave the home tab stuck in landscape. Whoever resolves
  // last re-applies the *current* intent.
  const orientationIntentRef = useRef<"portrait" | "landscape">("portrait");

  const enterFullscreen = useCallback(() => {
    const posSecs = currentPositionMsRef.current / 1000;
    setFsStartPositionMs(currentPositionMsRef.current);
    setFsCurrentSecs(posSecs);
    setFsControlsVisible(true);
    fsControlsOpacity.setValue(1);
    setIsFullscreen(true);
    scheduleFsHide();
    // On Android the Modal supportedOrientations prop is ignored — the
    // Activity-level lock set in AndroidManifest takes precedence. We must
    // programmatically unlock orientation to let the device rotate into
    // landscape for an immersive fullscreen experience.
    if (Platform.OS !== "web") {
      orientationIntentRef.current = "landscape";
      ScreenOrientation.lockAsync(
        ScreenOrientation.OrientationLock.LANDSCAPE,
      )
        .then(() => {
          if (orientationIntentRef.current !== "landscape") {
            ScreenOrientation.lockAsync(
              ScreenOrientation.OrientationLock.PORTRAIT_UP,
            ).catch(() => {});
          }
        })
        .catch(() => {});
    }
  }, [fsControlsOpacity, scheduleFsHide]);

  // Fires a reaction: sends it to the API + emits a floating emoji particle
  // over whichever player surface is currently active (inline vs fullscreen).
  const handleReaction = useCallback((emoji: string, apiKey: ReactionType) => {
    sendReaction(apiKey);
    if (isFullscreen) {
      fsReactionsRef.current?.emit(emoji);
    } else {
      reactionsRef.current?.emit(emoji);
    }
  }, [isFullscreen]);

  const exitFullscreen = useCallback(() => {
    if (fsHideTimerRef.current) clearTimeout(fsHideTimerRef.current);
    setFsStartPositionMs(currentPositionMsRef.current);
    setIsFullscreen(false);
    // Restore the app-wide portrait lock when leaving fullscreen so the
    // rest of the app (tab bar, home feed, library) stays in portrait.
    if (Platform.OS !== "web") {
      orientationIntentRef.current = "portrait";
      ScreenOrientation.lockAsync(
        ScreenOrientation.OrientationLock.PORTRAIT_UP,
      )
        .then(() => {
          if (orientationIntentRef.current !== "portrait") {
            ScreenOrientation.lockAsync(
              ScreenOrientation.OrientationLock.LANDSCAPE,
            ).catch(() => {});
          }
        })
        .catch(() => {});
    }
  }, []);

  // Clean up timer whenever fullscreen is closed (e.g. Android back button).
  useEffect(() => {
    if (!isFullscreen && fsHideTimerRef.current) {
      clearTimeout(fsHideTimerRef.current);
      fsHideTimerRef.current = null;
    }
  }, [isFullscreen]);

  // Release the landscape orientation lock when the app is sent to the
  // background or to an inactive state (e.g. incoming call, lock screen).
  // Without this, the LANDSCAPE lock bleeds into the home screen and any
  // app opened afterwards until the device auto-rotates on its own.
  // We restore PORTRAIT_UP here but do NOT exit fullscreen — if the user
  // returns quickly and the Modal is still open, enterFullscreen will
  // reapply the LANDSCAPE lock. For a proper exit the back button fires
  // exitFullscreen which already restores portrait.
  useEffect(() => {
    if (Platform.OS === "web") return undefined;
    const sub = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      const isGoingToBackground = nextState === "background" || nextState === "inactive";

      if (isGoingToBackground && isFullscreen) {
        if (isPipSupported && !isYoutube) {
          // Keep the fullscreen Modal open — the video fills the PiP window.
          // If the system rejects the PiP request (locked screen, display off,
          // TV device, etc.) fall back to restoring portrait orientation.
          enterPip().then((entered) => {
            if (!entered) {
              ScreenOrientation.lockAsync(
                ScreenOrientation.OrientationLock.PORTRAIT_UP,
              ).catch(() => {});
            }
          }).catch(() => {
            ScreenOrientation.lockAsync(
              ScreenOrientation.OrientationLock.PORTRAIT_UP,
            ).catch(() => {});
          });
        } else {
          // Non-PiP path: restore portrait so landscape lock doesn't bleed
          // into other apps after the user switches away.
          ScreenOrientation.lockAsync(
            ScreenOrientation.OrientationLock.PORTRAIT_UP,
          ).catch(() => {});
        }
      } else if (isGoingToBackground && !isFullscreen && isPipSupported && !isYoutube && isBroadcastV2) {
        // Auto-enter PiP from portrait mode for live broadcasts.
        // The Activity shrinks to a PiP window showing the player screen.
        // The V2PlayerContainer's own AppState effect handles forceReconnect
        // when the app resumes from PiP. No orientation lock needed since we
        // are not in landscape fullscreen mode.
        enterPip().catch(() => {});
      }
    });
    return () => sub.remove();
  }, [isFullscreen, isPipSupported, isYoutube, isBroadcastV2, enterPip]);

  // Restore portrait lock whenever the player screen is torn down, regardless
  // of how navigation happened (deep-link push, OS back gesture that bypasses
  // the Modal's onRequestClose, tab switch while fullscreen, etc.). Without
  // this, a landscape lock acquired inside the fullscreen Modal can persist
  // into the app's home screen and every screen opened afterward.
  // Also clears the fullscreen controls-hide timer: if the user navigates
  // away while isFullscreen=true, the 3-second hide timer would otherwise
  // fire after unmount, starting an Animated.timing on an orphaned value.
  useEffect(() => {
    return () => {
      if (Platform.OS !== "web") {
        ScreenOrientation.lockAsync(
          ScreenOrientation.OrientationLock.PORTRAIT_UP,
        ).catch(() => {});
      }
      if (fsHideTimerRef.current) {
        clearTimeout(fsHideTimerRef.current);
        fsHideTimerRef.current = null;
      }
    };
  }, []);

  // Live broadcast sync — viewerCount display only. Position is ignored for
  // V2 broadcasts (BroadcastHlsPlayer does `void rest` on initialPositionMs —
  // the V2 engine self-syncs position from the server clock offset). For VOD
  // HLS the LocalVideoPlayer branch uses startPositionSecs (route param)
  // directly, so livePositionMs correctly resolves to the route param in all paths.
  const sync           = useBroadcastSync();
  const livePositionMs = Math.round(startPositionSecs * 1000);

  const { isFavorite, toggleFavorite } = useFavorites();
  const { addToHistory }               = useWatchHistory();

  const favorited = isFavorite(videoId);

  const { sermons } = useVideos();
  const relatedVideos = useMemo(
    () =>
      sermons
        .filter((s) => s.id !== videoId && (!category || s.category === category))
        .slice(0, 8),
    [sermons, videoId, category],
  );

  useEffect(() => {
    if (!videoId || videoId === "live") return;
    recordView(videoId);
    addToHistory({
      id: videoId,
      title,
      thumbnailUrl,
      youtubeId,
      description,
      duration,
      category: category as Sermon["category"],
      preacher,
      date: new Date().toISOString(),
      videoSource: isYoutube ? "youtube" : "local",
      localVideoUrl: hlsUrl || undefined,
    });
  }, [videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggleFavorite = useCallback(() => {
    toggleFavorite({
      id: videoId,
      title,
      thumbnailUrl,
      youtubeId,
      description,
      duration,
      category: category as Sermon["category"],
      preacher,
      date: new Date().toISOString(),
      videoSource: isYoutube ? "youtube" : "local",
      localVideoUrl: hlsUrl || undefined,
    });
  }, [videoId, title, thumbnailUrl, youtubeId, description, duration, category, preacher, isYoutube, hlsUrl, toggleFavorite]);

  const navigateToRelated = useCallback((s: Sermon) => {
    // Keep the shared queue pointer in sync so Prev/Next on the next render
    // pivot around the newly-loaded item rather than the previous one.
    playbackQueue.setCurrent(s.id);
    router.replace({
      pathname: "/player",
      params: {
        id: s.id,
        title: s.title,
        youtubeId: s.videoSource === "youtube" ? s.youtubeId : "",
        hlsUrl: s.hlsMasterUrl ?? "",
        localVideoUrl: s.localVideoUrl ?? "",
        thumbnailUrl: s.thumbnailUrl,
        preacher: s.preacher,
        duration: s.duration,
        category: s.category,
        description: s.description,
      },
    });
  }, []);

  // ── Autoplay countdown state ────────────────────────────────────────────
  // Counts down 5 → 1 after a VOD ends. `null` = no countdown active.
  // Reaches 0 → navigate to nextSermon. Cancelled by user tap, by the
  // video id changing (already moved on), or component unmount.
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Deferred-fire handle for the terminal tick. The interval callback can't
  // navigate inline (router.replace inside a state setter is illegal), so
  // it schedules a 0-ms setTimeout instead. That timeout must also be
  // cancellable — otherwise a Cancel/Prev/unmount in the same frame as
  // count==1 still produces a delayed navigation against a stale pivot.
  const countdownFireRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Navigation-in-flight latch. Set immediately on Prev/Next tap and
  // cleared once the router actually delivers a new `videoId` param.
  // Without this, a rapid double-tap on Next would read the just-updated
  // queue pointer and skip an item — Next #2 would derive from
  // nextSermon's neighbour instead of the intended immediate next.
  const navInFlightRef = useRef(false);

  const stopCountdown = useCallback(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    if (countdownFireRef.current) {
      clearTimeout(countdownFireRef.current);
      countdownFireRef.current = null;
    }
    setCountdown(null);
  }, []);

  const goToNext = useCallback(() => {
    if (navInFlightRef.current) return;
    if (!nextSermon) return;
    navInFlightRef.current = true;
    stopCountdown();
    navigateToRelated(nextSermon);
  }, [nextSermon, stopCountdown, navigateToRelated]);

  const goToPrev = useCallback(() => {
    if (navInFlightRef.current) return;
    if (!prevSermon) return;
    navInFlightRef.current = true;
    stopCountdown();
    navigateToRelated(prevSermon);
  }, [prevSermon, stopCountdown, navigateToRelated]);

  const startCountdown = useCallback(() => {
    // Self-guarded: silently no-ops for live broadcasts or end-of-queue,
    // so the four onEnd call sites don't need to know whether countdown
    // is appropriate for the current source.
    if (!isVod || !nextSermon) return;
    if (countdownTimerRef.current) return; // already running
    setCountdown(5);
    countdownTimerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          if (countdownTimerRef.current) {
            clearInterval(countdownTimerRef.current);
            countdownTimerRef.current = null;
          }
          // Defer navigation outside the state setter and track the
          // handle so stopCountdown() can cancel it if the user reacts
          // within the same frame as count==1.
          countdownFireRef.current = setTimeout(() => {
            countdownFireRef.current = null;
            goToNext();
          }, 0);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  }, [isVod, nextSermon, goToNext]);

  // Cancel the countdown automatically when the screen unmounts or the
  // user advances to another item (videoId changes). Without this, a
  // ticking timer (or deferred terminal-tick fire) could outlive its
  // render and fire navigation against the wrong "current" pivot.
  useEffect(() => {
    return () => {
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
      if (countdownFireRef.current) {
        clearTimeout(countdownFireRef.current);
        countdownFireRef.current = null;
      }
      // Reset navigation guard on unmount. expo-router can keep screen
      // instances alive in its cache; if navInFlightRef is still true when
      // the screen re-activates, all Prev/Next taps would be silently blocked
      // until a videoId change resets it via the videoId effect below.
      navInFlightRef.current = false;
    };
  }, []);
  useEffect(() => {
    // Route delivered a new video id — clear the in-flight latch so the
    // user can immediately tap Prev/Next again, and cancel any countdown
    // that was racing the transition.
    navInFlightRef.current = false;
    stopCountdown();
  }, [videoId, stopCountdown]);

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ headerShown: false, header: () => null, title: "" }} />
      <StatusBar style="light" />

      {/* ── Page header: back button + title ───────────────────────── */}
      <View
        style={[
          styles.pageHeader,
          { paddingTop: insets.top + 8, backgroundColor: c.background, borderBottomColor: c.border },
        ]}
      >
        <Pressable
          onPress={() => router.canGoBack() ? router.back() : router.replace("/")}
          style={[styles.pageHeaderBack, { backgroundColor: c.card, borderColor: c.border }]}
          hitSlop={12}
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <Feather name="arrow-left" size={18} color={c.foreground} />
        </Pressable>
        <Text
          style={[styles.pageHeaderTitle, { color: c.foreground }]}
          numberOfLines={2}
          accessibilityRole="header"
        >
          {isLive ? (liveTitle || "Live Broadcast") : title}
        </Text>
        {isLive && <LiveBadge size="small" />}
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        bounces
        overScrollMode="auto"
        removeClippedSubviews={Platform.OS === "android"}
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 32 }}
      >
        {/* ── 16:9 Player Shell ─────────────────────────────────────────── */}
        <View style={[styles.playerShell, { height: playerHeight }]}>
          {isLive && isHls ? (
            <BroadcastHlsPlayer
              initialUrl={hlsUrl}
              initialPositionMs={livePositionMs}
              thumbnailUrl={thumbnailUrl}
              title={title}
              playerHeightOverride={playerHeight}
              onProgress={handleProgress}
              muted={isFullscreen}
              suppressEvents={isFullscreen}
              isInPip={isInPip}
            />
          ) : isYoutube ? (
            <YoutubePlayer
              videoId={youtubeId}
              thumbnailUrl={thumbnailUrl}
              title={title}
              autoPlay
              startPositionSecs={startPositionSecs}
              playerHeight={playerHeight}
              isBroadcastLive={isLive}
              onEnd={startCountdown}
              onProgress={handleProgress}
            />
          ) : isHls ? (
            <LocalVideoPlayer
              videoUrl={hlsUrl}
              hlsMasterUrl={hlsUrl}
              thumbnailUrl={thumbnailUrl}
              title={title}
              autoPlay
              startPositionMs={livePositionMs}
              isBroadcastLive={isLive}
              playerHeightOverride={playerHeight}
              nextVideoUrl={nextHlsForPreload}
              nextHlsMasterUrl={nextHlsForPreload}
              rate={playbackSpeed}
              onEnd={startCountdown}
              onError={handleVodError}
              onProgress={handleProgressWithPosition}
              onAspectRatioChange={handleAspectRatioChange}
            />
          ) : isLive ? (
            /* isLive=true but no hlsUrl and no youtubeId — default to the
               v2 broadcast engine. This happens when the supervisor or a
               push-notification deep-link pushes /player?isLive=true
               without an explicit stream URL, expecting the engine to
               resolve the current broadcast source itself. */
            <BroadcastHlsPlayer
              initialUrl=""
              initialPositionMs={0}
              thumbnailUrl={thumbnailUrl}
              title={title}
              playerHeightOverride={playerHeight}
              onProgress={handleProgress}
              muted={isFullscreen}
              suppressEvents={isFullscreen}
              isInPip={isInPip}
            />
          ) : (
            <Image
              source={thumbnailUrl ? { uri: thumbnailUrl } : PLACEHOLDER}
              style={StyleSheet.absoluteFill}
              resizeMode="contain"
            />
          )}

          {/* Fullscreen expand — hidden for YouTube (has its own native button) */}
          {!isYoutube && (
            <Pressable
              onPress={enterFullscreen}
              style={styles.fullscreenBtn}
              hitSlop={16}
              accessibilityLabel="Enter fullscreen"
              accessibilityRole="button"
            >
              <Feather name="maximize-2" size={15} color="#fff" />
            </Pressable>
          )}

          {/* Library Prev/Next chrome — VOD only, only when the queue has
              siblings to navigate to. The buttons share the same visual
              language as the back/fullscreen pills so the player feels
              consistent across surfaces. */}
          {isVod && (!!prevSermon || !!nextSermon) && (
            <>
              {prevSermon && (
                <Pressable
                  onPress={goToPrev}
                  style={styles.prevBtnInline}
                  hitSlop={16}
                  accessibilityLabel={`Previous video: ${prevSermon.title}`}
                  accessibilityRole="button"
                >
                  <Feather name="skip-back" size={15} color="#fff" />
                </Pressable>
              )}
              {nextSermon && (
                <Pressable
                  onPress={goToNext}
                  style={[styles.nextBtnInline, !isYoutube && { right: 56 }]}
                  hitSlop={16}
                  accessibilityLabel={`Next video: ${nextSermon.title}`}
                  accessibilityRole="button"
                >
                  <Feather name="skip-forward" size={15} color="#fff" />
                </Pressable>
              )}
            </>
          )}

          {/* Floating emoji reactions — rendered over the video, pointerEvents="none"
              so the back/badge/fullscreen controls still receive touches. Only
              mounted during live broadcasts; idle during VOD playback. */}
          {isLive && <FloatingReactions ref={reactionsRef} />}

          {/* Autoplay countdown overlay — covers the player surface when a
              VOD ends and another item is queued. Self-hides on Cancel /
              Play Now / video advance / unmount. */}
          {countdown !== null && nextSermon && !isInPip && (
            <CountdownOverlay
              next={nextSermon}
              count={countdown}
              onPlayNow={goToNext}
              onCancel={stopCountdown}
              colors={c}
            />
          )}
        </View>

        {/* ── Title & Metadata ──────────────────────────────────────────── */}
        <View style={[styles.infoBlock, { borderBottomColor: c.border }]}>
          {isLive ? (
            /* Live broadcast — V2-driven channel identity + live status */
            <View style={styles.liveMeta}>
              {/* Reconnecting banner — shown while the V2 transport is
                  re-establishing its WS/SSE connection after a drop */}
              {isBroadcastV2 && !v2Connected && (
                <View style={styles.reconnectBannerWrap}>
                  <StreamStatusBadge
                    state={isOnline ? "reconnecting" : "offline"}
                    variant="banner"
                  />
                </View>
              )}

              {/* Off-air state — shown when the V2 queue has no current item */}
              {isBroadcastV2 && !v2Current && v2Mode === "queue" ? (
                <View
                  style={[
                    styles.offAirCard,
                    { backgroundColor: c.card, borderColor: c.border },
                  ]}
                >
                  <View style={[styles.offAirIconWrap, { backgroundColor: c.muted }]}>
                    <Feather name="wifi-off" size={18} color={c.mutedForeground} />
                  </View>
                  <View style={styles.offAirBody}>
                    <Text style={[styles.offAirTitle, { color: c.foreground }]}>Off Air</Text>
                    <Text style={[styles.offAirDesc, { color: c.mutedForeground }]}>
                      {v2OffAirReason === "empty"
                        ? "No content is currently scheduled."
                        : v2OffAirReason === "all_blocked"
                        ? "Content temporarily unavailable."
                        : "Broadcast is paused."}
                    </Text>
                  </View>
                </View>
              ) : (
                <>
                  {/* Override mode badge */}
                  {isBroadcastV2 && v2Mode === "override" && v2Override && (
                    <View style={styles.modeBadgeRow}>
                      <View style={[styles.modeBadge, { backgroundColor: "#f59e0b18" }]}>
                        <Feather name="zap" size={11} color="#d97706" />
                        <Text style={[styles.modeBadgeText, { color: "#d97706" }]}>
                          LIVE OVERRIDE
                        </Text>
                      </View>
                    </View>
                  )}
                  {/* Failover mode badge */}
                  {isBroadcastV2 && v2Mode === "failover" && (
                    <View style={styles.modeBadgeRow}>
                      <View style={[styles.modeBadge, { backgroundColor: "#ef444418" }]}>
                        <Feather name="alert-triangle" size={11} color="#ef4444" />
                        <Text style={[styles.modeBadgeText, { color: "#ef4444" }]}>
                          FAILOVER MODE
                        </Text>
                      </View>
                    </View>
                  )}

                  {/* Sub-row: badge + ministry + quality badge + viewer count */}
                  <View style={styles.liveSubRow}>
                    <LiveBadge size="small" />
                    <Text style={[styles.liveMinistry, { color: c.mutedForeground }]}>
                      JCTM Ministries
                    </Text>
                    {/* Source quality badge — HLS / MP4 / SD */}
                    {isBroadcastV2 && v2SourceQuality &&
                      v2SourceQuality !== "youtube" &&
                      v2SourceQuality !== "live_override" && (
                      <View
                        style={[
                          styles.qualityBadge,
                          {
                            backgroundColor: v2SourceQuality === "hls"
                              ? c.primary + "18"
                              : c.card,
                            borderColor: v2SourceQuality === "hls"
                              ? c.primary + "40"
                              : c.border,
                          },
                        ]}
                      >
                        <Text style={[
                          styles.qualityBadgeText,
                          {
                            color: v2SourceQuality === "hls"
                              ? c.primary
                              : c.mutedForeground,
                          },
                        ]}>
                          {v2SourceQuality === "hls"
                            ? "HLS"
                            : v2SourceQuality === "mp4_faststart"
                            ? "MP4"
                            : "SD"}
                        </Text>
                      </View>
                    )}
                    {sync.viewerCount != null && sync.viewerCount > 0 && (
                      <View
                        style={[
                          styles.viewerChip,
                          { backgroundColor: c.card, borderColor: c.border },
                        ]}
                      >
                        <Feather name="users" size={10} color={c.mutedForeground} />
                        <Text style={[styles.viewerChipText, { color: c.mutedForeground }]}>
                          {sync.viewerCount >= 1000
                            ? `${(sync.viewerCount / 1000).toFixed(1)}k`
                            : String(sync.viewerCount)}
                        </Text>
                      </View>
                    )}
                  </View>

                  {/* Time remaining in current program */}
                  {isBroadcastV2 && v2Current && v2Current.endsAtMs > Date.now() && (
                    <BroadcastTimeRemaining
                      endsAtMs={v2Current.endsAtMs}
                      textColor={c.mutedForeground}
                    />
                  )}

                  {/* Up Next strip — next queued item from the V2 engine */}
                  {isBroadcastV2 && v2Next && (
                    <BroadcastUpNextStrip item={v2Next} colors={c} />
                  )}
                </>
              )}
            </View>
          ) : (
            <>
              <View style={styles.metaRow}>
                <Text style={[styles.preacherText, { color: c.mutedForeground }]} numberOfLines={1}>
                  {preacher}
                </Text>
                {!!duration && (
                  <>
                    <Text style={[styles.metaSep, { color: c.mutedForeground }]}>·</Text>
                    <Feather name="clock" size={11} color={c.mutedForeground} />
                    <Text style={[styles.metaText, { color: c.mutedForeground }]}>{duration}</Text>
                  </>
                )}
                {!!category && (
                  <>
                    <Text style={[styles.metaSep, { color: c.mutedForeground }]}>·</Text>
                    <View style={[styles.categoryPill, { backgroundColor: c.primary + "18", borderColor: c.primary + "40" }]}>
                      <Text style={[styles.categoryPillText, { color: c.primary }]}>{category}</Text>
                    </View>
                  </>
                )}
              </View>
            </>
          )}
        </View>

        {/* ── Action Bar ────────────────────────────────────────────────── */}
        <View style={[styles.actionBar, { borderBottomColor: c.border }]}>

          {/* Save — VOD only */}
          {videoId !== "live" && (
            <Pressable
              onPress={handleToggleFavorite}
              style={styles.actionItem}
              accessibilityLabel={favorited ? "Remove from saved" : "Save video"}
              accessibilityRole="button"
            >
              <View
                style={[
                  styles.actionIconWrap,
                  {
                    backgroundColor: favorited ? "#ef444418" : c.card,
                    borderColor:     favorited ? "#ef444435" : c.border,
                  },
                ]}
              >
                <Feather
                  name="heart"
                  size={20}
                  color={favorited ? "#ef4444" : c.foreground}
                />
              </View>
              <Text style={[styles.actionLabel, { color: favorited ? "#ef4444" : c.mutedForeground }]}>
                {favorited ? "Saved" : "Save"}
              </Text>
            </Pressable>
          )}

          {/* Share */}
          <Pressable
            onPress={() =>
              isLive
                ? Share.share({ title: "Live Broadcast", message: "Watch JCTM Live — Jesus Christ Temple Ministry" })
                : Share.share({ title, message: `Watch "${title}" on JCTM Broadcasting` })
            }
            style={styles.actionItem}
            accessibilityLabel="Share"
            accessibilityRole="button"
          >
            <View style={[styles.actionIconWrap, { backgroundColor: c.card, borderColor: c.border }]}>
              <Feather name="share-2" size={20} color={c.foreground} />
            </View>
            <Text style={[styles.actionLabel, { color: c.mutedForeground }]}>Share</Text>
          </Pressable>

          {/* PiP — Android only, not for YouTube */}
          {Platform.OS === "android" && isPipSupported && !isYoutube && (
            <Pressable
              onPress={enterPip}
              style={styles.actionItem}
              accessibilityLabel="Picture in Picture — watch in a small floating window"
              accessibilityRole="button"
            >
              <View style={[styles.actionIconWrap, { backgroundColor: c.card, borderColor: c.border }]}>
                <Feather name="monitor" size={20} color={c.foreground} />
              </View>
              <Text style={[styles.actionLabel, { color: c.mutedForeground }]}>Mini Player</Text>
            </Pressable>
          )}

          {/* Cast — VOD non-YouTube; AirPlay on iOS, Chromecast guide on Android */}
          {isVod && !isYoutube && (
            <Pressable
              onPress={() =>
                Alert.alert(
                  Platform.OS === "ios" ? "AirPlay" : "Cast to Chromecast",
                  Platform.OS === "ios"
                    ? "Tap the AirPlay icon (📺) in the video player controls to stream to Apple TV or any AirPlay-compatible device."
                    : "Make sure your Chromecast and phone are on the same Wi-Fi network. A cast icon will appear in your notification bar while a video plays.",
                  [{ text: "Got it" }],
                )
              }
              style={styles.actionItem}
              accessibilityLabel={Platform.OS === "ios" ? "AirPlay — stream to Apple TV" : "Cast to Chromecast"}
              accessibilityRole="button"
            >
              <View style={[styles.actionIconWrap, { backgroundColor: c.card, borderColor: c.border }]}>
                <Feather name="cast" size={20} color={c.foreground} />
              </View>
              <Text style={[styles.actionLabel, { color: c.mutedForeground }]}>
                {Platform.OS === "ios" ? "AirPlay" : "Cast"}
              </Text>
            </Pressable>
          )}

          {/* Chat — live only */}
          {isLive && (
            <Pressable
              onPress={() => setShowChat((v) => !v)}
              style={styles.actionItem}
              accessibilityLabel={showChat ? "Hide live chat" : "Open live chat"}
              accessibilityRole="button"
            >
              <View
                style={[
                  styles.actionIconWrap,
                  {
                    backgroundColor: showChat ? c.primary + "20" : c.card,
                    borderColor:     showChat ? c.primary + "50" : c.border,
                  },
                ]}
              >
                <Feather
                  name="message-circle"
                  size={20}
                  color={showChat ? c.primary : c.foreground}
                />
              </View>
              <Text style={[styles.actionLabel, { color: showChat ? c.primary : c.mutedForeground }]}>
                {showChat ? "Hide Chat" : "Chat"}
              </Text>
            </Pressable>
          )}
        </View>

        {/* ── Speed Control — VOD non-YouTube only ─────────────────────── */}
        {isVod && !isYoutube && (
          <View style={[styles.speedBar, { borderBottomColor: c.border }]}>
            <View style={styles.speedHeader}>
              <Feather name="zap" size={13} color={c.mutedForeground} />
              <Text style={[styles.speedHeaderLabel, { color: c.mutedForeground }]}>Playback Speed</Text>
            </View>
            <View style={styles.speedPills}>
              {([0.5, 0.75, 1, 1.25, 1.5, 2] as const).map((s) => (
                <Pressable
                  key={s}
                  onPress={() => setPlaybackSpeed(s)}
                  style={[
                    styles.speedPill,
                    {
                      backgroundColor: playbackSpeed === s ? c.primary : c.card,
                      borderColor:     playbackSpeed === s ? c.primary : c.border,
                    },
                  ]}
                  accessibilityLabel={`Set playback speed to ${s === 1 ? "normal" : `${s} times`}`}
                  accessibilityRole="button"
                >
                  <Text style={[styles.speedPillText, { color: playbackSpeed === s ? "#fff" : c.foreground }]}>
                    {s === 1 ? "Normal" : `${s}×`}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* ── Description (expandable) ──────────────────────────────────── */}
        {!!description && (
          <View style={[styles.descSection, { borderBottomColor: c.border }]}>
            <Text style={[styles.descText, { color: c.mutedForeground }]} numberOfLines={descExpanded ? undefined : 3}>
              {description}
            </Text>
            <Pressable onPress={() => setDescExpanded((v) => !v)} style={styles.descToggle} hitSlop={10} accessibilityRole="button" accessibilityLabel={descExpanded ? "Show less description" : "Show full description"}>
              <Text style={[styles.descToggleText, { color: c.primary }]}>{descExpanded ? "Show less" : "Show more"}</Text>
              <Feather name={descExpanded ? "chevron-up" : "chevron-down"} size={14} color={c.primary} />
            </Pressable>
          </View>
        )}

        {/* ── Live: Reactions + Prayer ──────────────────────────────────── */}
        {isLive && (
          <View style={styles.liveSection}>

            {/* Reactions card — no title, just the emoji grid */}
            <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
              <View style={styles.reactionsHeaderRow}>
                <Text style={[styles.reactionsTitle, { color: c.foreground }]}>
                  React to the Service
                </Text>
                <Text style={[styles.reactionsHint, { color: c.mutedForeground }]}>
                  Tap to react
                </Text>
              </View>
              <View style={styles.reactionsRow}>
                <ReactionButton emoji="🙏" label="Amen"   onPress={() => handleReaction("🙏", "amen")} />
                <ReactionButton emoji="🔥" label="Fire"   onPress={() => handleReaction("🔥", "fire")} />
                <ReactionButton emoji="✨" label="Glory"  onPress={() => handleReaction("✨", "hallelujah")} />
                <ReactionButton emoji="🕊️" label="Peace" onPress={() => handleReaction("🕊️", "hallelujah")} />
              </View>
            </View>

            <PrayerSection />
          </View>
        )}

        {/* ── Related Videos — VOD only ─────────────────────────────────── */}
        {!isLive && relatedVideos.length > 0 && (
          <View style={styles.relatedSection}>
            <View style={styles.relatedHeader}>
              <Text style={[styles.relatedTitle, { color: c.foreground }]}>
                {category ? `More ${category}` : "More Videos"}
              </Text>
              <View style={[styles.relatedCountPill, { backgroundColor: c.card, borderColor: c.border }]}>
                <Text style={[styles.relatedCountText, { color: c.mutedForeground }]}>{relatedVideos.length}</Text>
              </View>
            </View>
            {relatedVideos.map((s) => (
              <VideoCard key={s.id} sermon={s} onPress={() => navigateToRelated(s)} horizontal />
            ))}
          </View>
        )}
      </ScrollView>

      {/* ── Live Chat Panel — floats over full screen ─────────────────── */}
      {/* Chat panel is hidden during PiP — the window is too small for interaction. */}
      <ChatPanel visible={isLive && showChat && !isInPip} onClose={() => setShowChat(false)} />

      {/* ── Fullscreen Modal ──────────────────────────────────────────────
          Renders the active player in a full-device overlay so the video
          fills the entire screen regardless of aspect ratio. The player
          component is remounted (new instance) on toggle; for VOD sources
          the saved fsStartPositionMs ensures it picks up where the inline
          player left off. For live streams the V2 engine reconnects within
          ~1 s, which is acceptable for a user-initiated fullscreen action. */}
      <Modal
        visible={isFullscreen}
        animationType="fade"
        statusBarTranslucent
        onRequestClose={exitFullscreen}
        supportedOrientations={["portrait", "landscape", "landscape-left", "landscape-right"]}
      >
        <View style={styles.fsRoot}>
          <StatusBar hidden />

          {/* Player fills the entire modal */}
          <View style={styles.fsPlayerWrap}>
            {isLive && isHls ? (
              <BroadcastHlsPlayer
                initialUrl={hlsUrl}
                initialPositionMs={livePositionMs}
                thumbnailUrl={thumbnailUrl}
                title={title}
                playerHeightOverride={height}
                onProgress={handleProgress}
                isInPip={isInPip}
              />
            ) : isYoutube ? (
              <YoutubePlayer
                videoId={youtubeId}
                thumbnailUrl={thumbnailUrl}
                title={title}
                autoPlay
                startPositionSecs={Math.round(fsStartPositionMs / 1000)}
                playerHeight={height}
                isBroadcastLive={isLive}
                onEnd={startCountdown}
                onProgress={handleProgress}
              />
            ) : isHls ? (
              <LocalVideoPlayer
                videoUrl={hlsUrl}
                hlsMasterUrl={hlsUrl}
                thumbnailUrl={thumbnailUrl}
                title={title}
                autoPlay
                startPositionMs={fsStartPositionMs}
                isBroadcastLive={isLive}
                fillContainer
                nextVideoUrl={nextHlsForPreload}
                nextHlsMasterUrl={nextHlsForPreload}
                rate={playbackSpeed}
                onEnd={startCountdown}
                onError={exitFullscreen}
                onProgress={handleProgressWithPosition}
                onAspectRatioChange={handleAspectRatioChange}
              />
            ) : isLive ? (
              <BroadcastHlsPlayer
                initialUrl=""
                initialPositionMs={0}
                thumbnailUrl={thumbnailUrl}
                title={title}
                playerHeightOverride={height}
                onProgress={handleProgress}
                isInPip={isInPip}
              />
            ) : (
              <Image
                source={thumbnailUrl ? { uri: thumbnailUrl } : PLACEHOLDER}
                style={StyleSheet.absoluteFill}
                resizeMode="contain"
              />
            )}
          </View>

          {/* Floating reactions — fullscreen surface. Sits above the player
              but below the controls overlay so particles are always visible
              regardless of whether the controls are hidden. */}
          {isLive && <FloatingReactions ref={fsReactionsRef} />}

          {/* Autoplay countdown overlay — fullscreen surface.
              Hidden during PiP — the window is too small for meaningful interaction. */}
          {countdown !== null && nextSermon && !isInPip && (
            <CountdownOverlay
              next={nextSermon}
              count={countdown}
              onPlayNow={goToNext}
              onCancel={stopCountdown}
              colors={c}
            />
          )}

          {/* ── Controls overlay — tap anywhere on video to show/hide ──
              Hidden entirely when in PiP mode: the window is too small
              for any useful interaction, and the controls clutter the
              video frame. Media controls in PiP are provided by the OS
              (Android picture-in-picture media action buttons). */}
          {!isInPip && (
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={handleFsTap}
            accessibilityLabel="Toggle player controls"
          >
            <Animated.View
              style={[StyleSheet.absoluteFill, { opacity: fsControlsOpacity, pointerEvents: fsControlsVisible ? "box-none" : "none" }]}
            >
              {/* Top gradient + bar */}
              <LinearGradient
                colors={["rgba(0,0,0,0.72)", "transparent"]}
                style={styles.fsTopGradient}
              >
                <View style={[styles.fsTopBar, { paddingTop: insets.top + 8 }]}>
                  <Pressable
                    onPress={exitFullscreen}
                    style={styles.fsIconBtn}
                    hitSlop={16}
                    accessibilityLabel="Exit fullscreen"
                    accessibilityRole="button"
                  >
                    <Feather name="minimize-2" size={20} color="#fff" />
                  </Pressable>
                  {!isLive ? (
                    <Text numberOfLines={1} style={styles.fsTitleText} ellipsizeMode="tail">
                      {title}
                    </Text>
                  ) : (
                    <View style={{ flex: 1 }} />
                  )}
                  {isLive && (
                    <View style={styles.fsLiveBadgeWrap}>
                      <LiveBadge />
                    </View>
                  )}
                  {/* PiP button — Android only. Shrinks the fullscreen video into
                      a floating window so the user can multitask while watching. */}
                  {Platform.OS === "android" && isPipSupported && !isYoutube && (
                    <Pressable
                      onPress={enterPip}
                      style={styles.fsIconBtn}
                      hitSlop={16}
                      accessibilityLabel="Picture in Picture"
                      accessibilityRole="button"
                    >
                      <Feather name="monitor" size={18} color="#fff" />
                    </Pressable>
                  )}
                </View>
              </LinearGradient>

              {/* Bottom gradient + controls bar */}
              <LinearGradient
                colors={["transparent", "rgba(0,0,0,0.80)"]}
                style={styles.fsBottomGradient}
              >
                {/* Quick-reaction row — live broadcasts only */}
                {isLive && (
                  <View style={styles.fsReactionsRow}>
                    {(
                      [
                        { emoji: "🙏", key: "amen" },
                        { emoji: "🔥", key: "fire" },
                        { emoji: "✨", key: "hallelujah" },
                        { emoji: "🕊️", key: "peace" },
                      ] as const
                    ).map(({ emoji, key }) => (
                      <Pressable
                        key={key}
                        onPress={() =>
                          handleReaction(
                            emoji,
                            key === "peace" ? "hallelujah" : key,
                          )
                        }
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={`React with ${emoji}`}
                        style={({ pressed }: { pressed: boolean }) => [
                          styles.fsEmojiBtn,
                          { opacity: pressed ? 0.55 : 1 },
                        ]}
                      >
                        <Text style={styles.fsEmojiText}>{emoji}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}

                {/* Speed pills — VOD non-YouTube only; tap to change rate without leaving fullscreen */}
                {isVod && !isYoutube && (
                  <View style={styles.fsSpeedRow}>
                    {([0.5, 0.75, 1, 1.25, 1.5, 2] as const).map((s) => (
                      <Pressable
                        key={s}
                        onPress={() => setPlaybackSpeed(s)}
                        style={[styles.fsSpeedPill, playbackSpeed === s && styles.fsSpeedPillActive]}
                        hitSlop={8}
                        accessibilityLabel={`Set speed to ${s === 1 ? "normal" : `${s} times`}`}
                        accessibilityRole="button"
                      >
                        <Text style={[styles.fsSpeedPillText, playbackSpeed === s && styles.fsSpeedPillTextActive]}>
                          {s === 1 ? "1×" : `${s}×`}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}

                <View style={[styles.fsBottomBar, { paddingBottom: Math.max(insets.bottom, 16) }]}>
                  {/* Library prev — VOD only when queue has a predecessor */}
                  {isVod && prevSermon && (
                    <Pressable
                      onPress={goToPrev}
                      style={styles.fsIconBtn}
                      hitSlop={12}
                      accessibilityLabel={`Previous video: ${prevSermon.title}`}
                      accessibilityRole="button"
                    >
                      <Feather name="skip-back" size={20} color="#fff" />
                    </Pressable>
                  )}

                  {/* Play / Pause */}
                  <Pressable
                    onPress={handleFsPlayPause}
                    style={styles.fsIconBtn}
                    hitSlop={12}
                    accessibilityLabel={isPlaying ? "Pause" : "Play"}
                    accessibilityRole="button"
                  >
                    <Feather name={isPlaying ? "pause" : "play"} size={22} color="#fff" />
                  </Pressable>

                  {/* Library next — VOD only when queue has a successor */}
                  {isVod && nextSermon && (
                    <Pressable
                      onPress={goToNext}
                      style={styles.fsIconBtn}
                      hitSlop={12}
                      accessibilityLabel={`Next video: ${nextSermon.title}`}
                      accessibilityRole="button"
                    >
                      <Feather name="skip-forward" size={20} color="#fff" />
                    </Pressable>
                  )}

                  {/* Current time */}
                  <Text style={styles.fsTimeText}>
                    {formatTime(fsScrubbing ? fsScrubRatio * fsDuration : fsCurrentSecs)}
                  </Text>

                  {/* Scrub bar — VOD only, hidden for live */}
                  {!isLive && fsDuration > 0 ? (
                    <FsScrubBar
                      ratio={fsScrubbing ? fsScrubRatio : (fsDuration > 0 ? fsCurrentSecs / fsDuration : 0)}
                      onScrub={handleFsScrub}
                      onScrubEnd={handleFsScrubEnd}
                    />
                  ) : (
                    <View style={{ flex: 1 }} />
                  )}

                  {/* Total duration (or LIVE label) */}
                  {isLive ? (
                    <View style={styles.fsLiveChip}>
                      <Text style={styles.fsLiveChipText}>LIVE</Text>
                    </View>
                  ) : (
                    <Text style={styles.fsTimeText}>{formatTime(fsDuration)}</Text>
                  )}
                </View>
              </LinearGradient>
            </Animated.View>
          </Pressable>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  pageHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pageHeaderBack: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  pageHeaderTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 22,
    letterSpacing: -0.2,
  },

  playerShell: { width: "100%", backgroundColor: "#000", position: "relative", overflow: "hidden" },
  backBtn: { position: "absolute", left: 12, zIndex: 20, width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(0,0,0,0.50)", alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 4, elevation: 5 },
  liveBadgePos: { position: "absolute", right: 12, zIndex: 20 },
  fullscreenBtn: { position: "absolute", right: 12, bottom: 12, zIndex: 20, width: 34, height: 34, borderRadius: 17, backgroundColor: "rgba(0,0,0,0.50)", alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 4, elevation: 5 },
  prevBtnInline: { position: "absolute", left: 12, bottom: 12, zIndex: 20, width: 34, height: 34, borderRadius: 17, backgroundColor: "rgba(0,0,0,0.50)", alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 4, elevation: 5 },
  nextBtnInline: { position: "absolute", right: 12, bottom: 12, zIndex: 20, width: 34, height: 34, borderRadius: 17, backgroundColor: "rgba(0,0,0,0.50)", alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 4, elevation: 5 },

  fsRoot: { flex: 1, backgroundColor: "#000" },
  fsPlayerWrap: { flex: 1 },

  fsTopGradient: { position: "absolute", top: 0, left: 0, right: 0, height: 130 },
  fsTopBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, gap: 10 },
  fsIconBtn: { width: 38, height: 38, alignItems: "center", justifyContent: "center" },
  fsTitleText: { flex: 1, color: "#fff", fontSize: 14, fontWeight: "600", letterSpacing: 0.1 },
  fsLiveBadgeWrap: { flexShrink: 0 },

  fsBottomGradient: { position: "absolute", bottom: 0, left: 0, right: 0, height: 140, justifyContent: "flex-end" },
  fsBottomBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, gap: 10 },
  fsTimeText: { color: "rgba(255,255,255,0.90)", fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"], minWidth: 40, textAlign: "center" },
  fsLiveChip: { backgroundColor: "#DC2626", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  fsLiveChipText: { color: "#fff", fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },


  // ── Info block ──────────────────────────────────────────────────────────────
  infoBlock: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 16, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  liveMeta: { gap: 8 },
  liveChannelName: { fontSize: 20, fontWeight: "800", lineHeight: 27, letterSpacing: -0.4 },
  liveSubRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  liveMinistry: { fontSize: 13, fontWeight: "500" },
  viewerChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 20,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  reconnectBannerWrap: { marginBottom: 6 },
  // Off-air card
  offAirCard: {
    flexDirection: "row", alignItems: "center", gap: 12,
    borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12, paddingVertical: 10,
  },
  offAirIconWrap: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  offAirBody: { flex: 1, minWidth: 0 },
  offAirTitle: { fontSize: 14, fontWeight: "700" },
  offAirDesc: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  // Mode badge (override / failover)
  modeBadgeRow: { flexDirection: "row" },
  modeBadge: {
    flexDirection: "row", alignItems: "center", gap: 4,
    borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3,
  },
  modeBadgeText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.6 },
  // Source quality badge
  qualityBadge: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 4,
    paddingHorizontal: 5, paddingVertical: 1,
  },
  qualityBadgeText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
  viewerChipText: { fontSize: 11, fontWeight: "600" },
  videoTitle: { fontSize: 19, fontWeight: "800", lineHeight: 26, letterSpacing: -0.4 },
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 5, marginTop: 2 },
  preacherText: { fontSize: 13, fontWeight: "500", flexShrink: 1 },
  metaSep: { fontSize: 13, marginHorizontal: 2, opacity: 0.5 },
  metaText: { fontSize: 13 },
  categoryPill: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth },
  categoryPillText: { fontSize: 11, fontWeight: "700", letterSpacing: 0.2 },

  // ── Action bar ──────────────────────────────────────────────────────────────
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  actionItem: { alignItems: "center", gap: 6, flex: 1 },
  actionIconWrap: {
    width: 48, height: 48, borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center", justifyContent: "center",
  },
  actionLabel: { fontSize: 11, fontWeight: "600", letterSpacing: 0.15 },

  // ── Description ─────────────────────────────────────────────────────────────
  descSection: { paddingHorizontal: 16, paddingVertical: 12, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  descText: { fontSize: 14, lineHeight: 20 },
  descToggle: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  descToggleText: { fontSize: 13, fontWeight: "600" },

  // ── Live section (reactions + prayer) ───────────────────────────────────────
  liveSection: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, gap: 12 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 14 },
  cardTitle: { fontSize: 14, fontWeight: "700", letterSpacing: 0.1 },

  reactionsHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  reactionsTitle: { fontSize: 14, fontWeight: "700", letterSpacing: 0.1 },
  reactionsHint: { fontSize: 11, fontWeight: "500" },
  reactionsRow: { flexDirection: "row", justifyContent: "space-around" },


  speedBar: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  speedHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  speedHeaderLabel: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.2,
    textTransform: "uppercase",
  },
  speedPills: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  speedPill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
  },
  speedPillText: {
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.1,
  },

  relatedSection: { paddingTop: 16 },
  relatedHeader: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, marginBottom: 6 },
  relatedTitle: { fontSize: 15, fontWeight: "700", flex: 1 },
  relatedCountPill: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth },
  relatedCountText: { fontSize: 12, fontWeight: "600" },

  // Fullscreen quick-reaction row (live only)
  fsReactionsRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  fsEmojiBtn: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
    backgroundColor: "rgba(0,0,0,0.40)",
  },
  fsEmojiText: { fontSize: 24 },

  fsSpeedRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  fsSpeedPill: {
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.14)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
  },
  fsSpeedPillActive: {
    backgroundColor: "rgba(255,255,255,0.92)",
    borderColor: "rgba(255,255,255,0.92)",
  },
  fsSpeedPillText: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  fsSpeedPillTextActive: {
    color: "#111",
  },
});
