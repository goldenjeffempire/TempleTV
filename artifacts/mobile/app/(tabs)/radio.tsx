/**
 * Radio Screen — 24/7 live audio broadcast
 *
 * Connects to RadioStreamContext (RadioStreamProvider in app/_layout.tsx).
 * All stream lifecycle logic (connect, retry, stall watchdog, AppState
 * recovery) lives in the context; this file is pure UI.
 *
 * States handled:
 *  • configLoading      — skeleton while fetching stream config
 *  • !isStreamConfigured — friendly "stream not yet configured" empty-state
 *  • isRadioOn + isConnecting — buffering / connecting spinner + pulse ring
 *  • isRadioOn + !isConnecting + !isError — LIVE badge + waveform animation
 *  • isError            — error card with Retry button
 *  • isOffline          — offline banner with info text
 *  • !isRadioOn         — idle card, big "Listen Live" button
 */

import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

import React, { useCallback, useEffect, useRef } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { SymbolView } from "expo-symbols";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Stack } from "expo-router";
import { useColors } from "@/hooks/useColors";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useRadioStream } from "@/context/RadioStreamContext";
import { useNetworkContext } from "@/context/NetworkContext";

const ND = Platform.OS !== "web";

// ── Waveform bar animation ────────────────────────────────────────────────────

interface WaveBarProps {
  delay: number;
  height: number;
  color: string;
  active: boolean;
}

function WaveBar({ delay, height, color, active }: WaveBarProps) {
  const anim = useRef(new Animated.Value(0.3)).current;
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (active) {
      loopRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(anim, {
            toValue: 1,
            duration: 500 + delay * 80,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: ND,
            delay,
          }),
          Animated.timing(anim, {
            toValue: 0.3,
            duration: 500 + delay * 80,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: ND,
          }),
        ]),
      );
      loopRef.current.start();
    } else {
      loopRef.current?.stop();
      Animated.timing(anim, {
        toValue: 0.3,
        duration: 200,
        useNativeDriver: ND,
      }).start();
    }
    return () => loopRef.current?.stop();
  }, [active, anim, delay]);

  return (
    <Animated.View
      style={[
        styles.waveBar,
        {
          backgroundColor: color,
          maxHeight: height,
          transform: [{ scaleY: anim }],
        },
      ]}
    />
  );
}

function Waveform({ active, color }: { active: boolean; color: string }) {
  const bars = [24, 36, 48, 56, 44, 56, 48, 36, 24];
  return (
    <View style={styles.waveform}>
      {bars.map((h, i) => (
        <WaveBar key={i} delay={i * 60} height={h} color={color} active={active} />
      ))}
    </View>
  );
}

// ── Pulse ring (connecting state) ─────────────────────────────────────────────

