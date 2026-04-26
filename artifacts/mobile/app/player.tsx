import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  AppState,
  type AppStateStatus,
  Image,
  Linking,
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
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { useColors as useAutoColors } from "@/hooks/useColors";
import colors from "@/constants/colors";
import { useFavorites } from "@/hooks/useFavorites";
import { useWatchHistory } from "@/hooks/useWatchHistory";
import { useWatchProgress } from "@/hooks/useWatchProgress";
import { YoutubePlayer } from "@/components/YoutubePlayer";
import { LocalVideoPlayer } from "@/components/LocalVideoPlayer";
import { SermonCard } from "@/components/SermonCard";
import { LiveBadge } from "@/components/LiveBadge";
import { GlassCard } from "@/components/GlassCard";
import { usePlayer, usePlayerProgress } from "@/context/PlayerContext";
import { useAuth } from "@/context/AuthContext";
import { SERMONS } from "@/data/sermons";
import { useYouTubeChannel } from "@/hooks/useYouTubeChannel";
import { checkBroadcastCurrent, subscribeBroadcastEvents, type BroadcastCurrentResult, type ReactionType } from "@/services/broadcast";
import { BROADCAST_TITLE, BROADCAST_PREACHER } from "@/lib/broadcastIdentity";
import { ChannelBug } from "@/components/ChannelBug";
import { BroadcastInfoStrip } from "@/components/BroadcastInfoStrip";
import { LiveReactions } from "@/components/LiveReactions";
import { PrayerRequestModal } from "@/components/PrayerRequestModal";
import type { Sermon } from "@/types";
import { usePageSeo } from "@/hooks/usePageSeo";

/**
 * Player page locks to the LIGHT palette regardless of the time-of-day
 * "midnight" theme that `useAutoColors` would otherwise apply. The video
 * player itself stays on a black backdrop (so letterboxed videos look right),
 * but the surrounding chrome — channel row, action buttons, sermon details,
 * related sermons — uses an off-white background with high-contrast dark
 * typography. This dramatically improves readability for daytime viewing on
 * phones, tablets, and TVs alike.
 *
 * The return shape matches `useAutoColors()` so the rest of the file (which
 * already destructures `c.foreground`, `c.primary`, etc.) is a drop-in
 * switch with no per-call changes.
 */
function useColors(): ReturnType<typeof useAutoColors> {
  const auto = useAutoColors();
  return {
    ...colors.light,
    radius: colors.radius,
    themeMode: "light",
    isMidnightTheme: false,
    timeZone: auto.timeZone,
  };
}

/** Off-white background used by the player chrome and inset spacers. */
const LIGHT_PAGE_BG = colors.light.background;
/** Soft divider tint that reads on the off-white background. */
const LIGHT_DIVIDER = "rgba(10, 0, 20, 0.08)";

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function SeekBar({
  currentTime,
  duration,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  onSeek: (t: number) => void;
}) {
  const c = useColors();
  const [seeking, setSeeking] = useState(false);
  const [seekPreview, setSeekPreview] = useState(0);
  const barRef = useRef<View>(null);
  const barWidthRef = useRef(1);

  const progress = duration > 0 ? Math.min(1, (seeking ? seekPreview : currentTime) / duration) : 0;

  const handleLayout = (e: any) => {
    barWidthRef.current = e.nativeEvent.layout.width || 1;
  };

  const handlePress = (e: any) => {
    if (duration <= 0) return;
    const x = e.nativeEvent.locationX;
    const pct = Math.max(0, Math.min(1, x / barWidthRef.current));
    const t = pct * duration;
    onSeek(t);
  };

  return (
    <View style={seekStyles.wrapper}>
      <Text style={[seekStyles.time, { color: c.mutedForeground }]}>{formatTime(currentTime)}</Text>
      <Pressable
        style={seekStyles.track}
        onLayout={handleLayout}
        onPress={handlePress}
        hitSlop={12}
      >
        <View style={[seekStyles.bg, { backgroundColor: c.border }]} />
        <View
          style={[
            seekStyles.fill,
            { backgroundColor: c.primary, width: `${Math.round(progress * 100)}%` as any },
          ]}
        />
        <View
          style={[
            seekStyles.thumb,
            { backgroundColor: c.primary, left: `${Math.round(progress * 100)}%` as any },
          ]}
        />
      </Pressable>
      <Text style={[seekStyles.time, { color: c.mutedForeground }]}>{formatTime(duration)}</Text>
    </View>
  );
}

const seekStyles = StyleSheet.create({
  wrapper: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  time: { fontSize: 11, fontFamily: "Inter_400Regular", minWidth: 34, textAlign: "center" },
  track: { flex: 1, height: 20, justifyContent: "center" },
  bg: { position: "absolute", left: 0, right: 0, height: 3, borderRadius: 2 },
  fill: { position: "absolute", left: 0, height: 3, borderRadius: 2 },
  thumb: {
    position: "absolute",
    width: 12,
    height: 12,
    borderRadius: 6,
    marginLeft: -6,
    top: "50%",
    marginTop: -6,
  },
});

function VolumeBar({ volume, onVolume }: { volume: number; onVolume: (v: number) => void }) {
  const c = useColors();
  const barWidthRef = useRef(1);

  const handleLayout = (e: any) => {
    barWidthRef.current = e.nativeEvent.layout.width || 1;
  };

  const handlePress = (e: any) => {
    const x = e.nativeEvent.locationX;
    const pct = Math.max(0, Math.min(1, x / barWidthRef.current));
    onVolume(Math.round(pct * 100));
  };

  const icon = volume === 0 ? "volume-x" : volume < 40 ? "volume-1" : "volume-2";
  const pct = volume / 100;

  return (
    <View style={volStyles.wrapper}>
      <Feather name={icon as any} size={16} color={c.mutedForeground} />
      <Pressable style={volStyles.track} onLayout={handleLayout} onPress={handlePress} hitSlop={12}>
        <View style={[volStyles.bg, { backgroundColor: c.border }]} />
        <View
          style={[
            volStyles.fill,
            { backgroundColor: c.primary, width: `${Math.round(pct * 100)}%` as any },
          ]}
        />
        <View
          style={[
            volStyles.thumb,
            { backgroundColor: c.primary, left: `${Math.round(pct * 100)}%` as any },
          ]}
        />
      </Pressable>
      <Feather name="volume-2" size={16} color={c.mutedForeground} />
    </View>
  );
}

const volStyles = StyleSheet.create({
  wrapper: { flexDirection: "row", alignItems: "center", gap: 8 },
  track: { flex: 1, height: 20, justifyContent: "center" },
  bg: { position: "absolute", left: 0, right: 0, height: 3, borderRadius: 2 },
  fill: { position: "absolute", left: 0, height: 3, borderRadius: 2 },
  thumb: {
    position: "absolute",
    width: 12,
    height: 12,
    borderRadius: 6,
    marginLeft: -6,
    top: "50%",
    marginTop: -6,
  },
});

