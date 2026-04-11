import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";

interface ChannelBugProps {
  visible?: boolean;
  animated?: boolean;
}

export function ChannelBug({ visible = true, animated = true }: ChannelBugProps) {
  const opacityAnim = useRef(new Animated.Value(0.85)).current;

  useEffect(() => {
    if (!animated) return;
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacityAnim, { toValue: 0.55, duration: 3000, useNativeDriver: true }),
        Animated.timing(opacityAnim, { toValue: 0.85, duration: 3000, useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [animated]);

  if (!visible) return null;

  return (
    <Animated.View style={[styles.bug, { opacity: opacityAnim }]}>
      <View style={styles.dot} />
      <Text style={styles.text}>TEMPLE TV</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bug: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(106,13,173,0.8)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#FF0040",
  },
  text: {
    color: "#FFF",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.5,
  },
});
