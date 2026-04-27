import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
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
import { navigateToSermon, navigateToPlayer } from "@/utils/navigation";
import { useColors } from "@/hooks/useColors";
import { GlassCard } from "@/components/GlassCard";
import { ChannelBug } from "@/components/ChannelBug";
import { usePlayer } from "@/context/PlayerContext";
import { useYouTubeChannel } from "@/hooks/useYouTubeChannel";
import {
  checkBroadcastCurrent,
  normalizeBroadcastResult,
  subscribeBroadcastEvents,
  type BroadcastCurrentResult,
} from "@/services/broadcast";
import type { LoopMode, Sermon, SermonCategory } from "@/types";
import { usePageSeo } from "@/hooks/usePageSeo";

const PLACEHOLDER = require("@/assets/images/sermon-placeholder.png");

function fmtSecs(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const LOOP_ICONS: Record<LoopMode, string> = {
  none: "minus-circle",
  all: "repeat",
  one: "rotate-cw",
};

const LOOP_LABELS: Record<LoopMode, string> = {
  none: "No Loop",
  all: "Loop All",
  one: "Loop One",
};

const RADIO_CATEGORIES: SermonCategory[] = ["All", "Worship", "Teachings", "Faith", "Healing", "Deliverance", "Prophecy", "Special Programs"];

const SLEEP_TIMER_OPTIONS = [
  { label: "15 min", secs: 15 * 60 },
  { label: "30 min", secs: 30 * 60 },
  { label: "60 min", secs: 60 * 60 },
  { label: "90 min", secs: 90 * 60 },
];

function fmtTimer(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export default function RadioScreen() {
  usePageSeo({
    title: "Temple TV Radio — Audio Sermons & Worship 24/7",
    description:
      "Listen to Temple TV sermons and worship as a continuous radio stream. Background playback, sleep timer, and audio-only mode for low-bandwidth listening.",
    path: "/radio",
    structuredData: {
      "@context": "https://schema.org",
      "@type": "RadioStation",
      name: "Temple TV Radio",
      description: "24/7 Christian audio sermons and worship from Jesus Christ Temple Ministry.",
      broadcastFrequency: "Online streaming",
      url: "https://templetv.org.ng/radio",
      sameAs: ["https://templetv.org.ng/"],
    },
  });

  const c = useColors();
  const insets = useSafeAreaInsets();
  const {
    currentSermon,
    isPlaying,
    isRadioMode,
    isBroadcastMode,
    dataSaver,
    shuffleMode,
    loopMode,
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
    stopPlayback,
  } = usePlayer();
  const { sermons } = useYouTubeChannel();
  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const [radioCategory, setRadioCategory] = useState<SermonCategory>("All");
  const [broadcastInfo, setBroadcastInfo] = useState<BroadcastCurrentResult | null>(null);
  const [broadcastConnected, setBroadcastConnected] = useState<boolean | null>(null);
  const [autoMirror, setAutoMirror] = useState(false);
  const [broadcastPosition, setBroadcastPosition] = useState(0);
  const [sleepTimerSecs, setSleepTimerSecs] = useState(0);
  const [showTimerPicker, setShowTimerPicker] = useState(false);
  const sleepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const broadcastInfoRef = useRef<BroadcastCurrentResult | null>(null);
  const broadcastPositionRef = useRef(0);

  // Keep refs in sync with state so callbacks don't stale-close over them
  broadcastInfoRef.current = broadcastInfo;
  broadcastPositionRef.current = broadcastPosition;

  const applyBroadcastResult = useCallback((bc: BroadcastCurrentResult | null) => {
    setBroadcastInfo(bc);
    if (bc?.positionSecs != null) setBroadcastPosition(bc.positionSecs);
    setBroadcastConnected(bc !== null);
  }, []);

  // SSE subscription with polling fallback
  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const fetchCurrent = async () => {
      try {
        const bc = await checkBroadcastCurrent();
        if (!cancelled) applyBroadcastResult(bc);
      } catch {
        if (!cancelled) setBroadcastConnected(false);
      }
    };

    // Always do an initial fetch for immediate data
    fetchCurrent();

    // Try SSE for real-time updates
    const sub = subscribeBroadcastEvents({
      "broadcast-current-updated": (payload) => {
        if (cancelled) return;
        // The server attaches the full BroadcastCurrentPayload under
        // `payload.current` on every `broadcast-current-updated` push
        // (verified at routes/broadcast.ts: connect, item-transition,
        // pre-warm transition-imminent, cache-invalidate; admin.ts
        // invalidate-push). Promoting it directly is what the TV Hero,
        // mobile landing hero, and mobile player already do — only this
        // radio handler still re-fetched, costing one redundant
        // `/broadcast/current` round trip per radio listener per queue
        // transition or admin event. With many concurrent radio listeners
        // that load adds up — and on the cold-build path, each refetch
        // could cost up to ~70 ms (post the morning's setBackground +
        // single-flight fix) before falling back to the warm cache.
        //
        // `normalizeBroadcastResult` resolves any relative localVideoUrl /
        // thumbnailUrl paths against the API base — required because the
        // raw SSE payload bypasses `checkBroadcastCurrent`'s normalization
        // step, and a relative URL fed straight into the disc-image
        // <Image source> would 404 on native (no origin context). The
        // helper is a no-op for already-absolute URLs.
        //
        // Falls back to fetch only when the SSE payload is absent or
        // missing `.current` — preserves correctness against any future
        // server change that emits a "current-changed-but-payload-omitted"
        // signal (e.g., a scoped delta channel).
        if (payload?.current) {
          applyBroadcastResult(normalizeBroadcastResult(payload.current as BroadcastCurrentResult));
          setBroadcastConnected(true);
          return;
        }
        fetchCurrent();
      },
      "status": () => {
        if (!cancelled) setBroadcastConnected(true);
      },
    });

    if (sub) {
      // SSE is available — poll less frequently as a safety net
      pollTimer = setInterval(fetchCurrent, 60_000);
    } else {
      // No SSE (e.g. native without polyfill) — poll at 10s
      pollTimer = setInterval(fetchCurrent, 10_000);
    }

    return () => {
      cancelled = true;
      sub?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [applyBroadcastResult]);

  // Tick broadcast position forward every second while a known item is playing
  useEffect(() => {
    if (!broadcastInfo?.item) return;
    const ticker = setInterval(() => setBroadcastPosition((p) => p + 1), 1000);
    return () => clearInterval(ticker);
  }, [broadcastInfo?.item?.id]);

  // Auto-mirror: react to both toggle AND broadcast item changes
  const triggerAutoMirror = useCallback((enabled: boolean, info: BroadcastCurrentResult | null) => {
    if (!enabled || !info?.item) return;
    const item = info.item;
    const startMs = String(broadcastPositionRef.current * 1000);
    if (item.videoSource === "local" && item.localVideoUrl) {
      navigateToPlayer(
        { broadcastMode: "true", localVideoUrl: item.localVideoUrl, title: item.title, thumbnail: item.thumbnailUrl, startPositionMs: startMs, radioOnly: "true" },
      );
    } else if (item.youtubeId) {
      navigateToPlayer(
        { broadcastMode: "true", videoId: item.youtubeId, title: item.title, thumbnail: item.thumbnailUrl, startPositionMs: startMs, radioOnly: "true" },
      );
    }
  }, []);

  // Stable ref so the item-change effect can read the current value of
  // autoMirror without making it a dependency (avoids double-navigation
  // when both "toggle changed" and "item changed" fire on the same render).
  const autoMirrorRef = useRef(autoMirror);
  useEffect(() => { autoMirrorRef.current = autoMirror; });

  // Trigger auto-mirror when toggled ON
  useEffect(() => {
    if (autoMirror) triggerAutoMirror(true, broadcastInfoRef.current);
  }, [autoMirror, triggerAutoMirror]);

  // Trigger auto-mirror when the broadcast item transitions to a new item.
  // Reads autoMirror from ref so this effect does NOT re-fire when the
  // toggle changes — that is handled by the effect above.
  useEffect(() => {
    if (broadcastInfo?.item?.id && autoMirrorRef.current) {
      triggerAutoMirror(true, broadcastInfo);
    }
  }, [broadcastInfo?.item?.id, broadcastInfo, triggerAutoMirror]);

  // Sleep timer — use a stable boolean sentinel to avoid firing on every tick
  const sleepTimerActive = sleepTimerSecs > 0;
  useEffect(() => {
    if (sleepTimerRef.current) clearInterval(sleepTimerRef.current);
    if (!sleepTimerActive) return;
    sleepTimerRef.current = setInterval(() => {
      setSleepTimerSecs((prev) => {
        if (prev <= 1) {
          if (sleepTimerRef.current) clearInterval(sleepTimerRef.current);
          // Sleep timer fully tears down playback (clears the iframe and
          // notification) instead of merely pausing — otherwise audio
          // resources stay alive and the lock-screen "Now Playing" tile
          // lingers, which defeats the purpose of a sleep timer.
          stopPlayback();
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (sleepTimerRef.current) clearInterval(sleepTimerRef.current);
    };
  }, [sleepTimerActive, stopPlayback]);

  const handleSetSleepTimer = (secs: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSleepTimerSecs(secs);
    setShowTimerPicker(false);
  };

  const handleCancelSleepTimer = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (sleepTimerRef.current) clearInterval(sleepTimerRef.current);
    setSleepTimerSecs(0);
    setShowTimerPicker(false);
  };

  const handleListenLive = () => {
    const item = broadcastInfo?.item;
    if (!item) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Tear down any radio-mode playback BEFORE navigating to the broadcast
    // player. Without this, the PersistentAudioPlayer (radio's audio engine)
    // keeps streaming the on-demand sermon while the /player route mounts a
    // SECOND YoutubePlayer for the live broadcast — both audio sources play
    // simultaneously until the user manually pauses one. stopPlayback()
    // fully releases the audio session so the broadcast player can claim it
    // cleanly on mount.
    stopPlayback();
    const startMs = String((broadcastInfo?.positionSecs ?? 0) * 1000);
    if (item.videoSource === "local" && item.localVideoUrl) {
      router.push({
        pathname: "/player",
        params: { broadcastMode: "true", localVideoUrl: item.localVideoUrl, title: item.title, thumbnail: item.thumbnailUrl, startPositionMs: startMs },
      });
    } else {
      router.push({
        pathname: "/player",
        params: { broadcastMode: "true", videoId: item.youtubeId, title: item.title, thumbnail: item.thumbnailUrl, startPositionMs: startMs },
      });
    }
  };

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
    if (!isPlaying || !isRadioMode) {
      rotateAnim.stopAnimation();
      pulseAnim.setValue(1);
      waveAnim1.setValue(0.3);
      waveAnim2.setValue(0.5);
      waveAnim3.setValue(0.7);
      return;
    }

    const ND = Platform.OS !== "web";
    const rotate = Animated.loop(
      Animated.timing(rotateAnim, { toValue: 1, duration: 10000, useNativeDriver: ND }),
    );
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 2000, useNativeDriver: ND }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 2000, useNativeDriver: ND }),
      ]),
    );
    const makeWave = (anim: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, { toValue: 1, duration: 500, useNativeDriver: ND }),
          Animated.timing(anim, { toValue: 0.2, duration: 500, useNativeDriver: ND }),
        ]),
      );
    rotate.start();
    pulse.start();
    const w1 = makeWave(waveAnim1, 0);
    const w2 = makeWave(waveAnim2, 200);
    const w3 = makeWave(waveAnim3, 400);
    w1.start();
    w2.start();
    w3.start();

    return () => {
      rotate.stop();
      pulse.stop();
      w1.stop();
      w2.stop();
      w3.stop();
      waveAnim1.setValue(0.3);
      waveAnim2.setValue(0.5);
      waveAnim3.setValue(0.7);
    };
  }, [isPlaying, isRadioMode, rotateAnim, pulseAnim, waveAnim1, waveAnim2, waveAnim3]);

  const spin = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const nowPlaying = currentSermon ?? filteredQueue[0];
  const thumbUri = nowPlaying?.thumbnailUrl;

  // NOTE: removed `handlePlayToggle` and `handleStop` — the Radio screen no
  // longer exposes manual play/pause/stop UI per the TV-channel behavior
  // contract. Audio is started by the "Tune In to Temple TV Channel" CTA
  // (live broadcast) or by tapping a sermon row (on-demand). The sleep timer
  // still uses `stopPlayback` directly, and the system Radio Mode toggle
  // handles audio-only / video-on switching.

  const handleWatchVideo = () => {
    if (!nowPlaying) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isRadioMode) toggleRadioMode();
    // Round 6 (Pass 4): if the user is currently tuned to the broadcast
    // channel, "Watch Video" must reopen /player in broadcast mode (not as
    // VOD) — otherwise we'd give them seek/scrub controls on a channel feed.
    if (isBroadcastMode) {
      navigateToPlayer({ broadcastMode: "true" });
      return;
    }
    navigateToSermon(nowPlaying);
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
          <View style={{ flex: 1 }}>
            <Text style={[styles.header, { color: c.foreground }]}>Radio</Text>
            <Text style={[styles.desc, { color: c.mutedForeground }]}>
              Audio-only stream — background playback, low data
            </Text>
          </View>
          {broadcastConnected === false && (
            <View style={[styles.connBadge, { backgroundColor: c.muted, borderColor: c.border }]}>
              <Feather name="wifi-off" size={11} color={c.mutedForeground} />
              <Text style={[styles.connBadgeText, { color: c.mutedForeground }]}>Offline</Text>
            </View>
          )}
          {broadcastConnected === true && (
            <View style={[styles.connBadge, { backgroundColor: "rgba(34,197,94,0.12)", borderColor: "rgba(34,197,94,0.3)" }]}>
              <View style={styles.connDot} />
              <Text style={[styles.connBadgeText, { color: "#22c55e" }]}>Live</Text>
            </View>
          )}
        </View>

        {(broadcastInfo?.item || broadcastInfo?.liveOverride) && (
          <GlassCard style={[styles.broadcastCard, { borderColor: c.primary + "30" }]} intensity="medium">
            <View style={styles.broadcastCardHeader}>
              <ChannelBug visible animated />
              <Text style={[styles.broadcastCardLabel, { color: c.mutedForeground }]}>
                {broadcastInfo.liveOverride ? "LIVE ON AIR" : "ON AIR NOW"}
              </Text>
              <View style={{ flex: 1 }} />
              {/* TV-channel behavior: no time / duration / progress indicators
                  on the broadcast card. The viewer joins the channel mid-show
                  exactly like flipping on a television; the position pill, the
                  elapsed/remaining text, and the progress track were all
                  removed in this round. The pulsing channel bug + "ON AIR"
                  label is the only liveness indicator. */}
            </View>
            <Text style={[styles.broadcastCardTitle, { color: c.foreground }]} numberOfLines={2}>
              {broadcastInfo.liveOverride?.title ?? broadcastInfo.item?.title ?? ""}
            </Text>
            <Pressable
              style={({ pressed }) => [styles.listenLiveBtn, { backgroundColor: c.primary, opacity: pressed ? 0.85 : 1 }]}
              onPress={handleListenLive}
            >
              <Feather name="headphones" size={16} color="#FFF" />
              <Text style={styles.listenLiveBtnText}>Tune In to Temple TV Channel</Text>
            </Pressable>
          </GlassCard>
        )}

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

          {/* TV-channel behavior: skip-back / skip-forward are queue navigation
              (they cycle to a different sermon — they do NOT pause/resume the
              broadcast itself). The center button is no longer a play/pause
              toggle — it's a non-interactive ON AIR / TUNED-IN indicator. To
              start audio when nothing is playing, the user taps "Tune In to
              Temple TV Channel" above (live broadcast) or any sermon row in
              the queue list (on-demand). To stop, they navigate away from the
              Radio tab or toggle Radio Mode off in the player settings. */}
          {/* Round 6 (Pass 4): when the channel feed is tuned, hide queue
              navigation entirely — a real TV viewer can't skip to the
              previous or next program from the radio surface. The center
              ON AIR indicator is preserved as a "what's playing" badge. */}
          <View style={styles.controls}>
            {!isBroadcastMode && (
              <Pressable
                onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); playPrevious(); }}
                style={({ pressed }) => [{ opacity: pressed ? 0.6 : 1 }]}
                hitSlop={12}
                accessibilityLabel="Previous sermon"
              >
                <Feather name="skip-back" size={30} color={c.foreground} />
              </Pressable>
            )}

            <View
              accessibilityRole="text"
              accessibilityLabel={isPlaying ? "On air" : "Awaiting selection"}
              style={[
                styles.playButton,
                {
                  backgroundColor: isPlaying ? c.primary : c.muted,
                  flexDirection: "row",
                  gap: 8,
                  paddingHorizontal: 18,
                  width: undefined,
                },
              ]}
            >
              <View
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 5,
                  backgroundColor: isPlaying ? "#FFF" : c.mutedForeground,
                  opacity: isPlaying ? 1 : 0.5,
                }}
              />
              <Text
                style={{
                  color: isPlaying ? "#FFF" : c.mutedForeground,
                  fontWeight: "700",
                  letterSpacing: 1.2,
                  fontSize: 13,
                }}
              >
                {isPlaying ? "ON AIR" : "TUNE IN"}
              </Text>
            </View>

            {!isBroadcastMode && (
              <Pressable
                onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); playNext(); }}
                style={({ pressed }) => [{ opacity: pressed ? 0.6 : 1 }]}
                hitSlop={12}
                accessibilityLabel="Next sermon"
              >
                <Feather name="skip-forward" size={30} color={c.foreground} />
              </Pressable>
            )}
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

          {nowPlaying && Platform.OS !== "web" && (
            <Pressable
              onPress={handleWatchVideo}
              style={({ pressed }) => [
                styles.watchVideoBtn,
                { borderColor: c.border, backgroundColor: c.muted, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Feather name="video" size={14} color={c.foreground} />
              <Text style={[styles.watchVideoText, { color: c.foreground }]}>Watch Video</Text>
            </Pressable>
          )}
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
                  Audio-only stream — hides video, saves data
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

          {broadcastInfo?.item && (
            <GlassCard style={styles.toggleRow}>
              <View style={styles.toggleLeft}>
                <View style={[styles.toggleIcon, { backgroundColor: c.secondary }]}>
                  <Feather name="cast" size={16} color={c.primary} />
                </View>
                <View>
                  <Text style={[styles.toggleLabel, { color: c.foreground }]}>Auto-Mirror Broadcast</Text>
                  <Text style={[styles.toggleDesc, { color: c.mutedForeground }]}>
                    Opens current broadcast audio automatically
                  </Text>
                </View>
              </View>
              <Pressable
                onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setAutoMirror((v) => !v); }}
                style={[styles.switch, { backgroundColor: autoMirror ? c.primary : c.muted }]}
              >
                <View style={[styles.thumb, { transform: [{ translateX: autoMirror ? 20 : 0 }] }]} />
              </Pressable>
            </GlassCard>
          )}

          {/* Sleep Timer */}
          <GlassCard style={[styles.toggleRow, { flexDirection: "column", alignItems: "stretch", gap: 10 }]}>
            <View style={[styles.toggleRow, { padding: 0, gap: 12 }]}>
              <View style={styles.toggleLeft}>
                <View style={[styles.toggleIcon, { backgroundColor: c.secondary }]}>
                  <Feather name="moon" size={16} color={c.primary} />
                </View>
                <View>
                  <Text style={[styles.toggleLabel, { color: c.foreground }]}>Sleep Timer</Text>
                  <Text style={[styles.toggleDesc, { color: c.mutedForeground }]}>
                    {sleepTimerSecs > 0 ? `Stops in ${fmtTimer(sleepTimerSecs)}` : "Auto-pause after a set time"}
                  </Text>
                </View>
              </View>
              {sleepTimerSecs > 0 ? (
                <Pressable
                  onPress={handleCancelSleepTimer}
                  style={[styles.modeBtn, { backgroundColor: c.primary, borderColor: c.primary }]}
                >
                  <Text style={[styles.modeBtnText, { color: "#FFF" }]}>{fmtTimer(sleepTimerSecs)}</Text>
                  <Feather name="x" size={13} color="#FFF" />
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setShowTimerPicker((v) => !v); }}
                  style={[styles.modeBtn, { backgroundColor: c.muted, borderColor: c.border }]}
                >
                  <Feather name="moon" size={13} color={c.mutedForeground} />
                  <Text style={[styles.modeBtnText, { color: c.mutedForeground }]}>Set</Text>
                </Pressable>
              )}
            </View>
            {showTimerPicker && sleepTimerSecs === 0 && (
              <View style={styles.timerOptions}>
                {SLEEP_TIMER_OPTIONS.map((opt) => (
                  <Pressable
                    key={opt.secs}
                    onPress={() => handleSetSleepTimer(opt.secs)}
                    style={({ pressed }) => [styles.timerOption, { backgroundColor: pressed ? c.primary : c.muted, borderColor: c.border }]}
                  >
                    <Text style={[styles.timerOptionText, { color: c.foreground }]}>{opt.label}</Text>
                  </Pressable>
                ))}
              </View>
            )}
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
  stopBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    marginTop: 2,
    minHeight: 36,
  },
  stopBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
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
  timerOptions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  timerOption: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, borderWidth: 1 },
  timerOptionText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  watchVideoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 22,
    borderWidth: 1,
    marginTop: 2,
  },
  watchVideoText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  broadcastCard: { marginHorizontal: 16, marginBottom: 4, padding: 16, gap: 10, borderWidth: 1 },
  broadcastCardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  broadcastCardLabel: { fontSize: 12, fontFamily: "Inter_500Medium" },
  broadcastCardTitle: { fontSize: 16, fontFamily: "Inter_700Bold", lineHeight: 22 },
  broadcastProgressTrack: { height: 3, backgroundColor: "rgba(106,13,173,0.15)", borderRadius: 2, overflow: "hidden", marginTop: 2 },
  broadcastProgressFill: { height: "100%", borderRadius: 2 } as const,
  broadcastTimeRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, marginTop: 4 },
  broadcastTimeSm: { fontSize: 11, fontFamily: "Inter_400Regular" },
  broadcastTime: { fontSize: 11, fontFamily: "Inter_400Regular" },
  listenLiveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 11,
    borderRadius: 22,
    marginTop: 2,
  },
  listenLiveBtnText: { color: "#FFF", fontSize: 14, fontFamily: "Inter_700Bold" },
  connBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    borderWidth: 1,
    alignSelf: "flex-start",
    marginTop: 4,
  },
  connBadgeText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  connDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#22c55e" },
});
