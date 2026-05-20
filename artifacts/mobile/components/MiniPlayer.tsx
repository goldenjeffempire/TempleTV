import React from "react";
import { Pressable, StyleSheet, Text, View, Platform, useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { LiveBadge } from "@/components/LiveBadge";
import { usePlayer, usePlayerProgress } from "@/context/PlayerContext";
import { navigateToSermon, navigateToPlayer } from "@/utils/navigation";

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

  if (!currentSermon && !isLive && !isBroadcastMode) return null;

  const title = isLive ? "Temple TV Live" : isBroadcastMode ? "Temple TV" : currentSermon?.title ?? "";
  const subtitle = isLive
    ? "Watch Now"
    : isBroadcastMode
      ? "ON AIR"
      : isRadioMode
        ? "Radio Mode"
        : currentSermon?.preacher ?? "";
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  // Round 6: never show a playback-position bar on live or broadcast surfaces.
  // Broadcast queue items are a continuous channel feed — same rule as live.
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
    if (isLive) {
      navigateToPlayer(
        { live: "true", title: "Temple TV Live", preacher: "Temple TV JCTM" },
      );
    } else if (isBroadcastMode) {
      // Round 6 (Pass 3): re-entering /player from MiniPlayer while the
      // broadcast channel is still tuned must preserve broadcast intent.
      // The /player route reads `broadcastMode=true`, fetches the current
      // server-side broadcast item via SSE, and resyncs to the live
      // position. Without this branch the same sermon would re-open as a
      // VOD with seek/scrub controls — defeating the channel semantics.
      navigateToPlayer(
        { broadcastMode: "true" },
      );
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
        <View style={styles.info}>
          {/* Round 6: ON AIR badge for both live and broadcast — both
              are channel feeds, not on-demand playback. */}
          {(isLive || isBroadcastMode) && <LiveBadge size="small" />}
          {isRadioMode && !isLive && !isBroadcastMode && (
            <View style={[styles.radioBadge, { backgroundColor: c.primary }]}>
              <Feather name="radio" size={10} color="#FFF" />
            </View>
          )}
          <View style={styles.textContainer}>
            <Text style={[styles.title, { color: c.foreground }]} numberOfLines={1}>
              {title}
            </Text>
            <Text style={[styles.subtitle, { color: c.mutedForeground }]} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        </View>
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
          {/* Round 6: skip-forward is hidden in broadcast mode too — a
              real TV channel viewer can't skip the current program. */}
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

  // Bottom positioning math — sits just above the bottom tab bar.
  //
  // The classic Tab bar (react-navigation) renders at `49pt + insets.bottom`
  // tall: a constant 49pt for the icons/labels plus the device's bottom
  // safe-area inset (home indicator on iPhone X+, gesture nav on modern
  // Android). The previous hard-coded `bottom: 80` ignored the inset, so
  // on iPhone 14+ (insets.bottom ≈ 34) the mini-player sat ~3pt BELOW the
  // tab bar's top edge — visibly clipped by the tab chrome.
  //
  // Formula: 49 (tab) + insets.bottom (system) + 4 (visual gap). On web
  // the tab bar is a fixed 84pt with no system inset, so we keep the
  // original constant.
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
    // `bottom` is set inline from `bottomOffset` so it can include the
    // device's safe-area bottom inset (home indicator on iPhone X+, etc.).
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
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  info: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 },
  radioBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  textContainer: { flex: 1 },
  title: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  subtitle: { fontSize: 12, fontFamily: "Inter_400Regular" },
  controls: { flexDirection: "row", alignItems: "center", gap: 4 },
  // Tap targets: 44×44pt is the iOS HIG minimum; Android Material guidance
  // is 48dp. We use 44 across the board (close enough to 48dp at typical
  // densities) and keep `hitSlop={8}` on top to add another ~16pt of slop
  // in each axis — putting the *effective* tappable area at 60×60, well
  // above both platform minimums even for users with motor impairments.
  // The icon glyph itself stays at 22/20pt so the visual weight matches
  // the rest of the bar.
  controlBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
