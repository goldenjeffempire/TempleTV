import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Platform,
  Pressable,
  ScrollView,
  Share,
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
import { useFavorites } from "@/hooks/useFavorites";
import { useWatchHistory } from "@/hooks/useWatchHistory";
import { YoutubePlayer } from "@/components/YoutubePlayer";
import { SermonCard } from "@/components/SermonCard";
import { LiveBadge } from "@/components/LiveBadge";
import { GlassCard } from "@/components/GlassCard";
import { usePlayer } from "@/context/PlayerContext";
import { SERMONS } from "@/data/sermons";
import { useYouTubeChannel } from "@/hooks/useYouTubeChannel";
import type { Sermon } from "@/types";

export default function PlayerScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    videoId?: string;
    live?: string;
    title?: string;
    preacher?: string;
    duration?: string;
    thumbnail?: string;
    category?: string;
  }>();
  const { videoId, live, title: paramTitle, preacher: paramPreacher, duration: paramDuration, thumbnail, category: paramCategory } = params;
  const { playSermon, playNext } = usePlayer();
  const { isFavorite, toggleFavorite } = useFavorites();
  const { addToHistory } = useWatchHistory();
  const { sermons } = useYouTubeChannel();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [autoPlayNext, setAutoPlayNext] = useState(false);

  const isLive = live === "true";
  const localSermon = SERMONS.find((s) => s.youtubeId === videoId);
  const rssSermon = sermons.find((s) => s.youtubeId === videoId);
  const currentSermon = localSermon ?? rssSermon ?? null;

  const displayTitle = paramTitle ?? currentSermon?.title ?? "Temple TV";
  const displayPreacher = paramPreacher ?? currentSermon?.preacher ?? "JCTM";
  const displayDuration = paramDuration ?? currentSermon?.duration ?? "";
  const displayCategory = paramCategory ?? currentSermon?.category ?? "";
  const thumbnailUrl = thumbnail ?? currentSermon?.thumbnailUrl ?? (videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : undefined);

  const allSermons = sermons.length > 0 ? sermons : SERMONS;
  const relatedSermons = allSermons
    .filter((s) => s.youtubeId !== videoId && (currentSermon ? s.category === currentSermon.category : true))
    .slice(0, 6);
  const upNextSermon = relatedSermons[0];

  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const favorited = videoId ? isFavorite(videoId) : false;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    if (currentSermon) {
      addToHistory(currentSermon);
    } else if (videoId && displayTitle) {
      addToHistory({
        id: `player_${videoId}`,
        title: displayTitle,
        description: "",
        youtubeId: videoId,
        thumbnailUrl: thumbnailUrl ?? "",
        duration: displayDuration,
        category: (displayCategory as Sermon["category"]) || "Faith",
        preacher: displayPreacher,
        date: new Date().toISOString().slice(0, 10),
      });
    }
  }, []);

  const handleVideoEnd = useCallback(() => {
    if (upNextSermon) {
      router.replace({
        pathname: "/player",
        params: {
          videoId: upNextSermon.youtubeId,
          title: upNextSermon.title,
          preacher: upNextSermon.preacher,
          duration: upNextSermon.duration,
          thumbnail: upNextSermon.thumbnailUrl,
          category: upNextSermon.category,
        },
      });
    } else {
      playNext();
    }
  }, [upNextSermon, playNext]);

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
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
      });
    }
  };

  const handleShare = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const url = isLive
      ? "https://www.youtube.com/@templetvjctm/live"
      : `https://youtu.be/${videoId}`;
    if (Platform.OS === "web") {
      if (navigator.share) {
        await navigator.share({ title: displayTitle, url });
      } else {
        await navigator.clipboard?.writeText(url);
      }
    } else {
      await Share.share({ message: `Watch "${displayTitle}" on Temple TV JCTM: ${url}` });
    }
  };

  const handleToggleFavorite = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const sermon = currentSermon ?? {
      id: `player_${videoId}`,
      title: displayTitle,
      description: "",
      youtubeId: videoId ?? "",
      thumbnailUrl: thumbnailUrl ?? "",
      duration: displayDuration,
      category: (displayCategory as Sermon["category"]) || "Faith",
      preacher: displayPreacher,
      date: "",
    };
    toggleFavorite(sermon);
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
        category: sermon.category,
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
          autoPlay
          onEnd={handleVideoEnd}
        />
        <LinearGradient
          colors={["rgba(0,0,0,0.7)", "transparent"]}
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
            <View style={{ flex: 1 }} />
            {isLive && <LiveBadge size="medium" />}
          </View>
        </LinearGradient>
      </View>

      <Animated.View style={{ opacity: fadeAnim, flex: 1 }}>
        <ScrollView
          contentContainerStyle={[
            styles.info,
            { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 40 },
          ]}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.titleSection}>
            <View style={styles.topMeta}>
              {!!displayCategory && (
                <View style={[styles.categoryBadge, { backgroundColor: c.secondary }]}>
                  <Text style={[styles.categoryText, { color: c.accent }]}>{displayCategory}</Text>
                </View>
              )}
              {isLive && <LiveBadge size="small" />}
              <View style={{ flex: 1 }} />
              <Pressable onPress={handleToggleFavorite} hitSlop={12}>
                <Feather
                  name="heart"
                  size={22}
                  color={favorited ? "#FF0040" : c.mutedForeground}
                />
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

            {currentSermon?.description ? (
              <Text style={[styles.desc, { color: c.mutedForeground }]}>
                {currentSermon.description}
              </Text>
            ) : null}
          </View>

          <View style={styles.actionRow}>
            <Pressable
              onPress={openOnYouTube}
              style={({ pressed }) => [styles.primaryBtn, { backgroundColor: "#FF0000", opacity: pressed ? 0.85 : 1 }]}
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
              onPress={handleShare}
              hitSlop={8}
            >
              <Feather name="share-2" size={20} color={c.foreground} />
            </Pressable>
          </View>

          {upNextSermon && (
            <GlassCard style={styles.autoPlayBanner}>
              <View style={styles.autoPlayLeft}>
                <Feather name="skip-forward" size={16} color={c.primary} />
                <View>
                  <Text style={[styles.autoPlayLabel, { color: c.mutedForeground }]}>Up Next</Text>
                  <Text style={[styles.autoPlayTitle, { color: c.foreground }]} numberOfLines={1}>
                    {upNextSermon.title}
                  </Text>
                </View>
              </View>
              <Pressable
                onPress={() => navigateToRelated(upNextSermon)}
                style={[styles.autoPlayBtn, { backgroundColor: c.primary }]}
              >
                <Text style={styles.autoPlayBtnText}>Play</Text>
              </Pressable>
            </GlassCard>
          )}

          {relatedSermons.length > 0 && (
            <View style={styles.relatedSection}>
              <Text style={[styles.relatedTitle, { color: c.foreground }]}>Related Sermons</Text>
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
  container: { flex: 1 },
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
    height: 110,
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
  info: { padding: 16, gap: 16 },
  titleSection: { gap: 8 },
  topMeta: { flexDirection: "row", alignItems: "center", gap: 8 },
  categoryBadge: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 },
  categoryText: { fontSize: 12, fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
  title: { fontSize: 22, fontFamily: "Inter_700Bold", lineHeight: 28 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap" },
  meta: { fontSize: 14, fontFamily: "Inter_400Regular" },
  desc: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 22, marginTop: 4 },
  actionRow: { flexDirection: "row", gap: 10, alignItems: "center" },
  primaryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 13,
    borderRadius: 24,
  },
  primaryBtnText: { color: "#FFFFFF", fontSize: 15, fontFamily: "Inter_700Bold" },
  iconBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  autoPlayBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 14,
    gap: 12,
  },
  autoPlayLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  autoPlayLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5, marginBottom: 2 },
  autoPlayTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  autoPlayBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  autoPlayBtnText: { color: "#FFF", fontSize: 13, fontFamily: "Inter_700Bold" },
  relatedSection: { gap: 10, marginTop: 4 },
  relatedTitle: { fontSize: 18, fontFamily: "Inter_700Bold", marginBottom: 2 },
});
