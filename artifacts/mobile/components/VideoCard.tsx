/**
 * VideoCard — Reusable sermon/video card component.
 *
 * Supports two layouts:
 *  • default (vertical): thumbnail top, details below — for grid/row usage
 *  • horizontal: thumbnail left, details right — for list usage
 */

import React from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import type { Sermon } from "@/types";

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

interface VideoCardProps {
  sermon: Sermon;
  onPress: () => void;
  /** horizontal = list view, default = card/grid view */
  horizontal?: boolean;
  /** show a live indicator badge */
  showLiveBadge?: boolean;
}

function formatViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export const VideoCard = React.memo(function VideoCard({
  sermon,
  onPress,
  horizontal = false,
  showLiveBadge = false,
}: VideoCardProps) {
  const c = useColors();

  if (horizontal) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.horzContainer,
          { backgroundColor: c.card, borderBottomColor: c.border },
          pressed && { opacity: 0.75 },
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Play ${sermon.title}`}
      >
        {/* Thumbnail */}
        <View style={styles.horzThumbWrap}>
          <Image
            source={sermon.thumbnailUrl ? { uri: sermon.thumbnailUrl } : PLACEHOLDER}
            style={styles.horzThumb}
            defaultSource={PLACEHOLDER}
            // Fast-loading: skip the default 300 ms cross-fade so cached
            // thumbnails appear instantly; render progressively as bytes
            // arrive instead of waiting for the full JPEG to decode.
            fadeDuration={0}
            progressiveRenderingEnabled
          />
          {showLiveBadge && (
            <View style={styles.liveBadge}>
              <Text style={styles.liveText}>LIVE</Text>
            </View>
          )}
          {!!sermon.duration && (
            <View style={styles.durationBadge}>
              <Text style={styles.durationText}>{sermon.duration}</Text>
            </View>
          )}
        </View>

        {/* Details */}
        <View style={styles.horzDetails}>
          <Text
            style={[styles.horzTitle, { color: c.foreground }]}
            numberOfLines={2}
          >
            {sermon.title}
          </Text>
          <Text
            style={[styles.horzPreacher, { color: c.mutedForeground }]}
            numberOfLines={1}
          >
            {sermon.preacher}
          </Text>
          <View style={styles.horzMeta}>
            {!!sermon.category && sermon.category !== "All" && (
              <View style={[styles.categoryTag, { backgroundColor: c.primary + "22" }]}>
                <Text style={[styles.categoryTagText, { color: c.primary }]}>
                  {sermon.category}
                </Text>
              </View>
            )}
            {!!sermon.views && (
              <Text style={[styles.views, { color: c.mutedForeground }]}>
                {formatViews(sermon.views)} views
              </Text>
            )}
          </View>
        </View>

        <Feather name="chevron-right" size={16} color={c.mutedForeground} style={{ alignSelf: "center" }} />
      </Pressable>
    );
  }

  // Vertical (card) layout
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.cardContainer,
        { backgroundColor: c.card, borderColor: c.border },
        pressed && { opacity: 0.75 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Play ${sermon.title}`}
    >
      {/* Thumbnail */}
      <View style={styles.cardThumbWrap}>
        <Image
          source={sermon.thumbnailUrl ? { uri: sermon.thumbnailUrl } : PLACEHOLDER}
          style={styles.cardThumb}
          defaultSource={PLACEHOLDER}
          // Fast-loading: instant paint from cache + progressive render.
          fadeDuration={0}
          progressiveRenderingEnabled
        />
        {showLiveBadge && (
          <View style={styles.liveBadge}>
            <Text style={styles.liveText}>LIVE</Text>
          </View>
        )}
        {!!sermon.duration && (
          <View style={styles.durationBadge}>
            <Text style={styles.durationText}>{sermon.duration}</Text>
          </View>
        )}
        <View style={styles.playOverlay}>
          <Feather name="play-circle" size={32} color="rgba(255,255,255,0.85)" />
        </View>
      </View>

      {/* Details */}
      <View style={styles.cardDetails}>
        <Text
          style={[styles.cardTitle, { color: c.foreground }]}
          numberOfLines={2}
        >
          {sermon.title}
        </Text>
        <Text
          style={[styles.cardPreacher, { color: c.mutedForeground }]}
          numberOfLines={1}
        >
          {sermon.preacher}
        </Text>
        {!!sermon.views && (
          <Text style={[styles.views, { color: c.mutedForeground }]}>
            {formatViews(sermon.views)} views
          </Text>
        )}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  // Horizontal (list) layout
  horzContainer: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  horzThumbWrap: {
    width: 120,
    height: 68,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: "#111",
    flexShrink: 0,
  },
  horzThumb: { width: "100%", height: "100%" },
  horzDetails: { flex: 1, gap: 4 },
  horzTitle: { fontSize: 14, fontWeight: "600", lineHeight: 20 },
  horzPreacher: { fontSize: 12 },
  horzMeta: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },

  // Vertical (card) layout
  cardContainer: {
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    width: 180,
  },
  cardThumbWrap: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: "#111",
    position: "relative",
  },
  cardThumb: { width: "100%", height: "100%" },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  cardDetails: { padding: 10, gap: 3 },
  cardTitle: { fontSize: 13, fontWeight: "600", lineHeight: 18 },
  cardPreacher: { fontSize: 11 },

  // Shared
  liveBadge: {
    position: "absolute",
    top: 6,
    left: 6,
    backgroundColor: "#ef4444",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  liveText: { fontSize: 10, fontWeight: "700", color: "#fff", letterSpacing: 0.5 },
  durationBadge: {
    position: "absolute",
    bottom: 4,
    right: 4,
    backgroundColor: "rgba(0,0,0,0.75)",
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  durationText: { fontSize: 10, color: "#fff", fontWeight: "600" },
  categoryTag: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  categoryTagText: { fontSize: 10, fontWeight: "600" },
  views: { fontSize: 11 },
});
