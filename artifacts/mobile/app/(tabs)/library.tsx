import React, { useMemo, useState } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useYouTubeChannel } from "@/hooks/useYouTubeChannel";
import { useFavorites } from "@/hooks/useFavorites";
import { useWatchHistory } from "@/hooks/useWatchHistory";
import { CategoryPills } from "@/components/CategoryPills";
import { SermonCard } from "@/components/SermonCard";
import { SkeletonHorizontalCard } from "@/components/SkeletonCard";
import type { SermonCategory, Sermon, SortMode } from "@/types";

type ViewMode = "all" | "favorites" | "history";

const SORT_LABELS: Record<SortMode, string> = {
  newest: "Newest",
  oldest: "Oldest",
  popular: "Popular",
};

const SORT_ICONS: Record<SortMode, string> = {
  newest: "arrow-down",
  oldest: "arrow-up",
  popular: "trending-up",
};

const SORT_CYCLE: SortMode[] = ["newest", "oldest", "popular"];

function applySortAndFilter(
  sermons: Sermon[],
  search: string,
  category: SermonCategory,
  sortMode: SortMode,
  viewMode: ViewMode,
): Sermon[] {
  let results = [...sermons];

  if (viewMode === "all" && category !== "All") {
    results = results.filter((s) => s.category === category);
  }

  if (search.trim()) {
    const q = search.toLowerCase();
    results = results.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.preacher.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q),
    );
  }

  if (viewMode === "all") {
    if (sortMode === "newest") {
      results.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    } else if (sortMode === "oldest") {
      results.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    } else if (sortMode === "popular") {
      results.sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
    }
  }

  return results;
}

