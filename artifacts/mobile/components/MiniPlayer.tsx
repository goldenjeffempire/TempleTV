import React, { useRef } from "react";
import { Pressable, StyleSheet, Text, View, Platform, useColorScheme } from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { LiveBadge } from "@/components/LiveBadge";
import { usePlayer, usePlayerProgress } from "@/context/PlayerContext";
import { navigateToSermon, navigateToPlayer } from "@/utils/navigation";
import { useV2BroadcastNative } from "@workspace/player-core/react-native";
import { getApiBase } from "@/lib/apiBase";

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

export function MiniPlayer() {
  const c = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const insets = useSafeAreaInsets();
  const {
    currentSermon,
    isPlaying,
    isLive,
    isBroadcastMode,
    isRadioMode,
    togglePlay,
    playNext,
  } = usePlayer();
  const { currentTime, duration } = usePlayerProgress();

  // V2 broadcast snapshot — resolves the current program title and thumbnail.
  // Attaches to the singleton session (no extra WS connection).
  const apiBase = getApiBase() ?? "";
  const { snapshot: v2Snapshot } = useV2BroadcastNative({
    baseUrl: `${apiBase}/api/broadcast-v2`,
  });
  const v2Current = v2Snapshot.lastServerSnapshot?.current;
  const broadcastTitle = isBroadcastMode ? (v2Current?.title ?? null) : null;
  const broadcastThumb = isBroadcastMode ? (v2Current?.thumbnailUrl ?? null) : null;

  // Guard against rapid double-taps pushing duplicate /player entries onto
  // the navigation stack. Locks for 600 ms — long enough to cover a
  // touchscreen bounce or an impatient double-tap, short enough that a
  // deliberate second tap after the animation settles is still honoured.
  const navigatingRef = useRef(false);

  if (!currentSermon && !isLive && !isBroadcastMode) return null;

  const title = isLive
    ? "Live"
    : isBroadcastMode
      ? (broadcastTitle ?? "Live")
      : currentSermon?.title ?? "";

  const subtitle = isLive
    ? "Watch Now"
    : isBroadcastMode
      ? "ON AIR · Live Broadcast"
      : isRadioMode
        ? "Radio Mode"
        : currentSermon?.preacher ?? "";

  // Thumbnail — broadcast > VOD sermon > null
  const thumbUri = broadcastThumb ?? currentSermon?.thumbnailUrl ?? null;

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  // Never show a playback-position bar on live or broadcast surfaces.
  const showProgress = !isLive && !isBroadcastMode && duration > 0;

  const handleToggle = () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    togglePlay();
  };

  const handleNext = () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    playNext();
  };

  const handlePress = () => {
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    setTimeout(() => { navigatingRef.current = false; }, 600);

    if (isLive) {
      navigateToPlayer({ live: "true", title: "Temple TV Live", preacher: "Temple TV JCTM" });
    } else if (isBroadcastMode) {
      navigateToPlayer({ broadcastMode: "true" });
    } else if (currentSermon) {
      navigateToSermon(currentSermon);
    }
  };

  const content = (
    <View>
      {showProgress && (
        <View style={[styles.progressTrack, { backgroundColor: c.border }]}>
          <View
            style={[
              styles.progressFill,
              { backgroundColor: c.primary, width: `${Math.round(progress * 100)}%` as any },
            ]}
          />
        </View>
      )}
      <Pressable
        onPress={handlePress}
        style={({ pressed }) => [styles.inner, { opacity: pressed ? 0.85 : 1 }]}
      >
        {/* ── Info ─────────────────────────────────────────────────────── */}
        <View style={styles.info}>
          {/* Artwork / thumbnail */}
          {thumbUri ? (
            <View style={styles.artworkWrap}>
              <Image
                source={{ uri: thumbUri }}
                placeholder={PLACEHOLDER}
                style={styles.artwork}
                contentFit="cover"
                transition={200}
              />
              {/* Live dot overlay on artwork */}
              {(isLive || isBroadcastMode) && (
                <View style={styles.artworkLiveDot} />
              )}
            </View>
          ) : (
            /* Fallback icon when no thumbnail is available */
            <View style={[styles.artworkFallback, { backgroundColor: c.muted }]}>
              {(isLive || isBroadcastMode) ? (
                <Feather name="radio" size={16} color={c.primary} />
              ) : isRadioMode ? (
                <Feather name="radio" size={16} color={c.primary} />
              ) : (
                <Feather name="play" size={16} color={c.mutedForeground} />
              )}
            </View>
          )}

          {/* Live / Radio badge — only when no thumbnail */}
          {!thumbUri && (isLive || isBroadcastMode) && (
            <LiveBadge size="small" />
          )}
          {!thumbUri && isRadioMode && !isLive && !isBroadcastMode && (
            <View style={[styles.radioBadge, { backgroundColor: c.primary }]}>
              <Feather name="radio" size={10} color="#FFF" />
            </View>
          )}

          {/* Title + subtitle */}
          <View style={styles.textContainer}>
            <Text style={[styles.title, { color: c.foreground }]} numberOfLines={1}>
              {title}
            </Text>
            <Text style={[styles.subtitle, { color: c.mutedForeground }]} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        </View>

        {/* ── Controls ─────────────────────────────────────────────────── */}
        <View style={styles.controls}>
          <Pressable
            onPress={handleToggle}
            hitSlop={8}
            style={styles.controlBtn}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? "Pause" : "Play"}
          >
            <Feather name={isPlaying ? "pause" : "play"} size={22} color={c.foreground} />
          </Pressable>
          {/* Skip-forward hidden in broadcast/live mode — real TV channel semantics. */}
          {!isLive && !isBroadcastMode && (
            <Pressable
              onPress={handleNext}
              hitSlop={8}
              style={styles.controlBtn}
              accessibilityRole="button"
              accessibilityLabel="Skip to next"
            >
              <Feather name="skip-forward" size={20} color={c.mutedForeground} />
            </Pressable>
          )}
        </View>
      </Pressable>
    </View>
  );

  // Bottom positioning — sits just above the bottom tab bar.
  // Tab bar = 49pt constant + insets.bottom (home indicator / gesture nav).
  // +4 visual gap. Web keeps the original constant (tab bar = fixed 84pt).
  const bottomOffset = Platform.OS === "web" ? 84 : 53 + insets.bottom;

  if (Platform.OS === "ios") {
    return (
      <BlurView
        intensity={80}
        tint={isDark ? "dark" : "light"}
        style={[styles.container, { borderColor: c.border, bottom: bottomOffset }]}
      >
        {content}
      </BlurView>
    );
  }

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: c.surfaceGlass, borderColor: c.border, bottom: bottomOffset },
      ]}
    >
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 8,
    right: 8,
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
  },
  progressTrack: {
    height: 2,
    width: "100%",
  },
  progressFill: {
    height: 2,
    borderRadius: 1,
  },
  inner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  info: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0 },

  // Artwork
  artworkWrap: {
    position: "relative",
    flexShrink: 0,
  },
  artwork: {
    width: 42,
    height: 42,
    borderRadius: 8,
  },
  artworkLiveDot: {
    position: "absolute",
    bottom: 3,
    right: 3,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#ef4444",
    borderWidth: 1.5,
    borderColor: "#fff",
  },
  artworkFallback: {
    width: 42,
    height: 42,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },

  radioBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },

  textContainer: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  subtitle: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 1 },

  controls: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 },
  // 44×44pt meets iOS HIG minimum; hitSlop={8} extends effective area to ~60×60pt.
  controlBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
