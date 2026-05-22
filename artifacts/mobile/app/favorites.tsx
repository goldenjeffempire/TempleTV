import React, { useCallback } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  Alert,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { SermonCard } from "@/components/SermonCard";
import { useFavorites } from "@/hooks/useFavorites";
import type { Sermon } from "@/types";

function navigateToSermon(sermon: Sermon) {
  router.push({
    pathname: "/player",
    params: {
      id: sermon.id,
      title: sermon.title,
      youtubeId: sermon.videoSource === "youtube" ? sermon.youtubeId : "",
      hlsUrl: sermon.hlsMasterUrl ?? sermon.localVideoUrl ?? "",
      thumbnailUrl: sermon.thumbnailUrl,
      preacher: sermon.preacher,
      duration: sermon.duration,
      category: sermon.category,
      description: sermon.description,
    },
  });
}

export default function FavoritesScreen() {
  const insets = useSafeAreaInsets();
  const c = useColors();
  const { favorites, removeFavorite } = useFavorites();

  const handleRemove = useCallback(
    (sermon: Sermon) => {
      Alert.alert(
        "Remove Favorite",
        `Remove "${sermon.title}" from favorites?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: () => removeFavorite(sermon.id),
          },
        ],
      );
    },
    [removeFavorite],
  );

  const renderItem = useCallback(
    ({ item }: { item: Sermon }) => (
      <View style={styles.itemRow}>
        <View style={{ flex: 1 }}>
          <SermonCard
            sermon={item}
            onPress={() => navigateToSermon(item)}
            variant="horizontal"
          />
        </View>
        <Pressable
          onPress={() => handleRemove(item)}
          hitSlop={8}
          style={[styles.removeBtn, { backgroundColor: "#ef444422" }]}
        >
          <Feather name="heart" size={16} color="#ef4444" />
        </Pressable>
      </View>
    ),
    [handleRemove],
  );

  const keyExtractor = useCallback((item: Sermon) => item.id, []);

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, backgroundColor: c.background, borderBottomColor: c.border },
        ]}
      >
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <Feather name="arrow-left" size={22} color={c.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: c.foreground }]}>Favorites</Text>
        <Text style={[styles.headerCount, { color: c.mutedForeground }]}>
          {favorites.length} saved
        </Text>
      </View>

      {favorites.length === 0 ? (
        <View style={styles.empty}>
          <View style={[styles.emptyIcon, { backgroundColor: c.primary + "22" }]}>
            <Feather name="heart" size={36} color={c.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: c.foreground }]}>No favorites yet</Text>
          <Text style={[styles.emptyDesc, { color: c.mutedForeground }]}>
            Tap the heart icon on any sermon to save it here for quick access.
          </Text>
          <Pressable
            onPress={() => router.push("/(tabs)/library")}
            style={[styles.browseBtn, { backgroundColor: c.primary }]}
          >
            <Feather name="book-open" size={16} color="#fff" />
            <Text style={styles.browseBtnText}>Browse Library</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={favorites}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 100 }]}
          showsVerticalScrollIndicator={false}
          ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: c.border }]} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "700",
    flex: 1,
    letterSpacing: -0.3,
  },
  headerCount: { fontSize: 13 },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: { fontSize: 20, fontWeight: "700", textAlign: "center" },
  emptyDesc: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  browseBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 8,
  },
  browseBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  list: { paddingTop: 8 },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 4,
    gap: 8,
  },
  removeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  separator: { height: StyleSheet.hairlineWidth, marginHorizontal: 16 },
});
