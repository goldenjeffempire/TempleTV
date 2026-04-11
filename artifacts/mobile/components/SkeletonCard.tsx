import React, { useEffect, useRef } from "react";
import { Animated, Platform, StyleSheet, View } from "react-native";
import { useColors } from "@/hooks/useColors";
import colors from "@/constants/colors";

const ND = Platform.OS !== "web";

function Shimmer({ style }: { style: object }) {
  const c = useColors();
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 900, useNativeDriver: ND }),
        Animated.timing(shimmer, { toValue: 0, duration: 900, useNativeDriver: ND }),
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
  return (
    <View style={skeletonStyles.horizontalCard}>
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
    <View style={[skeletonStyles.liveBanner, { borderRadius: colors.radius }]}>
      <Shimmer style={skeletonStyles.liveThumb} />
    </View>
  );
}

const skeletonStyles = StyleSheet.create({
  verticalCard: { width: 200, gap: 8, padding: 4 },
  verticalThumb: { width: 200, height: 112, borderRadius: 12 },
  horizontalCard: { flexDirection: "row", gap: 12, padding: 12, marginHorizontal: 16, marginBottom: 8 },
  horizontalThumb: { width: 120, height: 68, borderRadius: 8 },
  horizontalInfo: { flex: 1, gap: 8, justifyContent: "center" },
  title1: { height: 14, width: "90%", borderRadius: 4 },
  title2: { height: 14, width: "65%", borderRadius: 4 },
  meta: { height: 11, width: "40%", borderRadius: 4 },
  liveBanner: { marginHorizontal: 16, marginBottom: 16, overflow: "hidden" },
  liveThumb: { height: 200, borderRadius: 16 },
});
