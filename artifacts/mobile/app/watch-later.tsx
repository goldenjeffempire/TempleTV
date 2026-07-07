import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

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
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { SermonCard } from "@/components/SermonCard";
import { AppHeader } from "@/components/AppHeader";
import { useWatchLater } from "@/hooks/useWatchLater";
import type { Sermon } from "@/types";

function navigateToSermon(sermon: Sermon) {
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

export default function WatchLaterScreen() {
  const insets = useSafeAreaInsets();
  const c = useColors();
  const { watchLater, removeFromWatchLater, clearWatchLater } = useWatchLater();

  const handleRemove = useCallback(
    (sermon: Sermon) => {
      Alert.alert(
        "Remove",
        `Remove "${sermon.title}" from Watch Later?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: () => removeFromWatchLater(sermon.id),
          },
        ],
      );
    },
    [removeFromWatchLater],
  );

  const handleClearAll = useCallback(() => {
    if (watchLater.length === 0) return;
    Alert.alert(
      "Clear Watch Later",
      "Remove all videos from your Watch Later list?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear All",
          style: "destructive",
          onPress: () => clearWatchLater(),
        },
      ],
    );
  }, [watchLater.length, clearWatchLater]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.container, { backgroundColor: c.background }]}>
        <AppHeader
          title={watchLater.length > 0 ? `Watch Later (${watchLater.length})` : "Watch Later"}
          onBack={() => router.back()}
          rightLabel={watchLater.length > 0 ? {
            text: "Clear All",
            onPress: handleClearAll,
            accessibilityLabel: "Clear all watch later",
          } : undefined}
        />

        <FlatList
          data={watchLater}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: insets.bottom + 24 },
          ]}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Feather name="clock" size={48} color={c.mutedForeground} style={styles.emptyIcon} />
              <Text style={[styles.emptyTitle, { color: c.foreground }]}>
                No videos saved
              </Text>
              <Text style={[styles.emptySubtitle, { color: c.mutedForeground }]}>
                Tap the bookmark icon on any video to save it for later
              </Text>
              <Pressable
                style={[styles.browseBtn, { backgroundColor: c.primary }]}
                onPress={() => router.replace("/(tabs)/library")}
              >
                <Text style={styles.browseBtnText}>Browse Library</Text>
              </Pressable>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.itemRow}>
              <View style={styles.cardWrap}>
                <SermonCard
                  sermon={item}
                  onPress={() => navigateToSermon(item)}
                  variant="horizontal"
                />
              </View>
              <Pressable
                onPress={() => handleRemove(item)}
                style={[styles.removeBtn, { backgroundColor: c.card }]}
                accessibilityLabel={`Remove ${item.title} from watch later`}
                hitSlop={8}
              >
                <Feather name="x" size={16} color={c.mutedForeground} />
              </Pressable>
            </View>
          )}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { flexGrow: 1 },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 8,
  },
  cardWrap: { flex: 1 },
  removeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 4,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    paddingTop: 80,
    gap: 12,
  },
  emptyIcon: { marginBottom: 8 },
  emptyTitle: { fontSize: 20, fontWeight: "700", textAlign: "center" },
  emptySubtitle: { fontSize: 14, textAlign: "center", lineHeight: 22 },
  browseBtn: {
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
  },
  browseBtnText: { color: "#fff", fontWeight: "600", fontSize: 15 },
});
