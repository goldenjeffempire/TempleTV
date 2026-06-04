import React, { useCallback } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { SermonCard } from "@/components/SermonCard";
import { useWatchHistory } from "@/hooks/useWatchHistory";
import type { HistoryEntry } from "@/hooks/useWatchHistory";
import type { Sermon } from "@/types";

function formatWatchedAt(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
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

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const c = useColors();
  const { history, clearHistory } = useWatchHistory();

  const handleClearAll = useCallback(() => {
    Alert.alert(
      "Clear Watch History",
      "This will permanently remove all videos from your watch history.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear All", style: "destructive", onPress: clearHistory },
      ],
    );
  }, [clearHistory]);

  const renderItem = useCallback(
    ({ item }: { item: HistoryEntry }) => (
      <View style={styles.itemRow}>
        <View style={{ flex: 1 }}>
          <SermonCard
            sermon={item.sermon}
            onPress={() => navigateToSermon(item.sermon)}
            variant="horizontal"
          />
        </View>
        <Text style={[styles.watchedAt, { color: c.mutedForeground }]}>
          {formatWatchedAt(item.watchedAt)}
        </Text>
      </View>
    ),
    [c],
  );

  const keyExtractor = useCallback((item: HistoryEntry) => `${item.sermon.id}-${item.watchedAt}`, []);

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, backgroundColor: c.background, borderBottomColor: c.border },
        ]}
      >
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8} accessibilityRole="button" accessibilityLabel="Go back">
          <Feather name="arrow-left" size={22} color={c.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: c.foreground }]}>Watch History</Text>
        {history.length > 0 && (
          <Pressable onPress={handleClearAll} hitSlop={8}>
            <Text style={styles.clearAll}>Clear All</Text>
          </Pressable>
        )}
      </View>

      {history.length === 0 ? (
        <View style={styles.empty}>
          <View style={[styles.emptyIcon, { backgroundColor: c.primary + "22" }]}>
            <Feather name="clock" size={36} color={c.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: c.foreground }]}>No watch history</Text>
          <Text style={[styles.emptyDesc, { color: c.mutedForeground }]}>
            Videos you watch will appear here so you can easily find them again.
          </Text>
          <Pressable
            onPress={() => router.push("/(tabs)/library")}
            style={[styles.browseBtn, { backgroundColor: c.primary }]}
          >
            <Feather name="play-circle" size={16} color="#fff" />
            <Text style={styles.browseBtnText}>Start Watching</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={history}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 100 }]}
          showsVerticalScrollIndicator={false}
          ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: c.border }]} />}
          ListHeaderComponent={
            <Text style={[styles.historyCount, { color: c.mutedForeground }]}>
              {history.length} {history.length === 1 ? "video" : "videos"} watched
            </Text>
          }
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
  clearAll: { fontSize: 14, color: "#ef4444", fontWeight: "500" },
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
  list: { paddingTop: 4 },
  historyCount: {
    fontSize: 13,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  itemRow: {
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  watchedAt: {
    fontSize: 11,
    paddingHorizontal: 16,
    paddingBottom: 4,
    textAlign: "right",
  },
  separator: { height: StyleSheet.hairlineWidth, marginHorizontal: 16 },
});
