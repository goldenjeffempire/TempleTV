import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  Platform,
  Pressable,
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
import { GlassCard } from "@/components/GlassCard";
import { LiveBadge } from "@/components/LiveBadge";
import { SermonCard } from "@/components/SermonCard";
import { NowPlayingBar } from "@/components/NowPlayingBar";
import { usePlayer } from "@/context/PlayerContext";
import { SERMONS } from "@/data/sermons";
import { checkLiveStatus } from "@/services/youtube";
import type { LiveCheckResult } from "@/services/youtube";
import type { Sermon } from "@/types";

export default function WatchScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { currentSermon, isLive } = usePlayer();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.95)).current;
  const [liveStatus, setLiveStatus] = useState<LiveCheckResult>({ isLive: false, videoId: null, title: null });
  const [checkingLive, setCheckingLive] = useState(true);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, damping: 20 }),
    ]).start();

    checkLiveStatus()
      .then((status) => setLiveStatus(status))
      .finally(() => setCheckingLive(false));
  }, []);

  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const recentSermons = SERMONS.slice(0, 5);
  const faithSermons = SERMONS.filter((s) => s.category === "Faith");
  const healingSermons = SERMONS.filter((s) => s.category === "Healing");
  const deliveranceSermons = SERMONS.filter((s) => s.category === "Deliverance");

  const navigateToPlayer = (params: {
    videoId?: string;
    live?: string;
    title?: string;
    preacher?: string;
    duration?: string;
  }) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push({ pathname: "/player", params });
  };

  const handleSermonPress = (sermon: Sermon) => {
    navigateToPlayer({
      videoId: sermon.youtubeId,
      title: sermon.title,
      preacher: sermon.preacher,
      duration: sermon.duration,
    });
  };

  const handleLivePress = () => {
    navigateToPlayer({
      live: "true",
      title: liveStatus.title ?? "Temple TV Live",
      preacher: "JCTM",
    });
  };

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingTop: insets.top + webTopPad, paddingBottom: 140 }}
      >
        <Animated.View style={{ opacity: fadeAnim, transform: [{ scale: scaleAnim }] }}>
          <View style={styles.header}>
            <View>
              <Text style={[styles.logo, { color: c.primary }]}>TEMPLE TV</Text>
              <Text style={[styles.subtitle, { color: c.mutedForeground }]}>JCTM Broadcasting</Text>
            </View>
            <Pressable
              style={[styles.settingsBtn, { backgroundColor: c.muted }]}
              onPress={() => router.push("/(tabs)/settings")}
              hitSlop={12}
            >
              <Feather name="settings" size={20} color={c.mutedForeground} />
            </Pressable>
          </View>

          <Pressable
            onPress={handleLivePress}
            style={({ pressed }) => [{ opacity: pressed ? 0.9 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }]}
          >
            <GlassCard style={styles.liveCard} intensity="high">
              <Image
                source={require("@/assets/images/live-banner.png")}
                style={styles.liveBanner}
                resizeMode="cover"
              />
              <View style={styles.liveOverlay}>
                {checkingLive ? (
                  <ActivityIndicator color="#FFF" size="small" />
                ) : liveStatus.isLive ? (
                  <LiveBadge size="large" />
                ) : (
                  <View style={styles.offlineTag}>
                    <Feather name="clock" size={14} color="rgba(255,255,255,0.7)" />
                    <Text style={styles.offlineTagText}>24/7 Stream</Text>
                  </View>
                )}
                <Text style={styles.liveTitle}>
                  {liveStatus.isLive && liveStatus.title ? liveStatus.title : "Temple TV Live"}
                </Text>
                <Text style={styles.liveSubtitle}>
                  {liveStatus.isLive
                    ? "Streaming now – tap to watch"
                    : "Live worship and preaching 24/7"}
                </Text>
                <View style={[styles.watchBtn, { backgroundColor: liveStatus.isLive ? "#FF0040" : c.primary }]}>
                  <Feather name="play" size={16} color="#FFF" />
                  <Text style={styles.watchBtnText}>
                    {liveStatus.isLive ? "Join Live" : "Watch Stream"}
                  </Text>
                </View>
              </View>
            </GlassCard>
          </Pressable>

          {(currentSermon || isLive) && (
            <NowPlayingBar
              title={isLive ? "Temple TV Live" : currentSermon?.title ?? ""}
              isLive={isLive}
            />
          )}

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: c.foreground }]}>Recent Sermons</Text>
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
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: c.foreground }]}>Faith</Text>
              <Pressable onPress={() => router.push("/(tabs)/library")}>
                <Text style={[styles.seeAll, { color: c.primary }]}>See all</Text>
              </Pressable>
            </View>
            <View style={styles.listContainer}>
              {faithSermons.map((sermon) => (
                <SermonCard key={sermon.id} sermon={sermon} onPress={handleSermonPress} variant="horizontal" />
              ))}
            </View>
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: c.foreground }]}>Healing & Miracles</Text>
              <Pressable onPress={() => router.push("/(tabs)/library")}>
                <Text style={[styles.seeAll, { color: c.primary }]}>See all</Text>
              </Pressable>
            </View>
            <View style={styles.listContainer}>
              {healingSermons.map((sermon) => (
                <SermonCard key={sermon.id} sermon={sermon} onPress={handleSermonPress} variant="horizontal" />
              ))}
            </View>
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: c.foreground }]}>Deliverance</Text>
              <Pressable onPress={() => router.push("/(tabs)/library")}>
                <Text style={[styles.seeAll, { color: c.primary }]}>See all</Text>
              </Pressable>
            </View>
            <View style={styles.listContainer}>
              {deliveranceSermons.map((sermon) => (
                <SermonCard key={sermon.id} sermon={sermon} onPress={handleSermonPress} variant="horizontal" />
              ))}
            </View>
          </View>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  logo: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    letterSpacing: 3,
  },
  subtitle: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    letterSpacing: 1,
    marginTop: 2,
  },
  settingsBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  liveCard: {
    marginHorizontal: 16,
    marginBottom: 8,
    height: 220,
  },
  liveBanner: {
    ...StyleSheet.absoluteFillObject,
    width: "100%",
    height: "100%",
  },
  liveOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
    padding: 20,
    gap: 6,
  },
  offlineTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
  },
  offlineTagText: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  liveTitle: {
    color: "#FFFFFF",
    fontSize: 22,
    fontFamily: "Inter_700Bold",
  },
  liveSubtitle: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  watchBtn: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 24,
    gap: 8,
    marginTop: 8,
  },
  watchBtnText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  section: {
    marginTop: 24,
    gap: 12,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
  },
  seeAll: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  listContainer: {
    paddingHorizontal: 16,
    gap: 10,
  },
});
