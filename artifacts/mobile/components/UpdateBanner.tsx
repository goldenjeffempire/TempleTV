/**
 * UpdateBanner
 *
 * Slide-in non-blocking banner shown when an optional (or OTA) app update is
 * available. Appears from the top of the screen below the status bar.
 *
 * – Optional store update:  "Update Available" → tap to open store
 * – OTA update:             "Improvements ready" → tap to apply now
 * – Dismissable:            user can close; banner won't reappear for 24 h
 * – Never shown for mandatory updates (those use MandatoryUpdateGate)
 */

import React, { useEffect, useRef } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useUpdate } from "@/context/UpdateContext";
import { useColors } from "@/hooks/useColors";

export function UpdateBanner() {
  const insets                          = useSafeAreaInsets();
  const c                               = useColors();
  const { bannerVisible, hasOTAUpdate, hasStoreUpdate, isMandatory,
          isApplyingOTA, latestVersion, applyOTA, openStore, dismissBanner } = useUpdate();

  const slideY  = useRef(new Animated.Value(-80)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  const shouldShow =
    bannerVisible &&
    !isMandatory &&
    (hasOTAUpdate || hasStoreUpdate) &&
    Platform.OS !== "web";

  useEffect(() => {
    Animated.parallel([
      Animated.spring(slideY, {
        toValue:         shouldShow ? 0 : -80,
        useNativeDriver: true,
        speed:           14,
        bounciness:      3,
      }),
      Animated.timing(opacity, {
        toValue:         shouldShow ? 1 : 0,
        duration:        200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [shouldShow, slideY, opacity]);

  if (!shouldShow && !isApplyingOTA) return null;

  const handleAction = () => {
    if (hasOTAUpdate) {
      void applyOTA();
    } else {
      void openStore();
    }
  };

  const title   = hasOTAUpdate ? "Improvements Ready" : `Update Available`;
  const subtitle = hasOTAUpdate
    ? "Tap to apply now — takes a few seconds"
    : latestVersion
    ? `Version ${latestVersion} is available`
    : "A new version is available";

  return (
    <Animated.View
      style={[
        styles.container,
        {
          top:             insets.top + 8,
          backgroundColor: c.primary,
          opacity,
          transform:       [{ translateY: slideY }],
        },
      ]}
      accessibilityRole="alert"
      accessibilityLabel={`${title}. ${subtitle}`}
      accessibilityLiveRegion="polite"
    >
      <Pressable
        style={styles.inner}
        onPress={handleAction}
        disabled={isApplyingOTA}
        accessibilityRole="button"
        accessibilityLabel={hasOTAUpdate ? "Apply update" : "Open app store to update"}
      >
        {/* Icon */}
        <View style={styles.iconWrap}>
          {isApplyingOTA ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Feather name="arrow-up-circle" size={20} color="#fff" />
          )}
        </View>

        {/* Text */}
        <View style={styles.textWrap}>
          <Text style={styles.title} numberOfLines={1}>
            {isApplyingOTA ? "Applying Update…" : title}
          </Text>
          {!isApplyingOTA && (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          )}
        </View>

        {/* CTA */}
        {!isApplyingOTA && (
          <View style={styles.cta}>
            <Text style={styles.ctaText}>
              {hasOTAUpdate ? "Restart" : "Update"}
            </Text>
          </View>
        )}
      </Pressable>

      {/* Dismiss button */}
      {!isApplyingOTA && (
        <Pressable
          style={styles.close}
          onPress={() => void dismissBanner()}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Dismiss update banner"
        >
          <Feather name="x" size={14} color="rgba(255,255,255,0.8)" />
        </Pressable>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position:     "absolute",
    left:         16,
    right:        16,
    zIndex:       9999,
    borderRadius: 14,
    shadowColor:  "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius:  8,
    elevation:     8,
    flexDirection: "row",
    alignItems:    "center",
    paddingVertical:   10,
    paddingHorizontal: 12,
    gap:               8,
  },
  inner: {
    flex:          1,
    flexDirection: "row",
    alignItems:    "center",
    gap:           10,
  },
  iconWrap: {
    width:           36,
    height:          36,
    borderRadius:    18,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems:      "center",
    justifyContent:  "center",
    flexShrink:      0,
  },
  textWrap: {
    flex:       1,
    minWidth:   0,
  },
  title: {
    color:      "#fff",
    fontSize:   14,
    fontWeight: "700",
  },
  subtitle: {
    color:     "rgba(255,255,255,0.85)",
    fontSize:  12,
    marginTop: 1,
  },
  cta: {
    backgroundColor: "rgba(255,255,255,0.22)",
    paddingHorizontal: 10,
    paddingVertical:    5,
    borderRadius:       8,
    flexShrink:         0,
  },
  ctaText: {
    color:      "#fff",
    fontSize:   13,
    fontWeight: "700",
  },
  close: {
    padding:    4,
    marginLeft: 2,
    flexShrink: 0,
  },
});
