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
} from "react";
import {
  Alert,
  Animated,
  AppState,
  type AppStateStatus,
  Image,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router, useLocalSearchParams } from "expo-router";
import { parseBoolParam, parseNumberParam } from "@/lib/params";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useKeepAwake } from "expo-keep-awake";
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from "expo-av";
import * as ScreenOrientation from "expo-screen-orientation";
import { useColors } from "@/hooks/useColors";
import { YoutubePlayer } from "@/components/YoutubePlayer";
import { LocalVideoPlayer } from "@/components/LocalVideoPlayer";
import { LiveBadge } from "@/components/LiveBadge";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useFavorites } from "@/hooks/useFavorites";
import { useWatchHistory } from "@/hooks/useWatchHistory";
import { useWatchProgress } from "@/hooks/useWatchProgress";
import { useBroadcastSync } from "@/hooks/useBroadcastSync";
import { useVideos } from "@/hooks/useVideos";
import { VideoCard } from "@/components/VideoCard";
import { sendReaction, submitPrayerRequest, recordView, type ReactionType } from "@/services/api";
import type { Sermon } from "@/types";
import { ChatPanel } from "@/components/ChatPanel";
import { FloatingReactions, type FloatingReactionsHandle } from "@/components/FloatingReactions";
import { V2PlayerContainer } from "@/components/V2PlayerContainer";
import { getApiBase } from "@/lib/apiBase";
import { usePageSeo } from "@/hooks/usePageSeo";
import { usePlayer } from "@/context/PlayerContext";

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

// Derive the canonical site origin from build-time env vars so structured-data
// URLs are correct across dev, preview, and production builds.
// Falls back to the production domain when the env var is absent (native-only
// builds that don't set EXPO_PUBLIC_DOMAIN).
const SITE_ORIGIN: string = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${(process.env.EXPO_PUBLIC_DOMAIN as string).replace(/^https?:\/\//, "").replace(/\/$/, "")}`
  : "https://templetv.org.ng";

// ─── Reaction Button ──────────────────────────────────────────────────────────

function ReactionButton({
  emoji,
  label,
  onPress,
}: {
  emoji: string;
  label: string;
  onPress: () => void;
}) {
  const c = useColors();
  const scale = useRef(new Animated.Value(1)).current;
  const [sent, setSent] = useState(false);

  const handlePress = () => {
    setSent(true);
    setTimeout(() => setSent(false), 1400);
    Animated.sequence([
      Animated.spring(scale, { toValue: 1.38, useNativeDriver: true, speed: 55, bounciness: 14 }),
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 28 }),
    ]).start();
    onPress();
  };

  return (
    <Pressable onPress={handlePress} style={styles.reactionBtn} hitSlop={10} accessibilityLabel={label} accessibilityRole="button">
      <Animated.View style={[styles.reactionCircle, { backgroundColor: sent ? c.primary + "20" : c.card, borderColor: sent ? c.primary + "60" : c.border, transform: [{ scale }] }]}>
        <Text style={styles.reactionEmoji}>{emoji}</Text>
      </Animated.View>
      <Text style={[styles.reactionLabel, { color: sent ? c.primary : c.mutedForeground }]}>{label}</Text>
    </Pressable>
  );
}

// ─── Prayer Section ───────────────────────────────────────────────────────────

