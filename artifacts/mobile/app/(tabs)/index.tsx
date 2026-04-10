import React, { useRef, useEffect } from "react";
import {
  Animated,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  FlatList,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { GlassCard } from "@/components/GlassCard";
import { LiveBadge } from "@/components/LiveBadge";
import { SermonCard } from "@/components/SermonCard";
import { NowPlayingBar } from "@/components/NowPlayingBar";
import { usePlayer } from "@/context/PlayerContext";
import { SERMONS } from "@/data/sermons";
import colors from "@/constants/colors";

export default function WatchScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { playSermon, playLive, currentSermon, isLive, isPlaying } = usePlayer();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.95)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, damping: 20 }),
    ]).start();
  }, []);

  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const recentSermons = SERMONS.slice(0, 4);
  const faithSermons = SERMONS.filter((s) => s.category === "Faith");
  const healingSermons = SERMONS.filter((s) => s.category === "Healing");

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
              hitSlop={12}
            >
              <Feather name="settings" size={20} color={c.mutedForeground} />
            </Pressable>
          </View>

          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              playLive();
            }}
            style={({ pressed }) => [{ opacity: pressed ? 0.9 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }]}
          >
            <GlassCard style={styles.liveCard} intensity="high">
              <Image
                source={require("@/assets/images/live-banner.png")}
                style={styles.liveBanner}
                resizeMode="cover"
              />
              <View style={styles.liveOverlay}>
                <LiveBadge size="large" />
                <Text style={styles.liveTitle}>Temple TV Live</Text>
                <Text style={styles.liveSubtitle}>Tap to watch the live broadcast</Text>
                <View style={styles.watchBtn}>
                  <Feather name="play" size={18} color="#FFF" />
                  <Text style={styles.watchBtnText}>Watch Now</Text>
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
                <SermonCard sermon={item} onPress={playSermon} variant="vertical" />
              )}
            />
          </View>

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: c.foreground }]}>Faith Messages</Text>
            <View style={styles.listContainer}>
              {faithSermons.map((sermon) => (
                <SermonCard key={sermon.id} sermon={sermon} onPress={playSermon} variant="horizontal" />
              ))}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: c.foreground }]}>Healing & Miracles</Text>
            <View style={styles.listContainer}>
              {healingSermons.map((sermon) => (
                <SermonCard key={sermon.id} sermon={sermon} onPress={playSermon} variant="horizontal" />
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
  liveTitle: {
    color: "#FFFFFF",
    fontSize: 24,
    fontFamily: "Inter_700Bold",
  },
  liveSubtitle: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  watchBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#6A0DAD",
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
  sectionTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    paddingHorizontal: 16,
  },
  listContainer: {
    paddingHorizontal: 16,
    gap: 10,
  },
});
