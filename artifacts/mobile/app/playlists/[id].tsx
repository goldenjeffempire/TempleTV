import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

/**
 * Playlist Detail Screen — Temple TV Mobile
 *
 * Shows the title, description, and ordered episode list for a playlist.
 * Tapping an episode navigates to the player.
 */

import React, { useCallback } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { Feather } from "@expo/vector-icons";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { usePlaylistDetail, type PlaylistVideo } from "@/hooks/usePlaylists";
import { VideoLiveStatusBadge } from "@/components/LiveBadge";
import { AppHeader } from "@/components/AppHeader";

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

function formatDuration(raw: string | null | undefined): string {
  if (!raw) return "";
  const iso = raw.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (iso) {
    const h = parseInt(iso[1] ?? "0");
    const m = parseInt(iso[2] ?? "0");
    const s = parseInt(iso[3] ?? "0");
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  const secs = parseInt(raw);
  if (!isNaN(secs) && secs > 0) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  return raw;
}

function EpisodeCard({
  episode,
  index,
  onPress,
}: {
  episode: PlaylistVideo;
  index: number;
  onPress: () => void;
}) {
  const c = useColors();
  const duration = formatDuration(episode.duration);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.episodeCard,
        { backgroundColor: pressed ? c.card : "transparent", borderBottomColor: c.border },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Play episode ${index + 1}: ${episode.title}`}
    >
      {/* Index */}
      <View style={[styles.indexBadge, { backgroundColor: c.primary + "22" }]}>
        <Text style={[styles.indexText, { color: c.primary }]}>{index + 1}</Text>
      </View>

      {/* Thumbnail */}
      <View style={[styles.epThumbWrap, { backgroundColor: c.card }]}>
        <Image
          source={episode.thumbnailUrl ? { uri: episode.thumbnailUrl } : PLACEHOLDER}
          style={styles.epThumb}
          contentFit="cover"
        />
        <View style={styles.playOverlay}>
          <Feather name="play" size={14} color="#fff" />
        </View>
        {!!episode.youtubeLiveStatus && (
          <View style={{ position: "absolute", top: 4, left: 4 }}>
            <VideoLiveStatusBadge status={episode.youtubeLiveStatus} size="small" />
          </View>
        )}
      </View>

      {/* Info */}
      <View style={styles.epInfo}>
        <Text style={[styles.epTitle, { color: c.foreground }]} numberOfLines={2}>
          {episode.title}
        </Text>
        <View style={styles.epMeta}>
          {!!episode.preacher && (
            <Text style={[styles.epMetaText, { color: c.mutedForeground }]} numberOfLines={1}>
              {episode.preacher}
            </Text>
          )}
          {!!duration && (
            <>
              {!!episode.preacher && (
                <Text style={[styles.epMetaSep, { color: c.mutedForeground }]}>·</Text>
              )}
              <Feather name="clock" size={11} color={c.mutedForeground} />
              <Text style={[styles.epMetaText, { color: c.mutedForeground }]}>{duration}</Text>
            </>
          )}
        </View>
      </View>
    </Pressable>
  );
}

export default function PlaylistDetailScreen() {
  const insets = useSafeAreaInsets();
  const c = useColors();
  const { id, title: titleParam } = useLocalSearchParams<{ id: string; title?: string }>();

  const { playlist, loading, error, refetch } = usePlaylistDetail(id ?? null);

  const navigateToEpisode = useCallback((ep: PlaylistVideo) => {
    const isLocal = ep.videoSource === "local" || ep.videoSource === "upload";
    router.push({
      pathname: "/player",
      params: {
        id: ep.id,
        title: ep.title,
        youtubeId: !isLocal ? (ep.youtubeId ?? "") : "",
        hlsUrl: ep.hlsMasterUrl ?? "",
        localVideoUrl: ep.localVideoUrl ?? "",
        thumbnailUrl: ep.thumbnailUrl ?? "",
        preacher: ep.preacher ?? "",
        duration: formatDuration(ep.duration),
        category: ep.category ?? "",
        description: ep.description ?? "",
      },
    });
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: PlaylistVideo; index: number }) => (
      <EpisodeCard episode={item} index={index} onPress={() => navigateToEpisode(item)} />
    ),
    [navigateToEpisode],
  );

  const headerTitle = playlist?.title ?? titleParam ?? "Playlist";

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ headerShown: false, header: () => null, title: "" }} />
      <StatusBar barStyle={c.isMidnightTheme ? "light-content" : "dark-content"} />
      <AppHeader title={headerTitle} />

      {loading && !playlist ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={c.primary} />
          <Text style={[styles.loadingText, { color: c.mutedForeground }]}>Loading playlist…</Text>
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Feather name="alert-circle" size={40} color={c.mutedForeground} />
          <Text style={[styles.errorTitle, { color: c.foreground }]}>Failed to load</Text>
          <Text style={[styles.errorDesc, { color: c.mutedForeground }]}>{error}</Text>
          <Pressable onPress={() => refetch()} style={[styles.retryBtn, { backgroundColor: c.primary }]}>
            <Text style={styles.retryText}>Try Again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={playlist?.videos ?? []}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ListHeaderComponent={
            playlist ? (
              <View style={[styles.playlistMeta, { borderBottomColor: c.border }]}>
                {playlist.thumbnailUrl ? (
                  <Image
                    source={{ uri: playlist.thumbnailUrl }}
                    style={styles.playlistThumb}
                    contentFit="cover"
                  />
                ) : null}
                <Text style={[styles.playlistTitle, { color: c.foreground }]}>
                  {playlist.title}
                </Text>
                {!!playlist.description && (
                  <Text style={[styles.playlistDesc, { color: c.mutedForeground }]}>
                    {playlist.description}
                  </Text>
                )}
                <View style={styles.playlistStats}>
                  {!!playlist.category && (
                    <View style={[styles.catPill, { backgroundColor: c.primary + "22" }]}>
                      <Text style={[styles.catPillText, { color: c.primary }]}>{playlist.category}</Text>
                    </View>
                  )}
                  <Text style={[styles.episodeCount, { color: c.mutedForeground }]}>
                    {playlist.videoCount} {playlist.videoCount === 1 ? "episode" : "episodes"}
                  </Text>
                </View>
              </View>
            ) : null
          }
          ListEmptyComponent={
            !loading ? (
              <View style={styles.emptyWrap}>
                <Feather name="list" size={40} color={c.mutedForeground} />
                <Text style={[styles.emptyTitle, { color: c.foreground }]}>No Episodes Yet</Text>
                <Text style={[styles.emptyDesc, { color: c.mutedForeground }]}>
                  This playlist has no videos yet.
                </Text>
              </View>
            ) : null
          }
          contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={() => refetch()} tintColor={c.primary} />
          }
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: -0.3,
  },

  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
  },
  loadingText: { fontSize: 14 },
  errorTitle: { fontSize: 18, fontWeight: "700" },
  errorDesc: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  retryBtn: { paddingHorizontal: 28, paddingVertical: 12, borderRadius: 20, marginTop: 8 },
  retryText: { color: "#fff", fontSize: 14, fontWeight: "700" },

  playlistMeta: {
    padding: 16,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
  },
  playlistThumb: {
    width: "100%",
    height: 180,
    borderRadius: 12,
    backgroundColor: "#1a1a2e",
  },
  playlistTitle: { fontSize: 22, fontWeight: "800", letterSpacing: -0.4 },
  playlistDesc: { fontSize: 14, lineHeight: 20 },
  playlistStats: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  catPill: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14 },
  catPillText: { fontSize: 12, fontWeight: "700" },
  episodeCount: { fontSize: 13, fontWeight: "500" },

  episodeCard: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  indexBadge: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  indexText: { fontSize: 13, fontWeight: "700" },

  epThumbWrap: {
    width: 80,
    height: 52,
    borderRadius: 8,
    overflow: "hidden",
    flexShrink: 0,
    position: "relative",
  },
  epThumb: { width: "100%", height: "100%" },
  playOverlay: {
    position: "absolute",
    bottom: 6,
    right: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },

  epInfo: { flex: 1, gap: 4 },
  epTitle: { fontSize: 13, fontWeight: "600", lineHeight: 17 },
  epMeta: { flexDirection: "row", alignItems: "center", gap: 4, flexWrap: "wrap" },
  epMetaText: { fontSize: 11 },
  epMetaSep: { fontSize: 11 },

  emptyWrap: {
    padding: 40,
    alignItems: "center",
    gap: 12,
  },
  emptyTitle: { fontSize: 18, fontWeight: "700" },
  emptyDesc: { fontSize: 14, textAlign: "center", lineHeight: 20 },
});
