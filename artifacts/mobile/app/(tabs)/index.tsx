import React, { useEffect, useRef, useState } from "react";
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
import { checkBroadcastCurrent, type BroadcastCurrentResult } from "@/services/broadcast";
import type { Sermon } from "@/types";

export default function WatchScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { currentSermon, isLive: playerIsLive, playSermon, playLive, setQueue } = usePlayer();
  const { sermons, loading, refresh, isFromRss, error: feedError } = useYouTubeChannel();
  const { featured } = useFeaturedVideos();
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

  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const topPad = insets.top + webTopPad;

  const recentSermons = sermons.slice(0, 6);
  const faithSermons = sermons.filter((s) => s.category === "Faith").slice(0, 3);
  const healingSermons = sermons.filter((s) => s.category === "Healing").slice(0, 3);
  const deliveranceSermons = sermons.filter((s) => s.category === "Deliverance").slice(0, 3);
  const worshipSermons = sermons.filter((s) => s.category === "Worship").slice(0, 3);

  const navigateToPlayer = (params: Record<string, string>) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push({ pathname: "/player", params });
  };

  const handleSermonPress = (sermon: Sermon) => {
    navigateToPlayer({
      videoId: sermon.youtubeId,
      title: sermon.title,
      preacher: sermon.preacher,
      duration: sermon.duration,
      thumbnail: sermon.thumbnailUrl,
      category: sermon.category,
    });
  };

  const handleLivePress = () => {
    navigateToPlayer({
      live: "true",
      title: liveStatus.title ?? "Temple TV Live",
      preacher: "Temple TV JCTM",
      ...(liveStatus.videoId ? { videoId: liveStatus.videoId } : {}),
    });
  };

  const handleBroadcastPress = () => {
    const item = broadcastCurrent?.item;
    if (!item) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (item.videoSource === "local" && item.localVideoUrl) {
      router.push({
        pathname: "/player",
        params: {
          localVideoUrl: item.localVideoUrl,
          title: item.title,
          thumbnail: item.thumbnailUrl,
          startPositionMs: String(broadcastCurrent!.positionSecs * 1000),
        },
      });
    } else {
      navigateToPlayer({
        videoId: item.youtubeId,
        title: item.title,
        thumbnail: item.thumbnailUrl,
      });
    }
  };

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
  const showBroadcast = !liveStatus.isLive && broadcastItem !== null;

  const teachingsSermons = sermons.filter((s) => s.category === "Teachings").slice(0, 3);
  const specialSermons = sermons.filter((s) => s.category === "Special Programs").slice(0, 3);

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
                    source={require("@/assets/images/live-banner.png")}
                    style={styles.liveBanner}
                    resizeMode="cover"
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
                      : showBroadcast
                      ? broadcastItem?.title ?? "Temple TV Broadcast"
                      : "Temple TV Live"}
                  </Text>
                  <Text style={styles.liveSubtitle}>
                    {liveStatus.isLive
                      ? "Now streaming live — tap to watch"
                      : showBroadcast
                      ? "Continuous broadcast — tap to watch"
                      : "Live worship & preaching 24/7"}
                  </Text>
                  {showBroadcast && broadcastCurrent?.nextItem && (
                    <Text style={styles.broadcastNext} numberOfLines={1}>
                      Up next: {broadcastCurrent.nextItem.title}
                    </Text>
                  )}
                  <Pressable
                    onPress={showBroadcast ? handleBroadcastPress : handleLivePress}
                    style={[styles.watchBtn, { backgroundColor: liveStatus.isLive ? "#FF0040" : c.primary }]}
                  >
                    <Feather name="play" size={15} color="#FFF" />
                    <Text style={styles.watchBtnText}>
                      {liveStatus.isLive ? "Join Live" : showBroadcast ? "Watch Broadcast" : "Watch Stream"}
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
  liveCard: { marginHorizontal: 16, marginBottom: 8, height: 220 },
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