function PulseRing({ color }: { color: string }) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale, { toValue: 1.4, duration: 900, useNativeDriver: ND }),
          Animated.timing(scale, { toValue: 1, duration: 900, useNativeDriver: ND }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0, duration: 900, useNativeDriver: ND }),
          Animated.timing(opacity, { toValue: 0.6, duration: 900, useNativeDriver: ND }),
        ]),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [scale, opacity]);

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        styles.pulseRing,
        {
          borderColor: color,
          transform: [{ scale }],
          opacity,
        },
      ]}
    />
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function RadioScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const {
    stationTitle,
    stationDescription,
    isStreamConfigured,
    configLoading,
    isRadioOn,
    isConnecting,
    isError,
    errorMsg,
    toggleRadio,
    retryConnect,
  } = useRadioStream();
  const { isOnline } = useNetworkContext();

  const isPlaying = isRadioOn && !isConnecting && !isError;

  // Card fade-in on mount
  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 500,
      useNativeDriver: ND,
    }).start();
  }, [fadeAnim]);

  // Stop radio when tab loses focus (optional UX: keep playing across tabs)
  // Comment out the lines below if you want radio to continue in background.
  // useFocusEffect(useCallback(() => () => {}, []));

  const handleToggle = useCallback(() => {
    if (isError) {
      retryConnect();
    } else {
      toggleRadio();
    }
  }, [isError, retryConnect, toggleRadio]);

  const bigButtonColor = isRadioOn ? c.primary : c.foreground;
  const bigButtonBg = isRadioOn
    ? c.primary + "22"
    : c.muted;

  // ── Loading skeleton ───────────────────────────────────────────────────────
  if (configLoading) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ headerShown: false, title: "" }} />
        <ScreenHeader title="Radio" />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={c.primary} />
          <Text style={[styles.loadingText, { color: c.mutedForeground }]}>
            Loading stream info…
          </Text>
        </View>
      </View>
    );
  }

  // ── Not configured ─────────────────────────────────────────────────────────
  if (!isStreamConfigured) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ headerShown: false, title: "" }} />
        <ScreenHeader title="Radio" />
        <View style={[styles.center, { paddingHorizontal: 32 }]}>
          <View style={[styles.iconCircle, { backgroundColor: c.muted }]}>
            {Platform.OS === "ios" ? (
              <SymbolView
                name="antenna.radiowaves.left.and.right"
                tintColor={c.mutedForeground}
                size={36}
              />
            ) : (
              <Feather name="radio" size={36} color={c.mutedForeground} />
            )}
          </View>
          <Text style={[styles.heading, { color: c.foreground }]}>Radio</Text>
          <Text style={[styles.subText, { color: c.mutedForeground }]}>
            The live radio stream has not been configured yet. Contact your
            administrator to set the stream URL.
          </Text>
        </View>
      </View>
    );
  }

  // ── Main player UI ─────────────────────────────────────────────────────────
  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ headerShown: false, title: "" }} />
      <ScreenHeader title="Radio" />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.body,
          { paddingBottom: insets.bottom + 48 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <Animated.View style={{ opacity: fadeAnim, width: "100%", alignItems: "center" }}>

          {/* ── Offline banner ── */}
          {!isOnline && (
            <View style={[styles.offlineBanner, { backgroundColor: c.muted, borderColor: c.border }]}>
              <Feather name="wifi-off" size={14} color={c.mutedForeground} />
              <Text style={[styles.offlineText, { color: c.mutedForeground }]}>
                No internet connection
              </Text>
            </View>
          )}

          {/* ── Station card ── */}
          <View
            style={[
              styles.stationCard,
              {
                backgroundColor: c.card,
                borderColor: c.border,
                shadowColor: c.foreground,
              },
            ]}
          >
            {/* Station icon + waveform area */}
            <View style={styles.stationVisual}>
              {/* Icon circle (with pulse ring when connecting) */}
              <View style={styles.iconWrap}>
                {isConnecting && <PulseRing color={c.primary} />}
                <View
                  style={[
                    styles.iconCircle,
                    {
                      backgroundColor: isRadioOn
                        ? c.primary + "22"
                        : c.muted,
                      borderWidth: isRadioOn ? 1.5 : 0,
                      borderColor: isRadioOn ? c.primary + "55" : "transparent",
                    },
                  ]}
                >
                  {Platform.OS === "ios" ? (
                    <SymbolView
                      name="antenna.radiowaves.left.and.right"
                      tintColor={isRadioOn ? c.primary : c.mutedForeground}
                      size={34}
                    />
                  ) : (
                    <Feather
                      name="radio"
                      size={34}
                      color={isRadioOn ? c.primary : c.mutedForeground}
                    />
                  )}
                </View>
              </View>

              {/* Waveform */}
              <Waveform active={isPlaying} color={c.primary} />
            </View>

            {/* Status badge row */}
            <View style={styles.badgeRow}>
              {isPlaying && (
                <View style={[styles.liveBadge, { backgroundColor: "#ef4444" }]}>
                  <View style={styles.liveDot} />
                  <Text style={styles.liveText}>LIVE</Text>
                </View>
              )}
              {isConnecting && (
                <View style={[styles.connectingBadge, { backgroundColor: c.primary + "22", borderColor: c.primary + "44" }]}>
                  <ActivityIndicator size={10} color={c.primary} />
                  <Text style={[styles.connectingText, { color: c.primary }]}>
                    Connecting…
                  </Text>
                </View>
              )}
              {isError && (
                <View style={[styles.connectingBadge, { backgroundColor: "#ef444422", borderColor: "#ef444444" }]}>
                  <Feather name="alert-circle" size={10} color="#ef4444" />
                  <Text style={[styles.connectingText, { color: "#ef4444" }]}>
                    Stream error
                  </Text>
                </View>
              )}
            </View>

            {/* Station name + description */}
            <Text style={[styles.stationTitle, { color: c.foreground }]}>
              {stationTitle}
            </Text>
            <Text style={[styles.stationDesc, { color: c.mutedForeground }]}>
              {stationDescription}
            </Text>

            {/* Error message */}
            {isError && errorMsg && (
              <Text style={[styles.errorMsg, { color: "#ef4444" }]}>{errorMsg}</Text>
            )}
          </View>

          {/* ── Big play/pause button ── */}
          <Pressable
            onPress={handleToggle}
            disabled={!isOnline && !isRadioOn}
            style={({ pressed }) => [
              styles.bigButton,
              {
                backgroundColor: bigButtonBg,
                borderColor: isRadioOn ? c.primary + "55" : c.border,
                opacity: pressed ? 0.75 : (!isOnline && !isRadioOn ? 0.4 : 1),
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={isRadioOn ? "Stop radio" : "Listen live"}
            accessibilityState={{ selected: isRadioOn }}
          >
            {isConnecting ? (
              <ActivityIndicator size={28} color={c.primary} />
            ) : (
              <Feather
                name={isError ? "refresh-cw" : isRadioOn ? "square" : "play"}
                size={28}
                color={bigButtonColor}
              />
            )}
          </Pressable>

          <Text style={[styles.buttonLabel, { color: c.mutedForeground }]}>
            {isError
              ? "Tap to retry"
              : isConnecting
                ? "Buffering stream…"
                : isPlaying
                  ? "Tap to stop"
                  : !isOnline
                    ? "No internet connection"
                    : "Listen Live"}
          </Text>

          {/* ── Feature list (shown when idle) ── */}
          {!isRadioOn && (
            <View style={[styles.featureCard, { backgroundColor: c.card, borderColor: c.border }]}>
              {[
                { icon: "users" as const, label: "Same stream for every listener — synchronized broadcast" },
                { icon: "wifi" as const, label: "Auto-reconnects on network drops with smart backoff" },
                { icon: "headphones" as const, label: "Background playback — listen while using other apps" },
                { icon: "clock" as const, label: "24/7 continuous broadcast with zero dead-air gaps" },
              ].map(({ icon, label }) => (
                <View key={label} style={styles.featureRow}>
                  <View style={[styles.featureIconWrap, { backgroundColor: c.muted }]}>
                    <Feather name={icon} size={13} color={c.primary} />
                  </View>
                  <Text style={[styles.featureText, { color: c.mutedForeground }]}>
                    {label}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {/* ── Now playing hint (when live) ── */}
          {isPlaying && (
            <View style={[styles.nowPlayingCard, { backgroundColor: c.card, borderColor: c.border }]}>
              <Feather name="music" size={14} color={c.primary} />
              <Text style={[styles.nowPlayingText, { color: c.mutedForeground }]}>
                You are listening live — every listener hears exactly the same
                broadcast in real time.
              </Text>
            </View>
          )}

        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 16,
  },

  loadingText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    marginTop: 8,
  },

  body: {
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 20,
  },

  offlineBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    width: "100%",
    maxWidth: 420,
    marginBottom: 4,
  },
  offlineText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },

  stationCard: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 20,
    borderWidth: 1,
    padding: 24,
    alignItems: "center",
    gap: 0,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },

  stationVisual: {
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 20,
    marginBottom: 20,
  },

  iconWrap: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },

  pulseRing: {
    borderRadius: 100,
    borderWidth: 2,
    position: "absolute",
    width: 86,
    height: 86,
  },

  iconCircle: {
    width: 78,
    height: 78,
    borderRadius: 39,
    alignItems: "center",
    justifyContent: "center",
  },

  waveform: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    height: 56,
  },
  waveBar: {
    width: 4,
    height: "100%",
    borderRadius: 2,
    transformOrigin: "bottom",
  },

  badgeRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 14,
    minHeight: 24,
    alignItems: "center",
  },

  liveBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#fff",
  },
  liveText: {
    color: "#fff",
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.1,
  },

  connectingBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
  },
  connectingText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },

  stationTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
    letterSpacing: -0.3,
    marginBottom: 6,
  },
  stationDesc: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },

  errorMsg: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginTop: 10,
  },

  bigButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    marginTop: 4,
  },

  buttonLabel: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    marginTop: 4,
    textAlign: "center",
  },

  heading: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
    letterSpacing: -0.3,
  },
  subText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 22,
    marginTop: 4,
  },

  featureCard: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
    gap: 0,
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 9,
  },
  featureIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  featureText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    flex: 1,
    lineHeight: 19,
  },

  nowPlayingCard: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    gap: 12,
    alignItems: "flex-start",
  },
  nowPlayingText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    flex: 1,
    lineHeight: 20,
  },
});
