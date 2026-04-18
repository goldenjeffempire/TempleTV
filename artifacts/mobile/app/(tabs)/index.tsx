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
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useYouTubeChannel } from "@/hooks/useYouTubeChannel";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { GlassCard } from "@/components/GlassCard";
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
import { navigateToSermon } from "@/utils/navigation";
import type { Sermon } from "@/types";

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
  const remaining = Math.max(0, totalDuration - positionSecs);
  const remMins = Math.floor(remaining / 60);
  const remSecs = remaining % 60;
  const remStr = remMins > 0
    ? `${remMins}m ${String(remSecs).padStart(2, "0")}s`
    : `${remSecs}s`;

  return (
    <View style={broadcastProgressStyles.section}>
      <View style={broadcastProgressStyles.row}>
        <View style={broadcastProgressStyles.track}>
          <View style={[broadcastProgressStyles.fill, { width: `${progress}%` } as any]} />
        </View>
        <View style={broadcastProgressStyles.timeBadge}>
          <Feather name="clock" size={9} color="rgba(255,255,255,0.7)" />
          <Text style={broadcastProgressStyles.timeText}>{remStr} left</Text>
        </View>
      </View>
      {broadcastCurrent.nextItem && (
        <Text style={broadcastProgressStyles.nextText} numberOfLines={1}>
          Up next: {broadcastCurrent.nextItem.title}
        </Text>
      )}
    </View>
  );
}

