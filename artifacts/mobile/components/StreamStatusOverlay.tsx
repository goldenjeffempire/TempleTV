/**
 * StreamStatusOverlay — streaming resilience layer
 *
 * A full-surface overlay rendered on top of a video player when the stream
 * enters an actionable state (reconnecting, offline, or fatal error). It
 * provides:
 *   • A descriptive status message scaled to the state severity
 *   • An exponential-backoff auto-retry countdown with a visible timer
 *   • A "Try Again" / "Retry" button for immediate manual retries
 *   • Clear offline vs error vs reconnecting visual distinction
 *
 * Pass `visible={false}` (or omit it entirely) during normal playback —
 * the component returns null and has zero render cost.
 *
 * Auto-retry behavior:
 *   The overlay starts a countdown from `retryAfterSecs` (default 30).
 *   When it reaches 0 it calls `onRetry()` and resets. Each successive
 *   retry doubles the wait (capped at 120 s) to implement exponential
 *   backoff without any state in the parent.
 *
 * Usage:
 *   <StreamStatusOverlay
 *     visible={mediaState === 'error' || mediaState === 'offline'}
 *     state={mediaState}
 *     onRetry={forceRebind}
 *   />
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import type { MediaState } from "@/hooks/useMediaPlayerState";
import { StreamStatusBadge } from "@/components/StreamStatusBadge";
import { FONT_SIZE, LINE_HEIGHT, RADIUS, SPACING } from "@/constants/design";

const ND = Platform.OS !== "web";

const BASE_RETRY_SECS = 30;
const MAX_RETRY_SECS = 120;

interface StreamStatusOverlayProps {
  /** Show the overlay. When false the component renders null. */
  visible?: boolean;
  /** Current media state — drives the icon, message, and color scheme. */
  state: MediaState;
  /**
   * Called when the user taps "Try Again" or when the auto-retry
   * countdown reaches zero. The parent should call forceRebind() /
   * forceReconnect() in response.
   */
  onRetry?: () => void;
  /**
   * Initial countdown (seconds) before the first automatic retry.
   * Subsequent retries double this value up to MAX_RETRY_SECS (120 s).
   * Pass 0 to disable the auto-retry countdown entirely.
   */
  retryAfterSecs?: number;
  /**
   * Override the headline message. When omitted a sensible default is
   * derived from `state`.
   */
  message?: string;
  /**
   * Override the sub-message. When omitted a sensible default is
   * derived from `state`.
   */
  subMessage?: string;
  /** When true, show the overlay with a transparent background (blends into hero). */
  transparent?: boolean;
}

const STATE_COPY: Record<
  MediaState,
  { headline: string; sub: string; icon: React.ComponentProps<typeof Feather>["name"]; color: string }
> = {
  offline: {
    headline: "You're Offline",
    sub: "Check your network connection. We'll reconnect automatically when you're back online.",
    icon: "wifi-off",
    color: "#9ca3af",
  },
  reconnecting: {
    headline: "Reconnecting…",
    sub: "We lost the stream for a moment. Reconnecting automatically.",
    icon: "refresh-cw",
    color: "#f59e0b",
  },
  error: {
    headline: "Stream Unavailable",
    sub: "The broadcast cannot be reached right now. Tap to retry.",
    icon: "alert-circle",
    color: "#ef4444",
  },
  loading: {
    headline: "Tuning In…",
    sub: "Connecting to the broadcast…",
    icon: "loader",
    color: "#B47FEB",
  },
  live: {
    headline: "Live",
    sub: "Stream is active",
    icon: "radio",
    color: "#ef4444",
  },
  idle: {
    headline: "Off Air",
    sub: "No broadcast scheduled",
    icon: "tv",
    color: "#6b7280",
  },
};

