import React, { useEffect, useRef } from "react";
import {
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { GlassCard } from "@/components/GlassCard";
import { usePlayer } from "@/context/PlayerContext";
import { SERMONS } from "@/data/sermons";

export default function RadioScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const {
    currentSermon,
    isPlaying,
    isRadioMode,
    dataSaver,
    togglePlay,
    toggleRadioMode,
    toggleDataSaver,
    playSermon,
    playNext,
    playPrevious,
    queue,
    currentIndex,
  } = usePlayer();
  const webTopPad = Platform.OS === "web" ? 67 : 0;

  const rotateAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (isPlaying && isRadioMode) {
      const rotate = Animated.loop(
        Animated.timing(rotateAnim, { toValue: 1, duration: 8000, useNativeDriver: true }),
      );
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.1, duration: 1500, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 1500, useNativeDriver: true }),
        ]),
      );
      rotate.start();
      pulse.start();
      return () => {
        rotate.stop();
        pulse.stop();
      };
    }
    rotateAnim.setValue(0);
    pulseAnim.setValue(1);
  }, [isPlaying, isRadioMode]);

  const spin = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  const nowPlaying = currentSermon ?? SERMONS[0];

  const handlePlayToggle = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (!currentSermon) {
      playSermon(SERMONS[0]);
      if (!isRadioMode) toggleRadioMode();
    } else {
      togglePlay();
    }
  };

  const handleRadioToggle = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    toggleRadioMode();
  };

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + webTopPad, paddingBottom: 140 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.header, { color: c.foreground }]}>Radio Mode</Text>
        <Text style={[styles.desc, { color: c.mutedForeground }]}>
          Listen to sermons with your screen off
        </Text>

        <View style={styles.playerSection}>
          <Animated.View
            style={[
              styles.disc,
              {
                backgroundColor: c.surfaceGlass,
                borderColor: c.border,
                transform: [{ rotate: spin }, { scale: pulseAnim }],
              },
            ]}
          >
            <View style={[styles.discInner, { backgroundColor: c.primary }]}>
              <Feather name="radio" size={40} color="#FFF" />
            </View>
          </Animated.View>

          <Text style={[styles.nowPlayingTitle, { color: c.foreground }]} numberOfLines={2}>
            {nowPlaying.title}
          </Text>
          <Text style={[styles.nowPlayingMeta, { color: c.mutedForeground }]}>
            {nowPlaying.preacher}
          </Text>

          <View style={styles.controls}>
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                playPrevious();
              }}
              hitSlop={12}
            >
              <Feather name="skip-back" size={28} color={c.foreground} />
            </Pressable>

            <Pressable
              onPress={handlePlayToggle}
              style={[styles.playButton, { backgroundColor: c.primary }]}
            >
              <Feather name={isPlaying ? "pause" : "play"} size={32} color="#FFF" />
            </Pressable>

            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                playNext();
              }}
              hitSlop={12}
            >
              <Feather name="skip-forward" size={28} color={c.foreground} />
            </Pressable>
          </View>
        </View>

        <View style={styles.togglesSection}>
          <GlassCard style={styles.toggleCard}>
            <View style={styles.toggleRow}>
              <View style={styles.toggleInfo}>
                <Feather name="radio" size={20} color={c.primary} />
                <View>
                  <Text style={[styles.toggleLabel, { color: c.foreground }]}>Radio Mode</Text>
                  <Text style={[styles.toggleDesc, { color: c.mutedForeground }]}>Audio only playback</Text>
                </View>
              </View>
              <Pressable
                onPress={handleRadioToggle}
                style={[
                  styles.toggleSwitch,
                  { backgroundColor: isRadioMode ? c.primary : c.muted },
                ]}
              >
                <View
                  style={[
                    styles.toggleThumb,
                    { transform: [{ translateX: isRadioMode ? 20 : 0 }] },
                  ]}
                />
              </Pressable>
            </View>
          </GlassCard>

          <GlassCard style={styles.toggleCard}>
            <View style={styles.toggleRow}>
              <View style={styles.toggleInfo}>
                <Feather name="wifi-off" size={20} color={c.primary} />
                <View>
                  <Text style={[styles.toggleLabel, { color: c.foreground }]}>Data Saver</Text>
                  <Text style={[styles.toggleDesc, { color: c.mutedForeground }]}>Lower quality audio</Text>
                </View>
              </View>
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  toggleDataSaver();
                }}
                style={[
                  styles.toggleSwitch,
                  { backgroundColor: dataSaver ? c.primary : c.muted },
                ]}
              >
                <View
                  style={[
                    styles.toggleThumb,
                    { transform: [{ translateX: dataSaver ? 20 : 0 }] },
                  ]}
                />
              </Pressable>
            </View>
          </GlassCard>
        </View>

        <View style={styles.queueSection}>
          <Text style={[styles.queueTitle, { color: c.foreground }]}>Up Next</Text>
          {queue.slice(currentIndex + 1, currentIndex + 4).map((sermon) => (
            <Pressable
              key={sermon.id}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                playSermon(sermon);
              }}
              style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}
            >
              <GlassCard style={styles.queueItem}>
                <Feather name="music" size={16} color={c.primary} />
                <View style={styles.queueText}>
                  <Text style={[styles.queueItemTitle, { color: c.foreground }]} numberOfLines={1}>
                    {sermon.title}
                  </Text>
                  <Text style={[styles.queueItemDuration, { color: c.mutedForeground }]}>
                    {sermon.duration}
                  </Text>
                </View>
              </GlassCard>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  desc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    paddingHorizontal: 16,
    marginTop: 4,
    marginBottom: 24,
  },
  playerSection: {
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 16,
  },
  disc: {
    width: 200,
    height: 200,
    borderRadius: 100,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  discInner: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  nowPlayingTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
    paddingHorizontal: 20,
  },
  nowPlayingMeta: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 32,
    marginTop: 8,
  },
  playButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  togglesSection: {
    paddingHorizontal: 16,
    marginTop: 32,
    gap: 10,
  },
  toggleCard: {
    padding: 16,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toggleInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  toggleLabel: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  toggleDesc: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  toggleSwitch: {
    width: 48,
    height: 28,
    borderRadius: 14,
    padding: 4,
  },
  toggleThumb: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#FFF",
  },
  queueSection: {
    paddingHorizontal: 16,
    marginTop: 32,
    gap: 8,
  },
  queueTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    marginBottom: 4,
  },
  queueItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    gap: 12,
  },
  queueText: {
    flex: 1,
  },
  queueItemTitle: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  queueItemDuration: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
});