function PrayerSection() {
  const c = useColors();
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);

  if (submitted) {
    return (
      <View style={[styles.prayerCard, { backgroundColor: c.card, borderColor: "#22c55e33" }]}>
        <View style={styles.prayerSuccessRow}>
          <View style={[styles.prayerSuccessIcon, { backgroundColor: "#22c55e20" }]}>
            <Feather name="check" size={18} color="#22c55e" />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[styles.prayerSentTitle, { color: c.foreground }]}>Prayer request received</Text>
            <Text style={[styles.prayerSentSub, { color: c.mutedForeground }]}>Our team is praying for you</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.prayerCard, { backgroundColor: c.card, borderColor: c.border }]}>
      <View style={styles.prayerHeader}>
        <View style={[styles.prayerIconWrap, { backgroundColor: c.primary + "1A" }]}>
          <Feather name="heart" size={16} color={c.primary} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.prayerTitle, { color: c.foreground }]}>Send a Prayer Request</Text>
          <Text style={[styles.prayerSubtitle, { color: c.mutedForeground }]}>Our team will pray for you during the service</Text>
        </View>
      </View>
      <Pressable
        onPress={() => {
          setSending(true);
          submitPrayerRequest(null, "Praying with Temple TV").then((ok) => {
            setSending(false);
            if (ok) setSubmitted(true);
          });
        }}
        style={({ pressed }) => [styles.prayerBtn, { backgroundColor: c.primary, opacity: sending || pressed ? 0.72 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel="Send prayer request"
      >
        <Feather name="send" size={14} color="#fff" />
        <Text style={styles.prayerBtnText}>{sending ? "Sending…" : "Send Request"}</Text>
      </Pressable>
    </View>
  );
}

// ─── Fullscreen helpers ───────────────────────────────────────────────────────

function formatTime(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function FsScrubBar({
  ratio,
  onScrub,
  onScrubEnd,
}: {
  ratio: number;
  onScrub: (r: number) => void;
  onScrubEnd: (r: number) => void;
}) {
  const [barWidth, setBarWidth] = useState(0);
  const barWidthRef = useRef(0);
  const startXRef   = useRef(0);
  const lastRRef    = useRef(ratio);
  lastRRef.current  = ratio;

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (evt) => {
        startXRef.current = evt.nativeEvent.locationX;
        const r = Math.max(0, Math.min(1, startXRef.current / (barWidthRef.current || 1)));
        onScrub(r);
      },
      onPanResponderMove: (_evt, gs) => {
        const x = startXRef.current + gs.dx;
        const r = Math.max(0, Math.min(1, x / (barWidthRef.current || 1)));
        onScrub(r);
      },
      onPanResponderRelease: (_evt, gs) => {
        const x = startXRef.current + gs.dx;
        const r = Math.max(0, Math.min(1, x / (barWidthRef.current || 1)));
        onScrubEnd(r);
      },
      onPanResponderTerminate: () => {
        onScrubEnd(lastRRef.current);
      },
    }),
  ).current;

  const progress = Math.max(0, Math.min(1, ratio));
  const thumbLeft = barWidth > 0 ? barWidth * progress - 7 : 0;

  return (
    <View
      style={styles.fsScrubBarWrap}
      onLayout={(e) => {
        barWidthRef.current = e.nativeEvent.layout.width;
        setBarWidth(e.nativeEvent.layout.width);
      }}
      {...pan.panHandlers}
    >
      <View style={styles.fsScrubTrack}>
        <View style={[styles.fsScrubFill, { width: `${progress * 100}%` as any }]} />
      </View>
      <View style={[styles.fsScrubThumb, { left: thumbLeft }]} />
    </View>
  );
}

// ─── Broadcast HLS Player (v2 — backed by player-core) ───────────────────────

interface BroadcastHlsPlayerProps {
  initialUrl:         string;
  initialPositionMs:  number;
  thumbnailUrl:       string;
  title:              string;
  playerHeightOverride: number;
  onProgress?:        (positionSecs: number, durationSecs: number) => void;
}

/**
 * Wrapper around `<V2PlayerContainer/>` so the call site at line ~432 keeps
 * its prop shape. The v2 container ignores all props except `baseUrl` — it
 * owns its own transport, FSM, and source resolution. The `initialUrl` /
 * `initialPositionMs` / `title` / `thumbnailUrl` parameters are no longer
 * needed but kept so this swap is a pure-rename for the parent.
 *
 * `onFatal`: when the FSM reaches FATAL (all recovery paths exhausted),
 * navigate the user back rather than leaving a frozen "Broadcast unavailable"
 * overlay with no escape route.
 */
