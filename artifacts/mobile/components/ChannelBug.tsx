import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";

/**
 * Real-broadcaster channel bug.
 *
 * Two render modes:
 *  - "chrome"    (default, legacy): always-visible pulsing badge sized for
 *                inline chrome usage (the radio screen still wires this in).
 *  - "watermark" (Round 9b): a discreet bottom-corner station identifier
 *                that fades in 3 seconds after each program change. Mirrors
 *                the convention used by real TV networks (NBC, ESPN, CNN)
 *                where the bug appears once the new program has settled
 *                on screen, not the moment it cuts in. Pass the current
 *                program identifier as `programKey` (e.g. the tuned
 *                videoId or HLS URL) — when it changes the bug fades back
 *                out and re-fades in after the 3s grace period.
 */
interface ChannelBugProps {
  visible?: boolean;
  animated?: boolean;
  mode?: "chrome" | "watermark";
  /** Identifier for the currently-airing program. When this changes the
   *  watermark resets and re-fades in after `appearDelayMs`. Ignored in
   *  "chrome" mode. */
  programKey?: string;
  /** Delay before the watermark fades in after a program change. Default 3000ms. */
  appearDelayMs?: number;
}

export function ChannelBug({
  visible = true,
  animated = true,
  mode = "chrome",
  programKey,
  appearDelayMs = 3000,
}: ChannelBugProps) {
  const opacityAnim = useRef(new Animated.Value(mode === "watermark" ? 0 : 0.85)).current;

  // ── Chrome mode: legacy pulsing badge ─────────────────────────────────
  useEffect(() => {
    if (mode !== "chrome") return;
    if (!animated) return;
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacityAnim, { toValue: 0.55, duration: 3000, useNativeDriver: true }),
        Animated.timing(opacityAnim, { toValue: 0.85, duration: 3000, useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [animated, mode, opacityAnim]);

  // ── Watermark mode: 3s delay, then single fade-in ─────────────────────
  useEffect(() => {
    if (mode !== "watermark") return;
    opacityAnim.setValue(0);
    const t = setTimeout(() => {
      Animated.timing(opacityAnim, {
        toValue: 0.7,
        duration: 700,
        useNativeDriver: true,
      }).start();
    }, appearDelayMs);
    return () => clearTimeout(t);
  }, [mode, programKey, appearDelayMs, opacityAnim]);

  if (!visible) return null;

  const containerStyle = mode === "watermark" ? styles.watermark : styles.bug;

  return (
    <Animated.View pointerEvents="none" style={[containerStyle, { opacity: opacityAnim }]}>
      <View style={styles.dot} />
      {mode === "watermark" ? (
        // Real-broadcaster station identity: primary network mark + the
        // "JCTM Broadcasting" sub-line so the channel bug reads as a true
        // TV station identifier rather than a single-word badge.
        <View style={styles.watermarkTextStack}>
          <Text style={styles.text}>TEMPLE TV</Text>
          <Text style={styles.subText}>JCTM Broadcasting</Text>
        </View>
      ) : (
        <Text style={styles.text}>TEMPLE TV</Text>
      )}
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
  watermark: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "rgba(13,17,23,0.55)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 7,
  },
  watermarkTextStack: {
    flexDirection: "column",
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
  subText: {
    color: "rgba(255,255,255,0.78)",
    fontSize: 7.5,
    fontWeight: "600",
    letterSpacing: 1.6,
    marginTop: 1,
    textTransform: "uppercase",
  },
});
