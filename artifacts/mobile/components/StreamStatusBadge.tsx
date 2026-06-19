/**
 * StreamStatusBadge — unified stream health indicator
 *
 * Shows the current broadcast stream state as a compact badge or a larger
 * status pill. Designed to sit inside the hero section, V2PlayerContainer
 * overlay, or any surface that needs a visible stream health indicator.
 *
 * States:
 *   live         — red pulsing dot + "LIVE" label
 *   loading      — spinner + "TUNING IN" label
 *   reconnecting — amber spinner + "RECONNECTING" label
 *   offline      — gray wifi-off icon + "OFFLINE" label
 *   error        — red alert-circle + "UNAVAILABLE" label
 *   idle         — nothing rendered (null)
 */

import React, { useEffect, useRef } from "react";
import { Animated, Platform, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { MediaState } from "@/hooks/useMediaPlayerState";
import { FONT_SIZE, RADIUS, SPACING } from "@/constants/design";

export interface StreamStatusBadgeProps {
  state: MediaState;
  /**
   * `compact`  — dot-only or icon-only (e.g. inside a corner of the hero)
   * `pill`     — icon + label (default, suitable for below-hero status bar)
   * `banner`   — full-width banner with label + sub-label
   */
  variant?: "compact" | "pill" | "banner";
  /** Suppress rendering entirely in `idle` state (default: true) */
  hideWhenIdle?: boolean;
  /** Additional sub-label shown in `banner` variant (e.g. "Tap to retry") */
  subLabel?: string;
}

const STATE_CONFIG: Record<
  MediaState,
  {
    label: string;
    subLabel: string;
    icon: React.ComponentProps<typeof Feather>["name"];
    dotColor: string;
    bgColor: string;
    textColor: string;
    pulse: boolean;
    spin: boolean;
  }
> = {
  live: {
    label: "LIVE",
    subLabel: "Stream is active",
    icon: "radio",
    dotColor: "#ef4444",
    bgColor: "rgba(239,68,68,0.18)",
    textColor: "#ef4444",
    pulse: true,
    spin: false,
  },
  loading: {
    label: "TUNING IN",
    subLabel: "Connecting to broadcast…",
    icon: "loader",
    dotColor: "#6A0DAD",
    bgColor: "rgba(106,13,173,0.18)",
    textColor: "#B47FEB",
    pulse: false,
    spin: true,
  },
  reconnecting: {
    label: "RECONNECTING",
    subLabel: "Restoring connection…",
    icon: "refresh-cw",
    dotColor: "#f59e0b",
    bgColor: "rgba(245,158,11,0.18)",
    textColor: "#f59e0b",
    pulse: false,
    spin: true,
  },
  offline: {
    label: "OFFLINE",
    subLabel: "No network connection",
    icon: "wifi-off",
    dotColor: "#6b7280",
    bgColor: "rgba(107,114,128,0.18)",
    textColor: "#9ca3af",
    pulse: false,
    spin: false,
  },
  error: {
    label: "UNAVAILABLE",
    subLabel: "Stream is temporarily unavailable",
    icon: "alert-circle",
    dotColor: "#ef4444",
    bgColor: "rgba(239,68,68,0.15)",
    textColor: "#f87171",
    pulse: false,
    spin: false,
  },
  idle: {
    label: "OFF AIR",
    subLabel: "No broadcast scheduled",
    icon: "tv",
    dotColor: "#6b7280",
    bgColor: "rgba(107,114,128,0.12)",
    textColor: "#9ca3af",
    pulse: false,
    spin: false,
  },
};

const ND = Platform.OS !== "web";

export function StreamStatusBadge({
  state,
  variant = "pill",
  hideWhenIdle = true,
  subLabel,
}: StreamStatusBadgeProps) {
  const cfg = STATE_CONFIG[state];

  // Pulse animation for LIVE dot
  const pulseAnim = useRef(new Animated.Value(1)).current;
  // Spin animation for loading / reconnecting
  const spinAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (cfg.pulse) {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.7,
            duration: 700,
            useNativeDriver: ND,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 700,
            useNativeDriver: ND,
          }),
        ])
      );
      anim.start();
      return () => anim.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [cfg.pulse, pulseAnim]);

  useEffect(() => {
    if (cfg.spin) {
      const anim = Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: 1200,
          useNativeDriver: ND,
        })
      );
      anim.start();
      return () => anim.stop();
    } else {
      spinAnim.setValue(0);
    }
  }, [cfg.spin, spinAnim]);

  if (hideWhenIdle && state === "idle") return null;

  const spinInterpolate = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  if (variant === "compact") {
    return (
      <View style={[styles.compactWrap, { backgroundColor: cfg.bgColor }]}>
        {cfg.pulse ? (
          <View style={styles.dotWrap}>
            <Animated.View
              style={[
                styles.dotPulse,
                { backgroundColor: cfg.dotColor, transform: [{ scale: pulseAnim }] },
              ]}
            />
            <View style={[styles.dot, { backgroundColor: cfg.dotColor }]} />
          </View>
        ) : cfg.spin ? (
          <Animated.View style={{ transform: [{ rotate: spinInterpolate }] }}>
            <Feather name={cfg.icon} size={8} color={cfg.textColor} />
          </Animated.View>
        ) : (
          <Feather name={cfg.icon} size={8} color={cfg.textColor} />
        )}
        <Text style={[styles.compactLabel, { color: cfg.textColor }]}>
          {cfg.label}
        </Text>
      </View>
    );
  }

  if (variant === "banner") {
    return (
      <View style={[styles.bannerWrap, { backgroundColor: cfg.bgColor, borderColor: cfg.dotColor + "40" }]}>
        <View style={styles.bannerLeft}>
          {cfg.pulse ? (
            <View style={styles.dotWrap}>
              <Animated.View
                style={[styles.dotPulse, { backgroundColor: cfg.dotColor, transform: [{ scale: pulseAnim }] }]}
              />
              <View style={[styles.dot, { backgroundColor: cfg.dotColor }]} />
            </View>
          ) : cfg.spin ? (
            <Animated.View style={{ transform: [{ rotate: spinInterpolate }] }}>
              <Feather name={cfg.icon} size={14} color={cfg.textColor} />
            </Animated.View>
          ) : (
            <Feather name={cfg.icon} size={14} color={cfg.textColor} />
          )}
        </View>
        <View style={styles.bannerText}>
          <Text style={[styles.bannerLabel, { color: cfg.textColor }]}>
            {cfg.label}
          </Text>
          <Text style={[styles.bannerSub, { color: cfg.textColor + "AA" }]}>
            {subLabel ?? cfg.subLabel}
          </Text>
        </View>
      </View>
    );
  }

  // pill (default)
  return (
    <View style={[styles.pillWrap, { backgroundColor: cfg.bgColor }]}>
      {cfg.pulse ? (
        <View style={styles.dotWrap}>
          <Animated.View
            style={[
              styles.dotPulse,
              { backgroundColor: cfg.dotColor, transform: [{ scale: pulseAnim }] },
            ]}
          />
          <View style={[styles.dot, { backgroundColor: cfg.dotColor }]} />
        </View>
      ) : cfg.spin ? (
        <Animated.View style={{ transform: [{ rotate: spinInterpolate }] }}>
          <Feather name={cfg.icon} size={10} color={cfg.textColor} />
        </Animated.View>
      ) : (
        <Feather name={cfg.icon} size={10} color={cfg.textColor} />
      )}
      <Text style={[styles.pillLabel, { color: cfg.textColor }]}>
        {cfg.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Compact (dot/icon only)
  compactWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.full,
  },
  compactLabel: {
    fontSize: FONT_SIZE.xxs,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.8,
  },

  // Pill
  pillWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.xs,
    paddingHorizontal: SPACING.md,
    paddingVertical: 5,
    borderRadius: RADIUS.full,
    alignSelf: "flex-start",
  },
  pillLabel: {
    fontSize: FONT_SIZE.xs,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1,
  },

  // Banner
  bannerWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
  },
  bannerLeft: {
    width: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  bannerText: {
    flex: 1,
    gap: 2,
  },
  bannerLabel: {
    fontSize: FONT_SIZE.xs,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1,
  },
  bannerSub: {
    fontSize: FONT_SIZE.xxs,
    fontFamily: "Inter_400Regular",
  },

  // Shared — live pulse dot
  dotWrap: {
    width: 10,
    height: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: RADIUS.full,
    position: "absolute",
  },
  dotPulse: {
    width: 7,
    height: 7,
    borderRadius: RADIUS.full,
    opacity: 0.4,
    position: "absolute",
  },
});
