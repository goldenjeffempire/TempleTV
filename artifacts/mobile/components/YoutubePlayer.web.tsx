import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { usePlayer } from "@/context/PlayerContext";

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: (() => void) | undefined;
    __ytApiReady: boolean;
    __ytApiCallbacks: Array<() => void>;
  }
}

function loadYTApi(): Promise<void> {
  return new Promise((resolve) => {
    if (window.__ytApiReady) { resolve(); return; }
    if (!window.__ytApiCallbacks) window.__ytApiCallbacks = [];
    window.__ytApiCallbacks.push(resolve);
    if (!document.querySelector('script[src*="iframe_api"]')) {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        window.__ytApiReady = true;
        prev?.();
        (window.__ytApiCallbacks ?? []).forEach((cb) => cb());
        window.__ytApiCallbacks = [];
      };
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    }
  });
}

interface YoutubePlayerProps {
  videoId?: string;
  isLive?: boolean;
  thumbnailUrl?: string;
  channelHandle?: string;
  autoPlay?: boolean;
  title?: string;
  preacher?: string;
  onEnd?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  onToggleAudioMode?: () => void;
}

export function YoutubePlayer({
  videoId,
  isLive,
  channelHandle = "templetvjctm",
  autoPlay = true,
  onEnd,
  onPlay,
  onPause,
}: YoutubePlayerProps) {
  const c = useColors();
  const { updatePlayback, playerPlayRef, playerPauseRef, playerSeekRef, playerVolumeRef, volume } =
    usePlayer();

  const containerId = useRef(`yt-player-${Math.random().toString(36).slice(2)}`);
  const playerRef = useRef<any>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);
  const currentVideoIdRef = useRef(videoId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  currentVideoIdRef.current = videoId;

  const stopTick = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  const startTick = useCallback(() => {
    stopTick();
    tickRef.current = setInterval(() => {
      if (!isMountedRef.current || !playerRef.current) return;
      try {
        const t = playerRef.current.getCurrentTime?.() ?? 0;
        const d = playerRef.current.getDuration?.() ?? 0;
        updatePlayback(t, d);
      } catch { stopTick(); }
    }, 500);
  }, [stopTick, updatePlayback]);

  const registerPlayerRefs = useCallback((p: any) => {
    playerPlayRef.current = () => { try { p.playVideo(); } catch {} };
    playerPauseRef.current = () => { try { p.pauseVideo(); } catch {} };
    playerSeekRef.current = (t: number) => { try { p.seekTo(t, true); } catch {} };
    playerVolumeRef.current = (v: number) => { try { p.setVolume(v); } catch {} };
  }, [playerPlayRef, playerPauseRef, playerSeekRef, playerVolumeRef]);

  const initPlayer = useCallback(() => {
    if (!isMountedRef.current) return;
    const el = document.getElementById(containerId.current);
    if (!el) return;

    if (playerRef.current) {
      try { playerRef.current.destroy(); } catch {}
      playerRef.current = null;
    }

    const src = isLive
      ? `https://www.youtube.com/embed/live_stream?channel=${JCTM_CHANNEL_ID}&autoplay=${autoPlay ? 1 : 0}&rel=0&modestbranding=1&enablejsapi=1`
      : videoId
        ? null
        : null;

    if (!videoId && !isLive) { setLoading(false); return; }

    setLoading(true);
    setError(false);

    if (isLive) {
      const iframe = document.createElement("iframe");
      iframe.src = src!;
      iframe.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
      iframe.allowFullscreen = true;
      iframe.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;border:none;background:#000;";
      iframe.onload = () => { if (isMountedRef.current) setLoading(false); };
      iframe.onerror = () => { if (isMountedRef.current) setError(true); };
      el.innerHTML = "";
      el.appendChild(iframe);
      return;
    }

    try {
      const p = new window.YT.Player(containerId.current, {
        videoId,
        playerVars: {
          autoplay: autoPlay ? 1 : 0,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin: window.location.origin,
          enablejsapi: 1,
          fs: 1,
        },
        events: {
          onReady: (e: any) => {
            if (!isMountedRef.current) return;
            playerRef.current = e.target;
            registerPlayerRefs(e.target);
            e.target.setVolume(volume);
            setLoading(false);
          },
          onStateChange: (e: any) => {
            if (!isMountedRef.current) return;
            const YT = window.YT;
            if (e.data === YT.PlayerState.ENDED) {
              stopTick();
              onEnd?.();
            } else if (e.data === YT.PlayerState.PLAYING) {
              startTick();
              onPlay?.();
            } else if (e.data === YT.PlayerState.PAUSED) {
              stopTick();
              onPause?.();
            } else if (e.data === YT.PlayerState.BUFFERING) {
              // keep ticking so progress bar updates
            }
          },
          onError: () => {
            if (isMountedRef.current) { setError(true); setLoading(false); }
          },
        },
      });
      playerRef.current = p;
    } catch (err) {
      setError(true);
      setLoading(false);
    }
  }, [videoId, isLive, autoPlay, volume, registerPlayerRefs, startTick, stopTick, onEnd, onPlay, onPause]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopTick();
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch {}
        playerRef.current = null;
      }
      playerPlayRef.current = null;
      playerPauseRef.current = null;
      playerSeekRef.current = null;
      playerVolumeRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (isLive) { initPlayer(); return; }
    if (!videoId) return;
    loadYTApi().then(() => {
      if (isMountedRef.current) initPlayer();
    });
  }, [videoId, isLive]);

  const handleRetry = useCallback(() => {
    setError(false);
    loadYTApi().then(() => {
      if (isMountedRef.current) initPlayer();
    });
  }, [initPlayer]);

  if (error) {
    return (
      <View style={[styles.container, { backgroundColor: "#0a0a0a" }]}>
        <View style={styles.centeredOverlay}>
          <Feather name="alert-circle" size={32} color={c.mutedForeground} />
          <Text style={[styles.hintText, { color: c.mutedForeground }]}>Could not load player</Text>
          <Pressable onPress={handleRetry} style={[styles.retryBtn, { backgroundColor: c.primary }]}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View
        nativeID={containerId.current}
        id={containerId.current}
        style={styles.playerInner}
      />
      {loading && (
        <View style={[styles.loadingOverlay, { backgroundColor: "#0a0a0a" }]}>
          <ActivityIndicator color={c.primary} size="large" />
          <Text style={[styles.hintText, { color: "rgba(255,255,255,0.6)" }]}>
            {isLive ? "Connecting to live stream..." : "Loading player..."}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  playerInner: { flex: 1, backgroundColor: "#000" },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  centeredOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  hintText: { fontSize: 13, fontFamily: "Inter_400Regular" },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, marginTop: 4 },
  retryText: { color: "#FFF", fontSize: 14, fontFamily: "Inter_600SemiBold" },
});
