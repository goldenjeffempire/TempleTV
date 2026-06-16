/**
 * Playlists Screen — Temple TV Mobile
 *
 * Browse all published playlists. Tapping a playlist navigates to
 * playlists/[id] for the episode list.
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
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { usePlaylists, type PlaylistItem } from "@/hooks/usePlaylists";
import { AppHeader } from "@/components/AppHeader";

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

function PlaylistCard({ playlist, onPress }: { playlist: PlaylistItem; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: c.card, borderColor: c.border, opacity: pressed ? 0.85 : 1 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Open playlist: ${playlist.title}`}
    >
      {/* Thumbnail */}
      <View style={styles.thumbWrap}>
        <Image
          source={playlist.thumbnailUrl ? { uri: playlist.thumbnailUrl } : PLACEHOLDER}
          style={styles.thumb}
          contentFit="cover"
        />
        {/* Count badge */}
        <View style={[styles.countBadge, { backgroundColor: "rgba(0,0,0,0.72)" }]}>
          <Feather name="list" size={11} color="#fff" />
          <Text style={styles.countText}>
            {playlist.videoCount} {playlist.videoCount === 1 ? "video" : "videos"}
          </Text>
        </View>
      </View>

      {/* Info */}
      <View style={styles.cardInfo}>
        <Text style={[styles.cardTitle, { color: c.foreground }]} numberOfLines={2}>
          {playlist.title}
        </Text>
        {!!playlist.category && (
          <Text style={[styles.cardCategory, { color: c.primary }]} numberOfLines={1}>
            {playlist.category}
          </Text>
        )}
        {!!playlist.description && (
          <Text style={[styles.cardDesc, { color: c.mutedForeground }]} numberOfLines={2}>
            {playlist.description}
          </Text>
        )}
      </View>

      <Feather name="chevron-right" size={18} color={c.mutedForeground} style={styles.chevron} />
    </Pressable>
  );
}

export default function PlaylistsScreen() {
  const insets = useSafeAreaInsets();
  const c = useColors();
  const { playlists, loading, error, refetch } = usePlaylists();

  const renderItem = useCallback(
    ({ item }: { item: PlaylistItem }) => (
      <PlaylistCard
        playlist={item}
        onPress={() => router.push({ pathname: "/playlists/[id]", params: { id: item.id, title: item.title } })}
      />
    ),
    [],
  );

  const keyExtractor = useCallback((item: PlaylistItem) => item.id, []);

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ headerShown: false, header: () => null, title: "" }} />
      <StatusBar barStyle={c.isMidnightTheme ? "light-content" : "dark-content"} />
      <AppHeader
        title="Playlists"
        rightElement={
          !loading && playlists.length > 0 ? (
            <View style={[styles.countPill, { backgroundColor: c.card }]}>
              <Text style={[styles.countPillText, { color: c.mutedForeground }]}>{playlists.length}</Text>
            </View>
          ) : null
        }
      />

      {/* Body */}
      {loading && playlists.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={c.primary} />
          <Text style={[styles.loadingText, { color: c.mutedForeground }]}>Loading playlists…</Text>
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Feather name="alert-circle" size={40} color={c.mutedForeground} />
          <Text style={[styles.errorTitle, { color: c.foreground }]}>Failed to load</Text>
          <Text style={[styles.errorDesc, { color: c.mutedForeground }]}>{error}</Text>
          <Pressable onPress={refetch} style={[styles.retryBtn, { backgroundColor: c.primary }]}>
            <Text style={styles.retryText}>Try Again</Text>
          </Pressable>
        </View>
      ) : playlists.length === 0 ? (
        <View style={styles.centered}>
          <Feather name="list" size={52} color={c.mutedForeground} />
          <Text style={[styles.errorTitle, { color: c.foreground }]}>No Playlists Yet</Text>
          <Text style={[styles.errorDesc, { color: c.mutedForeground }]}>
            Playlists will appear here once created by the admin team.
          </Text>
        </View>
      ) : (
        <FlatList
          data={playlists}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 80 }]}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={refetch} tintColor={c.primary} />
          }
          showsVerticalScrollIndicator={false}
          ItemSeparatorComponent={() => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />}
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
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  countPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  countPillText: { fontSize: 13, fontWeight: "600" },

  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
    paddingBottom: 60,
  },
  loadingText: { fontSize: 14 },
  errorTitle: { fontSize: 18, fontWeight: "700", textAlign: "center" },
  errorDesc: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  retryBtn: {
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 20,
    marginTop: 8,
  },
  retryText: { color: "#fff", fontSize: 14, fontWeight: "700" },

  list: { paddingTop: 8 },

  card: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 14,
    borderBottomWidth: 0,
  },
  thumbWrap: {
    width: 80,
    height: 56,
    borderRadius: 8,
    overflow: "hidden",
    position: "relative",
    flexShrink: 0,
    backgroundColor: "#1a1a2e",
  },
  thumb: { width: "100%", height: "100%" },
  countBadge: {
    position: "absolute",
    bottom: 4,
    right: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  countText: { color: "#fff", fontSize: 10, fontWeight: "700" },

  cardInfo: { flex: 1, gap: 3 },
  cardTitle: { fontSize: 14, fontWeight: "700", lineHeight: 18 },
  cardCategory: { fontSize: 11, fontWeight: "600" },
  cardDesc: { fontSize: 12, lineHeight: 16 },

  chevron: { flexShrink: 0 },
});
