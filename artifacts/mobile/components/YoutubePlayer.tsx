import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";

interface YoutubePlayerProps {
  videoId?: string;
  isLive?: boolean;
  thumbnailUrl?: string;
  channelHandle?: string;
  autoPlay?: boolean;
  title?: string;
  preacher?: string;
  playerHeight?: number;
  startPositionSecs?: number;
  onEnd?: () => void;
  onError?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  onToggleAudioMode?: () => void;
}

const ORIGIN =
  typeof window !== "undefined" && window.location?.origin
    ? window.location.origin
    : "https://templetv.org.ng";

function buildEmbedUrl({
  videoId,
  isLive,
  channelHandle,
  autoPlay,
  startPositionSecs,
}: Pick<YoutubePlayerProps, "videoId" | "isLive" | "channelHandle" | "autoPlay" | "startPositionSecs">): string {
  const params = new URLSearchParams({
    enablejsapi: "1",
    playsinline: "1",
    rel: "0",
    modestbranding: "1",
    fs: "1",
    origin: ORIGIN,
  });
  // When autoplay is initiated by a user gesture (radio play tap, etc.)
  // browsers permit sound. Only mute autoplay for ambient previews where
  // sound would be disruptive — the caller handles that case explicitly.
  params.set("autoplay", autoPlay ? "1" : "0");
  if (startPositionSecs && startPositionSecs > 0) {
    params.set("start", String(Math.floor(startPositionSecs)));
  }
  if (isLive && channelHandle) {
    // For the live tile, use the channel "live" deep-link via the
    // user_uploads list trick — when the channel is live this is what
    // YouTube returns.
    params.set("listType", "user_uploads");
    params.set("list", channelHandle);
    return `https://www.youtube-nocookie.com/embed?${params.toString()}`;
  }
  if (!videoId) {
    return "";
  }
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
}

/**
 * Web variant of the YouTube player. Embeds the video in-page via a
 * standard <iframe> (no redirect to youtube.com) and bridges the
 * IFrame Player API's postMessage events back to the parent component
 * so progress, autoplay, and "play next" wiring keep working.
 *
 * Native (iOS/Android) uses YoutubePlayer.native.tsx via Expo's
 * platform-specific resolution.
 */
export function YoutubePlayer({
  videoId,
  isLive,
  channelHandle = "templetvjctm",
  autoPlay,
  startPositionSecs,
  onEnd,
  onError,
  onPlay,
  onPause,
}: YoutubePlayerProps) {
  if (Platform.OS !== "web") {
    return null;
  }

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const callbacksRef = useRef({ onEnd, onError, onPlay, onPause });
  callbacksRef.current = { onEnd, onError, onPlay, onPause };
  const [iframeReady, setIframeReady] = useState(false);
  const posterUrl = videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : null;

  // Preconnect to YouTube origins on first render so the iframe handshake
  // is faster — knocks ~200-400ms off cold starts on mobile data.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const hosts = [
      "https://www.youtube-nocookie.com",
      "https://www.youtube.com",
      "https://i.ytimg.com",
    ];
    const links: HTMLLinkElement[] = [];
    hosts.forEach((href) => {
      if (document.querySelector(`link[rel="preconnect"][href="${href}"]`)) return;
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = href;
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
      links.push(link);
    });
    return () => { links.forEach((l) => l.remove()); };
  }, []);

  // Reset readiness whenever the video changes
  useEffect(() => { setIframeReady(false); }, [videoId, isLive]);

  const src = useMemo(
    () => buildEmbedUrl({ videoId, isLive, channelHandle, autoPlay, startPositionSecs }),
    // startPositionSecs intentionally excluded so seeking from the
    // parent doesn't force-remount the iframe mid-playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videoId, isLive, channelHandle, autoPlay],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const ALLOWED_HOSTS = new Set([
      "www.youtube.com",
      "youtube.com",
      "www.youtube-nocookie.com",
      "youtube-nocookie.com",
    ]);

    function handleMessage(event: MessageEvent) {
      // Strict origin check — substring matching would let
      // attacker-controlled hosts like youtube.com.evil.tld through.
      let host = "";
      try {
        host = new URL(event.origin).hostname;
      } catch {
        return;
      }
      if (!ALLOWED_HOSTS.has(host)) return;
      // Only accept messages from THIS iframe's window so a sibling
      // YouTube embed on the page can't trigger our state callbacks.
      if (event.source !== iframeRef.current?.contentWindow) return;
      let data: any = event.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (!data || typeof data !== "object") return;
      const cbs = callbacksRef.current;
      if (data.event === "onStateChange") {
        // YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
        const state = data.info;
        if (state === 0) cbs.onEnd?.();
        else if (state === 1) cbs.onPlay?.();
        else if (state === 2) cbs.onPause?.();
      } else if (data.event === "onError") {
        cbs.onError?.();
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // Once the iframe loads, opt-in to state-change events. The IFrame
  // Player API requires us to send a "listening" message and then a
  // "addEventListener" message to start receiving callbacks.
  const handleLoad = () => {
    setIframeReady(true);
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    try {
      iframe.contentWindow.postMessage(
        JSON.stringify({ event: "listening", id: "tt-yt-player" }),
        "*",
      );
      iframe.contentWindow.postMessage(
        JSON.stringify({
          event: "command",
          func: "addEventListener",
          args: ["onStateChange"],
        }),
        "*",
      );
      iframe.contentWindow.postMessage(
        JSON.stringify({
          event: "command",
          func: "addEventListener",
          args: ["onError"],
        }),
        "*",
      );
    } catch {
      // Cross-origin restriction — events just won't fire, the video
      // still plays normally via the native YouTube controls.
    }
  };

  if (!src) {
    return <View style={styles.container} />;
  }

  // react-native-web renders View as a div — embed a real <iframe> child.
  return (
    <View style={styles.container}>
      {/* Poster background while iframe boots — keeps the surface from
          flashing black and matches the modern OTT loading feel. */}
      {posterUrl && !iframeReady && (
        <img
          src={posterUrl}
          alt=""
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            filter: "brightness(0.65) blur(2px)",
          }}
        />
      )}
      {React.createElement("iframe", {
        ref: iframeRef,
        src,
        title: "Temple TV video player",
        allow:
          "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen",
        allowFullScreen: true,
        referrerPolicy: "strict-origin-when-cross-origin",
        loading: "eager",
        onLoad: handleLoad,
        style: {
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          border: "0",
          display: "block",
          backgroundColor: "transparent",
          opacity: iframeReady ? 1 : 0,
          transition: "opacity 350ms ease",
        },
      })}
      {!iframeReady && (
        <View pointerEvents="none" style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#FF0040" />
          <Text style={styles.loadingText}>
            {isLive ? "Connecting to live stream…" : "Loading player…"}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
    position: "relative",
    overflow: "hidden",
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  loadingText: {
    fontSize: 13,
    color: "rgba(255,255,255,0.75)",
    letterSpacing: 1,
    fontFamily: "Inter_500Medium",
  },
});
