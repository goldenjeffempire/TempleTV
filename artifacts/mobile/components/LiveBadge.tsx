import React, { useEffect, useRef } from "react";
import { Animated, Platform, StyleSheet, Text, View } from "react-native";

const ND = Platform.OS !== "web";

export function LiveBadge({ size = "medium" }: { size?: "small" | "medium" | "large" }) {
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.4, duration: 800, useNativeDriver: ND }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: ND }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [pulseAnim]);

  const fontSize = size === "small" ? 10 : size === "large" ? 16 : 12;
  const dotSize = size === "small" ? 6 : size === "large" ? 10 : 8;
  const paddingH = size === "small" ? 8 : size === "large" ? 16 : 12;
  const paddingV = size === "small" ? 3 : size === "large" ? 8 : 5;

  return (
    <View style={[styles.badge, { paddingHorizontal: paddingH, paddingVertical: paddingV }]}>
      <Animated.View
        style={[
          styles.dot,
          { width: dotSize, height: dotSize, borderRadius: dotSize / 2, opacity: pulseAnim },
        ]}
      />
      <Text style={[styles.text, { fontSize }]}>LIVE</Text>
    </View>
  );
}

/**
 * RebroadcastBadge — amber static pill shown when a live stream has ended
 * and the video is now a VOD/replay. Paired with LiveBadge for the full
 * YouTube Live Status badge system.
 */
export function RebroadcastBadge({ size = "medium" }: { size?: "small" | "medium" | "large" }) {
  const fontSize = size === "small" ? 9 : size === "large" ? 14 : 11;
  const paddingH = size === "small" ? 7 : size === "large" ? 14 : 10;
  const paddingV = size === "small" ? 2 : size === "large" ? 7 : 4;

  return (
    <View style={[styles.rebroadcastBadge, { paddingHorizontal: paddingH, paddingVertical: paddingV }]}>
      <Text style={[styles.rebroadcastText, { fontSize }]}>REBROADCAST</Text>
    </View>
  );
}

/**
 * VideoLiveStatusBadge — renders LiveBadge or RebroadcastBadge based on status.
 * Renders nothing when status is null/undefined.
 */
export function VideoLiveStatusBadge({
  status,
  size = "small",
}: {
  status?: "live" | "rebroadcast" | null;
  size?: "small" | "medium" | "large";
}) {
  if (status === "live") return <LiveBadge size={size} />;
  if (status === "rebroadcast") return <RebroadcastBadge size={size} />;
  return null;
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FF0040",
    borderRadius: 20,
    gap: 5,
  },
  dot: {
    backgroundColor: "#FFFFFF",
  },
  text: {
    color: "#FFFFFF",
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.5,
  },
  rebroadcastBadge: {
    backgroundColor: "#D97706",
    borderRadius: 20,
  },
  rebroadcastText: {
    color: "#FFFFFF",
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.2,
  },
});
