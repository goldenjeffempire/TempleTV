import React, { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text } from "react-native";
import { useColors } from "@/hooks/useColors";

export function ReactionButton({
  emoji,
  label,
  onPress,
}: {
  emoji: string;
  label: string;
  onPress: () => void;
}) {
  const c = useColors();
  const scale  = useRef(new Animated.Value(1)).current;
  const glowOp = useRef(new Animated.Value(0)).current;
  const [sent, setSent] = useState(false);
  const sentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (sentTimerRef.current) clearTimeout(sentTimerRef.current);
    };
  }, []);

  const handlePress = () => {
    if (sentTimerRef.current) clearTimeout(sentTimerRef.current);
    setSent(true);
    sentTimerRef.current = setTimeout(() => setSent(false), 1600);

    Animated.sequence([
      Animated.spring(scale, { toValue: 1.45, useNativeDriver: true, speed: 60, bounciness: 16 }),
      Animated.spring(scale, { toValue: 1,    useNativeDriver: true, speed: 30 }),
    ]).start();

    Animated.sequence([
      Animated.timing(glowOp, { toValue: 1, duration: 100, useNativeDriver: true }),
      Animated.timing(glowOp, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();

    onPress();
  };

  return (
    <Pressable
      onPress={handlePress}
      style={styles.reactionBtn}
      hitSlop={10}
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      <Animated.View
        style={[styles.reactionGlow, { borderColor: c.primary, opacity: glowOp }]}
        pointerEvents="none"
      />
      <Animated.View
        style={[
          styles.reactionCircle,
          {
            backgroundColor: sent ? c.primary + "18" : c.card,
            borderColor:     sent ? c.primary + "55" : c.border,
            transform: [{ scale }],
          },
        ]}
      >
        <Text style={styles.reactionEmoji}>{emoji}</Text>
      </Animated.View>
      <Text style={[styles.reactionLabel, { color: sent ? c.primary : c.mutedForeground }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  reactionBtn: { alignItems: "center", gap: 6, position: "relative" },
  reactionGlow: {
    position: "absolute",
    top: -4, left: -4, right: -4, bottom: -4,
    borderRadius: 34,
    borderWidth: 2,
    zIndex: 1,
  },
  reactionCircle: {
    width: 58, height: 58, borderRadius: 29,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center", justifyContent: "center",
  },
  reactionEmoji: { fontSize: 26 },
  reactionLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.15 },
});
