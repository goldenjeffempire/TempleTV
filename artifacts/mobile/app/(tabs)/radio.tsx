/**
 * Radio Screen — Coming Soon
 *
 * Placeholder screen shown while the live radio feature is being prepared.
 * Replaces the full stream UI; no RadioStreamContext calls needed here.
 */
import type { ErrorBoundaryProps } from "expo-router";
import { Stack } from "expo-router";
import { ErrorFallback } from "@/components/ErrorFallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <ErrorFallback error={error} resetError={retry} />;
}

import React, { useCallback, useEffect, useRef } from "react";
import {
  Animated,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { SymbolView } from "expo-symbols";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { useColors } from "@/hooks/useColors";

const ND = Platform.OS !== "web";

export default function RadioScreen() {
  const c      = useColors();
  const insets = useSafeAreaInsets();

  // Gentle pulse on the icon circle
  const pulseAnim = useRef(new Animated.Value(1)).current;
  // Slow fade in for the whole card
  const fadeAnim  = useRef(new Animated.Value(0)).current;

  // Fade-in plays once on mount
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 600,
      useNativeDriver: ND,
    }).start();
  }, [fadeAnim]);

  // Pulse only runs while this tab is focused — stops when the user switches tabs
  useFocusEffect(
    useCallback(() => {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.08, duration: 1800, useNativeDriver: ND }),
          Animated.timing(pulseAnim, { toValue: 1,    duration: 1800, useNativeDriver: ND }),
        ]),
      );
      pulse.start();
      return () => pulse.stop();
    }, [pulseAnim]),
  );

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ headerShown: false, header: () => null, title: "" }} />

      <View style={[styles.body, { paddingTop: insets.top, paddingBottom: insets.bottom + 40 }]}>
        <Animated.View style={[styles.card, { opacity: fadeAnim }]}>

          {/* Icon */}
          <Animated.View
            style={[
              styles.iconCircle,
              { backgroundColor: c.primary + "18", transform: [{ scale: pulseAnim }] },
            ]}
          >
            {Platform.OS === "ios" ? (
              <SymbolView
                name="antenna.radiowaves.left.and.right"
                tintColor={c.primary}
                size={42}
              />
            ) : (
              <Feather name="radio" size={42} color={c.primary} />
            )}
          </Animated.View>

          {/* Badge */}
          <View style={[styles.badge, { backgroundColor: c.primary + "18", borderColor: c.primary + "44" }]}>
            <View style={[styles.badgeDot, { backgroundColor: c.primary }]} />
            <Text style={[styles.badgeText, { color: c.primary }]}>LAUNCHING SOON</Text>
          </View>

          {/* Heading */}
          <Text style={[styles.heading, { color: c.foreground }]}>Radio</Text>

          {/* Sub-copy */}
          <Text style={[styles.body2, { color: c.mutedForeground }]}>
            Live audio broadcasting is on its way — one stream, every listener hears the same
            worship in real time, 24/7.
          </Text>

          {/* Divider */}
          <View style={[styles.divider, { backgroundColor: c.border }]} />

          {/* Feature teasers */}
          {[
            { icon: "users",    label: "Simultaneous broadcast to all listeners" },
            { icon: "wifi",     label: "Auto-reconnects on network drops" },
            { icon: "volume-2", label: "Background playback supported" },
          ].map(({ icon, label }) => (
            <View key={label} style={styles.featureRow}>
              <View style={[styles.featureIconWrap, { backgroundColor: c.muted }]}>
                <Feather
                  name={icon as React.ComponentProps<typeof Feather>["name"]}
                  size={14}
                  color={c.primary}
                />
              </View>
              <Text style={[styles.featureText, { color: c.mutedForeground }]}>{label}</Text>
            </View>
          ))}

        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  body: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
  },

  card: {
    alignItems: "center",
    width: "100%",
    maxWidth: 380,
    gap: 0,
  },

  iconCircle: {
    width: 110,
    height: 110,
    borderRadius: 55,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },

  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    marginBottom: 18,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  badgeText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.2,
  },

  heading: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
    marginBottom: 12,
    letterSpacing: -0.4,
  },

  body2: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 28,
  },

  divider: {
    width: "100%",
    height: 1,
    marginBottom: 24,
  },

  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    width: "100%",
    marginBottom: 14,
  },
  featureIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
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
});
