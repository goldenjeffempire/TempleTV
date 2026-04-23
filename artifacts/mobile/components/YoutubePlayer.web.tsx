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
    __ttPreconnected: boolean;
  }
}

// One-shot preconnect / DNS-prefetch to YouTube edge domains so the iframe
// kicks off TLS + DNS work in parallel with our JS bundle. Saves 100-300ms
// on cold loads, and is a no-op once injected. Idempotent across mounts.
function ensurePreconnect() {
  if (typeof document === "undefined") return;
  if (window.__ttPreconnected) return;
  window.__ttPreconnected = true;
  const hosts = [
    "https://www.youtube-nocookie.com",
    "https://www.youtube.com",
    "https://i.ytimg.com",
    "https://s.ytimg.com",
    "https://yt3.ggpht.com",
  ];
  for (const href of hosts) {
    const pre = document.createElement("link");
    pre.rel = "preconnect";
    pre.href = href;
    pre.crossOrigin = "anonymous";
    document.head.appendChild(pre);
    const dns = document.createElement("link");
    dns.rel = "dns-prefetch";
    dns.href = href;
    document.head.appendChild(dns);
  }
}

function loadYTApi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") { resolve(); return; }
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
      tag.async = true;
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
  playerHeight?: number;
  startPositionSecs?: number;
  onEnd?: () => void;
  onError?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  onToggleAudioMode?: () => void;
}

function WebAudioModeCard({
  videoId,
  thumbnailUrl,
  title,
  preacher,
  isLive,
  isLoading,
  onSwitchToVideo,
}: {
  videoId?: string;
  thumbnailUrl?: string;
  title?: string;
  preacher?: string;
  isLive?: boolean;
  isLoading: boolean;
  onSwitchToVideo?: () => void;
}) {
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const waveAnim1 = useRef(new Animated.Value(0.3)).current;
  const waveAnim2 = useRef(new Animated.Value(0.6)).current;
  const waveAnim3 = useRef(new Animated.Value(0.4)).current;
  const waveAnim4 = useRef(new Animated.Value(0.8)).current;
  const waveAnim5 = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    const ND = false;
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
  }, []);

  const spin = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const thumb = thumbnailUrl ?? (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null);

  return (
    <View style={webAudioStyles.card}>
      <View style={webAudioStyles.badge}>
        <Feather name="headphones" size={11} color="#B47FEB" />
        <Text style={webAudioStyles.badgeText}>
          {isLive ? "LIVE · AUDIO MODE" : "AUDIO MODE"}
        </Text>
      </View>

      <Animated.View style={{ transform: [{ rotate: spin }] }}>
        <View style={webAudioStyles.discOuter}>
          <View style={webAudioStyles.discMid}>
            {thumb ? (
              <Image source={{ uri: thumb }} style={webAudioStyles.discImage} />
            ) : (
              <View style={[webAudioStyles.discImage, { backgroundColor: "rgba(106,13,173,0.2)", alignItems: "center", justifyContent: "center" }]}>
                <Feather name="radio" size={32} color="rgba(106,13,173,0.6)" />
              </View>
            )}
            <View style={webAudioStyles.discCenter}>
              {isLoading ? (
                <ActivityIndicator color="#6A0DAD" size="small" />
              ) : (
                <Feather name="headphones" size={16} color="#6A0DAD" />
              )}
            </View>
          </View>
        </View>
      </Animated.View>

      <View style={webAudioStyles.waveRow}>
        {[waveAnim1, waveAnim2, waveAnim3, waveAnim4, waveAnim5].map((anim, i) => (
          <Animated.View key={i} style={[webAudioStyles.waveBar, { opacity: anim }]} />
        ))}
      </View>

      {(title || preacher) && (
        <View style={webAudioStyles.meta}>
          {title ? <Text style={webAudioStyles.metaTitle} numberOfLines={2}>{title}</Text> : null}
          {preacher ? <Text style={webAudioStyles.metaPreacher} numberOfLines={1}>{preacher}</Text> : null}
        </View>
      )}

      {onSwitchToVideo && (
        <Pressable
          onPress={onSwitchToVideo}
          style={({ pressed }) => [webAudioStyles.switchBtn, { opacity: pressed ? 0.7 : 1 }]}
        >
          <Feather name="video" size={13} color="#B47FEB" />
          <Text style={webAudioStyles.switchBtnText}>Switch to Video</Text>
        </Pressable>
      )}
    </View>
  );
}

