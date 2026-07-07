import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { AppHeader } from "@/components/AppHeader";
import { useDownloadContext } from "@/context/DownloadContext";
import type { DownloadItem } from "@/services/downloadManager";

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function ProgressBar({ progress, color }: { progress: number; color: string }) {
  return (
    <View style={styles.progressTrack}>
      <View
        style={[
          styles.progressFill,
          { width: `${Math.round(progress * 100)}%` as `${number}%`, backgroundColor: color },
        ]}
      />
    </View>
  );
}

function DownloadRow({ item }: { item: DownloadItem }) {
  const c = useColors();
  const { pauseDownload, resumeDownload, cancelDownload, retryDownload } = useDownloadContext();

  const handlePlay = () => {
    if (!item.localPath) return;
    router.push({
      pathname: "/player",
      params: {
        id: item.videoId,
        title: item.videoTitle,
        localVideoUrl: item.localPath,
        thumbnailUrl: item.thumbnailUrl,
        duration: item.duration,
        category: item.category,
        preacher: item.preacher,
      },
    });
  };

  const handleCancel = () => {
    Alert.alert(
      "Cancel Download",
      `Cancel downloading "${item.videoTitle}"?`,
      [
        { text: "Keep", style: "cancel" },
        { text: "Cancel Download", style: "destructive", onPress: () => cancelDownload(item.videoId) },
      ],
    );
  };

  const isActive = item.status === "downloading" || item.status === "queued";
  const isPaused = item.status === "paused";
  const isCompleted = item.status === "completed";
  const isFailed = item.status === "failed";

  const progressPct = Math.round(item.progress * 100);
  const statusColor =
    isCompleted ? c.primary :
    isFailed ? "#ef4444" :
    isActive ? c.primary :
    c.mutedForeground;

  const statusLabel =
    isCompleted ? "Downloaded" :
    isFailed ? (item.error ?? "Failed") :
    item.status === "queued" ? "Waiting…" :
    item.status === "downloading" ? `${progressPct}%` :
    "Paused";

  return (
    <View style={[styles.rowContainer, { backgroundColor: c.card, borderColor: c.border }]}>
      {/* Thumbnail */}
      <View style={styles.thumb}>
        <Image
          source={item.thumbnailUrl ? { uri: item.thumbnailUrl } : PLACEHOLDER}
          placeholder={PLACEHOLDER}
          style={styles.thumbImg}
          contentFit="cover"
        />
        {isCompleted && (
          <Pressable style={styles.playOverlay} onPress={handlePlay} accessibilityLabel="Play downloaded video">
            <View style={[styles.playCircle, { backgroundColor: c.primary }]}>
              <Feather name="play" size={14} color="#fff" style={{ marginLeft: 2 }} />
            </View>
          </Pressable>
        )}
      </View>

      {/* Info */}
      <View style={styles.info}>
        <Text style={[styles.title, { color: c.foreground }]} numberOfLines={2}>
          {item.videoTitle}
        </Text>
        {!!item.preacher && (
          <Text style={[styles.preacher, { color: c.mutedForeground }]} numberOfLines={1}>
            {item.preacher}
          </Text>
        )}

        {/* Progress bar for active / paused */}
        {(isActive || isPaused) && (
          <ProgressBar progress={item.progress} color={statusColor} />
        )}

        {/* Status line */}
        <View style={styles.statusRow}>
          <Text style={[styles.statusText, { color: statusColor }]}>
            {statusLabel}
          </Text>
          {(isActive || isPaused) && item.totalBytes != null && (
            <Text style={[styles.sizeText, { color: c.mutedForeground }]}>
              {formatBytes(item.downloadedBytes)} / {formatBytes(item.totalBytes)}
            </Text>
          )}
          {isCompleted && item.totalBytes != null && (
            <Text style={[styles.sizeText, { color: c.mutedForeground }]}>
              {formatBytes(item.totalBytes)}
            </Text>
          )}
        </View>
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        {isActive && (
          <Pressable
            onPress={() => pauseDownload(item.videoId)}
            style={styles.actionBtn}
            accessibilityLabel="Pause download"
            hitSlop={8}
          >
            <Feather name="pause" size={18} color={c.foreground} />
          </Pressable>
        )}
        {isPaused && (
          <Pressable
            onPress={() => resumeDownload(item.videoId)}
            style={styles.actionBtn}
            accessibilityLabel="Resume download"
            hitSlop={8}
          >
            <Feather name="play" size={18} color={c.primary} />
          </Pressable>
        )}
        {isFailed && (
          <Pressable
            onPress={() => retryDownload(item.videoId)}
            style={styles.actionBtn}
            accessibilityLabel="Retry download"
            hitSlop={8}
          >
            <Feather name="refresh-cw" size={18} color={c.primary} />
          </Pressable>
        )}
        {isCompleted && (
          <Pressable
            onPress={handlePlay}
            style={styles.actionBtn}
            accessibilityLabel="Play video"
            hitSlop={8}
          >
            <Feather name="play-circle" size={20} color={c.primary} />
          </Pressable>
        )}
        <Pressable
          onPress={isCompleted ? () => {
            Alert.alert(
              "Delete Download",
              `Delete the downloaded copy of "${item.videoTitle}"?`,
              [
                { text: "Cancel", style: "cancel" },
                { text: "Delete", style: "destructive", onPress: () => cancelDownload(item.videoId) },
              ],
            );
          } : handleCancel}
          style={styles.actionBtn}
          accessibilityLabel="Remove download"
          hitSlop={8}
        >
          <Feather name="trash-2" size={18} color={c.mutedForeground} />
        </Pressable>
      </View>
    </View>
  );
}