export default function LibraryScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { sermons, loading, refresh } = useYouTubeChannel();
  const { favorites, isFavorite, toggleFavorite } = useFavorites();
  const { history, hasWatched } = useWatchHistory();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<SermonCategory>("All");
  const [viewMode, setViewMode] = useState<ViewMode>("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [refreshing, setRefreshing] = useState(false);
  const webTopPad = Platform.OS === "web" ? 67 : 0;

  const sourceData = useMemo(() => {
    if (viewMode === "favorites") return favorites;
    if (viewMode === "history") return history.map((h) => h.sermon);
    return sermons;
  }, [viewMode, sermons, favorites, history]);

  const filtered = useMemo(
    () => applySortAndFilter(sourceData, search, category, sortMode, viewMode),
    [sourceData, search, category, sortMode, viewMode],
  );

  const handleSermonPress = (sermon: Sermon) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({
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

  const handleRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  const cycleSort = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSortMode((prev) => {
      const idx = SORT_CYCLE.indexOf(prev);
      return SORT_CYCLE[(idx + 1) % SORT_CYCLE.length];
    });
  };

  const viewModes: { key: ViewMode; label: string; icon: string }[] = [
    { key: "all", label: "All", icon: "grid" },
    { key: "favorites", label: "Saved", icon: "heart" },
    { key: "history", label: "History", icon: "clock" },
  ];

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <View style={{ paddingTop: insets.top + webTopPad }}>
        <View style={styles.headerRow}>
          <View>
            <Text style={[styles.header, { color: c.foreground }]}>Library</Text>
            <Text style={[styles.count, { color: c.mutedForeground }]}>
              {filtered.length} sermon{filtered.length !== 1 ? "s" : ""}
            </Text>
          </View>
          {viewMode === "all" && (
            <Pressable
              onPress={cycleSort}
              style={[styles.sortBtn, { backgroundColor: c.muted, borderColor: c.border }]}
            >
              <Feather name={SORT_ICONS[sortMode] as any} size={14} color={c.primary} />
              <Text style={[styles.sortLabel, { color: c.primary }]}>{SORT_LABELS[sortMode]}</Text>
            </Pressable>
          )}
        </View>

        <View style={styles.viewModeRow}>
          {viewModes.map((mode) => {
            const active = viewMode === mode.key;
            return (
              <Pressable
                key={mode.key}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setViewMode(mode.key);
                }}
                style={[
                  styles.viewModeBtn,
                  {
                    backgroundColor: active ? c.primary : c.muted,
                    borderColor: active ? c.primary : c.border,
                  },
                ]}
              >
                <Feather name={mode.icon as any} size={13} color={active ? "#FFF" : c.mutedForeground} />
                <Text style={[styles.viewModeText, { color: active ? "#FFF" : c.mutedForeground }]}>
                  {mode.label}
                  {mode.key === "favorites" && favorites.length > 0 ? ` (${favorites.length})` : ""}
                  {mode.key === "history" && history.length > 0 ? ` (${history.length})` : ""}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={[styles.searchContainer, { backgroundColor: c.muted, borderColor: c.border }]}>
          <Feather name="search" size={18} color={c.mutedForeground} />
          <TextInput
            style={[styles.searchInput, { color: c.foreground }]}
            placeholder="Search sermons, preachers, keywords..."
            placeholderTextColor={c.mutedForeground}
            value={search}
            onChangeText={setSearch}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {search.length > 0 && Platform.OS !== "ios" && (
            <Pressable onPress={() => setSearch("")} hitSlop={8}>
              <Feather name="x" size={18} color={c.mutedForeground} />
            </Pressable>
          )}
        </View>

        {viewMode === "all" && <CategoryPills selected={category} onSelect={setCategory} />}
      </View>

      {loading && viewMode === "all" ? (
        <FlatList
          data={[1, 2, 3, 4, 5]}
          keyExtractor={(i) => String(i)}
          contentContainerStyle={styles.listContent}
          renderItem={() => <SkeletonHorizontalCard />}
          showsVerticalScrollIndicator={false}
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            viewMode === "all" ? (
              <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                tintColor={c.primary}
                colors={[c.primary]}
              />
            ) : undefined
          }
          renderItem={({ item }) => (
            <View style={styles.cardWrapper}>
              <SermonCard sermon={item} onPress={handleSermonPress} variant="horizontal" />
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  toggleFavorite(item);
                }}
                style={styles.heartBtn}
                hitSlop={8}
              >
                <Feather
                  name="heart"
                  size={18}
                  color={isFavorite(item.youtubeId) ? "#FF0040" : c.mutedForeground}
                />
              </Pressable>
              {hasWatched(item.youtubeId) && (
                <View style={[styles.watchedBadge, { backgroundColor: c.primary }]}>
                  <Feather name="check" size={10} color="#FFF" />
                </View>
              )}
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Feather
                name={viewMode === "favorites" ? "heart" : viewMode === "history" ? "clock" : "search"}
                size={52}
                color={c.mutedForeground}
              />
              <Text style={[styles.emptyTitle, { color: c.foreground }]}>
                {viewMode === "favorites"
                  ? "No saved sermons"
                  : viewMode === "history"
                  ? "No watch history"
                  : "No sermons found"}
              </Text>
              <Text style={[styles.emptyText, { color: c.mutedForeground }]}>
                {viewMode === "favorites"
                  ? "Tap the heart icon on any sermon to save it"
                  : viewMode === "history"
                  ? "Sermons you watch will appear here"
                  : "Try a different search, category, or sort order"}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  header: { fontSize: 28, fontFamily: "Inter_700Bold" },
  count: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  sortBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    marginTop: 4,
  },
  sortLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  viewModeRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    marginTop: 12,
    marginBottom: 10,
  },
  viewModeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  viewModeText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
    marginBottom: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    padding: 0,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 150,
    gap: 10,
  },
  cardWrapper: { position: "relative" },
  heartBtn: {
    position: "absolute",
    right: 14,
    top: "50%",
    marginTop: -12,
  },
  watchedBadge: {
    position: "absolute",
    right: 48,
    bottom: 10,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#000",
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 80,
    gap: 10,
    paddingHorizontal: 32,
  },
  emptyTitle: { fontSize: 18, fontFamily: "Inter_600SemiBold", textAlign: "center" },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
});
