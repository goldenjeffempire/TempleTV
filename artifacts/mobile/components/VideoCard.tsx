/**
 * VideoCard — Reusable sermon/video card component.
 *
 * Supports two layouts:
 *  • default (vertical): thumbnail top, details below — for horizontal scroll rows
 *  • horizontal: thumbnail left, details right — for list/related usage
 *
 * Uses expo-image for intelligent caching, progressive loading, and smooth
 * transitions — significantly faster repeat loads vs React Native's Image.
 *
 * Card width is responsive: computed from the current screen width so two cards
 * always fit in a row even on 320 px phones (getCardWidth clamps 148–220 px).
 */

import React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import type { Sermon } from "@/types";
import { VideoLiveStatusBadge } from "@/components/LiveBadge";
import { getCardWidth, CARD_ASPECT_RATIO } from "@/constants/design";

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

interface VideoCardProps {
  sermon: Sermon;
  onPress: () => void;
  /** horizontal = list view, default = card/grid view */
  horizontal?: boolean;
  /** show a live indicator badge (legacy — prefer sermon.youtubeLiveStatus) */
  showLiveBadge?: boolean;
  /**
   * Override card width. Defaults to getCardWidth(screenWidth) — a responsive
   * value that guarantees two cards + gap fit in any scroll row from 320 px up.
   */
  cardWidth?: number;
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
  cardWidth: cardWidthProp,
}: VideoCardProps) {
  const c = useColors();
  const { width: screenWidth } = useWindowDimensions();
  const cardWidth = cardWidthProp ?? getCardWidth(screenWidth);
  const thumbHeight = Math.round(cardWidth / CARD_ASPECT_RATIO);

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
            placeholder={PLACEHOLDER}
            style={styles.horzThumb}
            contentFit="cover"
            contentPosition="top"
            transition={150}
          />
          {(sermon.youtubeLiveStatus || showLiveBadge) && (
            <View style={styles.badgeTopLeft}>
              {sermon.youtubeLiveStatus
                ? <VideoLiveStatusBadge status={sermon.youtubeLiveStatus} size="small" />
                : <View style={styles.liveBadge}><Text style={styles.liveText}>LIVE</Text></View>
              }
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
          {!!sermon.preacher && (
            <Text
              style={[styles.horzPreacher, { color: c.mutedForeground }]}
              numberOfLines={1}
            >
              {sermon.preacher}
            </Text>
          )}
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

  // ── Vertical (card) layout ────────────────────────────────────────────────
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.cardContainer,
        { backgroundColor: c.card, borderColor: c.border, width: cardWidth },
        pressed && { opacity: 0.75 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Play ${sermon.title}`}
    >
      {/* Thumbnail — responsive 16:9 */}
      <View style={[styles.cardThumbWrap, { height: thumbHeight }]}>
        <Image
          source={sermon.thumbnailUrl ? { uri: sermon.thumbnailUrl } : PLACEHOLDER}
          placeholder={PLACEHOLDER}
          style={styles.cardThumb}
          contentFit="cover"
          contentPosition="top"
          transition={150}
        />
        {(sermon.youtubeLiveStatus || showLiveBadge) && (
          <View style={styles.badgeTopLeft}>
            {sermon.youtubeLiveStatus
              ? <VideoLiveStatusBadge status={sermon.youtubeLiveStatus} size="small" />
              : <View style={styles.liveBadge}><Text style={styles.liveText}>LIVE</Text></View>
            }
          </View>
        )}
        {!!sermon.duration && (
          <View style={styles.durationBadge}>
            <Text style={styles.durationText}>{sermon.duration}</Text>
          </View>
        )}
        {/* Play overlay — only rendered when thumbnail is present */}
        {sermon.thumbnailUrl && (
          <View style={styles.playOverlay}>
            <View style={styles.playCircle}>
              <Feather name="play" size={14} color="#fff" style={{ marginLeft: 2 }} />
            </View>
          </View>
        )}
      </View>

      {/* Details */}
      <View style={styles.cardDetails}>
        <Text
          style={[styles.cardTitle, { color: c.foreground }]}
          numberOfLines={2}
        >
          {sermon.title}
        </Text>
        {!!sermon.preacher && (
          <Text
            style={[styles.cardPreacher, { color: c.mutedForeground }]}
            numberOfLines={1}
          >
            {sermon.preacher}
          </Text>
        )}
        <View style={styles.cardMeta}>
          {!!sermon.category && sermon.category !== "All" && (
            <View style={[styles.categoryTag, { backgroundColor: c.primary + "18" }]}>
              <Text style={[styles.categoryTagText, { color: c.primary }]}>
                {sermon.category}
              </Text>
            </View>
          )}
          {!!sermon.views && (
            <Text style={[styles.views, { color: c.mutedForeground }]}>
              {formatViews(sermon.views)}
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  // ── Horizontal (list) layout ──────────────────────────────────────────────
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
  horzDetails: { flex: 1, gap: 4, minWidth: 0 },
  horzTitle: { fontSize: 14, fontWeight: "600", lineHeight: 20 },
  horzPreacher: { fontSize: 12 },
  horzMeta: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 2 },

  // ── Vertical (card) layout — width set dynamically per-render ─────────────
  cardContainer: {
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    // width injected at render time from getCardWidth(screenWidth)
  },
  cardThumbWrap: {
    width: "100%",
    backgroundColor: "#111",
    // height set dynamically: Math.round(cardWidth / CARD_ASPECT_RATIO)
  },
  cardThumb: { width: "100%", height: "100%" },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  playCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.7)",
  },
  cardDetails: { padding: 10, gap: 4 },
  cardTitle: { fontSize: 13, fontWeight: "600", lineHeight: 18 },
  cardPreacher: { fontSize: 11 },
  cardMeta: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 2 },

  // ── Shared ────────────────────────────────────────────────────────────────
  badgeTopLeft: {
    position: "absolute",
    top: 6,
    left: 6,
  },
  liveBadge: {
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
    borderRadius: 5,
  },
  categoryTagText: { fontSize: 10, fontWeight: "600" },
  views: { fontSize: 11 },
});
