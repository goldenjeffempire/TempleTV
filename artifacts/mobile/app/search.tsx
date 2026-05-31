/**
 * Search Screen — Temple TV Mobile
 *
 * Full-screen dedicated search experience with:
 *  • Auto-focused text input
 *  • Debounced live results (server-side via usePaginatedVideos)
 *  • Recent searches stored in AsyncStorage (last 10)
 *  • Category filter pills
 *  • Sort toggle
 *  • Empty / no-results state
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useColors } from "@/hooks/useColors";
import { SermonCard } from "@/components/SermonCard";
import { usePaginatedVideos } from "@/hooks/useVideos";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import type { Sermon, SermonCategory, SortMode } from "@/types";

const RECENT_KEY = "@temple_tv/recent_searches_v1";
const MAX_RECENT = 10;

const CATEGORIES: { label: string; value: SermonCategory | "All" }[] = [
  { label: "All", value: "All" },
  { label: "Deliverance", value: "Deliverance" },
  { label: "Sermons", value: "Sermons" },
  { label: "Prayers", value: "Prayers" },
  { label: "Crusades", value: "Crusades" },
  { label: "Conferences", value: "Conferences" },
  { label: "Testimonies", value: "Testimonies" },
];

async function loadRecent(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

async function saveRecent(query: string, existing: string[]): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) return existing;
  const updated = [trimmed, ...existing.filter((q) => q !== trimmed)].slice(0, MAX_RECENT);
  try {
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(updated));
  } catch { /* non-critical */ }
  return updated;
}

