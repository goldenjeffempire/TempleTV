import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import { Feather } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { AppHeader } from "@/components/AppHeader";
import { usePaginatedVideos } from "@/hooks/useVideos";
import { SermonCard } from "@/components/SermonCard";
import { getApiBase } from "@/lib/apiBase";
import type { Sermon, SermonCategory, SortMode } from "@/types";
import { useWatchProgress, type ContinueWatchingItem } from "@/hooks/useWatchProgress";

const CATEGORIES: { label: string; value: SermonCategory }[] = [
  { label: "All", value: "All" },
  { label: "Deliverance", value: "Deliverance" },
  { label: "Sermons", value: "Sermons" },
  { label: "Prayers", value: "Prayers" },
  { label: "Crusades", value: "Crusades" },
  { label: "Conferences", value: "Conferences" },
  { label: "Testimonies", value: "Testimonies" },
];

const SORT_OPTIONS: { label: string; value: SortMode; icon: string }[] = [
  { label: "Newest", value: "newest", icon: "arrow-down" },
  { label: "Oldest", value: "oldest", icon: "arrow-up" },
  { label: "Popular", value: "popular", icon: "trending-up" },
];

interface SeriesItem {
  id: string;
  title: string;
  slug: string;
  description: string;
  thumbnailUrl: string;
  preacher: string | null;
  category: string;
  isOngoing: boolean;
}

function navigateToSermon(sermon: Sermon) {
  router.push({
    pathname: "/player",
    params: {
      id: sermon.id,
      title: sermon.title,
      youtubeId: sermon.videoSource === "youtube" ? sermon.youtubeId : "",
      hlsUrl: sermon.localVideoUrl ?? "",
      thumbnailUrl: sermon.thumbnailUrl,
      preacher: sermon.preacher,
      duration: sermon.duration,
      category: sermon.category,
      description: sermon.description,
    },
  });
}

function CategoryPill({
  category,
  active,
  onPress,
}: {
  category: { label: string; value: SermonCategory };
  active: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.pill,
        {
          backgroundColor: active ? c.primary : c.card,
          borderColor: active ? c.primary : c.border,
        },
      ]}
    >
      <Text
        style={[
          styles.pillText,
          { color: active ? "#fff" : c.foreground },
        ]}
      >
        {category.label}
      </Text>
    </Pressable>
  );
}