export default function DownloadsScreen() {
  const insets = useSafeAreaInsets();
  const c = useColors();
  const { downloads, clearCompleted, clearAll, getTotalStorageBytes } = useDownloadContext();
  const [totalStorage, setTotalStorage] = useState<number>(0);

  useEffect(() => {
    let active = true;
    getTotalStorageBytes()
      .then((bytes) => { if (active) setTotalStorage(bytes); })
      .catch(() => {});
    return () => { active = false; };
  }, [downloads, getTotalStorageBytes]);

  const handleClearAll = useCallback(() => {
    if (downloads.length === 0) return;
    Alert.alert(
      "Clear All Downloads",
      "Delete all downloaded videos from your device?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete All", style: "destructive", onPress: () => clearAll() },
      ],
    );
  }, [downloads.length, clearAll]);

  const handleClearCompleted = useCallback(() => {
    Alert.alert(
      "Clear Completed",
      "Delete all completed downloads from your device?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => clearCompleted() },
      ],
    );
  }, [clearCompleted]);

  const completed = downloads.filter((d) => d.status === "completed");
  const hasCompleted = completed.length > 0;

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.container, { backgroundColor: c.background }]}>
        <AppHeader
          title={downloads.length > 0 ? `Downloads · ${formatBytes(totalStorage)}` : "Downloads"}
          onBack={() => router.back()}
          rightLabel={downloads.length > 0 ? {
            text: hasCompleted ? "Clear Done" : "Clear All",
            onPress: hasCompleted ? handleClearCompleted : handleClearAll,
            accessibilityLabel: hasCompleted ? "Clear completed downloads" : "Clear all downloads",
          } : undefined}
        />

        <FlatList
          data={downloads}
          keyExtractor={(item) => item.videoId}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: insets.bottom + 24 },
          ]}
          ListHeaderComponent={
            downloads.length > 0 ? (
              <View style={[styles.infoBar, { backgroundColor: c.card, borderBottomColor: c.border }]}>
                <Feather name="info" size={14} color={c.mutedForeground} />
                <Text style={[styles.infoText, { color: c.mutedForeground }]}>
                  Downloads are available for offline playback. Only server-hosted videos can be downloaded.
                </Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Feather name="download" size={48} color={c.mutedForeground} style={styles.emptyIcon} />
              <Text style={[styles.emptyTitle, { color: c.foreground }]}>
                No downloads yet
              </Text>
              <Text style={[styles.emptySubtitle, { color: c.mutedForeground }]}>
                Download server-hosted videos to watch them offline. Look for the download icon on video cards.
              </Text>
              <Pressable
                style={[styles.browseBtn, { backgroundColor: c.primary }]}
                onPress={() => router.replace("/(tabs)/library")}
              >
                <Text style={styles.browseBtnText}>Browse Library</Text>
              </Pressable>
            </View>
          }
          renderItem={({ item }) => <DownloadRow item={item} />}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { flexGrow: 1, paddingTop: 8 },
  infoBar: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
  },
  infoText: { flex: 1, fontSize: 12, lineHeight: 18 },

  rowContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    padding: 10,
    gap: 10,
  },

  thumb: {
    width: 80,
    height: 52,
    borderRadius: 6,
    overflow: "hidden",
    backgroundColor: "#111",
    flexShrink: 0,
  },
  thumbImg: { width: "100%", height: "100%" },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  playCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    opacity: 0.9,
  },

  info: { flex: 1, gap: 4, minWidth: 0 },
  title: { fontSize: 13, fontWeight: "600", lineHeight: 18 },
  preacher: { fontSize: 11 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  statusText: { fontSize: 12, fontWeight: "500" },
  sizeText: { fontSize: 11 },

  progressTrack: {
    height: 3,
    backgroundColor: "#e5e7eb",
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: 2 },

  actions: { flexDirection: "column", gap: 8, alignItems: "center" },
  actionBtn: { padding: 4 },

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
