import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { usePlayer } from "@/context/PlayerContext";

let YoutubeIframe: any = null;
try {
  YoutubeIframe = require("react-native-youtube-iframe").default;
} catch {
  YoutubeIframe = null;
}

interface YoutubePlayerProps {
  videoId?: string;
  isLive?: boolean;
  thumbnailUrl?: string;
  channelHandle?: string;
  autoPlay?: boolean;
  title?: string;
  preacher?: string;
  playerHeight?: number;
  onEnd?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  onToggleAudioMode?: () => void;
}

function AudioModeCard({
  thumb,
  title,
  preacher,
  isLive,
  isPlaying,
  loading,
  onToggle,
}: {
  thumb: string | null;
  title?: string;
  preacher?: string;
  isLive?: boolean;
  isPlaying: boolean;
  loading: boolean;
  onToggle?: () => void;
}) {
  const c = useColors();
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const waveAnim1 = useRef(new Animated.Value(0.3)).current;
  const waveAnim2 = useRef(new Animated.Value(0.6)).current;
  const waveAnim3 = useRef(new Animated.Value(0.4)).current;
  const waveAnim4 = useRef(new Animated.Value(0.8)).current;
  const waveAnim5 = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (!isPlaying) {
      rotateAnim.stopAnimation();
      [waveAnim1, waveAnim2, waveAnim3, waveAnim4, waveAnim5].forEach((a) => a.stopAnimation());
      return;
    }
    const ND = Platform.OS !== "web";
    const rotate = Animated.loop(
      Animated.timing(rotateAnim, { toValue: 1, duration: 12000, useNativeDriver: ND }),
    );
    const makeWave = (anim: Animated.Value, delay: number, duration: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, { toValue: 1, duration, useNativeDriver: ND }),
          Animated.timing(anim, { toValue: 0.15, duration, useNativeDriver: ND }),
        ]),
      );
    rotate.start();
    const w1 = makeWave(waveAnim1, 0, 420);
    const w2 = makeWave(waveAnim2, 120, 560);
    const w3 = makeWave(waveAnim3, 240, 380);
    const w4 = makeWave(waveAnim4, 80, 500);
    const w5 = makeWave(waveAnim5, 320, 460);
    w1.start(); w2.start(); w3.start(); w4.start(); w5.start();
    return () => {
      rotate.stop(); w1.stop(); w2.stop(); w3.stop(); w4.stop(); w5.stop();
    };
  }, [isPlaying]);

  const spin = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });

  return (
    <View style={[audioStyles.card, { backgroundColor: "rgba(0,0,0,0.92)" }]}>
      <View style={[audioStyles.badge, { backgroundColor: "rgba(106,13,173,0.25)", borderColor: "rgba(106,13,173,0.4)" }]}>
        <Feather name="headphones" size={11} color="#B47FEB" />
        <Text style={[audioStyles.badgeText, { color: "#B47FEB" }]}>
          {isLive ? "LIVE · AUDIO MODE" : "AUDIO MODE"}
        </Text>
      </View>

      <Animated.View style={{ transform: [{ rotate: spin }] }}>
        <View style={audioStyles.discOuter}>
          <View style={audioStyles.discMid}>
            {thumb ? (
              <Image source={{ uri: thumb }} style={audioStyles.discImage} />
            ) : (
              <View style={[audioStyles.discImage, { backgroundColor: "rgba(106,13,173,0.2)", alignItems: "center", justifyContent: "center" }]}>
                <Feather name="radio" size={28} color="rgba(106,13,173,0.6)" />
              </View>
            )}
            <View style={[audioStyles.discCenter, { backgroundColor: "#000" }]}>
              {loading ? (
                <ActivityIndicator color="#6A0DAD" size="small" />
              ) : (
                <Feather name={isPlaying ? "headphones" : "pause"} size={14} color="#6A0DAD" />
              )}
            </View>
          </View>
        </View>
      </Animated.View>

      {isPlaying && (
        <View style={audioStyles.waveRow}>
          {[waveAnim1, waveAnim2, waveAnim3, waveAnim4, waveAnim5].map((anim, i) => (
            <Animated.View
              key={i}
              style={[audioStyles.waveBar, { opacity: anim }]}
            />
          ))}
        </View>
      )}

      {title ? (
        <View style={audioStyles.meta}>
          <Text style={audioStyles.metaTitle} numberOfLines={1}>{title}</Text>
          {preacher ? <Text style={audioStyles.metaPreacher} numberOfLines={1}>{preacher}</Text> : null}
        </View>
      ) : null}

      {onToggle && (
        <Pressable
          onPress={onToggle}
          style={({ pressed }) => [audioStyles.switchBtn, { opacity: pressed ? 0.7 : 1 }]}
        >
          <Feather name="video" size={13} color="#B47FEB" />
          <Text style={audioStyles.switchBtnText}>Switch to Video</Text>
        </Pressable>
      )}
    </View>
  );
}

