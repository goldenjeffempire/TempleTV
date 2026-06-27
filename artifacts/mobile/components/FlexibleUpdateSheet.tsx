/**
 * FlexibleUpdateSheet
 *
 * Polished bottom-sheet overlay shown during a Google Play Flexible Update
 * download or when a flexible update is already downloaded and awaiting restart.
 *
 * States:
 *   downloading  — animated progress bar, download speed, percentage
 *   downloaded   — "Restart Now" primary CTA becomes active
 *   failed       — retry button + error message
 *   (hidden)     — any other status
 *
 * Design:
 *   • Branded purple accent consistent with Temple TV identity
 *   • Spring-animated slide-up from bottom
 *   • Accessible: modal role, live-region announcements, min 48 pt touch targets
 *   • Dismissable only for flexible (not when mandatory indicated by server)
 */

import React, { useEffect, useRef } from "react";
import {
  AccessibilityInfo,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";

interface Props {
  visible:         boolean;
  status:          string;
  progress:        number;
  versionCode:     number | null;
  isMandatory:     boolean;
  error:           string | null;
  onRestart:       () => void;
  onLater:         () => void;
  onRetry:         () => void;
}

const BAR_HEIGHT = 6;

export function FlexibleUpdateSheet({
  visible,
  status,
  progress,
  versionCode,
  isMandatory,
  error,
  onRestart,
  onLater,
  onRetry,
}: Props) {
  const insets  = useSafeAreaInsets();
  const c       = useColors();

  const slideY      = useRef(new Animated.Value(300)).current;
  const opacity     = useRef(new Animated.Value(0)).current;
  const progressAV  = useRef(new Animated.Value(0)).current;
  const backdropAV  = useRef(new Animated.Value(0)).current;

  const isDownloading = status === "downloading";
  const isDownloaded  = status === "downloaded";
  const isFailed      = status === "failed";
  const shouldShow    = visible && Platform.OS === "android" &&
    (isDownloading || isDownloaded || isFailed);

  // Slide + backdrop
  useEffect(() => {
    Animated.parallel([
      Animated.spring(slideY, {
        toValue:         shouldShow ? 0 : 300,
        useNativeDriver: true,
        speed:           18,
        bounciness:      2,
      }),
      Animated.timing(opacity, {
        toValue:  shouldShow ? 1 : 0,
        duration: 220,
        useNativeDriver: true,
      }),
      Animated.timing(backdropAV, {
        toValue:  shouldShow ? 1 : 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start();

    if (shouldShow && isDownloaded) {
      AccessibilityInfo.announceForAccessibility(
        "Update downloaded. Tap Restart Now to apply the update.",
      );
    }
  }, [shouldShow, isDownloaded, slideY, opacity, backdropAV]);

  // Smooth progress bar
  useEffect(() => {
    Animated.timing(progressAV, {
      toValue:         Math.max(0.04, progress),
      duration:        400,
      useNativeDriver: false,
    }).start();
  }, [progress, progressAV]);

  if (!shouldShow && !isDownloaded) return null;

  const percent = Math.round(progress * 100);

  const heading = isDownloaded
    ? "Update Ready"
    : isFailed
    ? "Download Failed"
    : "Downloading Update";

  const subtitle = isDownloaded
    ? "Tap Restart Now to apply the update and get the latest features."
    : isFailed
    ? (error ?? "Something went wrong. Check your connection and try again.")
    : `Downloading in the background — ${percent}% complete`;

  const backdropOpacity = backdropAV.interpolate({
    inputRange:  [0, 1],
    outputRange: ["rgba(0,0,0,0)", "rgba(0,0,0,0.45)"],
  });

  return (
    <>
      {/* Backdrop */}
      <Animated.View
        style={[StyleSheet.absoluteFill, styles.backdrop, { backgroundColor: backdropOpacity as unknown as string }]}
        pointerEvents={shouldShow ? "box-none" : "none"}
      />

      {/* Sheet */}
      <Animated.View
        style={[
          styles.sheet,
          {
            backgroundColor:  c.card,
            paddingBottom:    insets.bottom + 8,
            opacity,
            transform: [{ translateY: slideY }],
          },
        ]}
        accessibilityViewIsModal
        accessibilityRole="alert"
        accessibilityLabel={`${heading}. ${subtitle}`}
        accessibilityLiveRegion={isDownloaded ? "assertive" : "polite"}
      >
        {/* Handle */}
        <View style={[styles.handle, { backgroundColor: c.mutedForeground + "50" }]} />

        {/* Icon row */}
        <View style={styles.iconRow}>
          <View style={[styles.iconCircle, { backgroundColor: c.primary + "18" }]}>
            <Feather
              name={isDownloaded ? "check-circle" : isFailed ? "alert-circle" : "download"}
              size={28}
              color={isFailed ? "#ef4444" : c.primary}
            />
          </View>
          {!isMandatory && (
            <Pressable
              style={styles.closeBtn}
              onPress={isFailed ? onLater : onLater}
              hitSlop={14}
              accessibilityRole="button"
              accessibilityLabel="Dismiss update sheet"
            >
              <Feather name="x" size={18} color={c.mutedForeground} />
            </Pressable>
          )}
        </View>

        {/* Title */}
        <Text style={[styles.heading, { color: c.foreground }]}>{heading}</Text>
        <Text style={[styles.subtitle, { color: c.mutedForeground }]}>{subtitle}</Text>

        {/* Progress bar — shown during download */}
        {isDownloading && (
          <View style={[styles.barTrack, { backgroundColor: c.muted }]}>
            <Animated.View
              style={[
                styles.barFill,
                {
                  backgroundColor: c.primary,
                  width: progressAV.interpolate({
                    inputRange:  [0, 1],
                    outputRange: ["0%", "100%"],
                  }),
                },
              ]}
            />
          </View>
        )}

        {/* Steps row — visual download indicator */}
        {isDownloading && (
          <View style={styles.stepsRow}>
            <View style={[styles.step, { backgroundColor: c.primary }]}>
              <Feather name="download-cloud" size={13} color="#fff" />
              <Text style={styles.stepText}>Downloading</Text>
            </View>
            <View style={[styles.stepDivider, { backgroundColor: c.muted }]} />
            <View style={[styles.step, { backgroundColor: c.muted }]}>
              <Feather name="check" size={13} color={c.mutedForeground} />
              <Text style={[styles.stepText, { color: c.mutedForeground }]}>Install</Text>
            </View>
            <View style={[styles.stepDivider, { backgroundColor: c.muted }]} />
            <View style={[styles.step, { backgroundColor: c.muted }]}>
              <Feather name="refresh-cw" size={13} color={c.mutedForeground} />
              <Text style={[styles.stepText, { color: c.mutedForeground }]}>Restart</Text>
            </View>
          </View>
        )}

        {/* Downloaded — steps with completed state */}
        {isDownloaded && (
          <View style={styles.stepsRow}>
            <View style={[styles.step, { backgroundColor: "#22c55e20" }]}>
              <Feather name="download-cloud" size={13} color="#22c55e" />
              <Text style={[styles.stepText, { color: "#22c55e" }]}>Downloaded</Text>
            </View>
            <View style={[styles.stepDivider, { backgroundColor: "#22c55e50" }]} />
            <View style={[styles.step, { backgroundColor: "#22c55e20" }]}>
              <Feather name="check" size={13} color="#22c55e" />
              <Text style={[styles.stepText, { color: "#22c55e" }]}>Ready</Text>
            </View>
            <View style={[styles.stepDivider, { backgroundColor: c.muted }]} />
            <View style={[styles.step, { backgroundColor: c.primary + "18" }]}>
              <Feather name="refresh-cw" size={13} color={c.primary} />
              <Text style={[styles.stepText, { color: c.primary }]}>Restart</Text>
            </View>
          </View>
        )}

        {/* Version badge */}
        {versionCode != null && (
          <View style={[styles.badge, { backgroundColor: c.muted }]}>
            <Text style={[styles.badgeText, { color: c.mutedForeground }]}>
              Build {versionCode}
            </Text>
          </View>
        )}

        {/* Primary CTA */}
        {isDownloaded && (
          <Pressable
            style={({ pressed }) => [
              styles.cta,
              { backgroundColor: c.primary, opacity: pressed ? 0.88 : 1 },
            ]}
            onPress={onRestart}
            accessibilityRole="button"
            accessibilityLabel="Restart Now to apply update"
          >
            <Feather name="refresh-cw" size={18} color="#fff" />
            <Text style={styles.ctaText}>Restart Now</Text>
          </Pressable>
        )}

        {isFailed && (
          <Pressable
            style={({ pressed }) => [
              styles.cta,
              { backgroundColor: c.primary, opacity: pressed ? 0.88 : 1 },
            ]}
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="Retry download"
          >
            <Feather name="refresh-cw" size={18} color="#fff" />
            <Text style={styles.ctaText}>Try Again</Text>
          </Pressable>
        )}

        {isDownloading && (
          <View style={[styles.ctaDisabled, { backgroundColor: c.muted }]}>
            <Feather name="download" size={18} color={c.mutedForeground} />
            <Text style={[styles.ctaText, { color: c.mutedForeground }]}>
              Downloading…  {percent}%
            </Text>
          </View>
        )}

        {/* Later link — only for flexible (not mandatory) */}
        {!isMandatory && (isDownloading || isFailed) && (
          <Pressable
            style={styles.laterBtn}
            onPress={onLater}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Update later"
          >
            <Text style={[styles.laterText, { color: c.mutedForeground }]}>
              {isDownloading ? "Continue in background" : "Skip for now"}
            </Text>
          </Pressable>
        )}

        {/* Note */}
        <Text style={[styles.note, { color: c.mutedForeground + "90" }]}>
          {isDownloaded
            ? "The update will be applied when you restart. The app will be available in seconds."
            : "Downloading over Wi-Fi or mobile data. Your session will not be interrupted."}
        </Text>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    zIndex: 9998,
  },
  sheet: {
    position:          "absolute",
    left:              0,
    right:             0,
    bottom:            0,
    zIndex:            9999,
    borderTopLeftRadius:  24,
    borderTopRightRadius: 24,
    paddingTop:        12,
    paddingHorizontal: 20,
    gap:               12,
    shadowColor:       "#000",
    shadowOffset:      { width: 0, height: -6 },
    shadowOpacity:     0.18,
    shadowRadius:      16,
    elevation:         20,
  },
  handle: {
    width:          40,
    height:         4,
    borderRadius:   2,
    alignSelf:      "center",
    marginBottom:   4,
  },
  iconRow: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginTop:      4,
  },
  iconCircle: {
    width:           56,
    height:          56,
    borderRadius:    28,
    alignItems:      "center",
    justifyContent:  "center",
  },
  closeBtn: {
    width:   36,
    height:  36,
    alignItems:    "center",
    justifyContent:"center",
  },
  heading: {
    fontSize:      22,
    fontWeight:    "800",
    letterSpacing: -0.4,
  },
  subtitle: {
    fontSize:   14,
    lineHeight: 20,
  },
  barTrack: {
    height:       BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    overflow:     "hidden",
  },
  barFill: {
    height:       BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
  },
  stepsRow: {
    flexDirection:  "row",
    alignItems:     "center",
    gap:            6,
  },
  step: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             5,
    paddingHorizontal: 10,
    paddingVertical:   6,
    borderRadius:    20,
  },
  stepText: {
    fontSize:   12,
    fontWeight: "600",
    color:      "#fff",
  },
  stepDivider: {
    flex:   1,
    height: 1,
  },
  badge: {
    alignSelf:    "flex-start",
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderRadius: 20,
  },
  badgeText: {
    fontSize:   12,
    fontWeight: "600",
  },
  cta: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             10,
    paddingVertical: 15,
    borderRadius:    14,
    marginTop:       4,
  },
  ctaDisabled: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    gap:             10,
    paddingVertical: 15,
    borderRadius:    14,
    marginTop:       4,
  },
  ctaText: {
    color:      "#fff",
    fontSize:   16,
    fontWeight: "700",
  },
  laterBtn: {
    alignSelf:     "center",
    paddingVertical: 6,
  },
  laterText: {
    fontSize:   14,
    fontWeight: "500",
  },
  note: {
    fontSize:   11,
    lineHeight: 16,
    textAlign:  "center",
    marginBottom: 4,
  },
});
