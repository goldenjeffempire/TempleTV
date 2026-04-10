import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { useColors } from "@/hooks/useColors";
import colors from "@/constants/colors";

function Shimmer({ style }: { style: object }) {
  const c = useColors();
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(shimmer, { toValue: 0, duration: 900, useNativeDriver: true }),
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

export function SkeletonVerticalCard() {
  return (
    <View style={skeletonStyles.verticalCard}>
      <Shimmer style={skeletonStyles.verticalThumb} />
      <Shimmer style={skeletonStyles.title1} />
      <Shimmer style={skeletonStyles.title2} />
      <Shimmer style={skeletonStyles.meta} />
    </View>
  );
}

export function SkeletonHorizontalCard() {
  const c = useColors();
  return (
    <View
      style={[
        skeletonStyles.horizontalCard,
        {
          backgroundColor: "rgba(106,13,173,0.08)",
          borderColor: c.border,
          borderRadius: colors.radius,
          borderWidth: 1,
        },
      ]}
    >
      <Shimmer style={skeletonStyles.horizontalThumb} />
      <View style={skeletonStyles.horizontalInfo}>
        <Shimmer style={skeletonStyles.hTitle1} />
        <Shimmer style={skeletonStyles.hTitle2} />
        <Shimmer style={skeletonStyles.hMeta} />
      </View>
    </View>
  );
}

export function SkeletonLiveBanner() {
  const c = useColors();
  return (
    <View
      style={[
        skeletonStyles.banner,
        { backgroundColor: c.muted, borderRadius: colors.radius },
      ]}
    >
      <Shimmer style={skeletonStyles.bannerBadge} />
      <Shimmer style={skeletonStyles.bannerTitle} />
      <Shimmer style={skeletonStyles.bannerSub} />
      <Shimmer style={skeletonStyles.bannerBtn} />
    </View>
  );
}

const skeletonStyles = StyleSheet.create({
  verticalCard: { width: 200, gap: 8 },
  verticalThumb: { width: 200, height: 112, borderRadius: 12 },
  title1: { height: 14, width: "90%", borderRadius: 4 },
  title2: { height: 14, width: "70%", borderRadius: 4 },
  meta: { height: 12, width: "50%", borderRadius: 4 },

  horizontalCard: { flexDirection: "row", padding: 12, gap: 12 },
  horizontalThumb: { width: 120, height: 68, borderRadius: 8 },
  horizontalInfo: { flex: 1, gap: 6, justifyContent: "center" },
  hTitle1: { height: 14, width: "90%", borderRadius: 4 },
  hTitle2: { height: 14, width: "65%", borderRadius: 4 },
  hMeta: { height: 11, width: "45%", borderRadius: 4 },

  banner: { marginHorizontal: 16, height: 220, padding: 20, justifyContent: "flex-end", gap: 10 },
  bannerBadge: { height: 28, width: 80, borderRadius: 20 },
  bannerTitle: { height: 22, width: "75%", borderRadius: 6 },
  bannerSub: { height: 14, width: "60%", borderRadius: 4 },
  bannerBtn: { height: 40, width: 140, borderRadius: 24 },
});
