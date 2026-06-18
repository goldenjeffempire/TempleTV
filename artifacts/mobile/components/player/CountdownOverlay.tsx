import React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { Sermon } from "@/types";
import type { useColors } from "@/hooks/useColors";

/**
 * Post-video autoplay countdown card.
 *
 * Renders absolutely over its parent (inline player shell or fullscreen
 * modal) with a translucent scrim that dims the last video frame and a
 * small card surfacing the next item's poster + title + a 5→1 counter.
 *
 * UX contract:
 *  • Cancel        → user opts out, video stays paused on its end frame
 *  • Play Now      → fires immediately (skip the remaining countdown)
 *  • Tapping scrim → does nothing (avoids accidental dismiss / autoplay)
 *
 * Renders independently of theme — fixed dark-mode tokens (video surface).
 */
export function CountdownOverlay({
  next,
  count,
  onPlayNow,
  onCancel,
  colors: _colors,
}: {
  next: Sermon;
  count: number;
  onPlayNow: () => void;
  onCancel: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={styles.root}>
      <Pressable
        style={styles.scrim}
        onPress={() => {}}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      <View style={styles.card}>
        <Text style={styles.kicker}>UP NEXT IN {count}s</Text>
        {next.thumbnailUrl ? (
          <Image source={{ uri: next.thumbnailUrl }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, { backgroundColor: "#1a1a1a" }]} />
        )}
        <Text style={styles.title} numberOfLines={2}>{next.title}</Text>
        {!!next.preacher && (
          <Text style={styles.sub} numberOfLines={1}>{next.preacher}</Text>
        )}
        <View style={styles.btnRow}>
          <Pressable
            onPress={onCancel}
            style={({ pressed }) => [
              styles.btn,
              styles.btnGhost,
              pressed && { opacity: 0.7 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Cancel autoplay"
          >
            <Text style={styles.btnGhostText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={onPlayNow}
            style={({ pressed }) => [
              styles.btn,
              styles.btnPrimary,
              pressed && { opacity: 0.85 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`Play next now: ${next.title}`}
          >
            <Feather name="play" size={14} color="#fff" />
            <Text style={styles.btnPrimaryText}>Play Now</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 30,
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.65)",
  },
  card: {
    width: "84%",
    maxWidth: 360,
    backgroundColor: "rgba(20,20,22,0.96)",
    borderRadius: 14,
    padding: 14,
    alignItems: "center",
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.10)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 10,
  },
  kicker: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
    color: "#DC2626",
  },
  thumb: {
    width: "100%",
    aspectRatio: 16 / 9,
    borderRadius: 8,
    backgroundColor: "#000",
  },
  title: {
    fontSize: 15,
    fontWeight: "700",
    color: "#fff",
    textAlign: "center",
    letterSpacing: -0.1,
  },
  sub: {
    fontSize: 12,
    fontWeight: "500",
    color: "rgba(255,255,255,0.65)",
  },
  btnRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
    width: "100%",
  },
  btn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 8,
  },
  btnGhost: {
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.18)",
  },
  btnGhostText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  btnPrimary: { backgroundColor: "#DC2626" },
  btnPrimaryText: { color: "#fff", fontSize: 13, fontWeight: "700" },
});