export default function PlayerScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  // Guest users land here directly from deep links, home hero taps, or
  // the radio screen — no auth check is performed before playback starts.
  // The optional sign-up nudge rendered inside the player (below) is
  // user-initiated and non-blocking; it never interrupts viewing.
  const { isLoggedIn, openAuthGate } = useAuth();
  const routeParams = useLocalSearchParams() as Record<string, string | undefined>;

  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const availableHeight = screenHeight - insets.top - insets.bottom;
  // Responsive sizing strategy:
  //  • Mobile portrait (<768px): full width 16:9, capped at 45% of viewport.
  //  • Tablet / small laptop (768-1280px): tighter cap so the page still
  //    shows metadata below the fold, capped at 55% of viewport height.
  //  • Desktop (>1280px): centre the player on a 1280px column for a
  //    cinema-style layout — the video doesn't need to spill into the
  //    margins like a recipe blog.
  const isDesktop = screenWidth >= 1280;
  const isTablet = screenWidth >= 768 && screenWidth < 1280;
  const playerColumnWidth = isDesktop ? 1280 : screenWidth;
  const params = useLocalSearchParams<{
    videoId?: string;
    live?: string;
    title?: string;
    preacher?: string;
    duration?: string;
    thumbnail?: string;
    category?: string;
    localVideoUrl?: string;
    hlsMasterUrl?: string;
    startPositionMs?: string;
    broadcastMode?: string;
  }>();

  const {
    videoId: paramVideoId,
    live,
    title: paramTitle,
    preacher: paramPreacher,
    duration: paramDuration,
    thumbnail: paramThumbnail,
    category: paramCategory,
    localVideoUrl: paramLocalVideoUrl,
    hlsMasterUrl: paramHlsMasterUrl,
    startPositionMs: paramStartPositionMs,
    broadcastMode: paramBroadcastMode,
  } = params;

  const {
    currentSermon: ctxSermon,
    nextSermon,
    isPlaying,
    playSermon,
    playNext,
    playPrevious,
    advanceToNext,
    shuffleMode,
    loopMode,
    toggleShuffle,
    cycleLoopMode,
    togglePlay,
    toggleRadioMode,
    setIsBroadcastMode: setCtxBroadcastMode,
    volume,
    dataSaver,
    isRadioMode,
    seekTo,
    setVolume,
  } = usePlayer();
  const { currentTime, duration } = usePlayerProgress();

  const { isFavorite, toggleFavorite } = useFavorites();
  const { addToHistory } = useWatchHistory();
  const { saveProgress } = useWatchProgress();
  const { sermons: rssSermons } = useYouTubeChannel();

  const isLive = live === "true";
  const isBroadcastMode = paramBroadcastMode === "true";

  // Sizing: broadcast/live gets a slightly taller container (11:16 ≈ cinema 4:3)
  // so the video dominates more of the screen without requiring landscape rotation.
  const isBroadcastOrLiveForSizing = isLive || isBroadcastMode;
  const heightCapRatio = isDesktop ? 0.7 : isTablet ? (isBroadcastOrLiveForSizing ? 0.65 : 0.55) : (isBroadcastOrLiveForSizing ? 0.52 : 0.45);
  const aspectRatioH = isBroadcastOrLiveForSizing ? 11 : 9;
  const videoPlayerHeight = Math.min(
    Math.round(playerColumnWidth * (aspectRatioH / 16)),
    Math.round(availableHeight * heightCapRatio),
  );

  const noPlaybackRef = useRef(false);
  useEffect(() => {
    if (noPlaybackRef.current) return;
    if (isLive || isBroadcastMode) return;
    if (paramVideoId || paramLocalVideoUrl) return;
    noPlaybackRef.current = true;
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [isLive, isBroadcastMode, paramVideoId, paramLocalVideoUrl]);

  // Per-page SEO: emits a Schema.org VideoObject for this sermon (or
  // BroadcastEvent when watching the live stream). This is what makes
  // individual sermons eligible for Google's Video search carousel and
  // for rich-result thumbnails in regular search.
  const seoVideoId = paramVideoId ?? ctxSermon?.youtubeId ?? "";
  const seoTitle = paramTitle ?? ctxSermon?.title ?? (isLive ? "Live Now — Temple TV" : "Watch Sermon");
  const seoThumb = paramThumbnail ?? ctxSermon?.thumbnailUrl ?? `https://i.ytimg.com/vi/${seoVideoId}/hqdefault.jpg`;
  const seoPreacher = paramPreacher ?? ctxSermon?.preacher ?? "Jesus Christ Temple Ministry";
  const seoDescription = ctxSermon?.description
    ? String(ctxSermon.description).slice(0, 240)
    : `${seoTitle} — watch on Temple TV. Preached by ${seoPreacher}.`;
  // Only emit a real publishedAt — synthesizing "now" pollutes structured-data
  // quality signals and risks disqualification from Google's Video carousel.
  const seoUploadDate = (() => {
    const raw = ctxSermon?.date;
    if (!raw) return undefined;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  })();
  const seoStructuredData = isLive
    ? {
        "@context": "https://schema.org",
        "@type": "BroadcastEvent",
        name: seoTitle,
        description: seoDescription,
        isLiveBroadcast: true,
        videoFormat: "HD",
        publishedOn: { "@id": "https://templetv.org.ng/#broadcast" },
      }
    : seoVideoId && seoUploadDate
      ? {
          "@context": "https://schema.org",
          "@type": "VideoObject",
          name: seoTitle,
          description: seoDescription,
          thumbnailUrl: seoThumb,
          uploadDate: seoUploadDate,
          contentUrl: `https://www.youtube.com/watch?v=${seoVideoId}`,
          embedUrl: `https://www.youtube.com/embed/${seoVideoId}`,
          publisher: { "@id": "https://templetv.org.ng/#organization" },
          author: { "@type": "Person", name: seoPreacher },
          inLanguage: "en",
          isFamilyFriendly: true,
        }
      : undefined;
  usePageSeo({
    title: `${seoTitle} | Temple TV`,
    description: seoDescription,
    path: seoVideoId ? `/player?videoId=${encodeURIComponent(seoVideoId)}` : "/player",
    image: seoThumb,
    structuredData: seoStructuredData,
  });
  const [broadcastInfo, setBroadcastInfo] = useState<BroadcastCurrentResult | null>(null);
  const [broadcastRecovering, setBroadcastRecovering] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const fadeAnim = useRef(new Animated.Value(Platform.OS === "web" ? 1 : 0)).current;
  const titleFade = useRef(new Animated.Value(1)).current;
  const initializedRef = useRef(false);
  const isMountedRef = useRef(true);
  /** Prevents three competing sync paths from all calling router.replace within the same second */
  const lastTuneTimeRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const allSermons = rssSermons.length > 0 ? rssSermons : SERMONS;

  const resolveSermon = useCallback(
    (id?: string): Sermon | null => {
      if (!id) return null;
      return (
        SERMONS.find((s) => s.youtubeId === id) ??
        rssSermons.find((s) => s.youtubeId === id) ??
        null
      );
    },
    [rssSermons],
  );

  const makeParamSermon = useCallback((): Sermon | null => {
    if (!paramVideoId && !paramLocalVideoUrl) return null;
    if (paramLocalVideoUrl) {
      return {
        id: `local_${encodeURIComponent(paramLocalVideoUrl)}`,
        title: paramTitle ?? "Temple TV",
        description: "",
        youtubeId: "",
        thumbnailUrl: paramThumbnail ?? "",
        duration: paramDuration ?? "",
        category: (paramCategory as Sermon["category"]) || "Faith",
        preacher: paramPreacher ?? "JCTM",
        date: new Date().toISOString().slice(0, 10),
        videoSource: "local",
        localVideoUrl: paramLocalVideoUrl,
      };
    }
    return {
      id: `player_${paramVideoId}`,
      title: paramTitle ?? "Temple TV",
      description: "",
      youtubeId: paramVideoId!,
      thumbnailUrl: paramThumbnail ?? `https://img.youtube.com/vi/${paramVideoId}/hqdefault.jpg`,
      duration: paramDuration ?? "",
      category: (paramCategory as Sermon["category"]) || "Faith",
      preacher: paramPreacher ?? "JCTM",
      date: new Date().toISOString().slice(0, 10),
    };
  }, [paramVideoId, paramLocalVideoUrl, paramTitle, paramPreacher, paramDuration, paramThumbnail, paramCategory]);

  const [activeSermon, setActiveSermon] = useState<Sermon | null>(() => {
    if (isLive) return null;
    return resolveSermon(paramVideoId) ?? makeParamSermon();
  });

  // ── Broadcast in-place tuning state ────────────────────────────────────
  // When in broadcast mode, the SSE stream (and the 15s poll, and the
  // precision end-of-item timer) push us into the next queue item every
  // few minutes. Previously each transition called `router.replace(...)`,
  // which remounts the entire <PlayerScreen>, forcibly tearing down the
  // <video> element and showing a blank/loading state for several seconds
  // — the exact opposite of TV-channel behavior.
  //
  // Instead, we initialize these values from the route params on mount,
  // but on every subsequent broadcast advance we MUTATE THESE STATE
  // SLOTS IN PLACE. The <LocalVideoPlayer> sees new prop values for
  // `videoUrl` / `hlsMasterUrl` / `startPositionMs` and uses its own A/B
  // double-buffer to swap to the preloaded slot — no remount, no veil,
  // no spinner, no black frame. We also feed `nextVideoUrl` /
  // `nextHlsMasterUrl` from the broadcast payload's `nextItem` so the
  // inactive slot can preload the upcoming item ahead of the cut.
  const [tunedLocalVideoUrl, setTunedLocalVideoUrl] = useState<string | undefined>(paramLocalVideoUrl);
  const [tunedHlsMasterUrl, setTunedHlsMasterUrl] = useState<string | undefined>(paramHlsMasterUrl);
  const [tunedTitle, setTunedTitle] = useState<string | undefined>(paramTitle);
  const [tunedThumbnail, setTunedThumbnail] = useState<string | undefined>(paramThumbnail);
  const [tunedVideoId, setTunedVideoId] = useState<string | undefined>(paramVideoId);
  const [tunedStartPositionMs, setTunedStartPositionMs] = useState<number>(
    paramStartPositionMs ? parseInt(paramStartPositionMs, 10) : 0,
  );
  const [tunedNextLocalVideoUrl, setTunedNextLocalVideoUrl] = useState<string | undefined>(undefined);
  const [tunedNextHlsMasterUrl, setTunedNextHlsMasterUrl] = useState<string | undefined>(undefined);

  // If the route params themselves change (e.g., user picks a different
  // sermon from related list while staying mounted on /player), re-sync
  // the tuned state. We deliberately key only on the param values, not
  // on the tuned state, so server-driven updates we wrote into the
  // tuned state don't get clobbered by a stale effect re-run.
  useEffect(() => {
    setTunedLocalVideoUrl(paramLocalVideoUrl);
    setTunedHlsMasterUrl(paramHlsMasterUrl);
    setTunedTitle(paramTitle);
    setTunedThumbnail(paramThumbnail);
    setTunedVideoId(paramVideoId);
    setTunedStartPositionMs(paramStartPositionMs ? parseInt(paramStartPositionMs, 10) : 0);
    setTunedNextLocalVideoUrl(undefined);
    setTunedNextHlsMasterUrl(undefined);
  }, [paramLocalVideoUrl, paramHlsMasterUrl, paramTitle, paramThumbnail, paramVideoId, paramStartPositionMs]);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: Platform.OS !== "web" }).start();
  }, []);

  useEffect(() => {
    if (isLive || initializedRef.current) return;
    initializedRef.current = true;
    const sermon = resolveSermon(paramVideoId) ?? makeParamSermon();
    if (sermon) {
      playSermon(sermon, allSermons);
      setActiveSermon(sermon);
      addToHistory(sermon);
      const domain = process.env.EXPO_PUBLIC_DOMAIN ?? "";
      const base = domain ? `https://${domain}` : "";
      fetch(`${base}/api/videos/${sermon.youtubeId}/view`, { method: "POST" }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!ctxSermon || isLive) return;
    if (ctxSermon.youtubeId === activeSermon?.youtubeId) return;
    Animated.timing(titleFade, { toValue: 0, duration: 150, useNativeDriver: Platform.OS !== "web" }).start(() => {
      if (!isMountedRef.current) return;
      setActiveSermon(ctxSermon);
      addToHistory(ctxSermon);
      scrollRef.current?.scrollTo({ y: 0, animated: true });
      Animated.timing(titleFade, { toValue: 1, duration: 250, useNativeDriver: Platform.OS !== "web" }).start();
    });
  }, [ctxSermon?.youtubeId]);

  useEffect(() => {
    if (isLive || isBroadcastMode || !activeSermon) return;
    if (currentTime < 5 || duration <= 0) return;
    saveProgress(activeSermon.id, currentTime, duration, {
      title: activeSermon.title,
      thumbnailUrl: activeSermon.thumbnailUrl,
    });
  }, [currentTime]);

  // Round 6 (Pass 3): mirror the route-level `isBroadcastMode` flag
  // into the PlayerContext so off-screen surfaces (MiniPlayer,
  // NowPlayingBar, future widgets) can suppress playback-position UI.
  // We deliberately do NOT clear the flag on unmount — if the user
  // backgrounds /player while broadcast playback continues via
  // PersistentAudioPlayer, the MiniPlayer must keep showing channel
  // semantics (no progress bar, no skip-forward). The flag is cleared
  // by `playSermon` (VOD pick) and `playLive` (YouTube live) inside
  // the context itself, which are the only ways out of broadcast.
  useEffect(() => {
    if (isBroadcastMode) setCtxBroadcastMode(true);
  }, [isBroadcastMode, setCtxBroadcastMode]);

  useEffect(() => {
    if (!isBroadcastMode) return;
    let cancelled = false;
    const refreshInfo = async () => {
      try {
        const bc = await checkBroadcastCurrent();
        if (!cancelled && bc) setBroadcastInfo(bc);
      } catch {}
    };
    refreshInfo();
    const ticker = setInterval(refreshInfo, 15000);
    return () => {
      cancelled = true;
      clearInterval(ticker);
    };
  }, [isBroadcastMode]);

  // ── In-place broadcast tune ───────────────────────────────────────────
  // Updates the tuned* state slots so the underlying <LocalVideoPlayer>
  // (or <YoutubePlayer>) sees a new `videoUrl` / `hlsMasterUrl` /
  // `startPositionMs` without remounting. The mobile <LocalVideoPlayer>'s
  // own A/B double-buffer (web path) handles the swap as either an
  // instant cut to the preloaded slot or a fresh load — but in both cases
  // the React subtree stays mounted, so there's no full-screen blank
  // / loading spinner like there was when this used router.replace.
  const tuneToBroadcastItem = useCallback((bc: BroadcastCurrentResult) => {
    if (!bc?.item) return;

    // Debounce: three sync mechanisms (SSE, 15s poll, precision timer) can
    // fire nearly simultaneously at an item boundary. Only act on the
    // first call within a 3-second window to avoid redundant slot swaps.
    const now = Date.now();
    if (now - lastTuneTimeRef.current < 3_000) return;
    lastTuneTimeRef.current = now;

    const item = bc.item;
    // Compensate for the time spent in transit (network latency + queueing
    // between when the server snapped `serverTimeMs` and now). Operate in
    // milliseconds throughout so we don't lose up to a full second to integer
    // rounding the way the previous formula did. Clamp to 0 so a client whose
    // wall clock is *behind* the server's never gets handed a negative drift.
    const transitMs = bc.serverTimeMs ? Math.max(0, now - bc.serverTimeMs) : 0;
    const startMs = bc.positionSecs * 1000 + transitMs;

    // The next-item URLs flow into the LocalVideoPlayer for inactive-slot
    // preload. We always update them, even if the active item didn't
    // change, so the preload stays warm as the queue mutates.
    const next = bc.nextItem;
    const nextLocal = next?.videoSource === "local" && next.localVideoUrl ? next.localVideoUrl : undefined;
    const nextHls = (next as any)?.hlsMasterUrl as string | undefined;
    setTunedNextLocalVideoUrl(nextLocal);
    setTunedNextHlsMasterUrl(nextHls);

    if (item.videoSource === "local" && item.localVideoUrl) {
      setTunedLocalVideoUrl(item.localVideoUrl);
      setTunedHlsMasterUrl((item as any).hlsMasterUrl ?? undefined);
      setTunedVideoId(undefined);
    } else {
      setTunedLocalVideoUrl(undefined);
      setTunedHlsMasterUrl(undefined);
      setTunedVideoId(item.youtubeId);
    }
    setTunedTitle(item.title);
    setTunedThumbnail(item.thumbnailUrl ?? undefined);
    setTunedStartPositionMs(startMs);
  }, []);

  // 15-second safety poll: catches missed SSE events. Now updates state
  // in place via tuneToBroadcastItem instead of doing a route replace.
  useEffect(() => {
    if (!isBroadcastMode) return;
    let cancelled = false;
    const syncBroadcast = async () => {
      try {
        const bc = await checkBroadcastCurrent();
        if (cancelled || !bc?.item) return;
        const bcIsLocal = bc.item.videoSource === "local" && !!bc.item.localVideoUrl;
        const currentIsLocal = !!tunedLocalVideoUrl;
        const currentId = currentIsLocal ? tunedLocalVideoUrl : tunedVideoId;
        const bcId = bcIsLocal ? bc.item.localVideoUrl : bc.item.youtubeId;
        if (currentId !== bcId) tuneToBroadcastItem(bc);
        else {
          // Same active item — refresh the next-item preload hint in case
          // the queue changed beneath us (admin reordered, override expired).
          const next = bc.nextItem;
          const nextLocal = next?.videoSource === "local" && next.localVideoUrl ? next.localVideoUrl : undefined;
          const nextHls = (next as any)?.hlsMasterUrl as string | undefined;
          setTunedNextLocalVideoUrl(nextLocal);
          setTunedNextHlsMasterUrl(nextHls);
        }
      } catch {}
    };
    const interval = setInterval(syncBroadcast, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isBroadcastMode, tunedVideoId, tunedLocalVideoUrl, tuneToBroadcastItem]);

  useEffect(() => {
    if (!isBroadcastMode) return;
    const handleBroadcastUpdate = async (payload?: any) => {
      const bc = (payload?.current as BroadcastCurrentResult | undefined) ?? await checkBroadcastCurrent().catch(() => null);
      if (!bc || !isMountedRef.current) return;
      setBroadcastInfo(bc);
      if (bc.item) {
        const bcIsLocal = bc.item.videoSource === "local" && !!bc.item.localVideoUrl;
        const currentId = tunedLocalVideoUrl ? tunedLocalVideoUrl : tunedVideoId;
        const nextId = bcIsLocal ? bc.item.localVideoUrl : bc.item.youtubeId;
        if (currentId !== nextId) tuneToBroadcastItem(bc);
        else {
          // Same active item, but the SSE payload may carry a fresh
          // nextItem we should keep preloading. Mirror the 15s-poll logic.
          const next = bc.nextItem;
          const nextLocal = next?.videoSource === "local" && next.localVideoUrl ? next.localVideoUrl : undefined;
          const nextHls = (next as any)?.hlsMasterUrl as string | undefined;
          setTunedNextLocalVideoUrl(nextLocal);
          setTunedNextHlsMasterUrl(nextHls);
        }
      }
    };

    const subscription = subscribeBroadcastEvents({
      "broadcast-current-updated": handleBroadcastUpdate,
      "broadcast-queue-updated": () => handleBroadcastUpdate(),
      "broadcast-schedule-updated": () => handleBroadcastUpdate(),
      "broadcast-control-updated": () => handleBroadcastUpdate(),
      "override-expired": () => handleBroadcastUpdate(),
      status: () => handleBroadcastUpdate(),
      "live-reaction": (data: unknown) => {
        const evt = data as { type: ReactionType; ts: number };
        if (evt?.type) setLatestReaction(evt);
      },
    });

    return () => subscription?.close();
  }, [isBroadcastMode, tunedVideoId, tunedLocalVideoUrl, tuneToBroadcastItem]);

  // Live YouTube re-tune from admin override.
  //
  // When the user is mid-watch on a live YouTube event (`isLive=true`,
  // NOT `isBroadcastMode`) and the admin swaps the live URL via Live
  // Control on the dashboard, the broadcast SSE channel emits a fresh
  // `broadcast-current-updated` payload whose `liveOverride.youtubeVideoId`
  // is the new ID. We mutate `tunedVideoId` in place so `<YoutubePlayer>`
  // sees a new prop value and the iframe navigates to the new stream
  // without remounting the player tree (which would unmount the chrome,
  // wipe the OSD, and break the persistent-pipeline guarantee).
  //
  // Mirrors `LiveYouTubePlayer` on the TV side. The HLS path doesn't need
  // an analog here because `LocalVideoPlayer` already swaps via its own
  // A/B double-buffer when its `hlsMasterUrl` prop changes.
  useEffect(() => {
    if (!isLive || isBroadcastMode) return;
    let lastSeenOverrideId: string | null = tunedVideoId ?? null;

    const applyOverride = (current: BroadcastCurrentResult | null | undefined) => {
      const overrideId = current?.liveOverride?.youtubeVideoId ?? null;
      if (!overrideId || overrideId === lastSeenOverrideId) return;
      lastSeenOverrideId = overrideId;
      setTunedVideoId(overrideId);
      const overrideTitle = current?.liveOverride?.title ?? null;
      if (overrideTitle) setTunedTitle(overrideTitle);
    };

    const handler = async (payload?: any) => {
      const bc =
        (payload?.current as BroadcastCurrentResult | undefined) ??
        (await checkBroadcastCurrent().catch(() => null));
      if (!bc || !isMountedRef.current) return;
      applyOverride(bc);
    };

    // Cold sync once at mount in case the broadcast/current payload
    // already carries an override the route params didn't include
    // (e.g., user tapped "Watch Live" the instant the admin activated it).
    checkBroadcastCurrent()
      .then((bc) => {
        if (bc && isMountedRef.current) applyOverride(bc);
      })
      .catch(() => {});

    const subscription = subscribeBroadcastEvents({
      "broadcast-current-updated": handler,
      "broadcast-control-updated": () => handler(),
      "override-expired": () => handler(),
      status: () => handler(),
    });

    return () => subscription?.close();
  }, [isLive, isBroadcastMode]);

  // Deployment-resilience resync: when the app returns to the foreground, the
  // SSE socket may have been killed by the OS during background, and a backend
  // deploy may have rolled while we were away. Pull a fresh /broadcast/current
  // immediately so the now-playing card and preloaded next item are accurate
  // before the SSE channel re-establishes. The anchor on the server keeps the
  // currently-airing program stable across deploys, so this never causes a
  // visible jump — it only corrects stale UI metadata.
  useEffect(() => {
    if (!isBroadcastMode) return;
    const sub = AppState.addEventListener("change", async (next: AppStateStatus) => {
      if (next !== "active" || !isMountedRef.current) return;
      try {
        const bc = await checkBroadcastCurrent();
        if (!isMountedRef.current || !bc?.item) return;
        const bcIsLocal = bc.item.videoSource === "local" && !!bc.item.localVideoUrl;
        const currentId = tunedLocalVideoUrl ? tunedLocalVideoUrl : tunedVideoId;
        const nextId = bcIsLocal ? bc.item.localVideoUrl : bc.item.youtubeId;
        if (currentId !== nextId) tuneToBroadcastItem(bc);
      } catch {}
    });
    return () => sub.remove();
  }, [isBroadcastMode, tunedVideoId, tunedLocalVideoUrl, tuneToBroadcastItem]);

  // Client-side precision transition timer: fires exactly when the server says
  // the current broadcast item ends, triggering a resync without polling wait.
  useEffect(() => {
    if (!isBroadcastMode) return;
    const endsAtMs = broadcastInfo?.currentItemEndsAtMs;
    if (!endsAtMs) return;
    const delay = endsAtMs - Date.now();
    if (delay <= 0) return;
    // Add a 1-second buffer so the server has time to advance its own state
    const timer = setTimeout(async () => {
      try {
        const bc = await checkBroadcastCurrent();
        if (isMountedRef.current && bc?.item) tuneToBroadcastItem(bc);
      } catch {}
    }, delay + 1000);
    return () => clearTimeout(timer);
  }, [isBroadcastMode, broadcastInfo?.currentItemEndsAtMs, tuneToBroadcastItem]);

  // ── Continuous broadcast-clock drift correction ────────────────────────
  // The 15s safety poll above only resyncs when the *active item* changes —
  // it doesn't notice if the local <video> has fallen behind the server clock
  // mid-program (which happens whenever a viewer hits a buffer underrun, a
  // spotty connection, or a backgrounded tab on the web). This effect closes
  // that gap: every 30 seconds it asks the server where the broadcast clock
  // genuinely is, compares against the local playhead, and only snaps when
  // the gap exceeds the audible/visible threshold. The snap is intentionally
  // hard (instant `seekTo`, not a rate-nudge) so all viewers converge to the
  // same wall-clock position fast — that's the whole point of "no device is
  // allowed to run ahead of or lag behind the live stream."
  //
  // We bypass `handleSeek` (which we no-op in broadcast mode for the user's
  // gesture) and call `seekTo` directly because this is a system correction,
  // not a user action.
  const HARD_SNAP_DRIFT_MS = 3_000;
  const DRIFT_TICK_MS = 30_000;
  useEffect(() => {
    if (!isBroadcastMode) return;
    let cancelled = false;

    const correctDrift = async () => {
      try {
        const bc = await checkBroadcastCurrent();
        if (cancelled || !isMountedRef.current || !bc?.item) return;

        // The active item must match — if a transition raced us, let
        // tuneToBroadcastItem (called via the SSE handler / 15s poll) deal
        // with it instead of fighting over the playhead.
        const bcIsLocal = bc.item.videoSource === "local" && !!bc.item.localVideoUrl;
        const currentId = tunedLocalVideoUrl ? tunedLocalVideoUrl : tunedVideoId;
        const bcId = bcIsLocal ? bc.item.localVideoUrl : bc.item.youtubeId;
        if (currentId !== bcId) return;

        // Where the server says we should be RIGHT NOW (account for the few
        // ms spent in transit). Same compensation formula as the initial
        // tune-in so the two stay consistent.
        const transitMs = bc.serverTimeMs ? Math.max(0, Date.now() - bc.serverTimeMs) : 0;
        const serverTargetSecs = bc.positionSecs + transitMs / 1000;

        // currentTime can be 0 briefly after a tune — don't fight a player
        // that hasn't reported a real position yet.
        if (currentTime <= 0) return;

        const driftMs = Math.abs(serverTargetSecs - currentTime) * 1000;
        if (driftMs >= HARD_SNAP_DRIFT_MS) {
          // Don't run past the end of the item; the transition timer will
          // handle item rollover cleanly a moment later.
          const cap = Math.max(0, (bc.item.durationSecs || serverTargetSecs) - 0.5);
          seekTo(Math.min(serverTargetSecs, cap));
        }
      } catch {}
    };

    // Stagger the first tick so it doesn't collide with the initial
    // tuneToBroadcastItem still settling the player.
    const initial = setTimeout(correctDrift, 10_000);
    const interval = setInterval(correctDrift, DRIFT_TICK_MS);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [isBroadcastMode, tunedVideoId, tunedLocalVideoUrl, currentTime, seekTo]);

  const recoverBroadcastPlayback = useCallback(async () => {
    if (!isBroadcastMode || broadcastRecovering) return;
    setBroadcastRecovering(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const bc = await checkBroadcastCurrent();
      if (!isMountedRef.current) return;
      if (bc?.item) {
        // Round 9: also refresh the broadcastInfo so the now-playing strip,
        // up-next preview, and currentItemEndsAtMs precision timer all
        // reflect the recovered state — without this they stay frozen on
        // the failed item until the next SSE event lands.
        setBroadcastInfo(bc);
        tuneToBroadcastItem(bc);
      }
    } finally {
      if (isMountedRef.current) setBroadcastRecovering(false);
    }
  }, [isBroadcastMode, broadcastRecovering, tuneToBroadcastItem]);

  // ── Broken-item skip protection ────────────────────────────────────────
  // If the currently-airing item fails to load 2+ times within a 30-second
  // window, treat it as broken and locally jump to the up-next item so the
  // broadcast keeps flowing instead of looping on a 404 / corrupt manifest.
  // The server's own anchor will catch up on the next /broadcast/current
  // call, so this is a temporary client-side bypass — not a desync source.
  //
  // Tightened from 3-in-60s on 2026-04-26: legacy queue items pointing at
  // /api/uploads/<uuid>.mp4 whose source files are gone from Render's
  // ephemeral disk (and were never mirrored to S3) hard-404 immediately.
  // Two errors in 30s is plenty of signal that the asset is dead — waiting
  // a full minute on the original threshold left viewers staring at a black
  // void. A real network blip on a healthy item will retry well inside this
  // window and the counter resets after every clean transition end-event.
  const consecutiveErrorsRef = useRef(0);
  const lastErrorAtRef = useRef(0);
  const SKIP_AFTER_ERRORS = 2;
  const ERROR_WINDOW_MS = 30_000;

  const handleBroadcastError = useCallback(async () => {
    if (!isBroadcastMode) {
      // Non-broadcast playback: existing recovery (no skip — user picked it).
      recoverBroadcastPlayback();
      return;
    }
    const now = Date.now();
    if (now - lastErrorAtRef.current > ERROR_WINDOW_MS) {
      consecutiveErrorsRef.current = 0;
    }
    lastErrorAtRef.current = now;
    consecutiveErrorsRef.current += 1;

    const nextItem = broadcastInfo?.nextItem;
    if (consecutiveErrorsRef.current >= SKIP_AFTER_ERRORS && nextItem) {
      // Build a synthetic payload positioned at the start of nextItem so
      // tuneToBroadcastItem swaps the slot. The real server timeline takes
      // over again on the next sync — by then the broken item should have
      // rolled past on the server side too.
      consecutiveErrorsRef.current = 0;
      const synthetic: BroadcastCurrentResult = {
        ...broadcastInfo!,
        item: nextItem,
        nextItem: null,
        index: (broadcastInfo!.index ?? 0) + 1,
        positionSecs: 0,
        progressPercent: 0,
        serverTimeMs: Date.now(),
        currentItemEndsAtMs: undefined,
        itemStartEpochSecs: Math.floor(Date.now() / 1000),
      };
      // Bypass the 3s tune debounce — this is a recovery jump, not a poll race.
      lastTuneTimeRef.current = 0;
      setBroadcastInfo(synthetic);
      tuneToBroadcastItem(synthetic);
      // Realign with the server a few seconds later once the slot is live.
      setTimeout(() => recoverBroadcastPlayback(), 5_000);
      return;
    }
    recoverBroadcastPlayback();
  }, [isBroadcastMode, broadcastInfo, recoverBroadcastPlayback, tuneToBroadcastItem]);

  const handleVideoEnd = useCallback(async () => {
    if (isBroadcastMode) {
      // The web player auto-swaps to the preloaded inactive slot the moment
      // the active video ends, so we don't need to wait for the server SSE
      // before kicking off the metadata refresh. Asking for the fresh
      // payload immediately keeps the now-playing card and up-next list in
      // lock-step with the actual video that just took over the screen.
      // No artificial delay here — any wait is a visible black gap on
      // platforms where the A/B swap isn't available (native iOS/Android).
      try {
        const bc = await checkBroadcastCurrent();
        if (!isMountedRef.current) return;
        if (bc?.item) {
          // Reset the broken-item counter — a clean transition means the
          // outgoing item played all the way through, so any prior errors
          // were transient (network blip, stalled segment) not a dead asset.
          consecutiveErrorsRef.current = 0;
          setBroadcastInfo(bc);
          tuneToBroadcastItem(bc);
        }
      } catch {}
    } else {
      advanceToNext();
    }
  }, [isBroadcastMode, advanceToNext, tuneToBroadcastItem]);
  const handlePlayNext = useCallback(() => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    playNext();
  }, [playNext]);
  const handlePlayPrevious = useCallback(() => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    playPrevious();
  }, [playPrevious]);

  const handleTogglePlay = useCallback(() => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    togglePlay();
  }, [togglePlay]);

  // Manual seeking is forbidden while the user is watching the live broadcast
  // queue. Every viewer must stay on the same wall-clock-aligned timeline; if
  // someone scrubs forward they'd be ahead of the rest of the audience, and
  // the next drift-correction tick would yank them right back, producing a
  // jarring jump. Silently no-op the seek instead — the SeekBar gesture is
  // also disabled visually below.
  const handleSeek = useCallback(
    (t: number) => {
      if (isBroadcastMode || isLive) return;
      seekTo(t);
    },
    [isBroadcastMode, isLive, seekTo],
  );
  const handleVolume = useCallback((v: number) => { setVolume(v); }, [setVolume]);

  const navigateToRelated = useCallback((sermon: Sermon) => {
    router.replace({ pathname: "/player", params: {
      videoId: sermon.youtubeId,
      title: sermon.title,
      preacher: sermon.preacher,
      duration: sermon.duration,
      thumbnail: sermon.thumbnailUrl,
      category: sermon.category,
    }});
  }, []);

  const openOnYouTube = async () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const url = isLive
      ? "https://www.youtube.com/@templetvjctm/live"
      : `https://www.youtube.com/watch?v=${activeSermon?.youtubeId ?? paramVideoId}`;
    if (Platform.OS === "web") { window.open(url, "_blank"); }
    else { await WebBrowser.openBrowserAsync(url, { toolbarColor: "#000000", controlsColor: "#6A0DAD", presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN }); }
  };

  const openCastHandoff = async () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const vid = activeSermon?.youtubeId ?? paramVideoId;
    const url = isLive ? "https://www.youtube.com/@templetvjctm/live" : `https://www.youtube.com/watch?v=${vid}`;
    if (Platform.OS !== "web" && vid) {
      const appUrl = `youtube://watch?v=${vid}`;
      const canOpen = await Linking.canOpenURL(appUrl);
      if (canOpen) {
        await Linking.openURL(appUrl);
        return;
      }
    }
    if (Platform.OS === "web") window.open(url, "_blank");
    else await WebBrowser.openBrowserAsync(url, { toolbarColor: "#000000", controlsColor: "#6A0DAD" });
  };

  const handleShare = async () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const vid = activeSermon?.youtubeId ?? paramVideoId;
    const url = isLive ? "https://www.youtube.com/@templetvjctm/live" : `https://youtu.be/${vid}`;
    const title = activeSermon?.title ?? paramTitle ?? "Temple TV";
    if (Platform.OS === "web") {
      if (navigator.share) { await navigator.share({ title, url }); }
      else { await navigator.clipboard?.writeText(url); }
    } else { await Share.share({ message: `Watch "${title}" on Temple TV JCTM: ${url}` }); }
  };

  const handleToggleFavorite = () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const sermon = activeSermon ?? makeParamSermon() ?? { id: `player_${paramVideoId}`, title: paramTitle ?? "Temple TV", description: "", youtubeId: paramVideoId ?? "", thumbnailUrl: paramThumbnail ?? `https://img.youtube.com/vi/${paramVideoId}/hqdefault.jpg`, duration: paramDuration ?? "", category: (paramCategory as Sermon["category"]) || "Faith", preacher: paramPreacher ?? "JCTM", date: "" };
    toggleFavorite(sermon);
  };

  // For broadcast mode, prefer the tuned* state (mutated in place by the
  // SSE / 15s poll / precision timer) so off-screen metadata reflects the
  // currently-airing item even after a queue advance. For VOD, fall back
  // to the active sermon / route params as before.
  // For live YouTube events: prefer the explicit override videoId
  // (delivered via the broadcast SSE handler below — `tunedVideoId` is
  // mutated in place when admin "Activate live stream" swaps URLs) over
  // the channel-handle embed fallback. Only when no override / param
  // videoId is present do we fall through to undefined, which causes
  // `<YoutubePlayer>` to use the @templetvjctm channel deep-link.
  // For VOD: unchanged — active sermon → tuned → route param.
  const displayVideoId = isLive
    ? (tunedVideoId ?? paramVideoId)
    : (activeSermon?.youtubeId ?? tunedVideoId ?? paramVideoId);
  // Round 9c: extended the broadcast-clean override to ALL live surfaces,
  // not just the broadcast-queue mode. Live YouTube events (`isLive=true`)
  // and station-driven broadcast queue items (`isBroadcastMode=true`) both
  // get the channel-identity title, preacher, and blanked duration/
  // category. Imports `BROADCAST_TITLE` / `BROADCAST_PREACHER` from the
  // shared identity module so a single edit updates every surface. VOD
  // playback continues to show its real sermon metadata.
  // `isBroadcastOrLive` itself is declared a few lines below (line ~776);
  // we can't reference it here without a forward-init, so the equivalent
  // expression is inlined. The semantics are identical.
  const displayTitle = (isLive || isBroadcastMode)
    ? BROADCAST_TITLE
    : (activeSermon?.title ?? paramTitle ?? "Temple TV");
  const displayPreacher = (isLive || isBroadcastMode)
    ? BROADCAST_PREACHER
    : (activeSermon?.preacher ?? paramPreacher ?? "JCTM");
  const displayDuration = (isLive || isBroadcastMode) ? "" : (activeSermon?.duration ?? paramDuration ?? "");
  const displayCategory = (isLive || isBroadcastMode) ? "" : (activeSermon?.category ?? paramCategory ?? "");
  const thumbnailUrl = (isBroadcastMode ? tunedThumbnail : undefined) ?? activeSermon?.thumbnailUrl ?? paramThumbnail ?? (displayVideoId ? `https://img.youtube.com/vi/${displayVideoId}/hqdefault.jpg` : undefined);
  const favorited = displayVideoId ? isFavorite(displayVideoId) : false;
  const relatedSermons = allSermons.filter((s) => s.youtubeId !== displayVideoId && (activeSermon ? s.category === activeSermon.category : true)).slice(0, 6);
  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const loopIcon = loopMode === "one" ? "rotate-cw" : loopMode === "all" ? "repeat" : "minus-circle";
  const loopColor = loopMode === "none" ? c.mutedForeground : c.primary;
  const showSeekBar = !isLive && !isBroadcastMode && duration > 0;
  const showVolume = !isLive && Platform.OS === "web";
  const isBroadcastOrLive = isLive || isBroadcastMode;

  // Nudge guests watching broadcast to sign up — shown once, dismissible.
  const [nudgeDismissed, setNudgeDismissed] = useState(false);

  const [latestReaction, setLatestReaction] = useState<{ type: ReactionType; ts: number } | null>(null);
  const [prayerModalVisible, setPrayerModalVisible] = useState(false);

  const handleToggleAudioMode = useCallback(() => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    toggleRadioMode();
  }, [toggleRadioMode]);

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      {Platform.OS !== "web" && <StatusBar barStyle="dark-content" backgroundColor={LIGHT_PAGE_BG} />}

      {/* Light safe-area spacer — keeps video below notch / Dynamic Island */}
      {Platform.OS !== "web" && insets.top > 0 && (
        <View style={{ height: insets.top, backgroundColor: LIGHT_PAGE_BG }} />
      )}

      <View
        style={[
          styles.playerContainer,
          {
            height: isRadioMode && !paramLocalVideoUrl
              ? Math.max(videoPlayerHeight, 280)
              : videoPlayerHeight,
          },
        ]}
      >
        {/* Broadcast backdrop. Real TV stations never show pure black during
            a tune-in or a brief signal hiccup — they show the program's
            poster art behind the bug. We mount the thumbnail as an absolute
            backdrop layer behind the video element so the cold-start frame
            and the brief window after a load error (before the broken-item
            skip swaps to the next item) reads as an intentional "tuning in"
            slide instead of a void. The video element overlays on top of
            this layer the moment a frame decodes, hiding it automatically. */}
        {tunedThumbnail ? (
          // Wrap in a View so we can set pointerEvents="none" — RN's
          // ImageStyle type doesn't accept pointerEvents, but it's valid on
          // a View. This guarantees taps fall through to the player chrome
          // above when the video element doesn't fully cover the backdrop
          // (letterboxing in cover mode on portrait phones).
          <View style={styles.playerBackdrop} pointerEvents="none">
            <Image
              source={{ uri: tunedThumbnail }}
              style={styles.playerBackdropImage}
              resizeMode="cover"
              blurRadius={Platform.OS === "web" ? 0 : 8}
            />
          </View>
        ) : null}
        {tunedLocalVideoUrl ? (
          <LocalVideoPlayer
            videoUrl={tunedLocalVideoUrl}
            hlsMasterUrl={tunedHlsMasterUrl}
            thumbnailUrl={tunedThumbnail}
            title={displayTitle}
            autoPlay
            startPositionMs={tunedStartPositionMs}
            coverMode={isBroadcastOrLive}
            playerHeightOverride={videoPlayerHeight}
            // Round 6: broadcast queue items must not expose native scrubber
            // / time / seek hotkeys. The flag is identical to the existing
            // showSeekBar gate `isLive || isBroadcastMode`.
            isBroadcastLive={isBroadcastOrLive}
            // Round 7 (broadcast continuity): feed the upcoming queue
            // item into the inactive A/B slot so transitions are
            // instant cuts, not reloads. These are populated by the
            // SSE / 15s poll / precision timer effects above when in
            // broadcast mode; outside of broadcast mode they're undefined
            // and the player just behaves as a single-slot VOD surface.
            nextVideoUrl={tunedNextLocalVideoUrl}
            nextHlsMasterUrl={tunedNextHlsMasterUrl}
            onEnd={handleVideoEnd}
            onError={handleBroadcastError}
          />
        ) : (
          <YoutubePlayer
            videoId={displayVideoId}
            isLive={isLive}
            thumbnailUrl={thumbnailUrl}
            title={displayTitle}
            preacher={displayPreacher}
            playerHeight={videoPlayerHeight}
            autoPlay
            startPositionSecs={Math.floor(tunedStartPositionMs / 1000) || undefined}
            // Round 6: broadcast YouTube items render with hidden YouTube
            // chrome (no control bar / fullscreen / keyboard seek) so the
            // station feed cannot be rewound or fast-forwarded even when
            // the underlying source is a non-live VOD.
            isBroadcastLive={isBroadcastOrLive}
            onEnd={handleVideoEnd}
            onError={handleBroadcastError}
            onToggleAudioMode={handleToggleAudioMode}
          />
        )}
        <LinearGradient
          colors={["rgba(13,17,23,0.78)", "rgba(13,17,23,0.32)", "transparent"]}
          locations={[0, 0.55, 1]}
          style={[styles.topGradient, { paddingTop: webTopPad + 12, pointerEvents: "box-none" }]}
        >
          <View style={styles.topControls}>
            <Pressable
              onPress={() => { if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.back(); }}
              style={styles.backBtn}
              hitSlop={12}
            >
              <Feather name="chevron-down" size={26} color="#FFF" />
            </Pressable>
            <View style={{ flex: 1 }} />
            {/* Round 6: ON AIR badge is shown for both live YouTube and
                station-driven broadcast queue surfaces. Both are "live to
                the viewer" — the broadcast queue is a continuous channel
                feed, not an on-demand pick. */}
            {isBroadcastOrLive && <LiveBadge size="medium" />}
            {!isLive && !paramLocalVideoUrl && (
              <Pressable
                onPress={handleToggleAudioMode}
                style={[styles.audioToggleBtn, isRadioMode && { backgroundColor: "rgba(106,13,173,0.6)" }]}
                hitSlop={12}
              >
                <Feather name={isRadioMode ? "video" : "headphones"} size={16} color="#FFF" />
              </Pressable>
            )}
            {/* Round 9b: the channel bug moved out of the top chrome and
                onto the bottom-right of the player surface as a real-
                broadcaster watermark — see <ChannelBug mode="watermark" />
                rendered below. The LIVE badge above is sufficient identity
                in the chrome itself. */}
          </View>
        </LinearGradient>

        {isBroadcastMode && !isRadioMode && (
          <BroadcastInfoStrip broadcast={broadcastInfo} playerHeight={videoPlayerHeight} />
        )}

        {/* ── Real-broadcaster channel bug (bottom-right watermark) ────────
            Round 9b: discreet "TEMPLE TV" mark that fades in 3 seconds
            after each program change. `programKey` is the currently-tuned
            program (videoId or local URL) so a queue advance resets the
            grace period and re-eases the bug back in once the new program
            has settled — exactly how real TV networks introduce their
            station identifier. */}
        {isBroadcastMode && !isRadioMode && (
          <View style={styles.channelBugWatermark} pointerEvents="none">
            <ChannelBug
              mode="watermark"
              programKey={tunedVideoId ?? tunedLocalVideoUrl ?? ""}
            />
          </View>
        )}
      </View>

      {/* ── Broadcast / Live: clean immersive footer — no metadata clutter ── */}
      {isBroadcastOrLive ? (
        <View style={[styles.broadcastFooter, { paddingBottom: insets.bottom + 12 }]}>
          {/* Live reactions overlay */}
          <LiveReactions
            latestIncoming={latestReaction}
            containerWidth={screenWidth}
          />

          {/* Channel identification row */}
          <View style={styles.broadcastChannelRow}>
            <View style={styles.onAirIndicator}>
              <View style={styles.onAirDot} />
              <Text style={styles.onAirLabel}>{isLive ? "LIVE" : "ON AIR"}</Text>
            </View>
            <Text style={[styles.broadcastChannelName, { color: c.foreground }]} numberOfLines={1}>
              Temple TV · JCTM Broadcasting
            </Text>
            <View style={{ flex: 1 }} />
            {isRadioMode && (
              <View style={[styles.playbackModeBadge, { backgroundColor: c.secondary }]}>
                <Feather name="radio" size={13} color={c.primary} />
                <Text style={[styles.playbackModeText, { color: c.primary }]}>Audio</Text>
              </View>
            )}
          </View>

          {/* Action buttons */}
          <View style={styles.broadcastActions}>
            <Pressable
              onPress={handleToggleAudioMode}
              style={({ pressed }) => [
                styles.broadcastActionBtn,
                { backgroundColor: isRadioMode ? c.primary : c.secondary, opacity: pressed ? 0.75 : 1 },
              ]}
              hitSlop={8}
            >
              <Feather name={isRadioMode ? "video" : "headphones"} size={18} color={isRadioMode ? "#FFF" : c.foreground} />
              <Text style={[styles.broadcastActionLabel, { color: isRadioMode ? "#FFF" : c.mutedForeground }]}>
                {isRadioMode ? "Video" : "Audio only"}
              </Text>
            </Pressable>
            <Pressable
              onPress={handleShare}
              style={({ pressed }) => [styles.broadcastActionBtn, { backgroundColor: c.secondary, opacity: pressed ? 0.75 : 1 }]}
              hitSlop={8}
            >
              <Feather name="share-2" size={18} color={c.foreground} />
              <Text style={[styles.broadcastActionLabel, { color: c.mutedForeground }]}>Share</Text>
            </Pressable>
            <Pressable
              onPress={() => setPrayerModalVisible(true)}
              style={({ pressed }) => [styles.broadcastActionBtn, { backgroundColor: "rgba(106,13,173,0.22)", opacity: pressed ? 0.75 : 1 }]}
              hitSlop={8}
            >
              <Text style={{ fontSize: 18, lineHeight: 22 }}>🙏</Text>
              <Text style={[styles.broadcastActionLabel, { color: c.primary }]}>Prayer</Text>
            </Pressable>
          </View>

          {/* Non-intrusive sign-up nudge for guests — shown once, dismissible */}
          {!isLoggedIn && !nudgeDismissed && (
            <Pressable
              style={[styles.signupNudge, { backgroundColor: "rgba(106,13,173,0.15)", borderColor: "rgba(106,13,173,0.3)" }]}
              onPress={() => {
                openAuthGate({
                  pathname: "/player",
                  params: Object.fromEntries(
                    Object.entries(routeParams).filter((e): e is [string, string] => typeof e[1] === "string"),
                  ),
                  reason: "Sign up free to save your watch history and never miss a live service.",
                });
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.nudgeTitle, { color: c.foreground }]}>Save your watch history</Text>
                <Text style={[styles.nudgeSub, { color: c.mutedForeground }]}>Create a free account — takes 30 seconds</Text>
              </View>
              <Pressable onPress={(e) => { e.stopPropagation(); setNudgeDismissed(true); }} hitSlop={12}>
                <Feather name="x" size={18} color={c.mutedForeground} />
              </Pressable>
            </Pressable>
          )}
        </View>
      ) : (
        /* ── VOD: standard scrollable metadata + controls section ── */
        <Animated.View style={{ opacity: fadeAnim, flex: 1 }}>
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={[styles.info, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 40 }]}
            showsVerticalScrollIndicator={false}
          >
            <Animated.View style={[styles.titleSection, { opacity: titleFade }]}>
              <View style={styles.topMeta}>
                {!!displayCategory && (
                  <View style={[styles.categoryBadge, { backgroundColor: c.secondary }]}>
                    <Text style={[styles.categoryText, { color: c.accent }]}>{displayCategory}</Text>
                  </View>
                )}
                <View style={{ flex: 1 }} />
                <Pressable onPress={handleToggleFavorite} hitSlop={12}>
                  <Feather name="heart" size={22} color={favorited ? "#FF0040" : c.mutedForeground} />
                </Pressable>
              </View>

              <Text style={[styles.title, { color: c.foreground }]}>{displayTitle}</Text>

              <View style={styles.metaRow}>
                <Feather name="user" size={13} color={c.mutedForeground} />
                <Text style={[styles.meta, { color: c.mutedForeground }]}>{displayPreacher}</Text>
                {!!displayDuration && (
                  <>
                    <Text style={{ color: c.border }}> · </Text>
                    <Feather name="clock" size={13} color={c.mutedForeground} />
                    <Text style={[styles.meta, { color: c.mutedForeground }]}>{displayDuration}</Text>
                  </>
                )}
              </View>

              {activeSermon?.description ? (
                <Text style={[styles.desc, { color: c.mutedForeground }]}>{activeSermon.description}</Text>
              ) : null}
              {(dataSaver || isRadioMode) && (
                <View style={[styles.playbackModeBadge, { backgroundColor: c.secondary }]}>
                  <Feather name={isRadioMode ? "radio" : "wifi-off"} size={13} color={c.primary} />
                  <Text style={[styles.playbackModeText, { color: c.primary }]}>
                    {isRadioMode ? "Audio/radio focus enabled" : "Data saver requests lower quality playback"}
                  </Text>
                </View>
              )}
            </Animated.View>

            {showSeekBar && (
              <GlassCard style={styles.seekCard}>
                <SeekBar currentTime={currentTime} duration={duration} onSeek={handleSeek} />
                {showVolume && (
                  <VolumeBar volume={volume} onVolume={handleVolume} />
                )}
              </GlassCard>
            )}

            <View style={styles.actionRow}>
              <Pressable
                onPress={openOnYouTube}
                style={({ pressed }) => [styles.primaryBtn, { backgroundColor: "#FF0000", opacity: pressed ? 0.85 : 1 }]}
              >
                <Feather name="youtube" size={18} color="#FFF" />
                <Text style={styles.primaryBtnText}>Watch on YouTube</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.iconBtn, { backgroundColor: c.muted, opacity: pressed ? 0.7 : 1 }]}
                onPress={handleShare}
                hitSlop={8}
              >
                <Feather name="share-2" size={20} color={c.foreground} />
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.iconBtn, { backgroundColor: c.muted, opacity: pressed ? 0.7 : 1 }]}
                onPress={openCastHandoff}
                hitSlop={8}
              >
                <Feather name="cast" size={20} color={c.foreground} />
              </Pressable>
            </View>

            <GlassCard style={styles.controlsCard}>
              <Pressable
                onPress={() => { if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); toggleShuffle(); }}
                style={styles.controlBtn}
                hitSlop={8}
              >
                <Feather name="shuffle" size={20} color={shuffleMode ? c.primary : c.mutedForeground} />
                <Text style={[styles.controlLabel, { color: shuffleMode ? c.primary : c.mutedForeground }]}>Shuffle</Text>
              </Pressable>

              <Pressable onPress={handlePlayPrevious} style={styles.controlBtn} hitSlop={8}>
                <Feather name="skip-back" size={24} color={c.foreground} />
              </Pressable>

              <Pressable onPress={handleTogglePlay} style={[styles.playPauseBtn, { backgroundColor: c.primary }]}>
                <Feather name={isPlaying ? "pause" : "play"} size={28} color="#FFF" />
              </Pressable>

              <Pressable onPress={handlePlayNext} style={styles.controlBtn} hitSlop={8}>
                <Feather name="skip-forward" size={24} color={c.foreground} />
              </Pressable>

              <Pressable
                onPress={() => { if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); cycleLoopMode(); }}
                style={styles.controlBtn}
                hitSlop={8}
              >
                <Feather name={loopIcon} size={20} color={loopColor} />
                <Text style={[styles.controlLabel, { color: loopColor }]}>
                  {loopMode === "one" ? "Loop 1" : loopMode === "all" ? "Loop All" : "No Loop"}
                </Text>
              </Pressable>
            </GlassCard>

            {/* Round 8: the "Up Next" auto-play banner is a VOD library
                affordance only. Broadcast playback never surfaces queue
                metadata, even if a nextSermon happens to be set. */}
            {!isBroadcastMode && nextSermon && (
              <GlassCard style={styles.autoPlayBanner}>
                <View style={styles.autoPlayLeft}>
                  <Feather name="skip-forward" size={16} color={c.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.autoPlayLabel, { color: c.mutedForeground }]}>Up Next</Text>
                    <Text style={[styles.autoPlayTitle, { color: c.foreground }]} numberOfLines={1}>
                      {nextSermon.title}
                    </Text>
                  </View>
                </View>
                <Pressable onPress={handlePlayNext} style={[styles.autoPlayBtn, { backgroundColor: c.primary }]}>
                  <Text style={styles.autoPlayBtnText}>Play</Text>
                </Pressable>
              </GlassCard>
            )}

            {!nextSermon && loopMode === "none" && (
              <GlassCard style={styles.autoPlayBanner}>
                <View style={styles.autoPlayLeft}>
                  <Feather name="check-circle" size={16} color={c.mutedForeground} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.autoPlayLabel, { color: c.mutedForeground }]}>Queue</Text>
                    <Text style={[styles.autoPlayTitle, { color: c.mutedForeground }]}>End of playlist</Text>
                  </View>
                </View>
                <Pressable onPress={() => cycleLoopMode()} style={[styles.autoPlayBtn, { backgroundColor: c.secondary }]}>
                  <Text style={[styles.autoPlayBtnText, { color: c.primary }]}>Loop</Text>
                </Pressable>
              </GlassCard>
            )}

            {relatedSermons.length > 0 && (
              <View style={styles.relatedSection}>
                <Text style={[styles.relatedTitle, { color: c.foreground }]}>Related Sermons</Text>
                {relatedSermons.map((sermon) => (
                  <SermonCard key={sermon.id} sermon={sermon} variant="horizontal" onPress={navigateToRelated} />
                ))}
              </View>
            )}
          </ScrollView>
        </Animated.View>
      )}

      <PrayerRequestModal
        visible={prayerModalVisible}
        onClose={() => setPrayerModalVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Broadcast surround: a tinted deep charcoal (warm purple undertone from
  // the #6A0DAD brand) instead of pure #000. Pure black against an otherwise
  // light-themed chrome reads as an unfinished void; this tint reads as a
  // deliberate TV-screen surround — the same approach Apple TV+ / Disney+
  // use. Dark enough that the video dominates, light enough not to be harsh.
  playerContainer: { width: "100%", backgroundColor: "#15131A", position: "relative" },
  // Absolute backdrop behind the <video> element so cold-start and the brief
  // pre-skip error window read as an intentional poster slide, not pure black.
  // The actual player overlays this on top — z-order is purely DOM order
  // since neither layer sets zIndex; the video element comes after the Image.
  playerBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Match playerContainer's tinted broadcast surround so any gap between
    // backdrop image load and the video element first frame reads as the
    // intentional TV chassis tone, never pure black.
    backgroundColor: "#15131A",
  },
  playerBackdropImage: {
    width: "100%",
    height: "100%",
    opacity: 0.6,
  },
  topGradient: { position: "absolute", top: 0, left: 0, right: 0, height: 110 },
  topControls: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 12 },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.4)" },
  audioToggleBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.4)" },
  channelBugWatermark: {
    position: "absolute",
    right: 14,
    bottom: 14,
    zIndex: 5,
  } as const,
  broadcastFooter: {
    paddingHorizontal: 20,
    paddingTop: 20,
    gap: 16,
    backgroundColor: LIGHT_PAGE_BG,
    borderTopWidth: 1,
    borderTopColor: LIGHT_DIVIDER,
    // Subtle elevation lifts the footer off the black video frame above so
    // the boundary reads as deliberate (and not a rendering glitch) on light
    // displays. Web-only — native platforms get this for free from the
    // status-bar / nav-bar contrast.
    ...Platform.select({
      web: { boxShadow: "0 -1px 0 rgba(10, 0, 20, 0.04), 0 8px 24px rgba(10, 0, 20, 0.04)" },
      default: {},
    }),
  },
  broadcastChannelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  onAirIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(255,0,64,0.15)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  onAirDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "#FF0040",
    shadowColor: "#FF0040",
    shadowOpacity: 0.7,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  onAirLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: "#FF0040",
    letterSpacing: 1.2,
  },
  broadcastChannelName: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.1,
    flexShrink: 1,
  },
  broadcastActions: {
    flexDirection: "row",
    gap: 10,
  },
  broadcastActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 22,
  },
  broadcastActionLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  signupNudge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  nudgeTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 2,
  },
  nudgeSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  info: { padding: 16, gap: 16 },
  titleSection: { gap: 8 },
  topMeta: { flexDirection: "row", alignItems: "center", gap: 8 },
  categoryBadge: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 },
  categoryText: { fontSize: 12, fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
  title: { fontSize: 22, fontFamily: "Inter_700Bold", lineHeight: 28 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap" },
  meta: { fontSize: 14, fontFamily: "Inter_400Regular" },
  desc: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 22, marginTop: 4 },
  playbackModeBadge: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 6, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, marginTop: 4 },
  playbackModeText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  seekCard: { paddingVertical: 14, paddingHorizontal: 16, gap: 12 },
  actionRow: { flexDirection: "row", gap: 10, alignItems: "center" },
  primaryBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 13, borderRadius: 24 },
  primaryBtnText: { color: "#FFFFFF", fontSize: 15, fontFamily: "Inter_700Bold" },
  iconBtn: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  controlsCard: { flexDirection: "row", alignItems: "center", justifyContent: "space-around", paddingVertical: 14, paddingHorizontal: 8 },
  controlBtn: { alignItems: "center", gap: 4, paddingHorizontal: 8 },
  controlLabel: { fontSize: 10, fontFamily: "Inter_600SemiBold", letterSpacing: 0.3 },
  playPauseBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: 2,
    ...Platform.select({
      ios: { shadowColor: "#6A0DAD", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 8 },
      android: { elevation: 6 },
      web: { boxShadow: "0 4px 16px rgba(106,13,173,0.5)" },
    }),
  },
  autoPlayBanner: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, gap: 12 },
  autoPlayLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  autoPlayLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5, marginBottom: 2 },
  autoPlayTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  autoPlayBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  autoPlayBtnText: { color: "#FFF", fontSize: 13, fontFamily: "Inter_700Bold" },
  relatedSection: { gap: 10, marginTop: 4 },
  relatedTitle: { fontSize: 18, fontFamily: "Inter_700Bold", marginBottom: 2 },
});