export function YoutubePlayer({
  videoId,
  isLive,
  thumbnailUrl,
  channelHandle = "templetvjctm",
  autoPlay = true,
  title,
  preacher,
  playerHeight: playerHeightProp,
  onEnd,
  onPlay,
  onPause,
  onToggleAudioMode,
}: YoutubePlayerProps) {
  const c = useColors();
  const { width, height: screenHeight } = useWindowDimensions();
  const { updatePlayback, playerPlayRef, playerPauseRef, playerSeekRef, dataSaver, isRadioMode } = usePlayer();
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(autoPlay);
  const [playerReady, setPlayerReady] = useState(false);
  const [playerError, setPlayerError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [activeVideoId, setActiveVideoId] = useState(videoId);
  const transitionOpacity = useRef(new Animated.Value(0)).current;
  const isMountedRef = useRef(true);
  const playerRef = useRef<any>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  useEffect(() => {
    playerPlayRef.current = () => { if (isMountedRef.current) setPlaying(true); };
    playerPauseRef.current = () => { if (isMountedRef.current) setPlaying(false); };
    playerSeekRef.current = (t: number) => {
      if (isMountedRef.current) playerRef.current?.seekTo?.(t, true);
    };
  }, [playerPlayRef, playerPauseRef, playerSeekRef]);

  useEffect(() => {
    if (videoId && videoId !== activeVideoId) {
      setPlayerReady(false);
      setPlayerError(false);
      setRetryCount(0);
      setPlaying(false);
      transitionOpacity.setValue(1);
      setActiveVideoId(videoId);
      requestAnimationFrame(() => {
        if (isMountedRef.current) setPlaying(true);
      });
    } else if (videoId && !activeVideoId) {
      setActiveVideoId(videoId);
      setPlaying(autoPlay);
    }
  }, [videoId]);

  const startTick = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(async () => {
      if (!isMountedRef.current || !playerRef.current) return;
      try {
        const t = await playerRef.current.getCurrentTime?.();
        const d = await playerRef.current.getDuration?.();
        if (isMountedRef.current) updatePlayback(t ?? 0, d ?? 0);
      } catch { clearInterval(tickRef.current!); }
    }, 1000);
  }, [updatePlayback]);

  const stopTick = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  const onPlayerReady = useCallback((ref: any) => {
    if (!isMountedRef.current) return;
    playerRef.current = ref;
    setPlayerReady(true);
    Animated.timing(transitionOpacity, { toValue: 0, duration: 350, useNativeDriver: true }).start();
  }, [transitionOpacity]);

  const onChangeState = useCallback(
    (state: string) => {
      if (!isMountedRef.current) return;
      if (state === "ended") {
        setPlaying(false);
        stopTick();
        onEnd?.();
      } else if (state === "playing") {
        setPlaying(true);
        startTick();
        onPlay?.();
        if (!playerReady) {
          setPlayerReady(true);
          Animated.timing(transitionOpacity, { toValue: 0, duration: 350, useNativeDriver: true }).start();
        }
      } else if (state === "paused") {
        setPlaying(false);
        stopTick();
        onPause?.();
      }
    },
    [onEnd, onPlay, onPause, playerReady, transitionOpacity, startTick, stopTick],
  );

  const openExternal = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setLoading(true);
    try {
      let url: string;
      if (isLive) {
        url = `https://www.youtube.com/@${channelHandle}/live`;
      } else if (activeVideoId) {
        if (Platform.OS !== "web") {
          const ytUrl = `youtube://watch?v=${activeVideoId}`;
          const canOpen = await Linking.canOpenURL(ytUrl);
          if (canOpen) { await Linking.openURL(ytUrl); return; }
        }
        url = `https://www.youtube.com/watch?v=${activeVideoId}`;
      } else {
        url = `https://www.youtube.com/@${channelHandle}`;
      }

      if (Platform.OS === "web") {
        window.open(url, "_blank");
      } else {
        await WebBrowser.openBrowserAsync(url, {
          toolbarColor: "#000000",
          controlsColor: "#6A0DAD",
          presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
        });
      }
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  };

  const handlePlayerError = useCallback(() => {
    if (!isMountedRef.current) return;
    if (retryCount < 2) {
      setRetryCount((count) => count + 1);
      setPlayerReady(false);
      setPlaying(false);
      setTimeout(() => {
        if (isMountedRef.current) setPlaying(true);
      }, 900);
      return;
    }
    setPlayerError(true);
  }, [retryCount]);

  const playerHeight = playerHeightProp ?? Math.min(
    Math.round(width * (9 / 16)),
    Math.round(screenHeight * 0.42),
  );
  const thumb =
    thumbnailUrl ?? (activeVideoId ? `https://img.youtube.com/vi/${activeVideoId}/hqdefault.jpg` : null);

  if (Platform.OS !== "web" && YoutubeIframe && activeVideoId && !playerError) {
    const ytPlayer = (
      <YoutubeIframe
        key={activeVideoId}
        videoId={activeVideoId}
        height={playerHeight}
        play={playing}
        onChangeState={onChangeState}
        onReady={onPlayerReady}
        onError={handlePlayerError}
        ref={playerRef}
        initialPlayerParams={{
          modestbranding: true,
          rel: false,
          preventFullScreen: false,
          cc_load_policy: false,
          iv_load_policy: 3,
          suggestedQuality: dataSaver || isRadioMode ? "small" : "auto",
        }}
        webViewProps={{
          allowsFullscreenVideo: !isRadioMode,
          allowsInlineMediaPlayback: true,
          mediaPlaybackRequiresUserAction: false,
          javaScriptEnabled: true,
          bounces: false,
        }}
      />
    );

    if (isRadioMode) {
      return (
        <View style={styles.audioModeWrapper}>
          <View style={styles.hiddenPlayer}>{ytPlayer}</View>
          <AudioModeCard
            thumb={thumb}
            title={title}
            preacher={preacher}
            isLive={isLive}
            isPlaying={playing}
            loading={!playerReady}
            onToggle={onToggleAudioMode}
          />
        </View>
      );
    }

    return (
      <View style={[styles.container, { height: playerHeight }]}>
        {ytPlayer}
        <Animated.View
          style={[styles.transitionOverlay, { opacity: transitionOpacity, pointerEvents: "none" }]}
        >
          {thumb && (
            <Image source={{ uri: thumb }} style={styles.thumbnail} resizeMode="cover" />
          )}
          <View style={[styles.loadingCenter, { backgroundColor: "rgba(0,0,0,0.5)" }]}>
            <ActivityIndicator color={c.primary} size="large" />
            <Text style={[styles.loadingText, { color: "rgba(255,255,255,0.6)" }]}>
              {retryCount > 0 ? "Reconnecting stream..." : dataSaver || isRadioMode ? "Loading low-data stream..." : "Loading next video..."}
            </Text>
          </View>
        </Animated.View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {thumb && (
        <Image source={{ uri: thumb }} style={styles.thumbnail} resizeMode="cover" />
      )}
      <View style={[styles.overlay, { backgroundColor: "rgba(0,0,0,0.38)" }]}>
        <Pressable
          onPress={openExternal}
          style={({ pressed }) => [
            styles.playButton,
            { backgroundColor: loading ? c.primary : "#FF0000", opacity: pressed ? 0.8 : 1, transform: [{ scale: pressed ? 0.92 : 1 }] },
          ]}
        >
          {loading ? (
            <ActivityIndicator color="#FFF" size="small" />
          ) : (
            <Feather name="play" size={28} color="#FFF" />
          )}
        </Pressable>
        <Text style={styles.tapHint}>
          {playerError ? "Playback failed here — open in YouTube to continue" : Platform.OS === "web" ? "Opens on YouTube" : "Opens in YouTube app"}
        </Text>
      </View>
    </View>
  );
}

