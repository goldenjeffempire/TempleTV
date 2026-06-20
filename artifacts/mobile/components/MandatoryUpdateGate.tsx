/**
 * MandatoryUpdateGate
 *
 * Full-screen blocking overlay shown when the server marks an update as
 * mandatory (isMandatory: true OR currentVersion < minRequiredVersion).
 * The user cannot dismiss this or use the app until they update.
 *
 * Store update:  Shows "Update Now" button → Linking.openURL(storeUrl)
 * No store URL:  Shows only the release notes + contact support link
 */

import React, { useEffect, useRef } from "react";
import {
  ActivityIndicator,
  Animated,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useUpdate } from "@/context/UpdateContext";
import { useColors } from "@/hooks/useColors";

export function MandatoryUpdateGate() {
  const insets = useSafeAreaInsets();
  const c      = useColors();
  const {
    isMandatoryBlocked,
    hasOTAUpdate,
    isApplyingOTA,
    latestVersion,
    releaseNotes,
    storeUrl,
    otaError,
    applyOTA,
    openStore,
  } = useUpdate();

  const fadeIn = useRef(new Animated.Value(0)).current;

  const shouldBlock = isMandatoryBlocked && Platform.OS !== "web";

  useEffect(() => {
    if (shouldBlock) {
      Animated.timing(fadeIn, {
        toValue:         1,
        duration:        350,
        useNativeDriver: true,
      }).start();
    }
  }, [shouldBlock, fadeIn]);

  if (!shouldBlock) return null;

  const appVersion = Constants.expoConfig?.version ?? "—";

  const handleAction = () => {
    if (hasOTAUpdate) {
      void applyOTA();
    } else if (storeUrl) {
      void openStore();
    } else {
      Linking.openURL("mailto:support@templetv.org.ng").catch(() => {});
    }
  };

  const actionLabel = hasOTAUpdate
    ? isApplyingOTA ? "Applying Update…" : "Restart & Update"
    : storeUrl
    ? "Update Now"
    : "Contact Support";

  const actionIcon: React.ComponentProps<typeof Feather>["name"] = hasOTAUpdate
    ? "refresh-cw"
    : storeUrl
    ? "arrow-up-circle"
    : "mail";

  return (
    <Animated.View
      style={[styles.overlay, { opacity: fadeIn }]}
      accessibilityViewIsModal
      accessibilityRole="alert"
      accessibilityLabel="Mandatory app update required"
    >
      {/* Dark blur backdrop */}
      <View style={[StyleSheet.absoluteFill, styles.backdrop]} />

      <View
        style={[
          styles.card,
          {
            backgroundColor: c.card,
            paddingTop:       Math.max(insets.top, 20) + 16,
            paddingBottom:    Math.max(insets.bottom, 24) + 16,
          },
        ]}
      >
        {/* Top icon */}
        <View style={[styles.iconCircle, { backgroundColor: c.primary + "20" }]}>
          <Feather name="arrow-up-circle" size={40} color={c.primary} />
        </View>

        {/* Heading */}
        <Text style={[styles.heading, { color: c.foreground }]}>
          Update Required
        </Text>
        <Text style={[styles.subheading, { color: c.mutedForeground }]}>
          Please update the app to continue.{"\n"}
          {latestVersion ? `Version ${latestVersion} is now available.` : "A required update is available."}
        </Text>

        {/* Release notes */}
        {!!releaseNotes && (
          <View style={[styles.notesCard, { backgroundColor: c.muted + "60" }]}>
            <Text style={[styles.notesLabel, { color: c.mutedForeground }]}>
              What's new
            </Text>
            <Text style={[styles.notes, { color: c.foreground }]} numberOfLines={8}>
              {releaseNotes}
            </Text>
          </View>
        )}

        {/* Error */}
        {!!otaError && (
          <View style={[styles.errorCard, { backgroundColor: "#ef444415" }]}>
            <Feather name="alert-circle" size={14} color="#ef4444" />
            <Text style={styles.errorText} numberOfLines={2}>{otaError}</Text>
          </View>
        )}

        {/* CTA */}
        <Pressable
          style={({ pressed }) => [
            styles.cta,
            { backgroundColor: c.primary, opacity: pressed ? 0.85 : 1 },
          ]}
          onPress={handleAction}
          disabled={isApplyingOTA}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
        >
          {isApplyingOTA ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Feather name={actionIcon} size={18} color="#fff" />
          )}
          <Text style={styles.ctaText}>{actionLabel}</Text>
        </Pressable>

        {/* Version footer */}
        <Text style={[styles.footer, { color: c.mutedForeground }]}>
          Current version: {appVersion}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex:          99999,
    alignItems:      "center",
    justifyContent:  "center",
  },
  backdrop: {
    backgroundColor: "rgba(0,0,0,0.85)",
  },
  card: {
    width:           "100%",
    height:          "100%",
    alignItems:      "center",
    paddingHorizontal: 28,
    gap:             20,
  },
  iconCircle: {
    width:           88,
    height:          88,
    borderRadius:    44,
    alignItems:      "center",
    justifyContent:  "center",
    marginTop:       20,
  },
  heading: {
    fontSize:    28,
    fontWeight:  "800",
    letterSpacing: -0.5,
    textAlign:   "center",
  },
  subheading: {
    fontSize:   15,
    textAlign:  "center",
    lineHeight: 22,
  },
  notesCard: {
    width:         "100%",
    borderRadius:  12,
    padding:       14,
    gap:           6,
  },
  notesLabel: {
    fontSize:   11,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  notes: {
    fontSize:   14,
    lineHeight: 20,
  },
  errorCard: {
    flexDirection:  "row",
    alignItems:     "center",
    width:          "100%",
    borderRadius:   10,
    padding:        12,
    gap:            8,
  },
  errorText: {
    flex:      1,
    color:     "#ef4444",
    fontSize:  13,
  },
  cta: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             10,
    width:           "100%",
    paddingVertical: 16,
    borderRadius:    14,
    marginTop:       4,
  },
  ctaText: {
    color:      "#fff",
    fontSize:   17,
    fontWeight: "700",
  },
  footer: {
    fontSize:   12,
    textAlign:  "center",
  },
});
