import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { GlassCard } from "@/components/GlassCard";
import { usePlayer } from "@/context/PlayerContext";
import { useYouTubeChannel } from "@/hooks/useYouTubeChannel";
import type { LoopMode, Sermon, SermonCategory } from "@/types";

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

const LOOP_ICONS: Record<LoopMode, string> = {
  none: "minus-circle",
  all: "repeat",
  one: "repeat",
};

const LOOP_LABELS: Record<LoopMode, string> = {
  none: "No Loop",
  all: "Loop All",
  one: "Loop One",
};

const RADIO_CATEGORIES: SermonCategory[] = ["All", "Worship", "Teachings", "Faith", "Healing", "Deliverance", "Prophecy", "Special Programs"];

export default function RadioScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const {
    currentSermon,
    isPlaying,
    isRadioMode,
    dataSaver,
    shuffleMode,
    loopMode,
    togglePlay,
    toggleRadioMode,
    toggleDataSaver,
    toggleShuffle,
    cycleLoopMode,
    playSermon,
    playNext,
    playPrevious,
    queue,
    currentIndex,
    setQueue,
  } = usePlayer();
  const { sermons } = useYouTubeChannel();
  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const [radioCategory, setRadioCategory] = useState<SermonCategory>("All");

  const filteredQueue = useMemo(() => {
    if (radioCategory === "All") return sermons.length > 0 ? sermons : queue;
    const base = sermons.length > 0 ? sermons : queue;
    return base.filter((s) => s.category === radioCategory);
  }, [sermons, queue, radioCategory]);

  useEffect(() => {
    if (filteredQueue.length > 0) setQueue(filteredQueue);
  }, [filteredQueue, setQueue]);

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
  const nowPlaying = currentSermon ?? filteredQueue[0];
  const thumbUri = nowPlaying?.thumbnailUrl;

  const handlePlayToggle = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (!currentSermon && filteredQueue.length > 0) {
      playSermon(filteredQueue[0]);
      if (!isRadioMode) toggleRadioMode();
    } else {
      togglePlay();
    }
  };

  const upNext = filteredQueue
    .slice(currentIndex + 1, currentIndex + 6)
    .filter((s) => s.youtubeId !== nowPlaying?.youtubeId);

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + webTopPad, paddingBottom: 150 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <View>
            <Text style={[styles.header, { color: c.foreground }]}>Radio</Text>
            <Text style={[styles.desc, { color: c.mutedForeground }]}>
              Listen with screen off — background audio mode
            </Text>
          </View>
        </View>

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

          <View style={styles.modeControls}>
            <Pressable
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); toggleShuffle(); }}
              style={[
                styles.modeBtn,
                {
                  backgroundColor: shuffleMode ? c.primary : c.muted,
                  borderColor: shuffleMode ? c.primary : c.border,
                },
              ]}
            >
              <Feather name="shuffle" size={15} color={shuffleMode ? "#FFF" : c.mutedForeground} />
              <Text style={[styles.modeBtnText, { color: shuffleMode ? "#FFF" : c.mutedForeground }]}>
                Shuffle
              </Text>
            </Pressable>

            <Pressable
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); cycleLoopMode(); }}
              style={[
                styles.modeBtn,
                {
                  backgroundColor: loopMode !== "none" ? c.primary : c.muted,
                  borderColor: loopMode !== "none" ? c.primary : c.border,
                },
              ]}
            >
              <Feather
                name={LOOP_ICONS[loopMode] as any}
                size={15}
                color={loopMode !== "none" ? "#FFF" : c.mutedForeground}
              />
              <Text style={[styles.modeBtnText, { color: loopMode !== "none" ? "#FFF" : c.mutedForeground }]}>
                {LOOP_LABELS[loopMode]}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.categorySection}>
          <Text style={[styles.categoryTitle, { color: c.mutedForeground }]}>FILTER BY CATEGORY</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryScroll}>
            {RADIO_CATEGORIES.map((cat) => (
              <Pressable
                key={cat}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setRadioCategory(cat);
                }}
                style={[
                  styles.catPill,
                  {
                    backgroundColor: radioCategory === cat ? c.primary : c.muted,
                    borderColor: radioCategory === cat ? c.primary : c.border,
                  },
                ]}
              >
                <Text style={[styles.catPillText, { color: radioCategory === cat ? "#FFF" : c.mutedForeground }]}>
                  {cat}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
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
                  Background audio — works with screen off
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
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  header: { fontSize: 28, fontFamily: "Inter_700Bold" },
  desc: { fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 4, marginBottom: 24 },
  playerSection: { alignItems: "center", paddingHorizontal: 16, gap: 14 },
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
  controls: { flexDirection: "row", alignItems: "center", gap: 36, marginTop: 4 },
  playButton: { width: 68, height: 68, borderRadius: 34, alignItems: "center", justifyContent: "center", paddingLeft: 3 },
  modeControls: { flexDirection: "row", gap: 10, marginTop: 4 },
  modeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  modeBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  categorySection: { paddingHorizontal: 16, marginTop: 28, gap: 8 },
  categoryTitle: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 1.5 },
  categoryScroll: { gap: 8, paddingVertical: 4 },
  catPill: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
  },
  catPillText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  togglesSection: { paddingHorizontal: 16, marginTop: 20, gap: 10 },
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
