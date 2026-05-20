/**
 * Radio Screen — Live radio streaming for Temple TV.
 *
 * This screen replaces the previous on-demand sermon audio player.
 * All stream state is managed by RadioStreamContext (RadioStreamProvider
 * wrapping the app in _layout.tsx). The context manages:
 *
 *   • Fetching stream config from GET /api/radio
 *   • Creating / destroying expo-av Audio.Sound (native) or HTML <audio> (web)
 *   • Reconnection with exponential backoff
 *   • isRadioOn toggle persistence across navigation
 *
 * Screen responsibilities:
 *   – Render the current stream state (connecting / live / error / off)
 *   – Provide the ON/OFF toggle
 *   – Show station metadata
 *   – Show animated wave visualizer when live
 *   – Show error + retry when the stream drops
 */
import type { ErrorBoundaryProps } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

import React, { useEffect, useRef } from "react";
import {
  ActivityIndicator,
  Animated,
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

import { useColors } from "@/hooks/useColors";
import { AppHeader } from "@/components/AppHeader";
import { GlassCard } from "@/components/GlassCard";
import { usePageSeo } from "@/hooks/usePageSeo";
import { useRadioStream } from "@/context/RadioStreamContext";

const ND = Platform.OS !== "web"; // useNativeDriver flag

// ─── Wave bar animation ───────────────────────────────────────────────────────
function makeWaveAnim(
  anim: Animated.Value,
  delay: number,
): Animated.CompositeAnimation {
  return Animated.loop(
    Animated.sequence([
      Animated.delay(delay),
      Animated.timing(anim, { toValue: 1,    duration: 370, useNativeDriver: ND }),
      Animated.timing(anim, { toValue: 0.12, duration: 370, useNativeDriver: ND }),
    ]),
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function RadioScreen() {
  usePageSeo({
    title: "Temple TV Radio — Live Audio Broadcast",
    description:
      "Listen to Temple TV's live radio broadcast. One stream — every listener hears the same audio in real time, 24/7.",
    path: "/radio",
    structuredData: {
      "@context": "https://schema.org",
      "@type": "RadioStation",
      name: "Temple TV Radio",
      description: "Live 24/7 Christian audio broadcast from Jesus Christ Temple Ministry.",
      broadcastFrequency: "Online streaming",
      url: "https://templetv.org.ng/radio",
    },
  });

  const c      = useColors();
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

  // ── Animation values ────────────────────────────────────────────────────────
  const waves = [
    useRef(new Animated.Value(0.3)).current,
    useRef(new Animated.Value(0.65)).current,
    useRef(new Animated.Value(1.0)).current,
    useRef(new Animated.Value(0.75)).current,
    useRef(new Animated.Value(0.45)).current,
    useRef(new Animated.Value(0.85)).current,
    useRef(new Animated.Value(0.35)).current,
  ];
  const WAVE_REST = [0.3, 0.65, 1.0, 0.75, 0.45, 0.85, 0.35];

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const ring1     = useRef(new Animated.Value(0)).current;
  const ring2     = useRef(new Animated.Value(0)).current;

  const isLive = isRadioOn && !isConnecting && !isError;

  useEffect(() => {
    if (!isLive) {
      waves.forEach((a, i) => a.setValue(WAVE_REST[i] ?? 0.5));
      pulseAnim.setValue(1);
      ring1.setValue(0);
      ring2.setValue(0);
      return;
    }

    // Wave bars
    const waveAnims = waves.map((a, i) => makeWaveAnim(a, i * 75));
    waveAnims.forEach((a) => a.start());

    // Pulse on circle
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.05, duration: 1800, useNativeDriver: ND }),
        Animated.timing(pulseAnim, { toValue: 1,    duration: 1800, useNativeDriver: ND }),
      ]),
    );
    pulse.start();

    // Expanding rings
    const makeRing = (anim: Animated.Value, delay: number): Animated.CompositeAnimation =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, { toValue: 1, duration: 2400, useNativeDriver: ND }),
          Animated.timing(anim, { toValue: 0, duration: 0,    useNativeDriver: ND }),
        ]),
      );
    const r1 = makeRing(ring1, 0);
    const r2 = makeRing(ring2, 1200);
    r1.start();
    r2.start();

    return () => {
      waveAnims.forEach((a) => a.stop());
      pulse.stop();
      r1.stop();
      r2.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive]);

  const ring1Scale   = ring1.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] });
  const ring1Opacity = ring1.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0.55, 0.2, 0] });
  const ring2Scale   = ring2.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] });
  const ring2Opacity = ring2.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0.55, 0.2, 0] });

  // ── Status ──────────────────────────────────────────────────────────────────
  let statusLabel = "OFF";
  let statusColor = c.mutedForeground;
  if (configLoading) { statusLabel = "Loading…"; statusColor = c.mutedForeground; }
  else if (isConnecting) { statusLabel = "Connecting…"; statusColor = c.primary; }
  else if (isLive)       { statusLabel = "LIVE"; statusColor = "#22c55e"; }
  else if (isError)      { statusLabel = "Error";  statusColor = "#ef4444"; }

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <AppHeader />
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: 14, paddingBottom: insets.bottom + 100 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Page heading ───────────────────────────────────────────────── */}
        <View style={styles.heading}>
          <Text style={[styles.title, { color: c.foreground }]}>Live Radio</Text>
          <Text style={[styles.subtitle, { color: c.mutedForeground }]}>
            One stream · every listener hears the same broadcast
          </Text>
        </View>

        {/* ── Visualizer ─────────────────────────────────────────────────── */}
        <View style={styles.vizWrap}>
          {/* Expanding rings */}
          <View style={styles.ringWrap}>
            <Animated.View
              style={[
                styles.ring,
                { borderColor: c.primary, transform: [{ scale: ring1Scale }], opacity: ring1Opacity },
              ]}
            />
            <Animated.View
              style={[
                styles.ring,
                { borderColor: c.primary, transform: [{ scale: ring2Scale }], opacity: ring2Opacity },
              ]}
            />

            {/* Centre circle */}
            <Animated.View
              style={[
                styles.circle,
                {
                  backgroundColor: isLive ? c.primary : c.muted,
                  transform: [{ scale: pulseAnim }],
                },
              ]}
            >
              {isConnecting ? (
                <ActivityIndicator size="large" color={c.primary} />
              ) : Platform.OS === "ios" ? (
                <SymbolView
                  name="antenna.radiowaves.left.and.right"
                  tintColor={isLive ? "#fff" : c.mutedForeground}
                  size={40}
                />
              ) : (
                <Feather name="radio" size={40} color={isLive ? "#fff" : c.mutedForeground} />
              )}
            </Animated.View>
          </View>

          {/* Status badge */}
          <View
            style={[
              styles.statusBadge,
              { backgroundColor: statusColor + "22", borderColor: statusColor + "55" },
            ]}
          >
            {isLive && <View style={[styles.liveDot, { backgroundColor: "#22c55e" }]} />}
            <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
          </View>

          {/* Wave bars */}
          <View style={styles.waveRow}>
            {waves.map((anim, i) => (
              <Animated.View
                key={i}
                style={[
                  styles.waveBar,
                  { backgroundColor: isLive ? c.primary : c.border },
                  isLive
                    ? {
                        opacity: anim,
                        transform: [
                          {
                            scaleY: anim.interpolate({
                              inputRange: [0, 1],
                              outputRange: [0.1, 1],
                            }),
                          },
                        ],
                      }
                    : { opacity: 0.3 },
                ]}
              />
            ))}
          </View>
        </View>

        {/* ── Station info ────────────────────────────────────────────────── */}
        <GlassCard style={[styles.stationCard, { borderColor: c.border }]} intensity="low">
          <View style={[styles.stationIconBox, { backgroundColor: c.primary + "1A" }]}>
            <Feather name="radio" size={18} color={c.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.stationName, { color: c.foreground }]} numberOfLines={1}>
              {configLoading ? "Loading…" : stationTitle}
            </Text>
            <Text style={[styles.stationDesc, { color: c.mutedForeground }]} numberOfLines={2}>
              {configLoading ? "" : stationDescription}
            </Text>
          </View>
        </GlassCard>

        {/* ── Toggle ─────────────────────────────────────────────────────── */}
        <View style={styles.toggleWrap}>
          {!isStreamConfigured && !configLoading ? (
            <View style={[styles.unconfigured, { backgroundColor: c.muted, borderColor: c.border }]}>
              <Feather name="settings" size={22} color={c.mutedForeground} />
              <Text style={[styles.unconfiguredTitle, { color: c.foreground }]}>
                Stream not configured
              </Text>
              <Text style={[styles.unconfiguredDesc, { color: c.mutedForeground }]}>
                An admin needs to set the stream URL in Admin → Radio Station before listeners can tune in.
              </Text>
            </View>
          ) : (
            <>
              <Pressable
                onPress={isStreamConfigured ? toggleRadio : undefined}
                disabled={!isStreamConfigured || configLoading}
                style={({ pressed }) => [
                  styles.toggleBtn,
                  isRadioOn
                    ? { backgroundColor: c.primary,   opacity: pressed ? 0.88 : 1 }
                    : {
                        backgroundColor: c.muted,
                        borderColor: c.border,
                        borderWidth: 1.5,
                        opacity: pressed ? 0.8 : 1,
                      },
                ]}
              >
                <Feather
                  name={isRadioOn ? "pause-circle" : "play-circle"}
                  size={26}
                  color={isRadioOn ? "#fff" : c.mutedForeground}
                />
                <Text
                  style={[
                    styles.toggleBtnText,
                    { color: isRadioOn ? "#fff" : c.mutedForeground },
                  ]}
                >
                  {isRadioOn ? "Turn Off Radio" : "Turn On Radio"}
                </Text>
              </Pressable>

              <Text style={[styles.toggleHint, { color: c.mutedForeground }]}>
                {isRadioOn
                  ? "Audio stops immediately when you turn off"
                  : "Starts the live broadcast stream · background playback supported"}
              </Text>
            </>
          )}
        </View>

        {/* ── Error card ──────────────────────────────────────────────────── */}
        {isError && (
          <GlassCard
            style={[styles.errorCard, { borderColor: "#ef444430" }]}
            intensity="low"
          >
            <Feather name="alert-circle" size={18} color="#ef4444" style={styles.errorIcon} />
            <View style={{ flex: 1 }}>
              <Text style={styles.errorTitle}>Stream unavailable</Text>
              <Text style={[styles.errorBody, { color: c.mutedForeground }]}>
                {errorMsg ?? "Connection failed. Reconnecting…"}
              </Text>
            </View>
            <Pressable
              onPress={retryConnect}
              style={({ pressed }) => [
                styles.retryBtn,
                { backgroundColor: c.primary, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Feather name="refresh-cw" size={13} color="#fff" />
              <Text style={styles.retryBtnText}>Retry</Text>
            </Pressable>
          </GlassCard>
        )}

        {/* ── How it works ────────────────────────────────────────────────── */}
        <View style={styles.infoSection}>
          {[
            { icon: "users",    text: "All listeners hear the same broadcast simultaneously" },
            { icon: "wifi",     text: "Reconnects automatically on network drops" },
            { icon: "volume-2", text: "Continues playing in the background" },
            { icon: "power",    text: "Audio stops instantly when Radio Mode is turned off" },
          ].map(({ icon, text }) => (
            <View key={text} style={styles.infoRow}>
              <Feather
                name={icon as React.ComponentProps<typeof Feather>["name"]}
                size={13}
                color={c.primary}
                style={styles.infoIcon}
              />
              <Text style={[styles.infoText, { color: c.mutedForeground }]}>{text}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const CIRCLE_SIZE = 116;

const styles = StyleSheet.create({
  root:    { flex: 1 },
  scroll:  { paddingHorizontal: 18, paddingBottom: 140 },

  // Heading
  heading:   { marginBottom: 32 },
  title:     { fontSize: 28, fontFamily: "Inter_700Bold" },
  subtitle:  { fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 4 },

  // Visualizer
  vizWrap:   { alignItems: "center", gap: 20, marginBottom: 28 },
  ringWrap:  {
    width: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    width: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    borderRadius: CIRCLE_SIZE / 2,
    borderWidth: 1.5,
  },
  circle: {
    width: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    borderRadius: CIRCLE_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
  },

  // Status badge
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  liveDot:    { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 12, fontFamily: "Inter_700Bold", letterSpacing: 0.9 },

  // Wave bars
  waveRow: { flexDirection: "row", alignItems: "flex-end", gap: 5, height: 40 },
  waveBar: { width: 4, height: 40, borderRadius: 3 },

  // Station card
  stationCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderWidth: 1,
    marginBottom: 24,
  },
  stationIconBox: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  stationName: { fontSize: 15, fontFamily: "Inter_700Bold" },
  stationDesc: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },

  // Toggle
  toggleWrap:   { alignItems: "center", gap: 12, marginBottom: 24 },
  toggleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 34,
    paddingVertical: 16,
    borderRadius: 32,
    minWidth: 220,
    justifyContent: "center",
  },
  toggleBtnText: { fontSize: 17, fontFamily: "Inter_700Bold" },
  toggleHint:    { fontSize: 12, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 18 },

  // Unconfigured
  unconfigured: {
    alignItems: "center",
    gap: 10,
    padding: 26,
    borderRadius: 18,
    borderWidth: 1,
    borderStyle: "dashed",
    width: "100%",
  },
  unconfiguredTitle: { fontSize: 16, fontFamily: "Inter_700Bold", textAlign: "center" },
  unconfiguredDesc:  { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },

  // Error
  errorCard:  {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
    borderWidth: 1,
    marginBottom: 24,
  },
  errorIcon:  { flexShrink: 0 },
  errorTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#ef4444" },
  errorBody:  { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    flexShrink: 0,
  },
  retryBtnText: { color: "#fff", fontSize: 12, fontFamily: "Inter_600SemiBold" },

  // Info section
  infoSection: { gap: 10 },
  infoRow:     { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  infoIcon:    { marginTop: 1, flexShrink: 0 },
  infoText:    { fontSize: 13, fontFamily: "Inter_400Regular", flex: 1, lineHeight: 19 },
});
