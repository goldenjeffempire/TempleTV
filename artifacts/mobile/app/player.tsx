import React, { useEffect, useRef } from "react";
import {
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { useColors } from "@/hooks/useColors";
import { YoutubePlayer } from "@/components/YoutubePlayer";
import { SermonCard } from "@/components/SermonCard";
import { LiveBadge } from "@/components/LiveBadge";
import { GlassCard } from "@/components/GlassCard";
import { usePlayer } from "@/context/PlayerContext";
import { SERMONS } from "@/data/sermons";
import type { Sermon } from "@/types";

export default function PlayerScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { videoId, live, title: paramTitle, preacher: paramPreacher, duration: paramDuration, thumbnail } =
    useLocalSearchParams<{
      videoId?: string;
      live?: string;
      title?: string;
      preacher?: string;
      duration?: string;
      thumbnail?: string;
    }>();
  const { playSermon } = usePlayer();

  const isLive = live === "true";
  const currentSermon = SERMONS.find((s) => s.youtubeId === videoId) ?? null;
  const displayTitle = paramTitle ?? currentSermon?.title ?? "Temple TV";
  const displayPreacher = paramPreacher ?? currentSermon?.preacher ?? "JCTM";
  const displayDuration = paramDuration ?? currentSermon?.duration ?? "";
  const thumbnailUrl = thumbnail ?? currentSermon?.thumbnailUrl ?? (videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : undefined);

  const relatedSermons = SERMONS.filter(
    (s) => s.youtubeId !== videoId && (currentSermon ? s.category === currentSermon.category : true),
  ).slice(0, 4);

  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, []);

  const openOnYouTube = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const url = isLive
      ? "https://www.youtube.com/@templetvjctm/live"
      : `https://www.youtube.com/watch?v=${videoId}`;
    if (Platform.OS === "web") {
      window.open(url, "_blank");
    } else {
      await WebBrowser.openBrowserAsync(url, {
        toolbarColor: "#000000",
        controlsColor: "#6A0DAD",
      });
    }
  };

  const navigateToRelated = (sermon: Sermon) => {
    router.replace({
      pathname: "/player",
      params: {
        videoId: sermon.youtubeId,
        title: sermon.title,
        preacher: sermon.preacher,
        duration: sermon.duration,
        thumbnail: sermon.thumbnailUrl,
      },
    });
  };

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      {Platform.OS !== "web" && <StatusBar barStyle="light-content" backgroundColor="#000" />}

      <View style={styles.playerContainer}>
        <YoutubePlayer
          videoId={isLive ? undefined : videoId}
          isLive={isLive}
          thumbnailUrl={thumbnailUrl}
        />
        <LinearGradient
          colors={["rgba(0,0,0,0.6)", "transparent"]}
          style={[styles.topGradient, { paddingTop: insets.top + webTopPad + 12 }]}
          pointerEvents="box-none"
        >
          <View style={styles.topControls}>
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.back();
              }}
              style={styles.backBtn}
              hitSlop={12}
            >
              <Feather name="chevron-down" size={26} color="#FFF" />
            </Pressable>
            {isLive && <LiveBadge size="medium" />}
          </View>
        </LinearGradient>
      </View>

      <Animated.View style={{ opacity: fadeAnim, flex: 1 }}>
        <ScrollView
          contentContainerStyle={[
            styles.info,
            { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 32 },
          ]}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.titleSection}>
            <View style={styles.categoryRow}>
              {currentSermon?.category && (
                <View style={[styles.categoryBadge, { backgroundColor: c.secondary }]}>
                  <Text style={[styles.categoryText, { color: c.accent }]}>
                    {currentSermon.category}
                  </Text>
                </View>
              )}
              {isLive && <LiveBadge size="small" />}
            </View>
            <Text style={[styles.title, { color: c.foreground }]}>{displayTitle}</Text>
            <View style={styles.metaRow}>
              <Feather name="user" size={14} color={c.mutedForeground} />
              <Text style={[styles.meta, { color: c.mutedForeground }]}>{displayPreacher}</Text>
              {!!displayDuration && (
                <>
                  <Text style={{ color: c.border }}> · </Text>
                  <Feather name="clock" size={14} color={c.mutedForeground} />
                  <Text style={[styles.meta, { color: c.mutedForeground }]}>{displayDuration}</Text>
                </>
              )}
            </View>
            {currentSermon?.description ? (
              <Text style={[styles.desc, { color: c.mutedForeground }]}>
                {currentSermon.description}
              </Text>
            ) : null}
          </View>

          <View style={styles.actionRow}>
            <Pressable
              onPress={openOnYouTube}
              style={({ pressed }) => [styles.primaryBtn, { backgroundColor: "#FF0000", opacity: pressed ? 0.8 : 1 }]}
            >
              <Feather name="youtube" size={18} color="#FFF" />
              <Text style={styles.primaryBtnText}>Watch on YouTube</Text>
            </Pressable>

            {!isLive && currentSermon && (
              <Pressable
                style={({ pressed }) => [styles.iconBtn, { backgroundColor: c.muted, opacity: pressed ? 0.7 : 1 }]}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  playSermon(currentSermon);
                }}
                hitSlop={8}
              >
                <Feather name="radio" size={20} color={c.primary} />
              </Pressable>
            )}

            <Pressable
              style={({ pressed }) => [styles.iconBtn, { backgroundColor: c.muted, opacity: pressed ? 0.7 : 1 }]}
              hitSlop={8}
            >
              <Feather name="share-2" size={20} color={c.foreground} />
            </Pressable>
          </View>

          {relatedSermons.length > 0 && (
            <View style={styles.relatedSection}>
              <Text style={[styles.relatedTitle, { color: c.foreground }]}>Up Next</Text>
              {relatedSermons.map((sermon) => (
                <SermonCard
                  key={sermon.id}
                  sermon={sermon}
                  variant="horizontal"
                  onPress={navigateToRelated}
                />
              ))}
            </View>
          )}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  playerContainer: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: "#000",
    maxHeight: 260,
    position: "relative",
  },
  topGradient: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 100,
  },
  topControls: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 12,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  info: {
    padding: 16,
    gap: 16,
  },
  titleSection: {
    gap: 8,
  },
  categoryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  categoryBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  categoryText: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  title: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    lineHeight: 28,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  meta: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  desc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
    marginTop: 4,
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },
  primaryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 24,
  },
  primaryBtnText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontFamily: "Inter_700Bold",
  },
  iconBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
  },
  relatedSection: {
    gap: 10,
    marginTop: 4,
  },
  relatedTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    marginBottom: 2,
  },
});
