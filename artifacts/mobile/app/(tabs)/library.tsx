import React, { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
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
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { ScreenHeader } from "@/components/ScreenHeader";
import { usePaginatedVideos } from "@/hooks/useVideos";
import { SermonCard } from "@/components/SermonCard";
import { VideoCard } from "@/components/VideoCard";
import {
  SkeletonHorizontalCard,
  SkeletonSeriesCard,
} from "@/components/SkeletonCard";
import { getApiBase } from "@/lib/apiBase";
import { fetchWithRetry } from "@/lib/fetchWithRetry";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import type { Sermon, SermonCategory, SortMode } from "@/types";
import { useWatchProgress, type ContinueWatchingItem } from "@/hooks/useWatchProgress";
import { playbackQueue } from "@/lib/playbackQueue";

const PLACEHOLDER_IMG = require("@/assets/images/sermon-placeholder.png");

const CATEGORIES: { label: string; value: SermonCategory }[] = [
  { label: "All", value: "All" },
  { label: "Live Service", value: "Live Service" },
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

function navigateToSermon(sermon: Sermon, orderedList?: readonly Sermon[]) {
  // Snapshot the current library ordering into the shared playback queue so
  // the player screen can derive Prev/Next without re-fetching. When the
  // list isn't provided (deep-links, Continue Watching cards) we fall back
  // to a single-item queue — Prev/Next will hide automatically.
  if (orderedList && orderedList.length > 0) {
    playbackQueue.set(orderedList, sermon.id);
  } else {
    playbackQueue.set([sermon], sermon.id);
  }
  router.push({
    pathname: "/player",
    params: {
      id: sermon.id,
      title: sermon.title,
      youtubeId: sermon.videoSource === "youtube" ? sermon.youtubeId : "",
      hlsUrl: sermon.hlsMasterUrl ?? "",
      localVideoUrl: sermon.localVideoUrl ?? "",
      thumbnailUrl: sermon.thumbnailUrl,
      preacher: sermon.preacher,
      duration: sermon.duration,
      category: sermon.category,
      description: sermon.description,
    },
  });
}

// Memoized so re-renders from search input / sort state don't repaint all pills
const CategoryPill = React.memo(function CategoryPill({
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
});

// Memoized: mode toggles only flip one pill — the others should be stable
const ModePill = React.memo(function ModePill({
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
});

// Fixed height for the horizontal SermonCard variant:
// horizontalThumbWrap (68) + horizontalCard padding top+bottom (12+12 = 24) = 92.
// LIST_ITEM_GAP matches the `gap: 10` in styles.list so offset maths stay accurate.
const SERMON_CARD_HEIGHT = 92;
const LIST_ITEM_GAP = 10;

const ContinueWatchingRow = React.memo(function ContinueWatchingRow({ items }: { items: ContinueWatchingItem[] }) {
  const c = useColors();

  const navigateToItem = useCallback((item: ContinueWatchingItem) => {
    router.push({
      pathname: "/player",
      params: {
        id: item.videoKey,
        title: item.title ?? "Continue Watching",
        thumbnailUrl: item.thumbnailUrl ?? "",
        youtubeId: item.youtubeId ?? "",
        hlsUrl: item.hlsMasterUrl ?? "",
        localVideoUrl: item.localVideoUrl ?? "",
        startPositionSecs: String(Math.floor(item.position)),
      },
    });
  }, []);

  if (items.length === 0) return null;

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
                    { backgroundColor: c.primary, width: `${Math.round(item.pct * 100)}%` as `${number}%` },
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
});

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

const SERIES_CACHE_KEY = "@temple_tv/series_v1";
const SERIES_CACHE_TTL_MS = 30 * 60 * 1000;

interface SeriesCacheEnvelope {
  data: SeriesItem[];
  cachedAt: number;
}

function useSeriesList() {
  const [series, setSeries] = useState<SeriesItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Ref-based guard: reading `series` state inside useCallback([]) always sees
  // the initial empty array (stale closure). A ref avoids this — it is set true
  // the moment any data (cache or network) is painted to the screen so the catch
  // path correctly suppresses errors that would clobber already-visible content.
  const hasDataRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async (opts?: { skipCache?: boolean }) => {
    setLoading(true);
    setError(null);

    // Step 1: serve stale-while-revalidate from AsyncStorage.
    if (!opts?.skipCache) {
      try {
        const raw = await AsyncStorage.getItem(SERIES_CACHE_KEY);
        if (raw) {
          const envelope = JSON.parse(raw) as SeriesCacheEnvelope;
          const age = Date.now() - envelope.cachedAt;
          if (age < SERIES_CACHE_TTL_MS && Array.isArray(envelope.data)) {
            if (mountedRef.current) {
              setSeries(envelope.data);
              hasDataRef.current = true;
              setLoading(false);
            }
          }
        }
      } catch {
        // Corrupted cache — continue to network fetch.
      }
    }

    // Step 2: background network fetch — updates the UI only if data changed.
    try {
      const apiBase = getApiBase();
      const res = await fetchWithRetry(`${apiBase}/api/series?limit=50`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { series?: SeriesItem[] };
      const fetched = data.series ?? [];

      if (!mountedRef.current) return;
      setSeries(fetched);
      hasDataRef.current = true;
      setError(null);

      const envelope: SeriesCacheEnvelope = { data: fetched, cachedAt: Date.now() };
      AsyncStorage.setItem(SERIES_CACHE_KEY, JSON.stringify(envelope)).catch(() => {});
    } catch (e) {
      if (!mountedRef.current) return;
      if (!hasDataRef.current) {
        setError(String(e));
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  return { series, loading, error, refetch: () => load({ skipCache: true }) };
}

export default function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const c = useColors();

  // Support deep-linking from the Channels tab: `router.navigate({ pathname: "/(tabs)/library", params: { category: "Prayers" } })`
  const { category: categoryParam } = useLocalSearchParams<{ category?: string }>();

  const [mode, setMode] = useState<"videos" | "series" | "playlists">("videos");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

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
  const { isOnline } = useNetworkStatus();

  const {
    sermons,
    total,
    loading,
    loadingMore,
    isRefreshing,
    hasMore,
    error,
    refreshError,
    loadMore,
    loadMoreError,
    retryCount,
    refetch,
  } = usePaginatedVideos({ search: debouncedSearch, category, sort, source: "youtube" });

  const { series, loading: seriesLoading, error: seriesError, refetch: refetchSeries } = useSeriesList();
  const { continueWatching } = useWatchProgress();

  const currentSort = SORT_OPTIONS.find((s) => s.value === sort)!;

  // Tablet-responsive grid — on tablets (≥768 px) show 2 columns of vertical
  // VideoCards instead of a single-column horizontal SermonCard list. On phone
  // keep the existing horizontal-list layout which maximises density.
  const { isTablet, getCardWidth: getTabletCardWidth } = useBreakpoint();
  const numCols = isTablet ? 2 : 1;

  // Stable ref to the latest sermons array so renderItem doesn't have to
  // depend on it (which would re-render every visible row on every page
  // append). Reading the ref at tap-time gives the player the most current
  // ordering for Prev/Next without trashing the FlatList memoization.
  const sermonsRef = useRef<Sermon[]>(sermons);
  sermonsRef.current = sermons;

  // tabletCardWidth is computed once per breakpoint change. The function
  // is stable across renders so this value won't bounce.
  const tabletCardWidth = isTablet ? getTabletCardWidth(2) : 0;

  const renderItem = useCallback(
    ({ item }: { item: Sermon }) => {
      if (isTablet) {
        return (
          <VideoCard
            sermon={item}
            onPress={() => navigateToSermon(item, sermonsRef.current)}
            cardWidth={tabletCardWidth}
          />
        );
      }
      return (
        <SermonCard
          sermon={item}
          onPress={() => navigateToSermon(item, sermonsRef.current)}
          variant="horizontal"
        />
      );
    },
    [isTablet, tabletCardWidth],
  );

  // Keep the shared playback queue in sync as the library loads more pages
  // (infinite scroll). If the player is open and the user reaches the end
  // of the snapshot, this extends the queue underneath them — appended-only,
  // no re-order, so the current item's index is preserved.
  useEffect(() => {
    if (sermons.length === 0) return;
    playbackQueue.extend(sermons);
  }, [sermons]);

  // Note: we don't aggressively clear the queue when filters change.
  // navigateToSermon overwrites it on every tap with the current ordering,
  // so a stale snapshot is replaced on the next play. Clearing on filter
  // change would also wipe the queue mid-watch when the library re-mounts
  // behind the player screen.

  const keyExtractor = useCallback((item: Sermon) => item.id, []);

  const ListFooter = loadingMore ? (
    <View style={styles.footerLoader}>
      <ActivityIndicator size="small" color={c.primary} />
      <Text style={[styles.footerText, { color: c.mutedForeground }]}>
        Loading more…
      </Text>
    </View>
  ) : loadMoreError ? (
    <Pressable onPress={loadMore} style={styles.footerHint} accessibilityRole="button" accessibilityLabel="Retry loading more videos">
      <Text style={[styles.footerText, { color: c.destructive ?? "#ef4444" }]}>
        Failed to load more — tap to retry
      </Text>
    </Pressable>
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
              <Pressable
                onPress={() => { setSearch(""); setDebouncedSearch(""); }}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
              >
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

          {!isOnline && !error && (
            <View style={[styles.errorBar, { backgroundColor: "#6b7280" + "22" }]}>
              <Feather name="wifi-off" size={13} color="#6b7280" />
              <Text style={{ color: "#6b7280", fontSize: 13, flex: 1, marginLeft: 6 }}>
                You're offline — videos will load when you reconnect
              </Text>
            </View>
          )}
          {error && (
            <View style={[styles.errorBar, { backgroundColor: "#ef4444" + "22" }]}>
              <Feather name={isOnline ? "alert-circle" : "wifi-off"} size={13} color="#ef4444" />
              <Text style={{ color: "#ef4444", fontSize: 13, flex: 1, marginLeft: 6 }}>
                {isOnline
                  ? retryCount > 0
                    ? `${error} (retrying…)`
                    : error
                  : "You're offline — connect to load videos"}
              </Text>
              {isOnline && (
                <Pressable onPress={refetch} accessibilityRole="button" accessibilityLabel="Retry loading videos">
                  <Text style={{ color: "#ef4444", fontSize: 13, fontWeight: "600" }}>Retry</Text>
                </Pressable>
              )}
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
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: c.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen options={{ headerShown: false, header: () => null, title: "" }} />
      <ScreenHeader title="Library" />

      {/* Stale / refresh-fail indicator — only shown in videos mode, only when online
          (NetworkBanner already covers the offline case at the root). */}
      {mode === "videos" && isOnline && (isRefreshing || !!refreshError) && (
        <View style={[
          styles.staleBanner,
          !!refreshError && styles.staleBannerFailed,
        ]}>
          <Feather
            name={refreshError ? "wifi-off" : "clock"}
            size={11}
            color={refreshError ? "#991b1b" : "#92400e"}
          />
          <Text style={[
            styles.staleBannerText,
            !!refreshError && styles.staleBannerTextFailed,
          ]}>
            {refreshError
              ? "Couldn't refresh — showing saved results"
              : "Refreshing catalog…"}
          </Text>
          {!!refreshError && (
            <Pressable
              onPress={refetch}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Retry refreshing videos"
            >
              <Text style={styles.staleBannerRetry}>Retry</Text>
            </Pressable>
          )}
        </View>
      )}

      {mode === "videos" && (
        <>
          {loading && sermons.length === 0 ? (
            <View style={styles.skeletonList}>
              {Array.from({ length: 5 }).map((_, i) => (
                <SkeletonHorizontalCard key={i} />
              ))}
            </View>
          ) : (
            <FlatList
              data={sermons}
              keyExtractor={keyExtractor}
              renderItem={renderItem}
              ListHeaderComponent={ListHeader}
              ListEmptyComponent={<EmptyState search={debouncedSearch} c={c} />}
              ListFooterComponent={ListFooter}
              contentContainerStyle={[
                styles.list,
                { paddingBottom: insets.bottom + 100 },
                isTablet && styles.listTablet,
              ]}
              refreshControl={
                <RefreshControl
                  refreshing={isRefreshing}
                  onRefresh={refetch}
                  tintColor={c.primary}
                />
              }
              onEndReached={loadMore}
              onEndReachedThreshold={0.4}
              showsVerticalScrollIndicator={false}
              removeClippedSubviews={Platform.OS === "android"}
              maxToRenderPerBatch={10}
              windowSize={7}
              initialNumToRender={10}
              numColumns={numCols}
              key={numCols}
              columnWrapperStyle={numCols > 1 ? styles.columnWrapper : undefined}
              getItemLayout={isTablet ? undefined : (_data, index) => ({
                length: SERMON_CARD_HEIGHT,
                offset: (SERMON_CARD_HEIGHT + LIST_ITEM_GAP) * index,
                index,
              })}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
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
            <View style={styles.skeletonList}>
              {Array.from({ length: 3 }).map((_, i) => (
                <SkeletonSeriesCard key={i} />
              ))}
            </View>
          ) : seriesError ? (
            <View style={[styles.errorBar, { backgroundColor: "#ef4444" + "22", marginHorizontal: 16 }]}>
              <Feather name="alert-circle" size={13} color="#ef4444" />
              <Text style={{ color: "#ef4444", fontSize: 13, flex: 1, marginLeft: 6 }}>{seriesError}</Text>
              <Pressable onPress={refetchSeries} accessibilityRole="button" accessibilityLabel="Retry loading series">
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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
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
  staleBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 7,
    backgroundColor: "#fef3c7",
  },
  staleBannerFailed: {
    backgroundColor: "#fee2e2",
  },
  staleBannerText: {
    flex: 1,
    fontSize: 12,
    fontWeight: "500",
    color: "#92400e",
  },
  staleBannerTextFailed: {
    color: "#991b1b",
  },
  staleBannerRetry: {
    fontSize: 12,
    fontWeight: "700",
    color: "#991b1b",
    textDecorationLine: "underline",
  },
  skeletonList: {
    paddingTop: 8,
  },
  list: { gap: 0 },
  listTablet: {
    paddingHorizontal: 16,
    gap: 12,
  },
  columnWrapper: {
    gap: 12,
    marginBottom: 0,
    alignItems: "flex-start",
  },
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