function BroadcastHlsPlayer(_props: BroadcastHlsPlayerProps) {
  void _props;
  const apiBase = getApiBase() ?? "";
  const handleFatal = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/");
    }
  }, []);
  return (
    <V2PlayerContainer
      baseUrl={`${apiBase}/api/broadcast-v2`}
      onFatal={handleFatal}
    />
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function PlayerScreen() {
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

  // Keep the screen on for the entire time the player screen is mounted.
  // The root layout already configures audio for background playback, but
  // for *visual* playback (live broadcast, VOD watch session) the user
  // expects the screen never to dim or auto-lock — same as YouTube/Twitch.
  // `useKeepAwake` is scoped to component lifetime: it auto-releases the
  // wake lock on unmount, so leaving the player frees the lock for normal
  // OS battery behaviour.
  useKeepAwake();

  // Re-assert the audio mode on player mount. The root layout sets this
  // once at app boot, but iOS/Android can revoke audio focus when another
  // app (Spotify, a phone call, Siri) takes over. Re-asserting here makes
  // sure that when the user returns to the broadcast surface, audio is
  // routed back to the playback session and isn't muted by the system's
  // last-known interruption state. Errors are swallowed — a failure here
  // is non-fatal (audio still plays, just with default routing).
  useEffect(() => {
    Audio.setAudioModeAsync({
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
    }).catch(() => {});
  }, []);

  const { setIsBroadcastMode, isPlaying, playerPlayRef, playerPauseRef, playerSeekRef } = usePlayer();

  const videoId      = params.id ?? "live";
  const title        = params.title ?? "Now Playing";
  const youtubeId    = params.youtubeId ?? params.videoId ?? "";
  const hlsUrl       = params.hlsUrl ?? params.hlsMasterUrl ?? params.localVideoUrl ?? "";
  const thumbnailUrl = params.thumbnailUrl ?? params.thumbnail ?? "";
  const preacher     = params.preacher ?? "Temple TV";
  const duration     = params.duration ?? "";
  const category     = params.category ?? "";
  const description  = params.description ?? "";
  const isLive       = parseBoolParam(params.isLive) || parseBoolParam(params.broadcastMode);
  // True when the V2 broadcast engine owns the player slot (HLS channel or
  // the raw "isLive=true" deep-link with no explicit source URL). Excludes
  // the YouTube live path — that is handled by the LiveBroadcastSupervisor
  // which already calls playLive() and sets PlayerContext.isLive=true.
  const isBroadcastV2 = isLive && !( !!( params.youtubeId ?? params.videoId ) && !hlsUrl );

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

  // Inject structured data (VideoObject or BroadcastEvent) for web-embedded
  // and PWA surfaces. This is a no-op on bare React Native / Expo Go — the
  // hook checks `typeof document` before writing to the DOM.
  usePageSeo(
    isLive
      ? {
          title: title || "Temple TV — Live Broadcast",
          description: "Watch Temple TV live worship broadcast",
          path: "/player",
          structuredData: {
            "@context": "https://schema.org",
            "@type": "BroadcastEvent",
            name: title || "Temple TV — Live Broadcast",
            description: "Watch Temple TV live worship broadcast",
            isLiveBroadcast: true,
            location: {
              "@type": "VirtualLocation",
              url: `${SITE_ORIGIN}/player`,
            },
            broadcaster: {
              "@type": "Organization",
              name: "Temple TV",
              url: "https://templetv.org.ng",
            },
          },
        }
      : {
          title: title || "Sermon",
          description: description || `Watch ${title ?? "this sermon"} on Temple TV`,
          path: `/player?id=${videoId}`,
          image: thumbnailUrl || undefined,
          structuredData: {
            "@context": "https://schema.org",
            "@type": "VideoObject",
            name: title,
            description: description || `Watch ${title} on Temple TV`,
            thumbnailUrl: thumbnailUrl || undefined,
            creator: preacher ? { "@type": "Person", name: preacher } : undefined,
            publisher: {
              "@type": "Organization",
              name: "Temple TV",
              url: "https://templetv.org.ng",
            },
          },
        },
  );

  const [showChat, setShowChat]         = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Detected aspect ratio of the loaded video (width / height). Defaults to
  // 16:9 so standard broadcasts / YouTube look correct before onLoad fires.
  // Updated by LocalVideoPlayer.onAspectRatioChange once the source loads.
  const [videoAspectRatio, setVideoAspectRatio] = useState(16 / 9);
  // Last-known playback position (ms). Written by handleProgressWithPosition
  // so that entering/exiting fullscreen can seek the new player instance to
  // where the previous one stopped, giving a seamless visual transition.
  const currentPositionMsRef = useRef(0);
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
  // than hardcoding 16:9.  Clamped to 55% of screen height in portrait so
  // vertical / square sources don't push metadata below the fold.
  const MAX_PORTRAIT_HEIGHT = Math.round(height * 0.55);
  const playerHeight = isLandscape
    ? height
    : Math.min(Math.round(width / videoAspectRatio), MAX_PORTRAIT_HEIGHT);
  const playerControlTop = Math.max(insets.top, 8) + 10;

  const handleAspectRatioChange = useCallback((ratio: number) => {
    // Clamp to sane range — ignore garbage values from corrupt streams.
    if (ratio > 0.1 && ratio < 10) setVideoAspectRatio(ratio);
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
      ScreenOrientation.lockAsync(
        ScreenOrientation.OrientationLock.LANDSCAPE,
      ).catch(() => {});
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
      ScreenOrientation.lockAsync(
        ScreenOrientation.OrientationLock.PORTRAIT_UP,
      ).catch(() => {});
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
      if ((nextState === "background" || nextState === "inactive") && isFullscreen) {
        ScreenOrientation.lockAsync(
          ScreenOrientation.OrientationLock.PORTRAIT_UP,
        ).catch(() => {});
      }
    });
    return () => sub.remove();
  }, [isFullscreen]);

  // Live broadcast sync — used by BroadcastHlsPlayer internally.
  // For the YouTube live path, read sync directly to keep title/id live.
  const sync             = useBroadcastSync();
  const livePositionSecs = isLive ? (sync.positionSecs ?? startPositionSecs) : startPositionSecs;
  const livePositionMs   = Math.round(livePositionSecs * 1000);

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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    router.replace({
      pathname: "/player",
      params: {
        id: s.id,
        title: s.title,
        youtubeId: s.videoSource === "youtube" ? s.youtubeId : "",
        hlsUrl: s.hlsMasterUrl ?? s.localVideoUrl ?? "",
        thumbnailUrl: s.thumbnailUrl,
        preacher: s.preacher,
        duration: s.duration,
        category: s.category,
        description: s.description,
      },
    });
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      <ScrollView
        showsVerticalScrollIndicator={false}
        bounces
        overScrollMode="auto"
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
              onEnd={() => {}}
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
              onEnd={() => {}}
              onError={() => {
                Alert.alert(
                  "Playback Error",
                  "This video could not be played. It may still be processing or the file is unavailable.",
                  [{ text: "OK" }],
                );
              }}
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
            />
          ) : (
            <Image
              source={thumbnailUrl ? { uri: thumbnailUrl } : PLACEHOLDER}
              style={StyleSheet.absoluteFill}
              resizeMode="contain"
            />
          )}

          {/* Back arrow */}
          <Pressable
            onPress={() =>
              router.canGoBack()
                ? router.back()
                : router.replace("/")
            }
            style={[styles.backBtn, { top: playerControlTop }]}
            hitSlop={16}
            accessibilityLabel="Go back"
            accessibilityRole="button"
          >
            <Feather name="arrow-left" size={18} color="#fff" />
          </Pressable>

          {/* LIVE badge */}
          {isLive && (
            <View style={[styles.liveBadgePos, { top: playerControlTop + 2 }]}>
              <LiveBadge />
            </View>
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

          {/* Floating emoji reactions — rendered over the video, pointerEvents="none"
              so the back/badge/fullscreen controls still receive touches. Only
              mounted during live broadcasts; idle during VOD playback. */}
          {isLive && <FloatingReactions ref={reactionsRef} />}
        </View>

        {/* ── Title & Metadata ──────────────────────────────────────────── */}
        <View style={[styles.infoBlock, { borderBottomColor: c.border }]}>
          {isLive ? (
            /* Live broadcast — channel identity only, no video title */
            <View style={styles.liveMeta}>
              <View style={styles.liveRow}>
                <LiveBadge size="small" />
                <Text style={[styles.liveLabelText, { color: c.mutedForeground }]}>Live Broadcast</Text>
                {sync.viewerCount != null && sync.viewerCount > 0 && (
                  <>
                    <Text style={[styles.metaSep, { color: c.mutedForeground }]}>·</Text>
                    <Feather name="users" size={11} color={c.mutedForeground} />
                    <Text style={[styles.metaText, { color: c.mutedForeground }]}>
                      {sync.viewerCount >= 1000
                        ? `${(sync.viewerCount / 1000).toFixed(1)}k`
                        : String(sync.viewerCount)}{" watching"}
                    </Text>
                  </>
                )}
              </View>
              <Text style={[styles.channelName, { color: c.foreground }]} accessibilityRole="header">
                Temple TV
              </Text>
              <Text style={[styles.channelSub, { color: c.mutedForeground }]}>JCTM Ministries</Text>
            </View>
          ) : (
            <>
              <Text style={[styles.videoTitle, { color: c.foreground }]} numberOfLines={3} accessibilityRole="header">
                {title}
              </Text>
              <View style={styles.metaRow}>
                <Text style={[styles.preacherText, { color: c.mutedForeground }]} numberOfLines={1}>{preacher}</Text>
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
                    <View style={[styles.categoryPill, { backgroundColor: c.primary + "18" }]}>
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
          {videoId !== "live" && (
            <Pressable onPress={handleToggleFavorite} style={styles.actionItem} accessibilityLabel={favorited ? "Remove from saved" : "Save video"} accessibilityRole="button">
              <View style={[styles.actionCircle, { backgroundColor: favorited ? "#ef444420" : c.card, borderColor: favorited ? "#ef444440" : c.border }]}>
                <Feather name="heart" size={19} color={favorited ? "#ef4444" : c.foreground} />
              </View>
              <Text style={[styles.actionLabel, { color: c.mutedForeground }]}>{favorited ? "Saved" : "Save"}</Text>
            </Pressable>
          )}

          <Pressable
            onPress={() =>
              isLive
                ? Share.share({ title: "Temple TV Live", message: "Watch Temple TV Live — JCTM Ministries" })
                : Share.share({ title, message: `Watch "${title}" on Temple TV` })
            }
            style={styles.actionItem}
            accessibilityLabel="Share"
            accessibilityRole="button"
          >
            <View style={[styles.actionCircle, { backgroundColor: c.card, borderColor: c.border }]}>
              <Feather name="share-2" size={19} color={c.foreground} />
            </View>
            <Text style={[styles.actionLabel, { color: c.mutedForeground }]}>Share</Text>
          </Pressable>

          {isLive && (
            <Pressable
              onPress={() => setShowChat((v) => !v)}
              style={styles.actionItem}
              accessibilityLabel={showChat ? "Hide live chat" : "Open live chat"}
              accessibilityRole="button"
            >
              <View style={[styles.actionCircle, { backgroundColor: showChat ? c.primary + "22" : c.card, borderColor: showChat ? c.primary + "55" : c.border }]}>
                <Feather name="message-circle" size={19} color={showChat ? c.primary : c.foreground} />
              </View>
              <Text style={[styles.actionLabel, { color: showChat ? c.primary : c.mutedForeground }]}>{showChat ? "Hide Chat" : "Chat"}</Text>
            </Pressable>
          )}
        </View>

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
            <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
              <Text style={[styles.cardTitle, { color: c.foreground }]}>React</Text>
              <View style={styles.reactionsRow}>
                <ReactionButton emoji="🙏" label="Amen"    onPress={() => handleReaction("🙏", "amen")} />
                <ReactionButton emoji="🔥" label="Fire"    onPress={() => handleReaction("🔥", "fire")} />
                <ReactionButton emoji="✨" label="Glory"   onPress={() => handleReaction("✨", "hallelujah")} />
                <ReactionButton emoji="🕊️" label="Peace"  onPress={() => handleReaction("🕊️", "hallelujah")} />
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
              <View style={[styles.relatedCountPill, { backgroundColor: c.card }]}>
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
      <ChatPanel visible={isLive && showChat} onClose={() => setShowChat(false)} />

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
                onEnd={() => {}}
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
                isBroadcastLive
                fillContainer
                onEnd={() => {}}
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

          {/* ── Controls overlay — tap anywhere on video to show/hide ── */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={handleFsTap}
            accessibilityLabel="Toggle player controls"
          >
            <Animated.View
              style={[StyleSheet.absoluteFill, { opacity: fsControlsOpacity }]}
              pointerEvents={fsControlsVisible ? "box-none" : "none"}
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
                  <Text numberOfLines={1} style={styles.fsTitleText} ellipsizeMode="tail">
                    {isLive ? "Temple TV — Live" : title}
                  </Text>
                  {isLive && (
                    <View style={styles.fsLiveBadgeWrap}>
                      <LiveBadge />
                    </View>
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
                        style={({ pressed }) => [
                          styles.fsEmojiBtn,
                          { opacity: pressed ? 0.55 : 1 },
                        ]}
                      >
                        <Text style={styles.fsEmojiText}>{emoji}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}

                <View style={[styles.fsBottomBar, { paddingBottom: Math.max(insets.bottom, 16) }]}>
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
        </View>
      </Modal>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },

  playerShell: { width: "100%", backgroundColor: "#000", position: "relative", overflow: "hidden" },
  backBtn: { position: "absolute", left: 12, zIndex: 20, width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(0,0,0,0.50)", alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 4, elevation: 5 },
  liveBadgePos: { position: "absolute", right: 12, zIndex: 20 },
  fullscreenBtn: { position: "absolute", right: 12, bottom: 12, zIndex: 20, width: 34, height: 34, borderRadius: 17, backgroundColor: "rgba(0,0,0,0.50)", alignItems: "center", justifyContent: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 4, elevation: 5 },

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

  fsScrubBarWrap: { flex: 1, height: 34, justifyContent: "center" },
  fsScrubTrack: { height: 3, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.30)", overflow: "hidden" },
  fsScrubFill: { height: 3, borderRadius: 2, backgroundColor: "#DC2626" },
  fsScrubThumb: { position: "absolute", width: 14, height: 14, borderRadius: 7, backgroundColor: "#fff", top: (34 - 14) / 2, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.4, shadowRadius: 3, elevation: 4 },

  infoBlock: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 14, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  liveMeta: { gap: 6 },
  liveRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 },
  liveLabelText: { fontSize: 12, fontWeight: "600", letterSpacing: 0.2 },
  channelName: { fontSize: 20, fontWeight: "700", lineHeight: 26, letterSpacing: -0.3 },
  channelSub: { fontSize: 13, fontWeight: "500" },
  videoTitle: { fontSize: 18, fontWeight: "700", lineHeight: 25, letterSpacing: -0.3 },
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4, marginTop: 1 },
  preacherText: { fontSize: 13, fontWeight: "500", flexShrink: 1 },
  metaSep: { fontSize: 13, marginHorizontal: 1 },
  metaText: { fontSize: 13 },
  categoryPill: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 20 },
  categoryPillText: { fontSize: 11, fontWeight: "700", letterSpacing: 0.2 },

  actionBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-around", paddingVertical: 14, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  actionItem: { alignItems: "center", gap: 6, flex: 1 },
  actionCircle: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  actionLabel: { fontSize: 11, fontWeight: "500", letterSpacing: 0.1 },

  descSection: { paddingHorizontal: 16, paddingVertical: 12, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  descText: { fontSize: 14, lineHeight: 20 },
  descToggle: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  descToggleText: { fontSize: 13, fontWeight: "600" },

  liveSection: { paddingHorizontal: 16, paddingTop: 16, gap: 12 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 10 },
  cardTitle: { fontSize: 14, fontWeight: "700", letterSpacing: 0.1 },
  reactionsRow: { flexDirection: "row", justifyContent: "space-around" },
  reactionBtn: { alignItems: "center", gap: 6 },
  reactionCircle: { width: 52, height: 52, borderRadius: 26, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  reactionEmoji: { fontSize: 24 },
  reactionLabel: { fontSize: 11, fontWeight: "600", letterSpacing: 0.1 },

  prayerCard: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 12 },
  prayerHeader: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  prayerIconWrap: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  prayerTitle: { fontSize: 14, fontWeight: "700" },
  prayerSubtitle: { fontSize: 12, lineHeight: 16 },
  prayerBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 11, borderRadius: 10 },
  prayerBtnText: { fontSize: 14, fontWeight: "700", color: "#fff" },
  prayerSuccessRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  prayerSuccessIcon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  prayerSentTitle: { fontSize: 14, fontWeight: "700" },
  prayerSentSub: { fontSize: 12 },

  relatedSection: { paddingTop: 16, paddingHorizontal: 16, gap: 12 },
  relatedHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  relatedTitle: { fontSize: 15, fontWeight: "700", flex: 1 },
  relatedCountPill: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 20 },
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
});
