import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  Image,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

import { LinearGradient } from "expo-linear-gradient";

import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useYouTubeChannel } from "@/hooks/useYouTubeChannel";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { LiveBadge } from "@/components/LiveBadge";
import { SermonCard } from "@/components/SermonCard";
import { NowPlayingBar } from "@/components/NowPlayingBar";
import { SectionHeader } from "@/components/SectionHeader";
import { SkeletonVerticalCard, SkeletonHorizontalCard, SkeletonLiveBanner } from "@/components/SkeletonCard";
import { NetworkBanner } from "@/components/NetworkBanner";
import { LiveNotificationBanner } from "@/components/LiveNotificationBanner";
import { usePlayer } from "@/context/PlayerContext";
import { checkLiveStatus, type LiveCheckResult } from "@/services/youtube";
import { sendLiveServiceNotification } from "@/services/notifications";
import { useFeaturedVideos } from "@/hooks/useFeaturedVideos";
import { useWatchProgress } from "@/hooks/useWatchProgress";
import { checkBroadcastCurrent, subscribeBroadcastEvents, type BroadcastCurrentResult } from "@/services/broadcast";
import { navigateToSermon, navigateToPlayer as gatedNavigateToPlayer } from "@/utils/navigation";
import { usePageSeo } from "@/hooks/usePageSeo";
import type { Sermon } from "@/types";

let HeroVideoComponent: any = null;
let HeroResizeMode: any = null;
try {
  const av = require("expo-av");
  HeroVideoComponent = av.Video;
  HeroResizeMode = av.ResizeMode;
} catch {}

