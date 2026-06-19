import React, { useEffect, useRef } from "react";
import { Animated, Platform, StyleSheet, View, useWindowDimensions } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useColors } from "@/hooks/useColors";
import colors from "@/constants/colors";
import { getCardWidth, CARD_ASPECT_RATIO, DURATION } from "@/constants/design";

const ND = Platform.OS !== "web";

function Shimmer({ style }: { style: object }) {
  const c = useColors();
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: DURATION.skeleton, useNativeDriver: ND }),
        Animated.timing(shimmer, { toValue: 0, duration: DURATION.skeleton, useNativeDriver: ND }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [shimmer]);

  const opacity = shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.7] });

  return (
    <Animated.View
      style={[{ backgroundColor: c.muted, borderRadius: 6, opacity }, style]}
    />
  );
}

/**
 * SkeletonVerticalCard — matches VideoCard vertical layout exactly.
 * Width and thumbnail height are computed from the current screen width using
 * the same getCardWidth() function VideoCard uses, so skeleton ↔ real card
 * dimensions are always in sync.
 */
export function SkeletonVerticalCard() {
  const { width: screenWidth } = useWindowDimensions();
  const cardWidth = getCardWidth(screenWidth);
  const thumbHeight = Math.round(cardWidth / CARD_ASPECT_RATIO);

  return (
    <View
      style={[skeletonStyles.verticalCard, { width: cardWidth }]}
      accessibilityElementsHidden={true}
      importantForAccessibility="no-hide-descendants"
    >
      <Shimmer style={{ width: cardWidth, height: thumbHeight, borderRadius: 10, marginBottom: 0 }} />
      <Shimmer style={skeletonStyles.title1} />
      <Shimmer style={skeletonStyles.title2} />
      <Shimmer style={skeletonStyles.meta} />
    </View>
  );
}

export function SkeletonHorizontalCard() {
  return (
    <View
      style={skeletonStyles.horizontalCard}
      accessibilityElementsHidden={true}
      importantForAccessibility="no-hide-descendants"
    >
      <Shimmer style={skeletonStyles.horizontalThumb} />
      <View style={skeletonStyles.horizontalInfo}>
        <Shimmer style={skeletonStyles.title1} />
        <Shimmer style={skeletonStyles.title2} />
        <Shimmer style={skeletonStyles.meta} />
      </View>
    </View>
  );
}

export function SkeletonLiveBanner() {
  return (
    <View
      style={[skeletonStyles.liveBanner, { borderRadius: colors.radius }]}
      accessibilityElementsHidden={true}
      importantForAccessibility="no-hide-descendants"
    >
      <Shimmer style={skeletonStyles.liveThumb} />
    </View>
  );
}

/**
 * SkeletonChannelCard — matches ChannelCard layout: left color strip + icon badge + text lines.
 */
export function SkeletonChannelCard() {
  const c = useColors();
  return (
    <View
      style={[skeletonStyles.channelCard, { backgroundColor: c.card, borderRadius: 14, overflow: "hidden" }]}
      accessibilityElementsHidden={true}
      importantForAccessibility="no-hide-descendants"
    >
      <Shimmer style={skeletonStyles.channelStrip} />
      <View style={skeletonStyles.channelContent}>
        <Shimmer style={skeletonStyles.channelIcon} />
        <View style={skeletonStyles.channelText}>
          <Shimmer style={skeletonStyles.channelTitle} />
          <Shimmer style={skeletonStyles.channelDesc} />
        </View>
        <Shimmer style={skeletonStyles.channelChevron} />
      </View>
    </View>
  );
}

/**
 * SkeletonPlaylistItem — matches PlaylistCard layout: thumbnail left, title + count right.
 */
export function SkeletonPlaylistItem() {
  const c = useColors();
  return (
    <View
      style={[skeletonStyles.playlistItem, { backgroundColor: c.card }]}
      accessibilityElementsHidden={true}
      importantForAccessibility="no-hide-descendants"
    >
      <Shimmer style={skeletonStyles.playlistThumb} />
      <View style={skeletonStyles.playlistInfo}>
        <Shimmer style={skeletonStyles.title1} />
        <Shimmer style={skeletonStyles.title2} />
        <Shimmer style={skeletonStyles.meta} />
      </View>
    </View>
  );
}

/**
 * SkeletonSeriesCard — matches SeriesCard layout in Library: thumbnail left (100×80) + info right.
 */
export function SkeletonSeriesCard() {
  const c = useColors();
  return (
    <View
      style={[skeletonStyles.seriesCard, { backgroundColor: c.card, borderRadius: 12 }]}
      accessibilityElementsHidden={true}
      importantForAccessibility="no-hide-descendants"
    >
      <Shimmer style={skeletonStyles.seriesThumb} />
      <View style={skeletonStyles.seriesInfo}>
        <Shimmer style={skeletonStyles.title1} />
        <Shimmer style={skeletonStyles.title2} />
        <Shimmer style={skeletonStyles.meta} />
      </View>
    </View>
  );
}

