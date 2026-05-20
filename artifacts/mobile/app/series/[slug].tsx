import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { Feather } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { SermonCard } from "@/components/SermonCard";
import { getApiBase } from "@/lib/apiBase";
import type { Sermon } from "@/types";
import { usePageSeo } from "@/hooks/usePageSeo";

interface Episode {
  id: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  duration: string;
  youtubeId: string;
  hlsMasterUrl: string | null;
  category: string;
  preacher: string;
  publishedAt: string;
  videoSource: "youtube" | "local" | "upload" | null;
}

interface SeriesDetail {
  id: string;
  title: string;
  slug: string;
  description: string;
  thumbnailUrl: string;
  preacher: string | null;
  category: string;
  isOngoing: boolean;
  episodeCount: number;
  episodes: Episode[];
}

function episodeToSermon(ep: Episode): Sermon {
  return {
    id: ep.id,
    title: ep.title,
    description: ep.description ?? "",
    youtubeId: ep.youtubeId ?? ep.id,
    thumbnailUrl: ep.thumbnailUrl ?? "",
    duration: ep.duration ?? "",
    category: (ep.category as Sermon["category"]) ?? "Faith",
    preacher: ep.preacher ?? "",
    date: ep.publishedAt?.slice(0, 10) ?? "",
    videoSource: (ep.videoSource === "local" ? "local" : "youtube") as "youtube" | "local",
    localVideoUrl: ep.hlsMasterUrl ?? undefined,
  };
}

function navigateToSermon(episode: Episode) {
  router.push({
    pathname: "/player",
    params: {
      id: episode.id,
      title: episode.title,
      youtubeId: episode.videoSource === "youtube" ? episode.youtubeId : "",
      hlsUrl: episode.hlsMasterUrl ?? "",
      thumbnailUrl: episode.thumbnailUrl,
      preacher: episode.preacher,
      duration: episode.duration,
      category: episode.category,
      description: episode.description,
    },
  });
}