export default function WatchScreen() {
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

  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const topPad = insets.top + webTopPad;

  const navigateToPlayer = useCallback((params: Record<string, string>) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push({ pathname: "/player", params });
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

  const handleBroadcastPress = useCallback(async () => {
    const latest = await checkBroadcastCurrent().catch(() => null);
    const currentBroadcast = latest ?? broadcastCurrent;
    if (latest) setBroadcastCurrent(latest);

    if (currentBroadcast?.activeSchedule?.contentType === "live") {
      handleLivePress();
      return;
    }
    const item = currentBroadcast?.item;
    if (!item) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const networkDriftSecs = currentBroadcast?.serverTimeMs
      ? Math.max(0, Math.round((Date.now() - currentBroadcast.serverTimeMs) / 1000))
      : 0;
    const startMs = String(((currentBroadcast?.positionSecs ?? 0) + networkDriftSecs) * 1000);
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
        contentContainerStyle={{ paddingTop: topPad, paddingBottom: 150 }}
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
          <View style={styles.header}>
            <View style={styles.headerLogoWrap}>
              <Image
                source={require("@/assets/images/logo.png")}
                style={styles.headerLogo}
                resizeMode="contain"
              />
              <View style={styles.logoMeta}>
                <Text style={[styles.subtitle, { color: c.mutedForeground }]}>JCTM Broadcasting</Text>
                {isFromRss && !feedError && (
                  <View style={[styles.liveDot, { backgroundColor: "#22c55e" }]} />
                )}
                {!!feedError && !loading && (
                  <View style={[styles.liveDot, { backgroundColor: "#f59e0b" }]} />
                )}
              </View>
            </View>
            <Pressable
              style={[styles.notifBtn, { backgroundColor: c.muted }]}
              onPress={() => router.push("/(tabs)/settings")}
              hitSlop={12}
            >
              <Feather name="settings" size={20} color={c.mutedForeground} />
            </Pressable>
          </View>

          {loading ? (
            <SkeletonLiveBanner />
          ) : (
            <Pressable
              onPress={showBroadcast ? handleBroadcastPress : handleLivePress}
              style={({ pressed }) => [{ opacity: pressed ? 0.9 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }]}
            >
              <GlassCard style={styles.liveCard} intensity="high">
                {showBroadcast && broadcastItem?.thumbnailUrl ? (
                  <Image
                    source={{ uri: broadcastItem.thumbnailUrl }}
                    style={styles.liveBanner}
                    resizeMode="cover"
                  />
                ) : (
                  <Image
                    source={require("@/assets/images/logo.png")}
                    style={styles.liveBanner}
                    resizeMode="contain"
                  />
                )}
                <View style={styles.liveOverlay}>
                  {checkingLive ? null : liveStatus.isLive ? (
                    <LiveBadge size="large" />
                  ) : showBroadcast ? (
                    <View style={[styles.offlineTag, { backgroundColor: "rgba(106,13,173,0.85)" }]}>
                      <Feather name="radio" size={13} color="rgba(255,255,255,0.9)" />
                      <Text style={styles.offlineTagText}>ON AIR</Text>
                    </View>
                  ) : (
                    <View style={styles.offlineTag}>
                      <Feather name="clock" size={13} color="rgba(255,255,255,0.8)" />
                      <Text style={styles.offlineTagText}>24/7 Stream</Text>
                    </View>
                  )}
                  <Text style={styles.liveTitle} numberOfLines={2}>
                    {liveStatus.isLive && liveStatus.title
                      ? liveStatus.title
                      : showScheduledLive
                      ? broadcastCurrent?.activeSchedule?.title ?? "Scheduled Live Service"
                      : showBroadcast
                      ? broadcastItem?.title ?? "Temple TV Broadcast"
                      : "Temple TV Live"}
                  </Text>
                  <Text style={styles.liveSubtitle}>
                    {liveStatus.isLive
                      ? "Now streaming live — tap to watch"
                      : showScheduledLive
                      ? "Scheduled live service — tap to join"
                      : showBroadcast
                      ? "Continuous broadcast — tap to watch"
                      : "Live worship & preaching 24/7"}
                  </Text>
                  {showBroadcast && broadcastCurrent?.item && (
                    <BroadcastProgress broadcastCurrent={broadcastCurrent} />
                  )}
                  <Pressable
                    onPress={showBroadcast ? handleBroadcastPress : handleLivePress}
                    style={[styles.watchBtn, { backgroundColor: liveStatus.isLive ? "#FF0040" : c.primary }]}
                  >
                    <Feather name="play" size={15} color="#FFF" />
                    <Text style={styles.watchBtnText}>
                      {liveStatus.isLive || showScheduledLive ? "Join Live" : showBroadcast ? "Tune In Now" : "Watch Stream"}
                    </Text>
                  </Pressable>
                </View>
              </GlassCard>
            </Pressable>
          )}

          {(currentSermon || playerIsLive) && (
            <NowPlayingBar
              title={playerIsLive ? "Temple TV Live" : currentSermon?.title ?? ""}
              isLive={playerIsLive}
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
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  logo: { fontSize: 28, fontFamily: "Inter_700Bold", letterSpacing: 3 },
  headerLogoWrap: { flexDirection: "column", justifyContent: "center" },
  headerLogo: { width: 140, height: 44 },
  logoMeta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  subtitle: { fontSize: 12, fontFamily: "Inter_400Regular", letterSpacing: 1 },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  notifBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  liveCard: { marginHorizontal: 16, marginBottom: 8, minHeight: 240 },
  liveBanner: { ...StyleSheet.absoluteFillObject, width: "100%", height: "100%" },
  liveOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.58)",
    justifyContent: "flex-end",
    padding: 20,
    gap: 6,
  },
  offlineTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
  },
  offlineTagText: { color: "rgba(255,255,255,0.85)", fontSize: 12, fontFamily: "Inter_600SemiBold" },
  liveTitle: { color: "#FFFFFF", fontSize: 22, fontFamily: "Inter_700Bold" },
  liveSubtitle: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontFamily: "Inter_400Regular" },
  broadcastProgressSection: { gap: 5, marginTop: 2 },
  broadcastProgressRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  broadcastProgressTrack: { flex: 1, height: 3, backgroundColor: "rgba(255,255,255,0.2)", borderRadius: 2, overflow: "hidden" },
  broadcastProgressFill: { height: "100%", backgroundColor: "#6A0DAD", borderRadius: 2 } as const,
  broadcastTimeBadge: { flexDirection: "row", alignItems: "center", gap: 3 },
  broadcastTimeText: { color: "rgba(255,255,255,0.7)", fontSize: 10, fontFamily: "Inter_500Medium" },
  broadcastNext: { color: "rgba(255,255,255,0.62)", fontSize: 12, fontFamily: "Inter_500Medium" },
  watchBtn: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 24,
    gap: 7,
    marginTop: 6,
  },
  watchBtnText: { color: "#FFFFFF", fontSize: 14, fontFamily: "Inter_700Bold" },
  section: { marginTop: 28, gap: 12 },
  listContainer: { paddingHorizontal: 16, gap: 10 },
});