const broadcastProgressStyles = StyleSheet.create({
  section: { gap: 5, marginTop: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  track: { flex: 1, height: 3, backgroundColor: "rgba(255,255,255,0.2)", borderRadius: 2, overflow: "hidden" },
  fill: { height: "100%" as any, backgroundColor: "#6A0DAD", borderRadius: 2 },
  timeBadge: { flexDirection: "row", alignItems: "center", gap: 3 },
  timeText: { color: "rgba(255,255,255,0.7)", fontSize: 10, fontFamily: "Inter_500Medium" },
  nextText: { color: "rgba(255,255,255,0.62)", fontSize: 12, fontFamily: "Inter_500Medium" },
});

function BroadcastProgress({ broadcastCurrent }: { broadcastCurrent: BroadcastCurrentResult }) {
  const [tickMs, setTickMs] = useState(() => Date.now());
  const fetchTimeRef = useRef(Date.now());

  useEffect(() => { fetchTimeRef.current = Date.now(); }, [broadcastCurrent]);
  useEffect(() => {
    const t = setInterval(() => setTickMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsed = (tickMs - fetchTimeRef.current) / 1000;
  const positionSecs = Math.round((broadcastCurrent.positionSecs ?? 0) + elapsed);
  const totalDuration = broadcastCurrent.item?.durationSecs ?? 1;
  const progress = Math.min(100, (positionSecs / totalDuration) * 100);

  return (
    <View style={broadcastProgressStyles.section}>
      <View style={broadcastProgressStyles.row}>
        <View style={broadcastProgressStyles.track}>
          <View style={[broadcastProgressStyles.fill, { width: `${progress}%` } as any]} />
        </View>
        {broadcastCurrent.nextItem && (
          <View style={broadcastProgressStyles.timeBadge}>
            <Feather name="skip-forward" size={9} color="rgba(255,255,255,0.6)" />
            <Text style={broadcastProgressStyles.timeText}>Up Next</Text>
          </View>
        )}
      </View>
    </View>
  );
}

export default function WatchScreen() {
  usePageSeo({
    title: "Temple TV — Live Worship, Sermons & 24/7 Broadcasting",
    description:
      "Join Jesus Christ Temple Ministry live. Stream worship services, sermons, and 24/7 Christian broadcasting on web, mobile, and Smart TV.",
    path: "/",
  });

  const c = useColors();
  const insets = useSafeAreaInsets();
  const { currentSermon, isLive: playerIsLive, playSermon, playLive, setQueue } = usePlayer();
  const { sermons, loading, refresh, isFromRss, error: feedError } = useYouTubeChannel();
  const { featured } = useFeaturedVideos();
  const { continueWatching, getProgress } = useWatchProgress();
  const { isOnline } = useNetworkStatus();
  const fadeAnim = useRef(new Animated.Value(Platform.OS === "web" ? 1 : 0)).current;
  const [liveStatus, setLiveStatus] = useState<LiveCheckResult>({ isLive: false, videoId: null, title: null });
  const [checkingLive, setCheckingLive] = useState(true);
  const [showLiveBanner, setShowLiveBanner] = useState(false);
  const [liveBannerDismissed, setLiveBannerDismissed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [broadcastCurrent, setBroadcastCurrent] = useState<BroadcastCurrentResult | null>(null);
  const [heroVideoFailed, setHeroVideoFailed] = useState(false);
  const heroVideoRef = useRef<any>(null);
  const autoStartedRef = useRef(false);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: Platform.OS !== "web" }).start();

    let lastSeenVideoId: string | null = null;

    const doLiveCheck = async (useCached = false) => {
      try {
        const [status, broadcastRes] = await Promise.all([
          checkLiveStatus(useCached),
          checkBroadcastCurrent(),
        ]);
        setLiveStatus(status);
        setBroadcastCurrent(broadcastRes);
        setCheckingLive(false);
        if (status.isLive) {
          if (!liveBannerDismissed) setShowLiveBanner(true);
          if (status.videoId !== lastSeenVideoId) {
            lastSeenVideoId = status.videoId;
            sendLiveServiceNotification(status.title ?? "Temple TV JCTM is LIVE!");
          }
          if (!autoStartedRef.current && !currentSermon && !playerIsLive) {
            autoStartedRef.current = true;
            playLive();
          }
        } else {
          setShowLiveBanner(false);
        }
      } catch {
        setCheckingLive(false);
      }
    };

    doLiveCheck(false);
    const interval = setInterval(() => doLiveCheck(true), 60000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Web browsers block unsolicited autoplay (and audio especially) — the
    // user must tap a play control. Auto-starting playback on the web is
    // bad UX and would silently fail anyway. Native (TV-like) clients keep
    // the cinematic auto-start.
    if (Platform.OS === "web") return;
    if (autoStartedRef.current || loading || sermons.length === 0) return;
    if (currentSermon || playerIsLive) { autoStartedRef.current = true; return; }
    autoStartedRef.current = true;
    const first = sermons[0];
    if (first) {
      setQueue(sermons);
      playSermon(first, sermons);
    }
  }, [loading, sermons]);

  useEffect(() => {
    const refreshBroadcast = async (payload?: any) => {
      if (payload?.current) {
        setBroadcastCurrent(payload.current);
        return;
      }
      const latest = await checkBroadcastCurrent().catch(() => null);
      if (latest) setBroadcastCurrent(latest);
    };

    const subscription = subscribeBroadcastEvents({
      "broadcast-current-updated": refreshBroadcast,
      "broadcast-queue-updated": () => refreshBroadcast(),
      "broadcast-schedule-updated": () => refreshBroadcast(),
      "broadcast-control-updated": () => refreshBroadcast(),
      "override-expired": () => refreshBroadcast(),
      status: (payload) => {
        if (payload) {
          setLiveStatus({
            isLive: !!payload.isLive,
            videoId: payload.ytVideoId ?? null,
            title: payload.ytTitle ?? payload.liveOverride?.title ?? null,
          });
          setShowLiveBanner(!!payload.isLive && !liveBannerDismissed);
        }
        refreshBroadcast();
      },
      "yt-status": (payload) => {
        if (payload) {
          setLiveStatus({
            isLive: !!payload.isLive,
            videoId: payload.videoId ?? null,
            title: payload.title ?? null,
          });
        }
      },
    });

    return () => subscription?.close();
  }, [liveBannerDismissed]);

  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isTabletLayout = windowWidth >= 768;
  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const topPad = insets.top + webTopPad;
  // Cinematic hero occupies 62% of viewport on mobile, 52% on tablet.
  // On web, add the fixed nav-bar height so the hero starts below it.
  const heroHeight = Math.round(
    windowHeight * (isTabletLayout ? 0.52 : 0.62) + (Platform.OS === "web" ? webTopPad : 0),
  );

  const navigateToPlayer = useCallback((params: Record<string, string>) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    gatedNavigateToPlayer(params, "Sign up free to watch this — it only takes a moment.");
  }, []);

  const handleSermonPress = useCallback((sermon: Sermon) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const prog = getProgress(sermon.id);
    navigateToSermon(
      sermon,
      prog ? { startPositionMs: String(Math.floor(prog.position * 1000)) } : {},
    );
  }, [getProgress]);

  const handleLivePress = useCallback(() => {
    navigateToPlayer({
      live: "true",
      title: liveStatus.title ?? "Temple TV Live",
      preacher: "Temple TV JCTM",
      ...(liveStatus.videoId ? { videoId: liveStatus.videoId } : {}),
    });
  }, [navigateToPlayer, liveStatus]);

  const handleBroadcastPress = useCallback(() => {
    const currentBroadcast = broadcastCurrent;

    checkBroadcastCurrent()
      .then((latest) => { if (latest) setBroadcastCurrent(latest); })
      .catch(() => {});

    if (currentBroadcast?.activeSchedule?.contentType === "live") {
      handleLivePress();
      return;
    }
    const item = currentBroadcast?.item;
    if (!item) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const elapsed = currentBroadcast?.serverTimeMs
      ? Math.max(0, Math.round((Date.now() - currentBroadcast.serverTimeMs) / 1000))
      : 0;
    const startMs = String(((currentBroadcast?.positionSecs ?? 0) + elapsed) * 1000);

    if (item.videoSource === "local" && item.localVideoUrl) {
      router.push({
        pathname: "/player",
        params: {
          broadcastMode: "true",
          localVideoUrl: item.localVideoUrl,
          hlsMasterUrl: (item as any).hlsMasterUrl ?? undefined,
          title: item.title,
          thumbnail: item.thumbnailUrl,
          startPositionMs: startMs,
        },
      });
    } else {
      router.push({
        pathname: "/player",
        params: {
          broadcastMode: "true",
          videoId: item.youtubeId,
          title: item.title,
          thumbnail: item.thumbnailUrl,
          startPositionMs: startMs,
        },
      });
    }
  }, [broadcastCurrent, handleLivePress]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([
      refresh(),
      checkLiveStatus().then((status) => {
        setLiveStatus(status);
        if (status.isLive && !liveBannerDismissed) setShowLiveBanner(true);
      }),
      checkBroadcastCurrent().then((bc) => setBroadcastCurrent(bc)),
    ]);
    setRefreshing(false);
  };

  const broadcastItem = broadcastCurrent?.item ?? null;
  const showScheduledLive = !liveStatus.isLive && broadcastCurrent?.activeSchedule?.contentType === "live";
  const showBroadcast = !liveStatus.isLive && (broadcastItem !== null || showScheduledLive);

  const recentSermons = useMemo(() => sermons.slice(0, 6), [sermons]);
  const faithSermons = useMemo(() => sermons.filter((s) => s.category === "Faith").slice(0, 3), [sermons]);
  const healingSermons = useMemo(() => sermons.filter((s) => s.category === "Healing").slice(0, 3), [sermons]);
  const deliveranceSermons = useMemo(() => sermons.filter((s) => s.category === "Deliverance").slice(0, 3), [sermons]);
  const worshipSermons = useMemo(() => sermons.filter((s) => s.category === "Worship").slice(0, 3), [sermons]);
  const teachingsSermons = useMemo(() => sermons.filter((s) => s.category === "Teachings").slice(0, 3), [sermons]);
  const specialSermons = useMemo(() => sermons.filter((s) => s.category === "Special Programs").slice(0, 3), [sermons]);

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <NetworkBanner visible={!isOnline} />

      <LiveNotificationBanner
        visible={showLiveBanner}
        title={liveStatus.title ?? "Temple TV is LIVE now"}
        onPress={() => {
          setShowLiveBanner(false);
          handleLivePress();
        }}
        onDismiss={() => {
          setShowLiveBanner(false);
          setLiveBannerDismissed(true);
        }}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 150 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={c.primary}
            colors={[c.primary]}
            progressBackgroundColor={c.card}
          />
        }
      >
        <Animated.View style={{ opacity: fadeAnim }}>

          {/* ─── Cinematic Hero ───────────────────────────────────────────────── */}
          {loading ? (
            <View style={{ paddingTop: topPad }}>
              <SkeletonLiveBanner />
            </View>
          ) : (
            <Pressable
              onPress={showBroadcast ? handleBroadcastPress : handleLivePress}
              style={({ pressed }) => [
                styles.cinemaHero,
                { height: heroHeight },
                pressed && { opacity: 0.93 },
              ]}
              accessible
              accessibilityRole="button"
              accessibilityLabel={liveStatus.isLive ? "Watch live service" : "Watch Temple TV"}
            >
              {/* ── Backdrop: video > thumbnail > logo ── */}
              <View style={StyleSheet.absoluteFill}>
                {showBroadcast && broadcastItem?.localVideoUrl && HeroVideoComponent && !heroVideoFailed ? (
                  <HeroVideoComponent
                    ref={heroVideoRef}
                    source={{ uri: broadcastItem.localVideoUrl }}
                    style={StyleSheet.absoluteFill}
                    resizeMode={HeroResizeMode?.COVER ?? "cover"}
                    isLooping
                    isMuted
                    shouldPlay
                    useNativeControls={false}
                    onError={() => setHeroVideoFailed(true)}
                    progressUpdateIntervalMillis={5000}
                    videoStyle={{ width: "100%", height: "100%" }}
                  />
                ) : showBroadcast && broadcastItem?.thumbnailUrl ? (
                  <Image source={{ uri: broadcastItem.thumbnailUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                ) : liveStatus.isLive && liveStatus.videoId && Platform.OS === "web" ? (
                  <View style={[StyleSheet.absoluteFill, { overflow: "hidden" as const }]}>
                    <iframe
                      src={`https://www.youtube-nocookie.com/embed/${liveStatus.videoId}?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&loop=1&playlist=${liveStatus.videoId}&rel=0&iv_load_policy=3`}
                      allow="autoplay; encrypted-media"
                      frameBorder={0}
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, pointerEvents: "none" } as any}
                      title="Temple TV Live Preview"
                    />
                  </View>
                ) : (
                  /* Off-air: branded gradient backdrop with subtle logo */
                  <View style={[StyleSheet.absoluteFill, styles.heroBrandedBg]}>
                    <Image
                      source={require("@/assets/images/logo.png")}
                      style={styles.heroLogoWatermark}
                      resizeMode="contain"
                    />
                  </View>
                )}
              </View>

              {/* ── Cinematic gradient overlay ── */}
              <LinearGradient
                colors={[
                  "rgba(0,0,0,0.68)",   // top — header legibility
                  "rgba(0,0,0,0.0)",    // upper-mid — let video breathe
                  "rgba(0,0,0,0.0)",    // lower-mid — let video breathe
                  "rgba(0,0,0,0.82)",   // bottom — content panel
                  "rgba(0,0,0,0.96)",   // very bottom — deep black
                ]}
                locations={[0, 0.22, 0.48, 0.78, 1]}
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
              />
              {/* Side vignette for cinematic feel */}
              <LinearGradient
                colors={["rgba(0,0,0,0.42)", "rgba(0,0,0,0)", "rgba(0,0,0,0.3)"]}
                locations={[0, 0.5, 1]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
              />

              {/* ── Floating Header ── */}
              <View style={[styles.heroHeader, { paddingTop: topPad + 10 }]}>
                <View style={styles.headerLogoWrap}>
                  <Image
                    source={require("@/assets/images/logo.png")}
                    style={styles.headerLogo}
                    resizeMode="contain"
                  />
                  <View style={styles.logoMeta}>
                    <Text style={styles.heroSubtitle}>JCTM Broadcasting</Text>
                    {isFromRss && !feedError && (
                      <View style={[styles.liveDot, { backgroundColor: "#22c55e" }]} />
                    )}
                    {!!feedError && !loading && (
                      <View style={[styles.liveDot, { backgroundColor: "#f59e0b" }]} />
                    )}
                  </View>
                </View>
                <Pressable
                  style={styles.heroSettingsBtn}
                  onPress={() => router.push("/(tabs)/settings")}
                  hitSlop={12}
                >
                  <Feather name="settings" size={20} color="rgba(255,255,255,0.85)" />
                </Pressable>
              </View>

              {/* ── Channel Bug (TV network-style watermark) ── */}
              {(showBroadcast || liveStatus.isLive) && (
                <View style={styles.channelBug}>
                  <Text style={styles.channelBugText}>TEMPLE TV</Text>
                </View>
              )}

              {/* ── Bottom content panel ── */}
              <View style={[styles.heroContent, { paddingBottom: Math.max(insets.bottom + 20, 28) }]}>
                {/* Status badge */}
                {!checkingLive && (
                  liveStatus.isLive ? (
                    <LiveBadge size="large" />
                  ) : showBroadcast ? (
                    <View style={styles.onAirBadge}>
                      <View style={styles.onAirPulse} />
                      <Text style={styles.onAirBadgeText}>ON AIR · TEMPLE TV</Text>
                    </View>
                  ) : (
                    <View style={styles.offlineBadge}>
                      <Feather name="tv" size={12} color="rgba(255,255,255,0.75)" />
                      <Text style={styles.offlineBadgeText}>24/7 STREAM</Text>
                    </View>
                  )
                )}

                {/* Title */}
                <Text style={styles.heroTitle} numberOfLines={2}>
                  {liveStatus.isLive && liveStatus.title
                    ? liveStatus.title
                    : showScheduledLive
                    ? "Live Service Coming Up"
                    : "Temple TV"}
                </Text>

                {/* Subtitle */}
                <Text style={styles.heroSubtitleMeta}>
                  {liveStatus.isLive
                    ? "Live worship service — tune in now"
                    : showScheduledLive
                    ? "Scheduled live service — tap to join"
                    : showBroadcast
                    ? "Spirit-filled broadcasts around the clock"
                    : "Temple TV Anywhere You Go"}
                </Text>

                {/* Broadcast progress bar */}
                {showBroadcast && broadcastCurrent?.item && (
                  <BroadcastProgress broadcastCurrent={broadcastCurrent} />
                )}

                {/* CTA row */}
                <View style={styles.heroCtaRow}>
                  <Pressable
                    onPress={showBroadcast ? handleBroadcastPress : handleLivePress}
                    style={({ pressed }) => [
                      styles.heroWatchBtn,
                      { backgroundColor: liveStatus.isLive ? "#FF0040" : "#6A0DAD" },
                      pressed && { opacity: 0.85 },
                    ]}
                  >
                    <Feather name="play" size={16} color="#FFF" />
                    <Text style={styles.heroWatchBtnText}>Watch Temple TV</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => router.push("/library")}
                    style={({ pressed }) => [styles.heroSecondaryBtn, pressed && { opacity: 0.75 }]}
                  >
                    <Feather name="grid" size={15} color="rgba(255,255,255,0.9)" />
                    <Text style={styles.heroSecondaryBtnText}>Library</Text>
                  </Pressable>
                </View>
              </View>
            </Pressable>
          )}

          {(currentSermon || playerIsLive) && (
            <NowPlayingBar
              title={playerIsLive ? "Temple TV Live" : currentSermon?.title ?? ""}
              isLive={playerIsLive}
              onPress={playerIsLive ? handleLivePress : (currentSermon ? () => navigateToSermon(currentSermon) : undefined)}
            />
          )}

          {continueWatching.length > 0 && !loading && (
            <View style={styles.section}>
              <SectionHeader
                title="Continue Watching"
                subtitle={`${continueWatching.length} in progress`}
                onSeeAll={() => router.push("/library")}
              />
              <FlatList
                horizontal
                data={continueWatching
                  .map((cw) => ({
                    item: sermons.find((s) => s.id === cw.videoKey),
                    pct: cw.pct,
                    position: cw.position,
                  }))
                  .filter((x): x is { item: Sermon; pct: number; position: number } => !!x.item)}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
                keyExtractor={(x) => x.item.id}
                initialNumToRender={4}
                windowSize={5}
                removeClippedSubviews
                renderItem={({ item: { item, pct, position } }) => (
                  <SermonCard
                    sermon={item}
                    onPress={(s) => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      navigateToSermon(s, { startPositionMs: String(Math.floor(position * 1000)) });
                    }}
                    variant="vertical"
                    progress={pct}
                  />
                )}
              />
            </View>
          )}

          {featured.length > 0 && (
            <View style={styles.section}>
              <SectionHeader
                title="Featured"
                subtitle="Handpicked sermons"
                onSeeAll={() => router.push("/library")}
              />
              <FlatList
                horizontal
                data={featured}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
                keyExtractor={(item) => item.id}
                initialNumToRender={4}
                windowSize={5}
                removeClippedSubviews
                renderItem={({ item }) => (
                  <SermonCard sermon={item} onPress={handleSermonPress} variant="vertical" />
                )}
              />
            </View>
          )}

          <View style={styles.section}>
            <SectionHeader
              title="Latest Sermons"
              subtitle={isFromRss ? "From YouTube" : "Featured"}
              onSeeAll={() => router.push("/library")}
            />
            {loading ? (
              <FlatList
                horizontal
                data={[1, 2, 3]}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
                keyExtractor={(item) => String(item)}
                renderItem={() => <SkeletonVerticalCard />}
              />
            ) : (
              <FlatList
                horizontal
                data={recentSermons}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
                keyExtractor={(item) => item.id}
                initialNumToRender={4}
                windowSize={5}
                removeClippedSubviews
                renderItem={({ item }) => (
                  <SermonCard sermon={item} onPress={handleSermonPress} variant="vertical" />
                )}
              />
            )}
          </View>

          {!loading && faithSermons.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="Faith" onSeeAll={() => router.push({ pathname: "/library", params: { category: "Faith" } })} />
              <View style={styles.listContainer}>
                {faithSermons.map((s) => (
                  <SermonCard key={s.id} sermon={s} onPress={handleSermonPress} variant="horizontal" />
                ))}
              </View>
            </View>
          )}

          {!loading && healingSermons.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="Healing & Miracles" onSeeAll={() => router.push({ pathname: "/library", params: { category: "Healing" } })} />
              <View style={styles.listContainer}>
                {healingSermons.map((s) => (
                  <SermonCard key={s.id} sermon={s} onPress={handleSermonPress} variant="horizontal" />
                ))}
              </View>
            </View>
          )}

          {!loading && deliveranceSermons.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="Deliverance" onSeeAll={() => router.push({ pathname: "/library", params: { category: "Deliverance" } })} />
              <View style={styles.listContainer}>
                {deliveranceSermons.map((s) => (
                  <SermonCard key={s.id} sermon={s} onPress={handleSermonPress} variant="horizontal" />
                ))}
              </View>
            </View>
          )}

          {!loading && worshipSermons.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="Worship" onSeeAll={() => router.push({ pathname: "/library", params: { category: "Worship" } })} />
              <View style={styles.listContainer}>
                {worshipSermons.map((s) => (
                  <SermonCard key={s.id} sermon={s} onPress={handleSermonPress} variant="horizontal" />
                ))}
              </View>
            </View>
          )}

          {!loading && teachingsSermons.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="Teachings" onSeeAll={() => router.push({ pathname: "/library", params: { category: "Teachings" } })} />
              <View style={styles.listContainer}>
                {teachingsSermons.map((s) => (
                  <SermonCard key={s.id} sermon={s} onPress={handleSermonPress} variant="horizontal" />
                ))}
              </View>
            </View>
          )}

          {!loading && specialSermons.length > 0 && (
            <View style={styles.section}>
              <SectionHeader title="Special Programs" onSeeAll={() => router.push({ pathname: "/library", params: { category: "Special" } })} />
              <View style={styles.listContainer}>
                {specialSermons.map((s) => (
                  <SermonCard key={s.id} sermon={s} onPress={handleSermonPress} variant="horizontal" />
                ))}
              </View>
            </View>
          )}

          {loading && (
            <View style={styles.section}>
              <View style={{ paddingHorizontal: 16 }}>
                <View style={{ height: 22, width: 120, backgroundColor: c.muted, borderRadius: 6, marginBottom: 12 }} />
              </View>
              <View style={styles.listContainer}>
                {[1, 2, 3].map((i) => <SkeletonHorizontalCard key={i} />)}
              </View>
            </View>
          )}
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // ── Cinematic Hero ───────────────────────────────────────────────────────────
  cinemaHero: {
    width: "100%",
    backgroundColor: "#060606",
    overflow: "hidden",
    position: "relative",
  },
  heroBrandedBg: {
    backgroundColor: "#0e0018",
    alignItems: "center",
    justifyContent: "center",
  },
  heroLogoWatermark: {
    width: 220,
    height: 70,
    opacity: 0.12,
  },

  // Floating header over the hero
  heroHeader: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingBottom: 10,
    zIndex: 10,
  },
  headerLogoWrap: { flexDirection: "column", justifyContent: "center" },
  headerLogo: { width: 130, height: 40 },
  logoMeta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 1 },
  heroSubtitle: { fontSize: 11, fontFamily: "Inter_400Regular", letterSpacing: 1.2, color: "rgba(255,255,255,0.65)" },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  heroSettingsBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
  },

  // TV network-style channel bug (top-right watermark)
  channelBug: {
    position: "absolute",
    top: 0,
    right: 18,
    zIndex: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 0,
  },
  channelBugText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    letterSpacing: 3,
    color: "rgba(255,255,255,0.45)",
  },

  // Bottom content panel
  heroContent: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 16,
    gap: 10,
  },

  // Badges
  onAirBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(106,13,173,0.9)",
    alignSelf: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(168,85,247,0.45)",
  },
  onAirPulse: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: "#a855f7",
  },
  onAirBadgeText: {
    color: "#fff",
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.2,
  },
  offlineBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.10)",
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
  },
  offlineBadgeText: { color: "rgba(255,255,255,0.8)", fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.8 },

  // Title & subtitle
  heroTitle: {
    color: "#FFFFFF",
    fontSize: 34,
    fontFamily: "Inter_700Bold",
    lineHeight: 38,
    letterSpacing: -0.5,
    textShadowColor: "rgba(0,0,0,0.55)",
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 12,
  },
  heroSubtitleMeta: {
    color: "rgba(255,255,255,0.80)",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },

  // CTA buttons row
  heroCtaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 4,
  },
  heroWatchBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 22,
    paddingVertical: 13,
    borderRadius: 26,
  },
  heroWatchBtnText: { color: "#FFFFFF", fontSize: 15, fontFamily: "Inter_700Bold" },
  heroSecondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderRadius: 26,
    backgroundColor: "rgba(255,255,255,0.14)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  heroSecondaryBtnText: { color: "rgba(255,255,255,0.9)", fontSize: 14, fontFamily: "Inter_600SemiBold" },

  // Shared / left-overs
  subtitle: { fontSize: 12, fontFamily: "Inter_400Regular", letterSpacing: 1 },
  notifBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  section: { marginTop: 28, gap: 12 },
  listContainer: { paddingHorizontal: 16, gap: 10 },
});
