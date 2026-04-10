import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { JCTM_CHANNEL_ID } from "@/data/sermons";

interface YoutubePlayerProps {
  videoId?: string;
  isLive?: boolean;
  thumbnailUrl?: string;
  channelHandle?: string;
  autoPlay?: boolean;
  onEnd?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
}

export function YoutubePlayer({
  videoId,
  isLive,
  channelHandle = "templetvjctm",
  autoPlay = true,
  onEnd,
}: YoutubePlayerProps) {
  const c = useColors();
  const containerRef = useRef<View>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const container = containerRef.current as unknown as HTMLDivElement | null;
    if (!container) return;

    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    iframeRef.current = null;
    setPlayerReady(false);
    setError(false);

    const src = isLive
      ? `https://www.youtube.com/embed/live_stream?channel=${JCTM_CHANNEL_ID}&autoplay=${autoPlay ? 1 : 0}&rel=0&modestbranding=1`
      : videoId
        ? `https://www.youtube.com/embed/${videoId}?autoplay=${autoPlay ? 1 : 0}&rel=0&modestbranding=1&playsinline=1&enablejsapi=0`
        : null;

    if (!src) return;

    const iframe = document.createElement("iframe");
    iframe.src = src;
    iframe.allow =
      "autoplay; encrypted-media; fullscreen; picture-in-picture; camera; microphone";
    iframe.allowFullscreen = true;
    iframe.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;border:none;background:#000;";

    iframe.onload = () => setPlayerReady(true);
    iframe.onerror = () => setError(true);

    container.style.position = "relative";
    container.appendChild(iframe);
    iframeRef.current = iframe;

    return () => {
      if (container.contains(iframe)) {
        container.removeChild(iframe);
      }
      iframeRef.current = null;
    };
  }, [videoId, isLive, autoPlay]);

  if (error) {
    return (
      <View style={[styles.container, { backgroundColor: "#0a0a0a" }]}>
        <View style={styles.overlay}>
          <Feather name="alert-circle" size={32} color={c.mutedForeground} />
          <Text style={[styles.tapHint, { color: c.mutedForeground }]}>
            Could not load player
          </Text>
          <Pressable
            onPress={() => setError(false)}
            style={[styles.retryBtn, { backgroundColor: c.primary }]}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View ref={containerRef} style={styles.iframeContainer} />
      {!playerReady && (
        <View style={[styles.loadingOverlay, { backgroundColor: "#0a0a0a" }]}>
          <ActivityIndicator color={c.primary} size="large" />
          <Text style={[styles.tapHint, { color: "rgba(255,255,255,0.6)" }]}>
            Loading player...
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },
  iframeContainer: {
    flex: 1,
    backgroundColor: "#000",
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  tapHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    marginTop: 4,
  },
  retryText: {
    color: "#FFF",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
});