/**
 * Full-bleed hero skeleton — shown while the broadcast WS connection is being
 * established (lastServerSnapshot === null). Covers the hero area with a dark
 * shimmer background + bottom placeholder rows so the first visible frame is
 * never a jarring blank box.
 *
 * Designed to sit as an absolutely-positioned overlay inside the hero Pressable
 * and fade out via an Animated.Value supplied by the parent.
 */
export function SkeletonHero() {
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 1200, useNativeDriver: ND }),
        Animated.timing(shimmer, { toValue: 0, duration: 1200, useNativeDriver: ND }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [shimmer]);

  const sweepOpacity = shimmer.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0, 0.07, 0],
  });

  const placeholderOpacity = shimmer.interpolate({
    inputRange: [0, 1],
    outputRange: [0.25, 0.45],
  });

  return (
    <View style={[StyleSheet.absoluteFill, heroSkeletonStyles.root]}>
      {/* Slow shimmer sweep over the full area */}
      <Animated.View
        style={[StyleSheet.absoluteFill, heroSkeletonStyles.sweep, { opacity: sweepOpacity }]}
      />

      {/* Bottom gradient + placeholder rows */}
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.55)", "rgba(0,0,0,0.88)"]}
        locations={[0.35, 0.65, 1]}
        style={[StyleSheet.absoluteFill, heroSkeletonStyles.gradient]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
      >
        <View style={heroSkeletonStyles.contentArea}>
          {/* Badge placeholder */}
          <Animated.View style={[heroSkeletonStyles.badge, { opacity: placeholderOpacity }]} />

          {/* Title line 1 */}
          <Animated.View style={[heroSkeletonStyles.titleLine1, { opacity: placeholderOpacity }]} />

          {/* Title line 2 */}
          <Animated.View style={[heroSkeletonStyles.titleLine2, { opacity: placeholderOpacity }]} />

          {/* Button placeholder */}
          <Animated.View style={[heroSkeletonStyles.button, { opacity: placeholderOpacity }]} />
        </View>
      </LinearGradient>
    </View>
  );
}

const heroSkeletonStyles = StyleSheet.create({
  root: { backgroundColor: "#0d0020", overflow: "hidden" },
  sweep: { backgroundColor: "#ffffff" },
  gradient: { justifyContent: "flex-end" },
  contentArea: { paddingHorizontal: 16, paddingBottom: 20, gap: 10 },
  badge: {
    height: 18,
    width: 60,
    borderRadius: 5,
    backgroundColor: "rgba(255,255,255,0.5)",
  },
  titleLine1: {
    height: 20,
    width: "72%",
    borderRadius: 5,
    backgroundColor: "rgba(255,255,255,0.5)",
  },
  titleLine2: {
    height: 20,
    width: "48%",
    borderRadius: 5,
    backgroundColor: "rgba(255,255,255,0.5)",
    marginBottom: 4,
  },
  button: {
    height: 36,
    width: 120,
    borderRadius: 24,
    backgroundColor: "rgba(255,255,255,0.35)",
  },
});

const skeletonStyles = StyleSheet.create({
  // Vertical card — width set dynamically via useWindowDimensions
  verticalCard: { gap: 8, padding: 4 },
  // Horizontal list card
  horizontalCard: { flexDirection: "row", gap: 12, padding: 12, marginHorizontal: 16, marginBottom: 8 },
  horizontalThumb: { width: 120, height: 68, borderRadius: 8 },
  horizontalInfo: { flex: 1, gap: 8, justifyContent: "center" },
  title1: { height: 14, width: "90%", borderRadius: 4 },
  title2: { height: 14, width: "65%", borderRadius: 4 },
  meta: { height: 11, width: "40%", borderRadius: 4 },
  liveBanner: { marginHorizontal: 16, marginBottom: 16, overflow: "hidden" },
  liveThumb: { height: 200, borderRadius: 16 },
  // Channel card — left strip + icon badge + text
  channelCard: { flexDirection: "row", marginBottom: 10, height: 72 },
  channelStrip: { width: 4, height: "100%", borderRadius: 0, opacity: 0.15 },
  channelContent: { flex: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: 14, gap: 12 },
  channelIcon: { width: 44, height: 44, borderRadius: 12 },
  channelText: { flex: 1, gap: 8 },
  channelTitle: { height: 14, width: "65%", borderRadius: 4 },
  channelDesc: { height: 11, width: "45%", borderRadius: 4 },
  channelChevron: { width: 18, height: 18, borderRadius: 4 },
  // Playlist item — thumbnail left + info right
  playlistItem: { flexDirection: "row", gap: 12, padding: 12, borderRadius: 0 },
  playlistThumb: { width: 120, height: 68, borderRadius: 8 },
  playlistInfo: { flex: 1, gap: 8, justifyContent: "center" },
  // Series card — thumbnail left (100×80) + info right
  seriesCard: { flexDirection: "row", overflow: "hidden" },
  seriesThumb: { width: 100, height: 80, borderRadius: 0 },
  seriesInfo: { flex: 1, padding: 12, gap: 8, justifyContent: "center" },
});
