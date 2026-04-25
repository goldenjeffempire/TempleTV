import React from "react";
import { Pressable, StyleSheet, Text, View, Platform, useColorScheme } from "react-native";
import { Feather } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useColors } from "@/hooks/useColors";
import { LiveBadge } from "@/components/LiveBadge";
import { usePlayer, usePlayerProgress } from "@/context/PlayerContext";
import { navigateToSermon, navigateToPlayer } from "@/utils/navigation";

export function MiniPlayer() {
  const c = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
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

  if (!currentSermon && !isLive) return null;

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
          <Pressable onPress={handleToggle} hitSlop={12} style={styles.controlBtn}>
            <Feather name={isPlaying ? "pause" : "play"} size={22} color={c.foreground} />
          </Pressable>
          {/* Round 6: skip-forward is hidden in broadcast mode too — a
              real TV channel viewer can't skip the current program. */}
          {!isLive && !isBroadcastMode && (
            <Pressable onPress={handleNext} hitSlop={12} style={styles.controlBtn}>
              <Feather name="skip-forward" size={20} color={c.mutedForeground} />
            </Pressable>
          )}
        </View>
      </Pressable>
    </View>
  );

  if (Platform.OS === "ios") {
    return (
      <BlurView
        intensity={80}
        tint={isDark ? "dark" : "light"}
        style={[styles.container, { borderColor: c.border }]}
      >
        {content}
      </BlurView>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: c.surfaceGlass, borderColor: c.border }]}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: Platform.OS === "web" ? 84 : 80,
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
  controlBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
});
