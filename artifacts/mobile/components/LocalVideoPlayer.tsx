import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { usePlayer } from "@/context/PlayerContext";

let VideoComponent: any = null;
let ResizeMode: any = null;
try {
  const av = require("expo-av");
  VideoComponent = av.Video;
  ResizeMode = av.ResizeMode;
} catch {
  VideoComponent = null;
}

interface LocalVideoPlayerProps {
  videoUrl: string;
  thumbnailUrl?: string;
  title?: string;
  autoPlay?: boolean;
  onEnd?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  startPositionMs?: number;
}

export function LocalVideoPlayer({
  videoUrl,
  thumbnailUrl,
  title,
  autoPlay = true,
  onEnd,
  onPlay,
  onPause,
  startPositionMs = 0,
}: LocalVideoPlayerProps) {
  const c = useColors();
  const { width } = useWindowDimensions();
  const { updatePlayback, playerPlayRef, playerPauseRef, playerSeekRef, dataSaver, isRadioMode } = usePlayer();
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const videoRef = useRef<any>(null);
  const isMountedRef = useRef(true);
  const transitionOpacity = useRef(new Animated.Value(1)).current;

  const playerHeight = Math.min(Math.round(width * (9 / 16)), 260);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    playerPlayRef.current = async () => {
      if (isMountedRef.current && videoRef.current) {
        await videoRef.current.playAsync?.();
      }
    };
    playerPauseRef.current = async () => {
      if (isMountedRef.current && videoRef.current) {
        await videoRef.current.pauseAsync?.();
      }
    };
    playerSeekRef.current = async (t: number) => {
      if (isMountedRef.current && videoRef.current) {
        await videoRef.current.setPositionAsync?.(t * 1000);
      }
    };
  }, [playerPlayRef, playerPauseRef, playerSeekRef]);

  const onPlaybackStatusUpdate = useCallback(
    (s: any) => {
      if (!isMountedRef.current) return;
      setStatus(s);

      if (s.isLoaded) {
        if (loading) {
          setLoading(false);
          Animated.timing(transitionOpacity, {
            toValue: 0,
            duration: 350,
            useNativeDriver: true,
          }).start();
        }

        const currentSecs = (s.positionMillis ?? 0) / 1000;
        const durationSecs = (s.durationMillis ?? 0) / 1000;
        updatePlayback(currentSecs, durationSecs);

        if (s.isPlaying) {
          onPlay?.();
        } else if (!s.isPlaying && !loading) {
          onPause?.();
        }

        if (s.didJustFinish) {
          onEnd?.();
        }
      }
    },
    [loading, onEnd, onPlay, onPause, transitionOpacity, updatePlayback]
  );

  if (Platform.OS !== "web" && VideoComponent) {
    return (
      <View style={[styles.container, { height: playerHeight }]}>
        <VideoComponent
          ref={videoRef}
          source={{ uri: videoUrl }}
          style={{ width: "100%", height: playerHeight }}
          resizeMode={ResizeMode?.CONTAIN ?? "contain"}
          shouldPlay={autoPlay}
          positionMillis={startPositionMs}
          onPlaybackStatusUpdate={onPlaybackStatusUpdate}
          useNativeControls
          isLooping={false}
          progressUpdateIntervalMillis={dataSaver || isRadioMode ? 2000 : 500}
        />
        <Animated.View
          style={[styles.overlay, { opacity: transitionOpacity, pointerEvents: "none" }]}
        >
          {thumbnailUrl && (
            <Image source={{ uri: thumbnailUrl }} style={styles.thumbnail} resizeMode="cover" />
          )}
          <View style={[styles.loadingCenter, { backgroundColor: "rgba(0,0,0,0.5)" }]}>
            <ActivityIndicator color={c.primary} size="large" />
            <Text style={[styles.loadingText, { color: "rgba(255,255,255,0.6)" }]}>
              {dataSaver || isRadioMode ? "Loading low-data playback..." : "Loading..."}
            </Text>
          </View>
        </Animated.View>
        {(dataSaver || isRadioMode) && (
          <View style={styles.modeBadge}>
            <Feather name={isRadioMode ? "radio" : "wifi-off"} size={12} color="#FFF" />
            <Text style={styles.modeBadgeText}>{isRadioMode ? "Audio focus" : "Data saver"}</Text>
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={[styles.container, { height: playerHeight }]}>
      {thumbnailUrl ? (
        <Image source={{ uri: thumbnailUrl }} style={styles.thumbnail} resizeMode="cover" />
      ) : (
        <View style={[styles.thumbnail, { backgroundColor: "#111" }]} />
      )}
      <View style={[styles.overlayCenter, { backgroundColor: "rgba(0,0,0,0.45)" }]}>
        <Pressable
          style={[styles.playButton, { backgroundColor: c.primary }]}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            if (Platform.OS === "web") {
              window.open(videoUrl, "_blank");
            }
          }}
        >
          <Feather name="play" size={28} color="#FFF" />
        </Pressable>
        {title && (
          <Text style={styles.tapHint} numberOfLines={1}>
            {title}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a", position: "relative", overflow: "hidden" },
  thumbnail: { ...StyleSheet.absoluteFillObject, width: "100%", height: "100%" },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0a0a0a",
  },
  overlayCenter: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  loadingCenter: {
    position: "absolute",
    alignItems: "center",
    gap: 10,
    padding: 20,
    borderRadius: 12,
  },
  loadingText: { fontSize: 13, fontFamily: "Inter_400Regular" },
  playButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: 4,
  },
  tapHint: { color: "rgba(255,255,255,0.5)", fontSize: 12, fontFamily: "Inter_400Regular" },
  modeBadge: {
    position: "absolute",
    left: 12,
    bottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.62)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
  },
  modeBadgeText: { color: "#FFF", fontSize: 11, fontFamily: "Inter_600SemiBold" },
});
