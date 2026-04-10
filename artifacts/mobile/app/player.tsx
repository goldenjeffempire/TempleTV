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

  const {
    videoId: paramVideoId,
    live,
    title: paramTitle,
    preacher: paramPreacher,
    duration: paramDuration,
    thumbnail: paramThumbnail,
    category: paramCategory,
  } = params;

  const {
    currentSermon: ctxSermon,
    nextSermon,
    playSermon,
    playNext,
    playPrevious,
    advanceToNext,
    shuffleMode,
    loopMode,
    toggleShuffle,
    cycleLoopMode,
  } = usePlayer();

  const { isFavorite, toggleFavorite } = useFavorites();
  const { addToHistory } = useWatchHistory();
  const { sermons: rssSermons } = useYouTubeChannel();

  const isLive = live === "true";
  const scrollRef = useRef<ScrollView>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const titleFade = useRef(new Animated.Value(1)).current;
  const initializedRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
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
    if (!paramVideoId) return null;
    return {
      id: `player_${paramVideoId}`,
      title: paramTitle ?? "Temple TV",
      description: "",
      youtubeId: paramVideoId,
      thumbnailUrl:
        paramThumbnail ??
        `https://img.youtube.com/vi/${paramVideoId}/hqdefault.jpg`,
      duration: paramDuration ?? "",
      category: (paramCategory as Sermon["category"]) || "Faith",
      preacher: paramPreacher ?? "JCTM",
      date: new Date().toISOString().slice(0, 10),
    };
  }, [paramVideoId, paramTitle, paramPreacher, paramDuration, paramThumbnail, paramCategory]);

  const [activeSermon, setActiveSermon] = useState<Sermon | null>(() => {
    if (isLive) return null;
    return resolveSermon(paramVideoId) ?? makeParamSermon();
  });

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, []);

  useEffect(() => {
    if (isLive || initializedRef.current) return;
    initializedRef.current = true;

    const sermon = resolveSermon(paramVideoId) ?? makeParamSermon();
    if (sermon) {
      playSermon(sermon, allSermons);
      setActiveSermon(sermon);
      addToHistory(sermon);
    }
  }, []);

  useEffect(() => {
    if (!ctxSermon || isLive) return;
    if (ctxSermon.youtubeId === activeSermon?.youtubeId) return;

    Animated.timing(titleFade, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => {
      if (!isMountedRef.current) return;
      setActiveSermon(ctxSermon);
      addToHistory(ctxSermon);
      scrollRef.current?.scrollTo({ y: 0, animated: true });
      Animated.timing(titleFade, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    });
  }, [ctxSermon?.youtubeId]);

  const handleVideoEnd = useCallback(() => {
    advanceToNext();
  }, [advanceToNext]);

  const handlePlayNext = useCallback(() => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    playNext();
  }, [playNext]);

  const handlePlayPrevious = useCallback(() => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    playPrevious();
  }, [playPrevious]);

  const navigateToRelated = useCallback((sermon: Sermon) => {
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
  }, []);

  const openOnYouTube = async () => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    const url = isLive
      ? "https://www.youtube.com/@templetvjctm/live"
      : `https://www.youtube.com/watch?v=${activeSermon?.youtubeId ?? paramVideoId}`;
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
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    const vid = activeSermon?.youtubeId ?? paramVideoId;
    const url = isLive ? "https://www.youtube.com/@templetvjctm/live" : `https://youtu.be/${vid}`;
    const title = activeSermon?.title ?? paramTitle ?? "Temple TV";
    if (Platform.OS === "web") {
      if (navigator.share) {
        await navigator.share({ title, url });
      } else {
        await navigator.clipboard?.writeText(url);
      }
    } else {
      await Share.share({ message: `Watch "${title}" on Temple TV JCTM: ${url}` });
    }
  };

  const handleToggleFavorite = () => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    const sermon =
      activeSermon ??
      makeParamSermon() ?? {
        id: `player_${paramVideoId}`,
        title: paramTitle ?? "Temple TV",
        description: "",
        youtubeId: paramVideoId ?? "",
        thumbnailUrl:
          paramThumbnail ??
          `https://img.youtube.com/vi/${paramVideoId}/hqdefault.jpg`,
        duration: paramDuration ?? "",
        category: (paramCategory as Sermon["category"]) || "Faith",
        preacher: paramPreacher ?? "JCTM",
        date: "",
      };
    toggleFavorite(sermon);
  };

  const displayVideoId = isLive ? undefined : (activeSermon?.youtubeId ?? paramVideoId);
  const displayTitle = activeSermon?.title ?? paramTitle ?? "Temple TV";
  const displayPreacher = activeSermon?.preacher ?? paramPreacher ?? "JCTM";
  const displayDuration = activeSermon?.duration ?? paramDuration ?? "";
  const displayCategory = activeSermon?.category ?? paramCategory ?? "";
  const thumbnailUrl =
    activeSermon?.thumbnailUrl ??
    paramThumbnail ??
    (displayVideoId ? `https://img.youtube.com/vi/${displayVideoId}/hqdefault.jpg` : undefined);

  const favorited = displayVideoId ? isFavorite(displayVideoId) : false;

  const relatedSermons = allSermons
    .filter(
      (s) =>
        s.youtubeId !== displayVideoId &&
        (activeSermon ? s.category === activeSermon.category : true),
    )
    .slice(0, 6);

  const webTopPad = Platform.OS === "web" ? 67 : 0;

  const loopIcon =
    loopMode === "one" ? "repeat" : loopMode === "all" ? "repeat" : "minus-circle";
  const loopColor =
    loopMode === "none" ? c.mutedForeground : c.primary;

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      {Platform.OS !== "web" && <StatusBar barStyle="light-content" backgroundColor="#000" />}

      <View style={styles.playerContainer}>
        <YoutubePlayer
          videoId={displayVideoId}
          isLive={isLive}
          thumbnailUrl={thumbnailUrl}
          autoPlay
          onEnd={handleVideoEnd}
        />
        <LinearGradient
          colors={["rgba(0,0,0,0.7)", "transparent"]}
          style={[
            styles.topGradient,
            { paddingTop: insets.top + webTopPad + 12, pointerEvents: "box-none" },
          ]}
        >
          <View style={styles.topControls}>
            <Pressable
              onPress={() => {
                if (Platform.OS !== "web") {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
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
          ref={scrollRef}
          contentContainerStyle={[
            styles.info,
            { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) + 40 },
          ]}
          showsVerticalScrollIndicator={false}
        >
          <Animated.View style={[styles.titleSection, { opacity: titleFade }]}>
            <View style={styles.topMeta}>
              {!!displayCategory && (
                <View style={[styles.categoryBadge, { backgroundColor: c.secondary }]}>
                  <Text style={[styles.categoryText, { color: c.accent }]}>
                    {displayCategory}
                  </Text>
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

            {activeSermon?.description ? (
              <Text style={[styles.desc, { color: c.mutedForeground }]}>
                {activeSermon.description}
              </Text>
            ) : null}
          </Animated.View>

          <View style={styles.actionRow}>
            <Pressable
              onPress={openOnYouTube}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: "#FF0000", opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Feather name="youtube" size={18} color="#FFF" />
              <Text style={styles.primaryBtnText}>Watch on YouTube</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.iconBtn,
                { backgroundColor: c.muted, opacity: pressed ? 0.7 : 1 },
              ]}
              onPress={handleShare}
              hitSlop={8}
            >
              <Feather name="share-2" size={20} color={c.foreground} />
            </Pressable>
          </View>

          {!isLive && (
            <GlassCard style={styles.controlsCard}>
              <Pressable
                onPress={() => {
                  if (Platform.OS !== "web") {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                  toggleShuffle();
                }}
                style={styles.controlBtn}
                hitSlop={8}
              >
                <Feather
                  name="shuffle"
                  size={20}
                  color={shuffleMode ? c.primary : c.mutedForeground}
                />
                <Text
                  style={[
                    styles.controlLabel,
                    { color: shuffleMode ? c.primary : c.mutedForeground },
                  ]}
                >
                  Shuffle
                </Text>
              </Pressable>

              <Pressable onPress={handlePlayPrevious} style={styles.controlBtn} hitSlop={8}>
                <Feather name="skip-back" size={24} color={c.foreground} />
              </Pressable>

              <Pressable onPress={handlePlayNext} style={styles.controlBtn} hitSlop={8}>
                <Feather name="skip-forward" size={24} color={c.foreground} />
              </Pressable>

              <Pressable
                onPress={() => {
                  if (Platform.OS !== "web") {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                  cycleLoopMode();
                }}
                style={styles.controlBtn}
                hitSlop={8}
              >
                <Feather name={loopIcon} size={20} color={loopColor} />
                <Text style={[styles.controlLabel, { color: loopColor }]}>
                  {loopMode === "one" ? "Loop 1" : loopMode === "all" ? "Loop All" : "No Loop"}
                </Text>
              </Pressable>
            </GlassCard>
          )}

          {nextSermon && !isLive && (
            <GlassCard style={styles.autoPlayBanner}>
              <View style={styles.autoPlayLeft}>
                <Feather name="skip-forward" size={16} color={c.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.autoPlayLabel, { color: c.mutedForeground }]}>Up Next</Text>
                  <Text
                    style={[styles.autoPlayTitle, { color: c.foreground }]}
                    numberOfLines={1}
                  >
                    {nextSermon.title}
                  </Text>
                </View>
              </View>
              <Pressable
                onPress={handlePlayNext}
                style={[styles.autoPlayBtn, { backgroundColor: c.primary }]}
              >
                <Text style={styles.autoPlayBtnText}>Play</Text>
              </Pressable>
            </GlassCard>
          )}

          {!nextSermon && !isLive && loopMode === "none" && (
            <GlassCard style={styles.autoPlayBanner}>
              <View style={styles.autoPlayLeft}>
                <Feather name="check-circle" size={16} color={c.mutedForeground} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.autoPlayLabel, { color: c.mutedForeground }]}>Queue</Text>
                  <Text style={[styles.autoPlayTitle, { color: c.mutedForeground }]}>
                    End of playlist
                  </Text>
                </View>
              </View>
              <Pressable
                onPress={() => cycleLoopMode()}
                style={[styles.autoPlayBtn, { backgroundColor: c.secondary }]}
              >
                <Text style={[styles.autoPlayBtnText, { color: c.primary }]}>Loop</Text>
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
  controlsCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingVertical: 14,
    paddingHorizontal: 8,
  },
  controlBtn: {
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
  },
  controlLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.3,
  },
  autoPlayBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 14,
    gap: 12,
  },
  autoPlayLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  autoPlayLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  autoPlayTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  autoPlayBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  autoPlayBtnText: { color: "#FFF", fontSize: 13, fontFamily: "Inter_700Bold" },
  relatedSection: { gap: 10, marginTop: 4 },
  relatedTitle: { fontSize: 18, fontFamily: "Inter_700Bold", marginBottom: 2 },
});
