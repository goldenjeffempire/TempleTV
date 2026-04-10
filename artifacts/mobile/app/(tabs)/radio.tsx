import React, { useEffect, useRef } from "react";
import {
  Animated,
  FlatList,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { GlassCard } from "@/components/GlassCard";
import { NowPlayingBar } from "@/components/NowPlayingBar";
import { usePlayer } from "@/context/PlayerContext";
import { useYouTubeChannel } from "@/hooks/useYouTubeChannel";
import type { Sermon } from "@/types";

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

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
    setQueue,
  } = usePlayer();
  const { sermons } = useYouTubeChannel();
  const webTopPad = Platform.OS === "web" ? 67 : 0;

  // Sync queue with real sermon data
  useEffect(() => {
    if (sermons.length > 0) setQueue(sermons);
  }, [sermons]);

  const rotateAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const waveAnim1 = useRef(new Animated.Value(0.3)).current;
  const waveAnim2 = useRef(new Animated.Value(0.5)).current;
  const waveAnim3 = useRef(new Animated.Value(0.7)).current;

  useEffect(() => {
    if (isPlaying && isRadioMode) {
      const rotate = Animated.loop(
        Animated.timing(rotateAnim, { toValue: 1, duration: 10000, useNativeDriver: true }),
      );
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.08, duration: 2000, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 2000, useNativeDriver: true }),
        ]),
      );
      const makeWave = (anim: Animated.Value, delay: number) =>
        Animated.loop(
          Animated.sequence([
            Animated.delay(delay),
            Animated.timing(anim, { toValue: 1, duration: 500, useNativeDriver: true }),
            Animated.timing(anim, { toValue: 0.2, duration: 500, useNativeDriver: true }),
          ]),
        );
      rotate.start();
      pulse.start();
      makeWave(waveAnim1, 0).start();
      makeWave(waveAnim2, 200).start();
      makeWave(waveAnim3, 400).start();
      return () => {
        rotate.stop();
        pulse.stop();
        waveAnim1.setValue(0.3);
        waveAnim2.setValue(0.5);
        waveAnim3.setValue(0.7);
      };
    }
  }, [isPlaying, isRadioMode]);

  const spin = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const nowPlaying = currentSermon ?? sermons[0];
  const thumbUri = nowPlaying?.thumbnailUrl;

  const handlePlayToggle = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (!currentSermon && sermons.length > 0) {
      playSermon(sermons[0]);
      if (!isRadioMode) toggleRadioMode();
    } else {
      togglePlay();
    }
  };

  const upNext = queue
    .slice(currentIndex + 1, currentIndex + 5)
    .filter((s) => s.youtubeId !== nowPlaying?.youtubeId);

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + webTopPad, paddingBottom: 150 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.header, { color: c.foreground }]}>Radio</Text>
        <Text style={[styles.desc, { color: c.mutedForeground }]}>
          Listen with screen off — Temple TV audio mode
        </Text>

        <View style={styles.playerSection}>
          <Animated.View style={{ transform: [{ rotate: spin }, { scale: pulseAnim }] }}>
            <View style={[styles.discOuter, { borderColor: "rgba(106,13,173,0.4)" }]}>
              <View style={[styles.discMid, { backgroundColor: "rgba(106,13,173,0.15)" }]}>
                {thumbUri ? (
                  <Image source={{ uri: thumbUri }} style={styles.discImage} />
                ) : (
                  <Image source={PLACEHOLDER} style={styles.discImage} />
                )}
                <View style={[styles.discCenter, { backgroundColor: c.background }]}>
                  <Feather name="radio" size={20} color={c.primary} />
                </View>
              </View>
            </View>
          </Animated.View>

          {isPlaying && isRadioMode && (
            <View style={styles.waveContainer}>
              {[waveAnim1, waveAnim2, waveAnim3, waveAnim2, waveAnim1].map((anim, i) => (
                <Animated.View
                  key={i}
                  style={[styles.waveBar, { backgroundColor: c.primary, opacity: anim }]}
                />
              ))}
            </View>
          )}

          <Text style={[styles.nowTitle, { color: c.foreground }]} numberOfLines={2}>
            {nowPlaying?.title ?? "Select a sermon to play"}
          </Text>
          <Text style={[styles.nowPreacher, { color: c.mutedForeground }]}>
            {nowPlaying?.preacher ?? "Temple TV JCTM"}
          </Text>

          <View style={styles.controls}>
            <Pressable
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); playPrevious(); }}
              style={({ pressed }) => [{ opacity: pressed ? 0.6 : 1 }]}
              hitSlop={12}
            >
              <Feather name="skip-back" size={30} color={c.foreground} />
            </Pressable>

            <Pressable
              onPress={handlePlayToggle}
              style={({ pressed }) => [
                styles.playButton,
                { backgroundColor: c.primary, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Feather name={isPlaying ? "pause" : "play"} size={30} color="#FFF" />
            </Pressable>

            <Pressable
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); playNext(); }}
              style={({ pressed }) => [{ opacity: pressed ? 0.6 : 1 }]}
              hitSlop={12}
            >
              <Feather name="skip-forward" size={30} color={c.foreground} />
            </Pressable>
          </View>
        </View>

        <View style={styles.togglesSection}>
          <GlassCard style={styles.toggleRow}>
            <View style={styles.toggleLeft}>
              <View style={[styles.toggleIcon, { backgroundColor: c.secondary }]}>
                <Feather name="radio" size={16} color={c.primary} />
              </View>
              <View>
                <Text style={[styles.toggleLabel, { color: c.foreground }]}>Radio Mode</Text>
                <Text style={[styles.toggleDesc, { color: c.mutedForeground }]}>
                  Background audio playback
                </Text>
              </View>
            </View>
            <Pressable
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); toggleRadioMode(); }}
              style={[styles.switch, { backgroundColor: isRadioMode ? c.primary : c.muted }]}
            >
              <View style={[styles.thumb, { transform: [{ translateX: isRadioMode ? 20 : 0 }] }]} />
            </Pressable>
          </GlassCard>

          <GlassCard style={styles.toggleRow}>
            <View style={styles.toggleLeft}>
              <View style={[styles.toggleIcon, { backgroundColor: c.secondary }]}>
                <Feather name="wifi-off" size={16} color={c.primary} />
              </View>
              <View>
                <Text style={[styles.toggleLabel, { color: c.foreground }]}>Data Saver</Text>
                <Text style={[styles.toggleDesc, { color: c.mutedForeground }]}>
                  Lower quality — saves mobile data
                </Text>
              </View>
            </View>
            <Pressable
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); toggleDataSaver(); }}
              style={[styles.switch, { backgroundColor: dataSaver ? c.primary : c.muted }]}
            >
              <View style={[styles.thumb, { transform: [{ translateX: dataSaver ? 20 : 0 }] }]} />
            </Pressable>
          </GlassCard>
        </View>

        {upNext.length > 0 && (
          <View style={styles.queueSection}>
            <Text style={[styles.queueTitle, { color: c.foreground }]}>Up Next</Text>
            {upNext.map((sermon) => (
              <Pressable
                key={sermon.id}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  playSermon(sermon);
                }}
                style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}
              >
                <GlassCard style={styles.queueItem}>
                  <View style={[styles.queueDot, { backgroundColor: c.primary }]} />
                  <View style={styles.queueText}>
                    <Text style={[styles.queueItemTitle, { color: c.foreground }]} numberOfLines={1}>
                      {sermon.title}
                    </Text>
                    <Text style={[styles.queueMeta, { color: c.mutedForeground }]}>
                      {sermon.preacher}{sermon.duration ? ` · ${sermon.duration}` : ""}
                    </Text>
                  </View>
                  <Feather name="play" size={14} color={c.mutedForeground} />
                </GlassCard>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { fontSize: 28, fontFamily: "Inter_700Bold", paddingHorizontal: 16, paddingTop: 12 },
  desc: { fontSize: 13, fontFamily: "Inter_400Regular", paddingHorizontal: 16, marginTop: 4, marginBottom: 28 },
  playerSection: { alignItems: "center", paddingHorizontal: 16, gap: 16 },
  discOuter: {
    width: 210,
    height: 210,
    borderRadius: 105,
    borderWidth: 2,
    padding: 8,
  },
  discMid: {
    flex: 1,
    borderRadius: 97,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    position: "relative",
  },
  discImage: { width: "100%", height: "100%", borderRadius: 97 },
  discCenter: {
    position: "absolute",
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  waveContainer: { flexDirection: "row", alignItems: "center", gap: 4, height: 24 },
  waveBar: { width: 3, height: 20, borderRadius: 2 },
  nowTitle: { fontSize: 19, fontFamily: "Inter_700Bold", textAlign: "center", paddingHorizontal: 24, lineHeight: 26 },
  nowPreacher: { fontSize: 14, fontFamily: "Inter_400Regular" },
  controls: { flexDirection: "row", alignItems: "center", gap: 36, marginTop: 8 },
  playButton: { width: 68, height: 68, borderRadius: 34, alignItems: "center", justifyContent: "center", paddingLeft: 3 },
  togglesSection: { paddingHorizontal: 16, marginTop: 32, gap: 10 },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, gap: 12 },
  toggleLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
  toggleIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  toggleLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  toggleDesc: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 1 },
  switch: { width: 48, height: 28, borderRadius: 14, padding: 4 },
  thumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: "#FFF" },
  queueSection: { paddingHorizontal: 16, marginTop: 28, gap: 8 },
  queueTitle: { fontSize: 18, fontFamily: "Inter_700Bold", marginBottom: 4 },
  queueItem: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12 },
  queueDot: { width: 6, height: 6, borderRadius: 3 },
  queueText: { flex: 1 },
  queueItemTitle: { fontSize: 14, fontFamily: "Inter_500Medium" },
  queueMeta: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
});
