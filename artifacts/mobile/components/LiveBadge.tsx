import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";

export function LiveBadge({ size = "medium" }: { size?: "small" | "medium" | "large" }) {
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 0.4,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
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
});