export function StreamStatusOverlay({
  visible = true,
  state,
  onRetry,
  retryAfterSecs = BASE_RETRY_SECS,
  message,
  subMessage,
  transparent = false,
}: StreamStatusOverlayProps) {
  const [countdown, setCountdown] = useState(retryAfterSecs);
  const retryIntervalRef = useRef(retryAfterSecs);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const iconAnim = useRef(new Animated.Value(0)).current;

  const cfg = STATE_COPY[state];

  // Fade in on mount / visible change
  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: ND }),
        Animated.spring(iconAnim, { toValue: 1, useNativeDriver: ND, tension: 80, friction: 7 }),
      ]).start();
    } else {
      Animated.timing(fadeAnim, { toValue: 0, duration: 200, useNativeDriver: ND }).start();
      iconAnim.setValue(0);
    }
  }, [visible, fadeAnim, iconAnim]);

  // Auto-retry countdown — only active in error/offline states with a positive retryAfterSecs
  const handleRetry = useCallback(() => {
    onRetry?.();
    // Double the interval for exponential backoff, cap at MAX_RETRY_SECS
    retryIntervalRef.current = Math.min(retryIntervalRef.current * 2, MAX_RETRY_SECS);
    setCountdown(retryIntervalRef.current);
  }, [onRetry]);

  useEffect(() => {
    if (!visible || retryAfterSecs <= 0) return;
    if (state !== "error" && state !== "offline") return;

    setCountdown(retryIntervalRef.current);

    intervalRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          handleRetry();
          return retryIntervalRef.current;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [visible, state, retryAfterSecs, handleRetry]);

  // Reset backoff when state recovers
  useEffect(() => {
    if (state === "live" || state === "loading") {
      retryIntervalRef.current = retryAfterSecs;
      setCountdown(retryAfterSecs);
    }
  }, [state, retryAfterSecs]);

  if (!visible) return null;

  const iconScale = iconAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.6, 1],
  });

  const showCountdown =
    (state === "error" || state === "offline") &&
    retryAfterSecs > 0 &&
    countdown > 0;

  const showRetryBtn = (state === "error" || state === "offline") && !!onRetry;
  const showReconnecting = state === "reconnecting";

  return (
    <Animated.View
      style={[
        styles.overlay,
        transparent ? styles.overlayTransparent : styles.overlaySolid,
        { opacity: fadeAnim },
      ]}
      pointerEvents={visible ? "auto" : "none"}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      {/* Status badge at the top */}
      <StreamStatusBadge state={state} variant="pill" hideWhenIdle={false} />

      {/* Icon */}
      <Animated.View
        style={[styles.iconWrap, { transform: [{ scale: iconScale }] }]}
      >
        {showReconnecting ? (
          <ReconnectingIcon color={cfg.color} />
        ) : (
          <View style={[styles.iconCircle, { backgroundColor: cfg.color + "20" }]}>
            <Feather name={cfg.icon} size={32} color={cfg.color} />
          </View>
        )}
      </Animated.View>

      {/* Headline */}
      <Text style={styles.headline}>{message ?? cfg.headline}</Text>
      <Text style={styles.sub}>{subMessage ?? cfg.sub}</Text>

      {/* Countdown + retry */}
      {showCountdown && (
        <View style={styles.countdownRow}>
          <Feather name="clock" size={13} color="rgba(255,255,255,0.5)" />
          <Text style={styles.countdownText}>
            Retrying in {countdown}s
          </Text>
        </View>
      )}

      {showRetryBtn && (
        <Pressable
          onPress={() => {
            retryIntervalRef.current = retryAfterSecs;
            setCountdown(retryAfterSecs);
            onRetry();
          }}
          style={({ pressed }) => [
            styles.retryBtn,
            { backgroundColor: cfg.color, opacity: pressed ? 0.8 : 1 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Retry connection"
        >
          <Feather name="refresh-cw" size={14} color="#fff" />
          <Text style={styles.retryBtnText}>Try Again</Text>
        </Pressable>
      )}
    </Animated.View>
  );
}

/** Animated spinning refresh icon for the reconnecting state */
function ReconnectingIcon({ color }: { color: string }) {
  const spinAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(spinAnim, {
        toValue: 1,
        duration: 1000,
        useNativeDriver: ND,
      })
    );
    anim.start();
    return () => anim.stop();
  }, [spinAnim]);

  const spin = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  return (
    <View style={[styles.iconCircle, { backgroundColor: color + "20" }]}>
      <Animated.View style={{ transform: [{ rotate: spin }] }}>
        <Feather name="refresh-cw" size={32} color={color} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: SPACING.md,
    paddingHorizontal: SPACING.xl,
    zIndex: 50,
  },
  overlaySolid: {
    backgroundColor: "rgba(0,0,0,0.82)",
  },
  overlayTransparent: {
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  iconWrap: {
    marginBottom: SPACING.xs,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: RADIUS.full,
    alignItems: "center",
    justifyContent: "center",
  },
  headline: {
    fontSize: FONT_SIZE.xl,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    textAlign: "center",
    lineHeight: LINE_HEIGHT.xl,
  },
  sub: {
    fontSize: FONT_SIZE.sm,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.65)",
    textAlign: "center",
    lineHeight: LINE_HEIGHT.sm,
    maxWidth: 280,
  },
  countdownRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.xs,
    marginTop: SPACING.xs,
  },
  countdownText: {
    fontSize: FONT_SIZE.sm,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.45)",
  },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.full,
    marginTop: SPACING.sm,
    minWidth: 140,
    justifyContent: "center",
  },
  retryBtnText: {
    fontSize: FONT_SIZE.base,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
});
