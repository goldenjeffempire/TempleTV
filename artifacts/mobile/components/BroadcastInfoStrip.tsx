import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Feather } from "@expo/vector-icons";
import type { BroadcastCurrentResult } from "@/services/broadcast";

interface BroadcastInfoStripProps {
  broadcast: BroadcastCurrentResult | null;
  playerHeight: number;
}

function fmtRemaining(secs: number): string {
  if (secs <= 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${rm}m`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function BroadcastInfoStrip({ broadcast, playerHeight }: BroadcastInfoStripProps) {
  const slideAnim = useRef(new Animated.Value(20)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!broadcast?.item) return;
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: 0, duration: 400, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
    ]).start();
  }, [broadcast?.item?.id]);

  if (!broadcast?.item) return null;

  const { item, nextItem, positionSecs, progressPercent } = broadcast;
  const remaining = Math.max(0, item.durationSecs - positionSecs);

  return (
    <Animated.View
      style={[styles.container, { opacity: fadeAnim, transform: [{ translateY: slideAnim }], pointerEvents: "none" }]}
    >
      <LinearGradient
        colors={["transparent", "rgba(0,0,0,0.95)"]}
        style={[styles.gradient, { height: Math.max(Math.round(playerHeight * 0.55), 120) }]}
      >
        <View style={styles.inner}>
          <View style={styles.nowRow}>
            <View style={styles.nowBadge}>
              <View style={styles.nowDot} />
              <Text style={styles.nowLabel}>NOW ON AIR</Text>
            </View>
            <View style={styles.nowBadge}>
              <Feather name="radio" size={10} color="rgba(255,255,255,0.5)" />
              <Text style={styles.channelLabel}>TEMPLE TV</Text>
            </View>
          </View>

          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.min(100, progressPercent ?? 0)}%` }]} />
          </View>

          {nextItem && (
            <View style={styles.upNextRow}>
              <Feather name="chevrons-right" size={11} color="rgba(255,255,255,0.5)" />
              <Text style={styles.upNextText}>Up Next</Text>
            </View>
          )}
        </View>
      </LinearGradient>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  gradient: {
    justifyContent: "flex-end",
  },
  inner: {
    paddingHorizontal: 14,
    paddingBottom: 12,
    gap: 5,
  },
  nowRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  nowBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  nowDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#FF0040",
  },
  nowLabel: {
    color: "#FF0040",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  channelLabel: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 1.1,
  },
  progressTrack: {
    height: 2,
    backgroundColor: "rgba(255,255,255,0.2)",
    borderRadius: 1,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#6A0DAD",
    borderRadius: 1,
  },
  upNextRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  upNextText: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 10,
    flex: 1,
  },
});