function ModePill({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: React.ComponentProps<typeof Feather>["name"];
  active: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.modePill,
        {
          backgroundColor: active ? c.primary : c.card,
          borderColor: active ? c.primary : c.border,
        },
      ]}
    >
      <Feather name={icon} size={14} color={active ? "#fff" : c.foreground} />
      <Text style={[styles.modePillText, { color: active ? "#fff" : c.foreground }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function ContinueWatchingRow({ items }: { items: ContinueWatchingItem[] }) {
  const c = useColors();
  if (items.length === 0) return null;

  const PLACEHOLDER_IMG = require("@/assets/images/sermon-placeholder.png");

  const navigateToItem = (item: ContinueWatchingItem) => {
    router.push({
      pathname: "/player",
      params: {
        id: item.videoKey,
        title: item.title ?? "Continue Watching",
        thumbnailUrl: item.thumbnailUrl ?? "",
        youtubeId: item.youtubeId ?? "",
        hlsUrl: item.localVideoUrl ?? "",
        startPositionSecs: String(Math.floor(item.position)),
      },
    });
  };

  return (
    <View style={cwStyles.section}>
      <Text style={[cwStyles.heading, { color: c.foreground }]}>Continue Watching</Text>
      <FlatList
        horizontal
        data={items}
        keyExtractor={(it) => it.videoKey}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={cwStyles.list}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => navigateToItem(item)}
            style={({ pressed }) => [cwStyles.card, { opacity: pressed ? 0.8 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel={`Resume ${item.title ?? "sermon"}`}
          >
            <View style={[cwStyles.thumbWrap, { backgroundColor: c.card }]}>
              <Image
                source={item.thumbnailUrl ? { uri: item.thumbnailUrl } : PLACEHOLDER_IMG}
                style={cwStyles.thumb}
                contentFit="cover"
              />
              <View style={[cwStyles.progressTrack, { backgroundColor: "rgba(255,255,255,0.25)" }]}>
                <View
                  style={[
                    cwStyles.progressFill,
                    { backgroundColor: c.primary, width: `${Math.round(item.pct * 100)}%` as any },
                  ]}
                />
              </View>
              <View style={cwStyles.playBadge}>
                <Feather name="play" size={14} color="#fff" />
              </View>
            </View>
            <Text style={[cwStyles.cardTitle, { color: c.foreground }]} numberOfLines={2}>
              {item.title ?? "Sermon"}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const cwStyles = StyleSheet.create({
  section: {
    paddingTop: 12,
    paddingBottom: 4,
  },
  heading: {
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: -0.3,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  list: {
    paddingHorizontal: 16,
    gap: 10,
  },
  card: {
    width: 150,
  },
  thumbWrap: {
    width: 150,
    height: 90,
    borderRadius: 10,
    overflow: "hidden",
    position: "relative",
  },
  thumb: {
    width: "100%",
    height: "100%",
  },
  progressTrack: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
  },
  progressFill: {
    height: 3,
    borderRadius: 2,
  },
  playBadge: {
    position: "absolute",
    bottom: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: "500",
    marginTop: 6,
    lineHeight: 16,
  },
});

function EmptyState({ search, c }: { search: string; c: ReturnType<typeof useColors> }) {
  return (
    <View style={styles.empty}>
      <Feather name="search" size={48} color={c.mutedForeground} />
      <Text style={[styles.emptyTitle, { color: c.foreground }]}>
        {search ? "No results found" : "No videos available"}
      </Text>
      <Text style={[styles.emptyDesc, { color: c.mutedForeground }]}>
        {search
          ? `No sermons match "${search}"`
          : "Videos will appear here once uploaded to the catalog"}
      </Text>
    </View>
  );
}

function SeriesCard({
  series,
  onPress,
}: {
  series: SeriesItem;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={[styles.seriesCard, { backgroundColor: c.card, borderColor: c.border }]}
    >
      <Image
        source={series.thumbnailUrl ? { uri: series.thumbnailUrl } : require("@/assets/images/sermon-placeholder.png")}
        style={styles.seriesThumbnail}
        contentFit="cover"
      />
      <View style={styles.seriesInfo}>
        <Text style={[styles.seriesTitle, { color: c.foreground }]} numberOfLines={2}>
          {series.title}
        </Text>
        {series.preacher ? (
          <Text style={[styles.seriesPreacher, { color: c.mutedForeground }]} numberOfLines={1}>
            {series.preacher}
          </Text>
        ) : null}
        <View style={styles.seriesMeta}>
          <Text style={[styles.seriesCategory, { color: c.primary }]}>
            {series.category}
          </Text>
          {series.isOngoing && (
            <View style={[styles.ongoingBadge, { backgroundColor: c.primary + "22" }]}>
              <Text style={[styles.ongoingText, { color: c.primary }]}>Ongoing</Text>
            </View>
          )}
        </View>
        {series.description ? (
          <Text style={[styles.seriesDesc, { color: c.mutedForeground }]} numberOfLines={2}>
            {series.description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function useSeriesList() {
  const [series, setSeries] = useState<SeriesItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const apiBase = getApiBase();
      const res = await fetch(`${apiBase}/api/series?limit=50`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSeries(data.series ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  return { series, loading, error, refetch: load };
}

export default function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const c = useColors();

  // Support deep-linking from the Channels tab: `router.navigate({ pathname: "/(tabs)/library", params: { category: "Prayers" } })`
  const { category: categoryParam } = useLocalSearchParams<{ category?: string }>();

  const [mode, setMode] = useState<"videos" | "series" | "playlists">("videos");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<SermonCategory>(() => {
    if (categoryParam && CATEGORIES.some((c) => c.value === categoryParam)) {
      return categoryParam as SermonCategory;
    }
    return "All";
  });
  const [sort, setSort] = useState<SortMode>("newest");
  const [showSort, setShowSort] = useState(false);

  // Keep category in sync when navigating here from another tab with a param
  const prevCategoryParamRef = useRef(categoryParam);
  useEffect(() => {
    if (categoryParam && categoryParam !== prevCategoryParamRef.current) {
      prevCategoryParamRef.current = categoryParam;
      if (CATEGORIES.some((c) => c.value === categoryParam)) {
        setCategory(categoryParam as SermonCategory);
      }
    }
  }, [categoryParam]);

  // Server-side paginated search — reacts to search/category/sort changes
  const {
    sermons,
    total,
    loading,
    loadingMore,
    hasMore,
    error,
    loadMore,
    refetch,
  } = usePaginatedVideos({ search, category, sort });

  const { series, loading: seriesLoading, error: seriesError, refetch: refetchSeries } = useSeriesList();
  const { continueWatching } = useWatchProgress();

  const currentSort = SORT_OPTIONS.find((s) => s.value === sort)!;

  const renderItem = useCallback(
    ({ item }: { item: Sermon }) => (
      <SermonCard
        sermon={item}
        onPress={() => navigateToSermon(item)}
        variant="horizontal"
      />
    ),
    [],
  );

  const keyExtractor = useCallback((item: Sermon) => item.id, []);

  const ListFooter = loadingMore ? (
    <View style={styles.footerLoader}>
      <ActivityIndicator size="small" color={c.primary} />
      <Text style={[styles.footerText, { color: c.mutedForeground }]}>
        Loading more…
      </Text>
    </View>
  ) : hasMore ? (
    <View style={styles.footerHint}>
      <Text style={[styles.footerText, { color: c.mutedForeground }]}>
        Scroll for more
      </Text>
    </View>
  ) : sermons.length > 0 ? (
    <View style={styles.footerEnd}>
      <Text style={[styles.footerText, { color: c.mutedForeground }]}>
        {total} {total === 1 ? "video" : "videos"} total
      </Text>
    </View>
  ) : null;

  const ListHeader = (
    <View>
      {/* Continue Watching — only in Videos mode when there are items */}
      {mode === "videos" && <ContinueWatchingRow items={continueWatching} />}

      {/* Mode toggle */}
      <View style={styles.modeRow}>
        <ModePill
          label="Videos"
          icon="video"
          active={mode === "videos"}
          onPress={() => setMode("videos")}
        />
        <ModePill
          label="Series"
          icon="book-open"
          active={mode === "series"}
          onPress={() => setMode("series")}
        />
        <ModePill
          label="Playlists"
          icon="list"
          active={mode === "playlists"}
          onPress={() => router.push("/playlists")}
        />
      </View>

      {mode === "videos" && (
        <>
          {/* Search */}
          <View style={[styles.searchRow, { backgroundColor: c.card, borderColor: c.border }]}>
            <Feather name="search" size={16} color={c.mutedForeground} />
            <TextInput
              style={[styles.searchInput, { color: c.foreground }]}
              placeholder="Search sermons, preachers…"
              placeholderTextColor={c.mutedForeground}
              value={search}
              onChangeText={setSearch}
              returnKeyType="search"
              clearButtonMode="while-editing"
              autoCorrect={false}
            />
            {search.length > 0 && (
              <Pressable onPress={() => setSearch("")} hitSlop={8}>
                <Feather name="x" size={16} color={c.mutedForeground} />
              </Pressable>
            )}
          </View>

          {/* Category pills */}
          <FlatList
            horizontal
            data={CATEGORIES}
            keyExtractor={(cat) => cat.value}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.pillRow}
            renderItem={({ item }) => (
              <CategoryPill
                category={item}
                active={category === item.value}
                onPress={() => setCategory(item.value)}
              />
            )}
          />

          {/* Sort + count row */}
          <View style={styles.metaRow}>
            <Text style={[styles.count, { color: c.mutedForeground }]}>
              {loading
                ? "Loading…"
                : `${total} ${total === 1 ? "video" : "videos"}`}
            </Text>
            <Pressable
              onPress={() => setShowSort((s) => !s)}
              style={[styles.sortBtn, { backgroundColor: c.card, borderColor: c.border }]}
            >
              <Feather
                name={currentSort.icon as React.ComponentProps<typeof Feather>["name"]}
                size={14}
                color={c.foreground}
              />
              <Text style={[styles.sortLabel, { color: c.foreground }]}>{currentSort.label}</Text>
              <Feather name="chevron-down" size={14} color={c.mutedForeground} />
            </Pressable>
          </View>

          {showSort && (
            <View
              style={[styles.sortDropdown, { backgroundColor: c.card, borderColor: c.border }]}
            >
              {SORT_OPTIONS.map((opt) => (
                <Pressable
                  key={opt.value}
                  onPress={() => { setSort(opt.value); setShowSort(false); }}
                  style={[
                    styles.sortOption,
                    sort === opt.value && { backgroundColor: c.primary + "22" },
                  ]}
                >
                  <Feather
                    name={opt.icon as React.ComponentProps<typeof Feather>["name"]}
                    size={14}
                    color={sort === opt.value ? c.primary : c.foreground}
                  />
                  <Text
                    style={[
                      styles.sortOptionText,
                      { color: sort === opt.value ? c.primary : c.foreground },
                    ]}
                  >
                    {opt.label}
                  </Text>
                  {sort === opt.value && <Feather name="check" size={14} color={c.primary} />}
                </Pressable>
              ))}
            </View>
          )}

          {error && (
            <View style={[styles.errorBar, { backgroundColor: "#ef4444" + "22" }]}>
              <Text style={{ color: "#ef4444", fontSize: 13 }}>{error} — </Text>
              <Pressable onPress={refetch}>
                <Text style={{ color: "#ef4444", fontSize: 13, fontWeight: "600" }}>Retry</Text>
              </Pressable>
            </View>
          )}
        </>
      )}

      {mode === "series" && (
        <View style={styles.seriesHeader}>
          <Text style={[styles.seriesCount, { color: c.mutedForeground }]}>
            {series.length} {series.length === 1 ? "series" : "sermon series"}
          </Text>
        </View>
      )}
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <AppHeader />
      {/* Header */}
      <View
        style={[
          styles.header,
          { backgroundColor: c.background, borderBottomColor: c.border },
        ]}
      >
        <Text style={[styles.headerTitle, { color: c.foreground }]}>Library</Text>
      </View>

      {mode === "videos" && (
        <>
          {loading && sermons.length === 0 ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="large" color={c.primary} />
              <Text style={[styles.loadingText, { color: c.mutedForeground }]}>
                Loading catalog…
              </Text>
            </View>
          ) : (
            <FlatList
              data={sermons}
              keyExtractor={keyExtractor}
              renderItem={renderItem}
              ListHeaderComponent={ListHeader}
              ListEmptyComponent={<EmptyState search={search} c={c} />}
              ListFooterComponent={ListFooter}
              contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 100 }]}
              refreshControl={
                <RefreshControl
                  refreshing={loading && sermons.length > 0}
                  onRefresh={refetch}
                  tintColor={c.primary}
                />
              }
              onEndReached={loadMore}
              onEndReachedThreshold={0.4}
              showsVerticalScrollIndicator={false}
              removeClippedSubviews={Platform.OS === "android"}
              maxToRenderPerBatch={10}
              windowSize={10}
            />
          )}
        </>
      )}

      {mode === "series" && (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
          refreshControl={
            <RefreshControl
              refreshing={seriesLoading}
              onRefresh={refetchSeries}
              tintColor={c.primary}
            />
          }
          showsVerticalScrollIndicator={false}
        >
          {ListHeader}
          {seriesLoading && series.length === 0 ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="large" color={c.primary} />
              <Text style={[styles.loadingText, { color: c.mutedForeground }]}>
                Loading series…
              </Text>
            </View>
          ) : seriesError ? (
            <View style={[styles.errorBar, { backgroundColor: "#ef4444" + "22", marginHorizontal: 16 }]}>
              <Text style={{ color: "#ef4444", fontSize: 13 }}>{seriesError} — </Text>
              <Pressable onPress={refetchSeries}>
                <Text style={{ color: "#ef4444", fontSize: 13, fontWeight: "600" }}>Retry</Text>
              </Pressable>
            </View>
          ) : series.length === 0 ? (
            <View style={styles.empty}>
              <Feather name="book-open" size={48} color={c.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: c.foreground }]}>No series yet</Text>
              <Text style={[styles.emptyDesc, { color: c.mutedForeground }]}>
                Sermon series will appear here once created by the admin.
              </Text>
            </View>
          ) : (
            <View style={styles.seriesList}>
              {series.map((s) => (
                <SeriesCard
                  key={s.id}
                  series={s}
                  onPress={() => {
                    router.push(`/series/${s.slug}`);
                  }}
                />
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  modeRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  modePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  modePillText: { fontSize: 13, fontWeight: "600" },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },
  pillRow: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
  },
  pillText: {
    fontSize: 13,
    fontWeight: "500",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  count: { fontSize: 13 },
  sortBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sortLabel: { fontSize: 13, fontWeight: "500" },
  sortDropdown: {
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    marginBottom: 8,
  },
  sortOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sortOptionText: { flex: 1, fontSize: 14, fontWeight: "500" },
  errorBar: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 8,
  },
  list: { gap: 0 },
  loadingWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingTop: 60 },
  loadingText: { fontSize: 14 },
  empty: { alignItems: "center", paddingVertical: 60, paddingHorizontal: 32, gap: 12 },
  emptyTitle: { fontSize: 18, fontWeight: "600", textAlign: "center" },
  emptyDesc: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  footerLoader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 20,
  },
  footerHint: {
    alignItems: "center",
    paddingVertical: 16,
  },
  footerEnd: {
    alignItems: "center",
    paddingVertical: 20,
  },
  footerText: { fontSize: 13 },
  seriesHeader: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  seriesCount: { fontSize: 13 },
  seriesList: {
    paddingHorizontal: 16,
    gap: 12,
    paddingTop: 8,
  },
  seriesCard: {
    flexDirection: "row",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  seriesThumbnail: {
    width: 100,
    height: 80,
  },
  seriesInfo: {
    flex: 1,
    padding: 12,
    gap: 4,
  },
  seriesTitle: {
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 18,
  },
  seriesPreacher: {
    fontSize: 12,
  },
  seriesMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  seriesCategory: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "capitalize",
  },
  ongoingBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  ongoingText: {
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  seriesDesc: {
    fontSize: 12,
    lineHeight: 16,
  },
});
