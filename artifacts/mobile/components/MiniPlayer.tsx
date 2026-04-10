import React from "react";
import { Pressable, StyleSheet, Text, View, Platform } from "react-native";
import { Feather } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { LiveBadge } from "@/components/LiveBadge";
import { usePlayer } from "@/context/PlayerContext";

export function MiniPlayer() {
  const c = useColors();
  const { currentSermon, isPlaying, isLive, isRadioMode, togglePlay } = usePlayer();

  if (!currentSermon && !isLive) return null;

  const title = isLive ? "Temple TV Live" : currentSermon?.title ?? "";
  const subtitle = isLive ? "Watch Now" : isRadioMode ? "Radio Mode" : currentSermon?.preacher ?? "";

  const handleToggle = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    togglePlay();
  };

  const content = (
    <View style={styles.inner}>
      <View style={styles.info}>
        {isLive && <LiveBadge size="small" />}
        {isRadioMode && !isLive && (
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
      <Pressable onPress={handleToggle} hitSlop={12} style={styles.playBtn}>
        <Feather name={isPlaying ? "pause" : "play"} size={24} color={c.foreground} />
      </Pressable>
    </View>
  );

  if (Platform.OS === "ios") {
    return (
      <BlurView intensity={80} tint="dark" style={[styles.container, { borderColor: c.border }]}>
        {content}
      </BlurView>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: "rgba(10, 0, 20, 0.95)", borderColor: c.border }]}>
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
  inner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  info: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  radioBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  textContainer: {
    flex: 1,
  },
  title: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  subtitle: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  playBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
});