const audioStyles = StyleSheet.create({
  card: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingVertical: 20,
    paddingHorizontal: 16,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
  },
  badgeText: { fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1.2 },
  discOuter: {
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 2,
    borderColor: "rgba(106,13,173,0.5)",
    padding: 6,
  },
  discMid: {
    flex: 1,
    borderRadius: 64,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    backgroundColor: "rgba(106,13,173,0.15)",
  },
  discImage: { width: "100%", height: "100%", borderRadius: 64 },
  discCenter: {
    position: "absolute",
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  waveRow: { flexDirection: "row", alignItems: "center", gap: 3, height: 20 },
  waveBar: { width: 3, height: 18, borderRadius: 2, backgroundColor: "#6A0DAD" },
  meta: { alignItems: "center", gap: 3, paddingHorizontal: 24 },
  metaTitle: { fontSize: 15, fontFamily: "Inter_700Bold", color: "#FFF", textAlign: "center", lineHeight: 20 },
  metaPreacher: { fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.5)", textAlign: "center" },
  switchBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(106,13,173,0.5)",
    backgroundColor: "rgba(106,13,173,0.15)",
  },
  switchBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#B47FEB" },
});

const styles = StyleSheet.create({
  audioModeWrapper: { flex: 1, backgroundColor: "#0a0a0a", minHeight: 240 },
  hiddenPlayer: { height: 1, overflow: "hidden" },
  container: { flex: 1, backgroundColor: "#0a0a0a", position: "relative" },
  thumbnail: { ...StyleSheet.absoluteFillObject, width: "100%", height: "100%" },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", gap: 10 },
  playButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: 4,
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 12 },
      android: { elevation: 8 },
      web: { boxShadow: "0 4px 12px rgba(0,0,0,0.5)" },
    }),
  },
  tapHint: { color: "rgba(255,255,255,0.5)", fontSize: 12, fontFamily: "Inter_400Regular" },
  transitionOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0a0a0a",
  },
  loadingCenter: { position: "absolute", alignItems: "center", gap: 10, padding: 20, borderRadius: 12 },
  loadingText: { fontSize: 13, fontFamily: "Inter_400Regular" },
});
