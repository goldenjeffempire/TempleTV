import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
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
import { useColors } from "@/hooks/useColors";
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
    const networkDriftSecs = bc.serverTimeMs ? Math.max(0, Math.round((now - bc.serverTimeMs) / 1000)) : 0;
    const startMs = (bc.positionSecs + networkDriftSecs) * 1000;

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

  const recoverBroadcastPlayback = useCallback(async () => {
    if (!isBroadcastMode || broadcastRecovering) return;
    setBroadcastRecovering(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const bc = await checkBroadcastCurrent();
      if (!isMountedRef.current) return;
      if (bc?.item) tuneToBroadcastItem(bc);
    } finally {
      if (isMountedRef.current) setBroadcastRecovering(false);
    }
  }, [isBroadcastMode, broadcastRecovering, tuneToBroadcastItem]);

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

  const handleSeek = useCallback((t: number) => { seekTo(t); }, [seekTo]);
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
  const displayVideoId = isLive ? undefined : (activeSermon?.youtubeId ?? tunedVideoId ?? paramVideoId);
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
      {Platform.OS !== "web" && <StatusBar barStyle="light-content" backgroundColor="#000" />}

      {/* Black safe-area spacer — keeps video below notch / Dynamic Island */}
      {Platform.OS !== "web" && insets.top > 0 && (
        <View style={{ height: insets.top, backgroundColor: "#000" }} />
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
            onError={recoverBroadcastPlayback}
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
            onError={recoverBroadcastPlayback}
            onToggleAudioMode={handleToggleAudioMode}
          />
        )}
        <LinearGradient
          colors={["rgba(0,0,0,0.7)", "transparent"]}
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
              <Text style={[styles.broadcastActionLabel, { color: "#c084fc" }]}>Prayer</Text>
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
  playerContainer: { width: "100%", backgroundColor: "#000", position: "relative" },
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
    paddingTop: 18,
    gap: 16,
    backgroundColor: "#000",
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
