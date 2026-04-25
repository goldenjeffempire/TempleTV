import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Feather } from "@expo/vector-icons";
import type { BroadcastCurrentResult } from "@/services/broadcast";

interface BroadcastInfoStripProps {
  broadcast: BroadcastCurrentResult | null;
  playerHeight: number;
}

// Round 6: removed `fmtRemaining` helper. A TV-channel viewer never sees a
// remaining-time readout for the current program; it shipped previously as
// a "X:YY" countdown next to the progress bar but both are gone now.

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

  // Round 8: per the broadcast-clean directive, no video titles, queue
  // metadata, or "Up Next" sneak peeks are exposed on viewer surfaces.
  // The strip is reduced to the bare TV-channel affordances: NOW ON AIR
  // and the channel identity. The component is kept in the tree so the
  // gradient + safe-area math driving the player chrome stays stable.
  return (
    <Animated.View
      style={[styles.container, { opacity: fadeAnim, transform: [{ translateY: slideAnim }], pointerEvents: "none" }]}
    >
      <LinearGradient
        colors={["transparent", "rgba(13,17,23,0.45)", "rgba(13,17,23,0.88)"]}
        locations={[0, 0.55, 1]}
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
    shadowColor: "#FF0040",
    shadowOpacity: 0.7,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  nowLabel: {
    color: "#FF0040",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  channelLabel: {
    color: "rgba(255,255,255,0.65)",
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