export default function SeriesDetailScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const insets = useSafeAreaInsets();
  const c = useColors();

  const [data, setData] = useState<SeriesDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      const apiBase = getApiBase();
      const res = await fetch(`${apiBase}/api/series/${slug}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  // Inject TVSeries structured data for web/PWA contexts.
  // No-op on bare React Native.
  usePageSeo({
    title: data ? `${data.title} — Temple TV` : "Series — Temple TV",
    description: data?.description ?? `Watch ${data?.title ?? "this series"} on Temple TV`,
    path: `/series/${slug ?? ""}`,
    image: data?.thumbnailUrl ?? undefined,
    structuredData: data
      ? {
          "@context": "https://schema.org",
          "@type": "TVSeries",
          name: data.title,
          description: data.description || `Watch ${data.title} on Temple TV`,
          image: data.thumbnailUrl || undefined,
          numberOfEpisodes: data.episodes?.length ?? 0,
          creator: data.preacher ? { "@type": "Person", name: data.preacher } : undefined,
          publisher: {
            "@type": "Organization",
            name: "Temple TV",
            url: "https://templetv.org.ng",
          },
        }
      : undefined,
  });

  const renderItem = useCallback(
    ({ item, index }: { item: Episode; index: number }) => (
      <View style={styles.episodeRow}>
        <View style={[styles.episodeNumber, { backgroundColor: c.primary + "22" }]}>
          <Text style={[styles.episodeNumberText, { color: c.primary }]}>{index + 1}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <SermonCard
            sermon={episodeToSermon(item)}
            onPress={() => navigateToSermon(item)}
            variant="horizontal"
          />
        </View>
      </View>
    ),
    [c],
  );

  const keyExtractor = useCallback((item: Episode) => item.id, []);

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { backgroundColor: c.background }]}>
        <View style={[styles.header, { paddingTop: insets.top + 8, backgroundColor: c.background }]}>
          <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace("/(tabs)/channels")} style={styles.backBtn} hitSlop={8}>
            <Feather name="arrow-left" size={22} color={c.foreground} />
          </Pressable>
        </View>
        <ActivityIndicator size="large" color={c.primary} style={{ marginTop: 40 }} />
        <Text style={[styles.loadingText, { color: c.mutedForeground }]}>Loading series…</Text>
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={[styles.container, styles.center, { backgroundColor: c.background }]}>
        <View style={[styles.header, { paddingTop: insets.top + 8, backgroundColor: c.background }]}>
          <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace("/(tabs)/channels")} style={styles.backBtn} hitSlop={8}>
            <Feather name="arrow-left" size={22} color={c.foreground} />
          </Pressable>
        </View>
        <Feather name="alert-circle" size={48} color={c.mutedForeground} style={{ marginTop: 40 }} />
        <Text style={[styles.errorTitle, { color: c.foreground }]}>Could not load series</Text>
        <Text style={[styles.errorDesc, { color: c.mutedForeground }]}>{error}</Text>
        <Pressable
          onPress={load}
          style={[styles.retryBtn, { backgroundColor: c.primary }]}
        >
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const ListHeader = (
    <View>
      {/* Hero */}
      <View style={[styles.hero, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace("/(tabs)/channels")} style={styles.backBtn} hitSlop={8}>
          <Feather name="arrow-left" size={22} color="#fff" />
        </Pressable>
        {data.thumbnailUrl ? (
          <Image
            source={{ uri: data.thumbnailUrl }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
          />
        ) : null}
        <View style={styles.heroOverlay} />
        <View style={styles.heroContent}>
          <Text style={styles.heroTitle} numberOfLines={2}>{data.title}</Text>
          {data.preacher ? (
            <Text style={styles.heroPreacher}>{data.preacher}</Text>
          ) : null}
          <View style={styles.heroBadges}>
            <View style={[styles.badge, { backgroundColor: c.primary }]}>
              <Text style={styles.badgeText}>{data.category}</Text>
            </View>
            {data.isOngoing && (
              <View style={[styles.badge, { backgroundColor: "rgba(255,255,255,0.2)" }]}>
                <Text style={styles.badgeText}>Ongoing</Text>
              </View>
            )}
            <View style={[styles.badge, { backgroundColor: "rgba(0,0,0,0.4)" }]}>
              <Feather name="play-circle" size={10} color="#fff" />
              <Text style={styles.badgeText}>{data.episodeCount} episodes</Text>
            </View>
          </View>
          {data.description ? (
            <Text style={styles.heroDesc} numberOfLines={3}>{data.description}</Text>
          ) : null}
        </View>
      </View>

      {/* Episodes header */}
      <View style={[styles.episodesHeader, { borderBottomColor: c.border }]}>
        <Text style={[styles.episodesTitle, { color: c.foreground }]}>Episodes</Text>
        <Text style={[styles.episodesCount, { color: c.mutedForeground }]}>
          {data.episodes.length} videos
        </Text>
      </View>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <FlatList
        data={data.episodes}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Feather name="video-off" size={40} color={c.mutedForeground} />
            <Text style={[styles.emptyText, { color: c.mutedForeground }]}>
              No episodes yet
            </Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={load} tintColor={c.primary} />
        }
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={Platform.OS === "android"}
        maxToRenderPerBatch={10}
        windowSize={10}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { alignItems: "center" },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.3)",
    zIndex: 10,
  },
  hero: {
    height: 280,
    position: "relative",
    justifyContent: "flex-end",
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  heroOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  heroContent: {
    gap: 6,
    zIndex: 1,
  },
  heroTitle: {
    fontSize: 24,
    fontWeight: "800",
    color: "#fff",
    letterSpacing: -0.5,
  },
  heroPreacher: {
    fontSize: 14,
    color: "rgba(255,255,255,0.75)",
    fontWeight: "500",
  },
  heroBadges: {
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
    marginTop: 2,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#fff",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  heroDesc: {
    fontSize: 13,
    color: "rgba(255,255,255,0.7)",
    lineHeight: 18,
    marginTop: 4,
  },
  episodesHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  episodesTitle: {
    fontSize: 17,
    fontWeight: "700",
  },
  episodesCount: {
    fontSize: 13,
  },
  episodeRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 12,
    paddingRight: 16,
    paddingVertical: 4,
  },
  episodeNumber: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
    flexShrink: 0,
  },
  episodeNumberText: {
    fontSize: 13,
    fontWeight: "700",
  },
  empty: {
    alignItems: "center",
    paddingVertical: 60,
    gap: 12,
  },
  emptyText: { fontSize: 15 },
  loadingText: { fontSize: 14, marginTop: 12 },
  errorTitle: { fontSize: 18, fontWeight: "600", marginTop: 12 },
  errorDesc: { fontSize: 13, marginTop: 4, textAlign: "center", paddingHorizontal: 32 },
  retryBtn: {
    marginTop: 20,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  retryText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