// Exponential-backoff retry schedule (ms). Capped at 4 attempts so a permanently
// broken video doesn't burn CPU forever. Real network blips usually recover
// inside the first 2 attempts; the longer tail covers DNS / cell-tower flips.
const RETRY_BACKOFF_MS = [800, 2000, 4000, 8000];
// If currentTime fails to advance for this long while we believe playback is
// active, treat it as a stall and try to nudge the player.
const STALL_THRESHOLD_MS = 8000;

export function YoutubePlayer({
  videoId,
  isLive,
  channelHandle = "templetvjctm",
  autoPlay = true,
  startPositionSecs,
  title,
  preacher,
  thumbnailUrl,
  onEnd,
  onError,
  onPlay,
  onPause,
  onToggleAudioMode,
}: YoutubePlayerProps) {
  const c = useColors();
  const {
    updatePlayback,
    playerPlayRef,
    playerPauseRef,
    playerSeekRef,
    playerVolumeRef,
    volume,
    isRadioMode,
    toggleRadioMode,
  } = usePlayer();

  const containerId = useRef(`yt-player-${Math.random().toString(36).slice(2)}`);
  const playerRef = useRef<any>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);
  const currentVideoIdRef = useRef(videoId);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTickTimeRef = useRef<number>(0);
  const lastTickAtRef = useRef<number>(0);
  const stallNudgesRef = useRef(0);
  const isLogicallyPlayingRef = useRef(false);
  // Tracks YT.PlayerState.BUFFERING separately from PLAYING so the stall
  // watchdog can't false-positive on a long, legitimate buffer (slow 3G,
  // ad insertion, quality renegotiation). Real stalls only count when YT
  // *thinks* it's playing but currentTime hasn't advanced.
  const isBufferingRef = useRef(false);
  const wasPlayingBeforeOfflineRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"network" | "playback" | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  currentVideoIdRef.current = videoId;

  // Preconnect to YouTube edge domains as early as possible.
  useEffect(() => {
    ensurePreconnect();
  }, []);

  const stopTick = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
  }, []);

  // Owner-token refs so cleanup only clears refs THIS instance set.
  // Prevents the race where an unmounting player wipes the refs a newly
  // mounted player just registered (persistent ↔ /player route swap).
  const ownedPlayRef = useRef<(() => void) | null>(null);
  const ownedPauseRef = useRef<(() => void) | null>(null);
  const ownedSeekRef = useRef<((t: number) => void) | null>(null);
  const ownedVolumeRef = useRef<((v: number) => void) | null>(null);

  const startTick = useCallback(() => {
    stopTick();
    lastTickTimeRef.current = 0;
    lastTickAtRef.current = Date.now();
    stallNudgesRef.current = 0;
    tickRef.current = setInterval(() => {
      if (!isMountedRef.current || !playerRef.current) return;
      // Pause progress polling while the tab is hidden — saves CPU and
      // avoids running into browser timer-throttling oddities.
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const t = playerRef.current.getCurrentTime?.() ?? 0;
        const d = playerRef.current.getDuration?.() ?? 0;
        updatePlayback(t, d);

        // Stall watchdog: only trigger when YT thinks it's playing AND we
        // think it's playing AND we are NOT in YT's buffering state AND
        // time has truly frozen — never on live edge (duration keeps
        // growing), never on buffering, never on PAUSED.
        if (!isLive && isLogicallyPlayingRef.current && !isBufferingRef.current) {
          const now = Date.now();
          if (t > lastTickTimeRef.current + 0.05) {
            lastTickTimeRef.current = t;
            lastTickAtRef.current = now;
          } else if (now - lastTickAtRef.current > STALL_THRESHOLD_MS) {
            lastTickAtRef.current = now;
            // Two soft nudges (re-issue play) before falling back to a
            // hard reinit. Avoids flicker for transient micro-buffering.
            if (stallNudgesRef.current < 2) {
              stallNudgesRef.current += 1;
              try { playerRef.current.playVideo?.(); } catch {}
            } else {
              stallNudgesRef.current = 0;
              setReconnecting(true);
              scheduleRetry("network");
            }
          }
        }
      } catch { stopTick(); }
    }, 500);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopTick, updatePlayback, isLive]);

  const registerPlayerRefs = useCallback((p: any) => {
    const playFn = () => { try { p.playVideo(); } catch {} };
    const pauseFn = () => { try { p.pauseVideo(); } catch {} };
    const seekFn = (t: number) => { try { p.seekTo(t, true); } catch {} };
    const volFn = (v: number) => { try { p.setVolume(v); } catch {} };
    ownedPlayRef.current = playFn;
    ownedPauseRef.current = pauseFn;
    ownedSeekRef.current = seekFn;
    ownedVolumeRef.current = volFn;
    playerPlayRef.current = playFn;
    playerPauseRef.current = pauseFn;
    playerSeekRef.current = seekFn;
    playerVolumeRef.current = volFn;
  }, [playerPlayRef, playerPauseRef, playerSeekRef, playerVolumeRef]);

  const initPlayer = useCallback(() => {
    if (!isMountedRef.current) return;
    const el = document.getElementById(containerId.current);
    if (!el) return;

    if (playerRef.current) {
      try { playerRef.current.destroy(); } catch {}
      playerRef.current = null;
    }

    if (!videoId && !isLive) { setLoading(false); return; }

    setLoading(true);
    setError(null);

    // Use youtube-nocookie.com for privacy + cookieless faster initial paint.
    if (isLive) {
      const src =
        `https://www.youtube-nocookie.com/embed/live_stream` +
        `?channel=${JCTM_CHANNEL_ID}` +
        `&autoplay=${autoPlay ? 1 : 0}` +
        `&rel=0&modestbranding=1&playsinline=1&enablejsapi=1` +
        `&origin=${encodeURIComponent(window.location.origin)}`;
      const iframe = document.createElement("iframe");
      iframe.src = src;
      iframe.title = "Live broadcast";
      iframe.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture; accelerometer; gyroscope";
      iframe.allowFullscreen = true;
      iframe.referrerPolicy = "strict-origin-when-cross-origin";
      iframe.style.cssText =
        "position:absolute;top:0;left:0;width:100%;height:100%;border:none;background:#000;display:block;";
      iframe.onload = () => {
        if (!isMountedRef.current) return;
        setLoading(false);
        setReconnecting(false);
        retryCountRef.current = 0;
      };
      iframe.onerror = () => {
        if (isMountedRef.current) scheduleRetry("network");
      };
      el.innerHTML = "";
      el.appendChild(iframe);
      return;
    }

    try {
      const p = new window.YT.Player(containerId.current, {
        host: "https://www.youtube-nocookie.com",
        videoId,
        playerVars: {
          autoplay: autoPlay ? 1 : 0,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin: window.location.origin,
          enablejsapi: 1,
          fs: 1,
          iv_load_policy: 3,
          cc_load_policy: 0,
          start: startPositionSecs && startPositionSecs > 0 ? Math.floor(startPositionSecs) : undefined,
        },
        events: {
          onReady: (e: any) => {
            if (!isMountedRef.current) return;
            playerRef.current = e.target;
            registerPlayerRefs(e.target);
            try { e.target.setVolume(volume); } catch {}
            setLoading(false);
            setReconnecting(false);
            retryCountRef.current = 0;
          },
          onStateChange: (e: any) => {
            if (!isMountedRef.current) return;
            const YT = window.YT;
            if (e.data === YT.PlayerState.ENDED) {
              isLogicallyPlayingRef.current = false;
              isBufferingRef.current = false;
              stopTick();
              onEnd?.();
            } else if (e.data === YT.PlayerState.PLAYING) {
              isLogicallyPlayingRef.current = true;
              isBufferingRef.current = false;
              // Reset stall accounting on every transition into PLAYING so
              // we never count "buffer time" as "stall time."
              lastTickAtRef.current = Date.now();
              stallNudgesRef.current = 0;
              startTick();
              onPlay?.();
            } else if (e.data === YT.PlayerState.PAUSED) {
              isLogicallyPlayingRef.current = false;
              isBufferingRef.current = false;
              stopTick();
              onPause?.();
            } else if (e.data === YT.PlayerState.BUFFERING) {
              // Mark buffering so the watchdog stays quiet, and keep ticking
              // so the progress bar still updates if the player advances.
              isBufferingRef.current = true;
              lastTickAtRef.current = Date.now();
            }
          },
          onError: (e: any) => {
            // YT error codes: 2 invalid id, 5 HTML5, 100 not found,
            // 101/150 embedding disabled. The first three are recoverable;
            // the last two are not — surface them as playback errors.
            const code = e?.data;
            const recoverable = code === 2 || code === 5 || code === 100;
            if (recoverable) {
              scheduleRetry("network");
            } else {
              isLogicallyPlayingRef.current = false;
              stopTick();
              onError?.();
              if (isMountedRef.current) { setError("playback"); setLoading(false); setReconnecting(false); }
            }
          },
        },
      });
      playerRef.current = p;
    } catch (err) {
      scheduleRetry("network");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, isLive, autoPlay, volume, registerPlayerRefs, startTick, stopTick, onEnd, onError, onPlay, onPause, startPositionSecs]);

  // Exponential-backoff retry. Bounded; falls back to a hard error UI when
  // exhausted so the user always has an actionable surface (Retry / Open on
  // YouTube). Marked as 'any' to break the init/retry circular dep.
  const scheduleRetry = useCallback((kind: "network" | "playback") => {
    if (!isMountedRef.current) return;
    clearRetryTimer();
    const attempt = retryCountRef.current;
    if (attempt >= RETRY_BACKOFF_MS.length) {
      isLogicallyPlayingRef.current = false;
      stopTick();
      setError(kind);
      setLoading(false);
      setReconnecting(false);
      onError?.();
      return;
    }
    setReconnecting(true);
    setError(null);
    const delay = RETRY_BACKOFF_MS[attempt];
    retryCountRef.current = attempt + 1;
    retryTimerRef.current = setTimeout(() => {
      if (!isMountedRef.current) return;
      loadYTApi().then(() => { if (isMountedRef.current) initPlayer(); });
    }, delay);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearRetryTimer, stopTick, onError, initPlayer]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopTick();
      clearRetryTimer();
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch {}
        playerRef.current = null;
      }
      if (playerPlayRef.current === ownedPlayRef.current) playerPlayRef.current = null;
      if (playerPauseRef.current === ownedPauseRef.current) playerPauseRef.current = null;
      if (playerSeekRef.current === ownedSeekRef.current) playerSeekRef.current = null;
      if (playerVolumeRef.current === ownedVolumeRef.current) playerVolumeRef.current = null;
      ownedPlayRef.current = null;
      ownedPauseRef.current = null;
      ownedSeekRef.current = null;
      ownedVolumeRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    retryCountRef.current = 0;
    if (isLive) { initPlayer(); return; }
    if (!videoId) return;
    loadYTApi().then(() => {
      if (isMountedRef.current) initPlayer();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, isLive]);

  // Network + visibility recovery. When the browser comes back online or
  // the user returns to the tab after a long backgrounding, attempt to
  // resume playback from where it stopped. This is what makes the player
  // feel "always-on" like Netflix / YouTube web.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOffline = () => {
      wasPlayingBeforeOfflineRef.current = isLogicallyPlayingRef.current;
      setReconnecting(true);
    };
    const handleOnline = () => {
      if (!isMountedRef.current) return;
      // If the player itself is healthy, just nudge it; otherwise re-init.
      try {
        if (playerRef.current?.getPlayerState && wasPlayingBeforeOfflineRef.current) {
          playerRef.current.playVideo?.();
          setReconnecting(false);
        } else {
          retryCountRef.current = 0;
          loadYTApi().then(() => { if (isMountedRef.current) initPlayer(); });
        }
      } catch {
        retryCountRef.current = 0;
        loadYTApi().then(() => { if (isMountedRef.current) initPlayer(); });
      }
    };
    const handleVisibility = () => {
      if (typeof document === "undefined") return;
      // Coming back to a foregrounded tab: reset the stall watchdog so the
      // throttled background time doesn't trip a false-positive nudge.
      if (!document.hidden) {
        lastTickAtRef.current = Date.now();
      }
    };
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleManualRetry = useCallback(() => {
    retryCountRef.current = 0;
    setError(null);
    setReconnecting(true);
    loadYTApi().then(() => {
      if (isMountedRef.current) initPlayer();
    });
  }, [initPlayer]);

  const handleOpenYouTube = useCallback(() => {
    const url = videoId
      ? `https://www.youtube.com/watch?v=${videoId}`
      : `https://www.youtube.com/@${channelHandle}/live`;
    if (Platform.OS === "web") {
      window.open(url, "_blank", "noopener,noreferrer");
    } else {
      Linking.openURL(url).catch(() => {});
    }
  }, [videoId, channelHandle]);

  if (error) {
    const heading = error === "network" ? "Connection lost" : "Playback unavailable";
    const sub =
      error === "network"
        ? "We couldn't reach YouTube. Check your network and try again."
        : "This video can't be embedded right now. You can still watch it on YouTube.";
    return (
      <View style={styles.container}>
        <View style={styles.errorOverlay}>
          <View style={styles.errorIconWrap}>
            <Feather name={error === "network" ? "wifi-off" : "alert-triangle"} size={28} color="#fff" />
          </View>
          <Text style={styles.errorHeading}>{heading}</Text>
          <Text style={styles.errorSub}>{sub}</Text>
          <View style={styles.errorBtnRow}>
            <Pressable
              onPress={handleManualRetry}
              style={({ pressed }) => [styles.primaryBtn, { backgroundColor: c.primary, opacity: pressed ? 0.85 : 1 }]}
            >
              <Feather name="refresh-cw" size={14} color="#FFF" />
              <Text style={styles.primaryBtnText}>Try again</Text>
            </Pressable>
            <Pressable
              onPress={handleOpenYouTube}
              style={({ pressed }) => [styles.secondaryBtn, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Feather name="external-link" size={14} color="#FFF" />
              <Text style={styles.secondaryBtnText}>Open on YouTube</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  // Radio / audio-only mode:
  // Keep the iframe alive in a 1×1 invisible box so playback continues
  // uninterrupted, then overlay the full-size audio card. Toggling radio
  // mode off removes the overlay — zero player reinit, zero buffering.
  const handleSwitchToVideo = onToggleAudioMode ?? toggleRadioMode;

  return (
    <View style={styles.container}>
      {/* The iframe container — always mounted so playback never stops.
          In radio mode it's shrunk to 1×1 and made invisible. */}
      <View
        nativeID={containerId.current}
        id={containerId.current}
        style={isRadioMode ? styles.playerInnerHidden : styles.playerInner}
      />

      {/* Normal loading/reconnecting overlay (hidden in radio mode — the card handles UX) */}
      {(loading || reconnecting) && !isRadioMode && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          {videoId
            ? React.createElement("img", {
                src: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
                onError: (e: any) => {
                  if (e?.currentTarget) e.currentTarget.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
                },
                alt: "",
                "aria-hidden": "true",
                style: {
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  filter: "brightness(0.45) blur(6px)",
                  transform: "scale(1.04)",
                  transition: "opacity 300ms ease",
                },
              })
            : null}
          <View style={styles.loadingCenter}>
            <ActivityIndicator color="#fff" size="large" />
            <Text style={styles.loadingText}>
              {reconnecting
                ? "Reconnecting…"
                : isLive
                  ? "Connecting to live stream…"
                  : "Preparing playback"}
            </Text>
          </View>
        </View>
      )}

      {/* Audio mode card — full-size overlay shown when radio mode is active */}
      {isRadioMode && (
        <View style={[StyleSheet.absoluteFillObject, { zIndex: 10 }]}>
          <WebAudioModeCard
            videoId={videoId}
            thumbnailUrl={thumbnailUrl}
            title={title}
            preacher={preacher}
            isLive={isLive}
            isLoading={loading || reconnecting}
            onSwitchToVideo={handleSwitchToVideo}
          />
        </View>
      )}
    </View>
  );
}

const webAudioStyles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
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
    backgroundColor: "rgba(106,13,173,0.25)",
    borderColor: "rgba(106,13,173,0.4)",
  },
  badgeText: { fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1.2, color: "#B47FEB" },
  discOuter: {
    width: 150,
    height: 150,
    borderRadius: 75,
    borderWidth: 2,
    borderColor: "rgba(106,13,173,0.5)",
    padding: 6,
  },
  discMid: {
    flex: 1,
    borderRadius: 69,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    backgroundColor: "rgba(106,13,173,0.15)",
  },
  discImage: { width: "100%", height: "100%", borderRadius: 69 },
  discCenter: {
    position: "absolute",
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000",
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
  container: { flex: 1, backgroundColor: "#000", overflow: "hidden" },
  playerInner: { flex: 1, backgroundColor: "#000" },
  // Hidden player: 1×1, invisible, pointer-events off — keeps the iframe
  // alive so audio continues while the audio card overlay is shown.
  playerInnerHidden: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
    overflow: "hidden",
    pointerEvents: "none",
  } as any,
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#050505",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  loadingCenter: {
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  loadingText: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    color: "rgba(255,255,255,0.85)",
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#070707",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingHorizontal: 28,
  },
  errorIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  errorHeading: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: "#fff",
    textAlign: "center",
  },
  errorSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.65)",
    textAlign: "center",
    maxWidth: 380,
    lineHeight: 18,
  },
  errorBtnRow: { flexDirection: "row", gap: 10, marginTop: 8 },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 22,
  },
  primaryBtnText: { color: "#FFF", fontSize: 14, fontFamily: "Inter_700Bold" },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  secondaryBtnText: { color: "#FFF", fontSize: 14, fontFamily: "Inter_600SemiBold" },
});