async function removeRecent(query: string, existing: string[]): Promise<string[]> {
  const updated = existing.filter((q) => q !== query);
  try {
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(updated));
  } catch { /* non-critical */ }
  return updated;
}

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

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const c = useColors();
  const inputRef = useRef<TextInput>(null);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<SermonCategory>("All" as SermonCategory);
  const [sort] = useState<SortMode>("newest");
  const [recent, setRecent] = useState<string[]>([]);
  const [recentLoaded, setRecentLoaded] = useState(false);

  const isSearching = query.trim().length > 0;

  const { isOnline } = useNetworkStatus();

  const { sermons, total, loading, loadingMore, isRefreshing, hasMore, refreshError, loadMoreError, loadMore, refetch } = usePaginatedVideos({
    search: isSearching ? query : "",
    category,
    sort,
  });

  useEffect(() => {
    loadRecent().then((r) => {
      setRecent(r);
      setRecentLoaded(true);
    });
    const t = setTimeout(() => inputRef.current?.focus(), 150);
    return () => clearTimeout(t);
  }, []);

  const handleSubmit = useCallback(() => {
    const q = query.trim();
    if (!q) return;
    saveRecent(q, recent).then(setRecent);
    Keyboard.dismiss();
  }, [query, recent]);

  const applyRecent = useCallback((q: string) => {
    setQuery(q);
    inputRef.current?.blur();
  }, []);

  const deleteRecent = useCallback((q: string) => {
    removeRecent(q, recent).then(setRecent);
  }, [recent]);

  const clearQuery = useCallback(() => {
    setQuery("");
    inputRef.current?.focus();
  }, []);

  const renderItem = useCallback(({ item }: { item: Sermon }) => (
    <SermonCard
      sermon={item}
      onPress={() => {
        saveRecent(query, recent).then(setRecent);
        navigateToSermon(item);
      }}
      variant="horizontal"
    />
  ), [query, recent]);

  const keyExtractor = useCallback((item: Sermon) => item.id, []);

  const ListFooter = loadingMore ? (
    <View style={styles.footerLoader}>
      <ActivityIndicator size="small" color={c.primary} />
    </View>
  ) : loadMoreError ? (
    <Pressable onPress={loadMore} style={styles.footerLoader} accessibilityRole="button" accessibilityLabel="Retry loading more results">
      <Text style={[styles.footerText, { color: c.destructive ?? "#ef4444" }]}>
        Failed to load more — tap to retry
      </Text>
    </Pressable>
  ) : null;

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: c.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar barStyle={c.isMidnightTheme ? "light-content" : "dark-content"} />

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <View
        style={[
          styles.topBar,
          {
            paddingTop: insets.top + 8,
            backgroundColor: c.background,
            borderBottomColor: c.border,
          },
        ]}
      >
        <Pressable
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={12}
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <Feather name="arrow-left" size={22} color={c.foreground} />
        </Pressable>

        <View style={[styles.inputWrap, { backgroundColor: c.card, borderColor: c.border }]}>
          <Feather name="search" size={16} color={c.mutedForeground} />
          <TextInput
            ref={inputRef}
            style={[styles.input, { color: c.foreground }]}
            placeholder="Search sermons, preachers, topics…"
            placeholderTextColor={c.mutedForeground}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={handleSubmit}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="never"
          />
          {query.length > 0 && (
            <Pressable onPress={clearQuery} hitSlop={10}>
              <Feather name="x-circle" size={16} color={c.mutedForeground} />
            </Pressable>
          )}
        </View>
      </View>

      {/* ── Category filter strip ─────────────────────────────────────── */}
      {isSearching && (
        <FlatList
          horizontal
          data={CATEGORIES}
          keyExtractor={(cat) => cat.value}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.catRow}
          style={{ flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => setCategory(item.value as SermonCategory)}
              style={[
                styles.catPill,
                {
                  backgroundColor: category === item.value ? c.primary : c.card,
                  borderColor: category === item.value ? c.primary : c.border,
                },
              ]}
            >
              <Text
                style={[
                  styles.catPillText,
                  { color: category === item.value ? "#fff" : c.foreground },
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          )}
        />
      )}

      {/* ── Refresh / stale indicator — shown when a background refresh is
           running or has failed on top of existing results.
           The global NetworkBanner covers the fully-offline case. */}
      {isSearching && isOnline && (isRefreshing || !!refreshError) && (
        <View style={[styles.staleBanner, !!refreshError && styles.staleBannerFailed]}>
          <Feather
            name={refreshError ? "wifi-off" : "clock"}
            size={11}
            color={refreshError ? "#991b1b" : "#92400e"}
          />
          <Text style={[styles.staleBannerText, !!refreshError && styles.staleBannerTextFailed]}>
            {refreshError ? "Couldn't refresh — showing previous results" : "Refreshing results…"}
          </Text>
          {!!refreshError && (
            <Pressable onPress={refetch} hitSlop={8} accessibilityRole="button">
              <Text style={styles.staleBannerRetry}>Retry</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* ── Results ──────────────────────────────────────────────────── */}
      {isSearching ? (
        <>
          {loading && sermons.length === 0 ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color={c.primary} />
              <Text style={[styles.loadingText, { color: c.mutedForeground }]}>Searching…</Text>
            </View>
          ) : sermons.length === 0 ? (
            <View style={styles.centered}>
              <Feather name="search" size={52} color={c.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: c.foreground }]}>No results</Text>
              <Text style={[styles.emptyDesc, { color: c.mutedForeground }]}>
                No sermons match "{query}". Try a different keyword.
              </Text>
            </View>
          ) : (
            <FlatList
              data={sermons}
              keyExtractor={keyExtractor}
              renderItem={renderItem}
              ListHeaderComponent={
                <Text style={[styles.resultCount, { color: c.mutedForeground }]}>
                  {total} {total === 1 ? "result" : "results"}
                </Text>
              }
              ListFooterComponent={ListFooter}
              contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 100 }]}
              onEndReached={loadMore}
              onEndReachedThreshold={0.4}
              showsVerticalScrollIndicator={false}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              removeClippedSubviews={Platform.OS === "android"}
              maxToRenderPerBatch={10}
            />
          )}
        </>
      ) : (
        /* ── Recent searches ────────────────────────────────────────── */
        <ScrollView
          contentContainerStyle={[styles.recentWrap, { paddingBottom: insets.bottom + 100 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {recentLoaded && recent.length > 0 && (
            <>
              <View style={styles.recentHeader}>
                <Text style={[styles.recentTitle, { color: c.foreground }]}>Recent Searches</Text>
                <Pressable
                  onPress={async () => {
                    await AsyncStorage.removeItem(RECENT_KEY);
                    setRecent([]);
                  }}
                  hitSlop={10}
                >
                  <Text style={[styles.clearAll, { color: c.primary }]}>Clear all</Text>
                </Pressable>
              </View>
              {recent.map((q) => (
                <Pressable
                  key={q}
                  onPress={() => applyRecent(q)}
                  style={[styles.recentRow, { borderBottomColor: c.border }]}
                >
                  <Feather name="clock" size={15} color={c.mutedForeground} />
                  <Text style={[styles.recentText, { color: c.foreground }]} numberOfLines={1}>
                    {q}
                  </Text>
                  <Pressable
                    onPress={() => deleteRecent(q)}
                    hitSlop={10}
                    style={styles.recentDelete}
                  >
                    <Feather name="x" size={14} color={c.mutedForeground} />
                  </Pressable>
                </Pressable>
              ))}
            </>
          )}

          {/* Quick category shortcuts */}
          <Text style={[styles.recentTitle, { color: c.foreground, marginTop: recent.length > 0 ? 24 : 12 }]}>
            Browse by Category
          </Text>
          <View style={styles.catGrid}>
            {CATEGORIES.filter((c) => c.value !== "All").map((cat) => (
              <Pressable
                key={cat.value}
                onPress={() => {
                  setQuery(cat.label);
                  setCategory(cat.value as SermonCategory);
                }}
                style={[styles.catGridItem, { backgroundColor: c.card, borderColor: c.border }]}
              >
                <Text style={[styles.catGridText, { color: c.foreground }]}>{cat.label}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
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
  inputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },

  catRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  catPill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
  },
  catPillText: {
    fontSize: 13,
    fontWeight: "500",
  },

  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
    paddingBottom: 60,
  },
  loadingText: { fontSize: 14, marginTop: 8 },
  emptyTitle: { fontSize: 18, fontWeight: "700", textAlign: "center" },
  emptyDesc: { fontSize: 14, textAlign: "center", lineHeight: 20 },

  resultCount: {
    fontSize: 12,
    fontWeight: "500",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  list: { paddingTop: 4 },
  footerLoader: { paddingVertical: 16, alignItems: "center" },
  footerText: { fontSize: 13, textAlign: "center" },

  recentWrap: { paddingHorizontal: 16, paddingTop: 16 },
  recentHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  recentTitle: { fontSize: 16, fontWeight: "700", letterSpacing: -0.3, marginBottom: 8 },
  clearAll: { fontSize: 13, fontWeight: "600" },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  recentText: { flex: 1, fontSize: 15 },
  recentDelete: { padding: 4 },

  catGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 8,
  },
  catGridItem: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    minWidth: "44%",
    flexGrow: 1,
    alignItems: "center",
  },
  catGridText: { fontSize: 14, fontWeight: "600" },

  staleBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 12,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: "#fef3c7",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#fcd34d",
  },
  staleBannerFailed: {
    backgroundColor: "#fee2e2",
    borderColor: "#fca5a5",
  },
  staleBannerText: {
    flex: 1,
    fontSize: 12,
    color: "#92400e",
  },
  staleBannerTextFailed: {
    color: "#991b1b",
  },
  staleBannerRetry: {
    fontSize: 12,
    fontWeight: "600",
    color: "#991b1b",
    paddingLeft: 4,
  },
});
