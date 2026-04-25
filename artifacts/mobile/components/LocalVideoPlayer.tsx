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
import {
  loadAndPlayTrack,
  pauseTrackPlayer,
  resumeTrackPlayer,
  seekTrackPlayer,
  stopTrackPlayer,
  isTrackPlayerSetup,
} from "@/services/nowPlaying";

let VideoComponent: any = null;
let ResizeMode: any = null;
try {
  const av = require("expo-av");
  VideoComponent = av.Video;
  ResizeMode = av.ResizeMode;
} catch {
  VideoComponent = null;
}

function LocalAudioModeCard({
  thumbnailUrl,
  title,
  isPlaying,
  loading,
  onToggle,
}: {
  thumbnailUrl?: string;
  title?: string;
  isPlaying: boolean;
  loading: boolean;
  onToggle?: () => void;
}) {
  const c = useColors();
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const waveAnims = [
    useRef(new Animated.Value(0.3)).current,
    useRef(new Animated.Value(0.6)).current,
    useRef(new Animated.Value(0.4)).current,
    useRef(new Animated.Value(0.8)).current,
    useRef(new Animated.Value(0.5)).current,
  ];

  useEffect(() => {
    if (!isPlaying) {
      rotateAnim.stopAnimation();
      waveAnims.forEach((a) => a.stopAnimation());
      return;
    }
    const ND = Platform.OS !== "web";
    const rotate = Animated.loop(
      Animated.timing(rotateAnim, { toValue: 1, duration: 12000, useNativeDriver: ND }),
    );
    const waves = waveAnims.map((anim, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 80),
          Animated.timing(anim, { toValue: 1, duration: 400 + i * 60, useNativeDriver: ND }),
          Animated.timing(anim, { toValue: 0.15, duration: 400 + i * 60, useNativeDriver: ND }),
        ]),
      ),
    );
    rotate.start();
    waves.forEach((w) => w.start());
    return () => {
      rotate.stop();
      waves.forEach((w) => w.stop());
    };
  }, [isPlaying]);

  const spin = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });

  return (
    <View style={[audioStyles.card, { backgroundColor: "rgba(0,0,0,0.92)" }]}>
      <View style={[audioStyles.badge, { backgroundColor: "rgba(106,13,173,0.25)", borderColor: "rgba(106,13,173,0.4)" }]}>
        <Feather name="headphones" size={11} color="#B47FEB" />
        <Text style={[audioStyles.badgeText, { color: "#B47FEB" }]}>AUDIO MODE</Text>
      </View>

      <Animated.View style={{ transform: [{ rotate: spin }] }}>
        <View style={audioStyles.discOuter}>
          <View style={audioStyles.discMid}>
            {thumbnailUrl ? (
              <Image source={{ uri: thumbnailUrl }} style={audioStyles.discImage} />
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
          {waveAnims.map((anim, i) => (
            <Animated.View key={i} style={[audioStyles.waveBar, { opacity: anim }]} />
          ))}
        </View>
      )}

      {title ? (
        <View style={audioStyles.meta}>
          <Text style={audioStyles.metaTitle} numberOfLines={2}>{title}</Text>
          <Text style={audioStyles.metaArtist}>Temple TV JCTM</Text>
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

interface LocalVideoPlayerProps {
  videoUrl: string;
  hlsMasterUrl?: string;
  thumbnailUrl?: string;
  title?: string;
  autoPlay?: boolean;
  onEnd?: () => void;
  onError?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  startPositionMs?: number;
  /** Use COVER resize mode (cinematic crop) instead of CONTAIN. Useful for broadcast/live hero-style presentation. */
  coverMode?: boolean;
  /** Override the computed player height. When not provided, the component derives height from screen width at 9:16. */
  playerHeightOverride?: number;
}

export function LocalVideoPlayer({
  videoUrl,
  hlsMasterUrl,
  thumbnailUrl,
  title,
  autoPlay = true,
  onEnd,
  onError,
  onPlay,
  onPause,
  startPositionMs = 0,
  coverMode = false,
  playerHeightOverride,
}: LocalVideoPlayerProps) {
  const effectiveUrl = hlsMasterUrl || videoUrl;
  const c = useColors();
  const { width } = useWindowDimensions();
  const { updatePlayback, playerPlayRef, playerPauseRef, playerSeekRef, isPlaying, dataSaver, isRadioMode, toggleRadioMode } = usePlayer();
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const retryCountRef = useRef(0);
  const videoRef = useRef<any>(null);
  const isMountedRef = useRef(true);
  const transitionOpacity = useRef(new Animated.Value(1)).current;
  const rntp = Platform.OS !== "web" && isTrackPlayerSetup();

  // Web-only: HTML5 video element ref + hls.js instance ref
  const webVideoRef = useRef<HTMLVideoElement | null>(null);
  const webHlsRef = useRef<any>(null);
  // Web-only: watchdog timer that surfaces a stalled-load failure if the
  // <video> element makes no progress within WEB_LOAD_WATCHDOG_MS. Without
  // this, CORS-blocked or stalled requests would hang the loading veil
  // indefinitely. Mirrors the TV HlsVideoPlayer's watchdog behaviour.
  const webLoadWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const WEB_LOAD_WATCHDOG_MS = 15_000;
  const [webNeedsPlayGesture, setWebNeedsPlayGesture] = useState(false);

  const playerHeight = playerHeightOverride ?? Math.min(Math.round(width * (9 / 16)), 260);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (isRadioMode && rntp) {
      playerPlayRef.current = () => { resumeTrackPlayer().catch(() => {}); };
      playerPauseRef.current = () => { pauseTrackPlayer().catch(() => {}); };
      playerSeekRef.current = (t: number) => { seekTrackPlayer(t).catch(() => {}); };
    } else {
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
    }
  }, [isRadioMode, rntp, playerPlayRef, playerPauseRef, playerSeekRef]);

  useEffect(() => {
    if (!isRadioMode || !rntp || !effectiveUrl || Platform.OS === "web") return;

    setLoading(true);
    loadAndPlayTrack({
      id: effectiveUrl,
      url: effectiveUrl,
      title: title ?? "Temple TV",
      artist: "Temple TV JCTM",
      artwork: thumbnailUrl,
      isLiveStream: false,
    })
      .then(() => { if (isMountedRef.current) setLoading(false); })
      .catch(() => { if (isMountedRef.current) setLoading(false); });

    return () => {
      stopTrackPlayer().catch(() => {});
    };
  }, [isRadioMode, rntp, effectiveUrl, title, thumbnailUrl]);

  useEffect(() => {
    if (!isRadioMode || !rntp || Platform.OS === "web") return;
    if (isPlaying) {
      resumeTrackPlayer().catch(() => {});
    } else {
      pauseTrackPlayer().catch(() => {});
    }
  }, [isPlaying, isRadioMode, rntp]);

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
      if (!s.isLoaded && s.error) {
        if (retryCountRef.current < 2) {
          retryCountRef.current += 1;
          setLoading(true);
          setTimeout(() => {
            if (!isMountedRef.current || !videoRef.current) return;
            videoRef.current.replayAsync?.({ positionMillis: startPositionMs }).catch(() => onError?.());
          }, 700);
        } else {
          setLoading(false);
          onError?.();
        }
      }
    },
    [loading, onEnd, onError, onPlay, onPause, startPositionMs, transitionOpacity, updatePlayback]
  );

  // Web HLS player init
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const video = webVideoRef.current;
    if (!video) return;

    // Clean up any previous hls instance
    if (webHlsRef.current) {
      webHlsRef.current.destroy();
      webHlsRef.current = null;
    }

    // ── Web playback helpers (watchdog + autoplay-policy handling) ─────────
    const clearWebWatchdog = () => {
      if (webLoadWatchdog.current) {
        clearTimeout(webLoadWatchdog.current);
        webLoadWatchdog.current = null;
      }
    };
    const armWebWatchdog = () => {
      clearWebWatchdog();
      webLoadWatchdog.current = setTimeout(() => {
        // Suppress stale fires when the element actually has data.
        if (video.readyState >= 2) return;
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[LocalVideoPlayer] web load watchdog fired — stalled");
        }
        if (isMountedRef.current) {
          setLoading(false);
          onError?.();
        }
      }, WEB_LOAD_WATCHDOG_MS);
    };
    const safePlay = () => {
      if (!autoPlay) return;
      const r = video.play();
      if (r && typeof r.then === "function") {
        r.then(() => {
          if (isMountedRef.current) setWebNeedsPlayGesture(false);
        }).catch((err: any) => {
          // NotAllowedError = autoplay policy rejection (recoverable via
          // a tap on the video). Other errors are usually transient.
          if (err && err.name === "NotAllowedError" && isMountedRef.current) {
            setWebNeedsPlayGesture(true);
            // The video is loaded; clear loading veil so the user sees
            // the play overlay instead of the spinner.
            setLoading(false);
            clearWebWatchdog();
          } else if (typeof console !== "undefined" && console.warn) {
            console.warn("[LocalVideoPlayer] web video.play() rejected:", err);
          }
        });
      }
    };
    // Cancel watchdog and clear loading state once the element actually
    // reaches a playable state — the most reliable cross-engine signal
    // that playback is alive.
    const onCanPlay = () => { clearWebWatchdog(); if (isMountedRef.current) setLoading(false); };
    const onPlaying = () => { clearWebWatchdog(); if (isMountedRef.current) { setLoading(false); setWebNeedsPlayGesture(false); } };
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("playing", onPlaying);

    let Hls: any;
    try { Hls = require("hls.js"); } catch { return; }
    // require returns the module, which may have a .default for ESM
    const HlsClass = Hls?.default ?? Hls;
    if (!HlsClass) return;

    if (HlsClass.isSupported && HlsClass.isSupported()) {
      const hls = new HlsClass({
        startLevel: -1,
        maxBufferLength: 30,
        // Match the TV player: never include credentials on cross-origin
        // segment fetches so the production CDN's CORS doesn't have to
        // echo a specific Access-Control-Allow-Origin.
        xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = false; },
      });
      webHlsRef.current = hls;
      hls.loadSource(effectiveUrl);
      hls.attachMedia(video);
      armWebWatchdog();
      hls.on("hlsManifestParsed", () => {
        if (startPositionMs > 0) video.currentTime = startPositionMs / 1000;
        safePlay();
      });
      hls.on("hlsError", (_e: any, data: any) => {
        if (data?.fatal) {
          clearWebWatchdog();
          if (typeof console !== "undefined" && console.warn) {
            console.warn("[LocalVideoPlayer] fatal hls error:", data.type, data.details);
          }
          if (isMountedRef.current) { setLoading(false); onError?.(); }
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = effectiveUrl;
      armWebWatchdog();
      if (startPositionMs > 0) {
        video.addEventListener("loadedmetadata", () => {
          video.currentTime = startPositionMs / 1000;
        }, { once: true });
      }
      safePlay();
    } else {
      // Direct MP4 fallback
      video.src = effectiveUrl;
      armWebWatchdog();
      safePlay();
    }

    return () => {
      clearWebWatchdog();
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("playing", onPlaying);
      if (webHlsRef.current) {
        webHlsRef.current.destroy();
        webHlsRef.current = null;
      }
    };
  }, [effectiveUrl, autoPlay, startPositionMs, onError]);

  if (Platform.OS !== "web") {
    if (isRadioMode) {
      return (
        <LocalAudioModeCard
          thumbnailUrl={thumbnailUrl}
          title={title}
          isPlaying={isPlaying}
          loading={loading}
        />
      );
    }

    if (VideoComponent) {
      return (
        <View style={[styles.container, { height: playerHeight }]}>
          <VideoComponent
            ref={videoRef}
            source={{ uri: effectiveUrl }}
            style={{ width: "100%", height: playerHeight }}
            resizeMode={coverMode ? (ResizeMode?.COVER ?? "cover") : (ResizeMode?.CONTAIN ?? "contain")}
            shouldPlay={autoPlay}
            positionMillis={startPositionMs}
            onPlaybackStatusUpdate={onPlaybackStatusUpdate}
            useNativeControls
            isLooping={false}
            progressUpdateIntervalMillis={dataSaver ? 2000 : 500}
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
                {dataSaver && !coverMode ? "Loading (data saver)..." : "Loading..."}
              </Text>
            </View>
          </Animated.View>
          {hlsMasterUrl && !loading && !coverMode && (
            <View style={[styles.modeBadge, { right: 12, left: undefined }]}>
              <Feather name="layers" size={12} color="#FFF" />
              <Text style={styles.modeBadgeText}>ABR</Text>
            </View>
          )}
          {dataSaver && !coverMode && (
            <View style={styles.modeBadge}>
              <Feather name="wifi-off" size={12} color="#FFF" />
              <Text style={styles.modeBadgeText}>Data saver</Text>
            </View>
          )}
        </View>
      );
    }
  }

  // Web HLS player using hls.js
  // In radio mode: keep the <video> element alive (hls.js / audio continues)
  // but hide it behind the audio card overlay — zero buffering on mode switch.
  return (
    <View style={[styles.container, !isRadioMode && { height: playerHeight }]}>
      {/* Video element — always mounted, hidden in radio mode so audio plays on */}
      <View
        style={
          isRadioMode
            ? { position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }
            : { flex: 1 }
        }
      >
        {React.createElement("video", {
          ref: (el: HTMLVideoElement | null) => {
            (webVideoRef as any).current = el;
            // Wire context refs to the HTML5 video element so the play/pause/seek
            // controls in the player screen and radio tab work on web.
            if (el) {
              playerPlayRef.current = () => el.play().catch(() => {});
              playerPauseRef.current = () => { el.pause(); };
              playerSeekRef.current = (t: number) => { el.currentTime = t; };
            }
          },
          controls: !isRadioMode,
          playsInline: true,
          preload: "auto",
          // Intentionally NOT setting `crossOrigin`. Our broadcast queue
          // contains absolute production URLs whose CORS allow-list only
          // includes a fixed set of origins; setting `crossOrigin="anonymous"`
          // would force CORS validation and block playback on Replit dev
          // previews, custom domains, and embedded contexts. We never read
          // pixels off the video, so CORS isn't required.
          style: {
            width: "100%",
            height: isRadioMode ? "1px" : "100%",
            objectFit: "contain",
            background: "#000",
            display: "block",
          },
          onPlay: () => onPlay?.(),
          onPause: () => onPause?.(),
          onEnded: () => onEnd?.(),
          onError: () => onError?.(),
          onTimeUpdate: (e: any) => {
            const v = e.target as HTMLVideoElement;
            if (v.duration) updatePlayback(v.currentTime, v.duration);
          },
        })}
      </View>

      {/* Radio mode audio card overlay */}
      {isRadioMode && (
        <LocalAudioModeCard
          thumbnailUrl={thumbnailUrl}
          title={title}
          isPlaying={isPlaying}
          loading={false}
          onToggle={toggleRadioMode}
        />
      )}

      {/* HLS / ABR badge — only in video mode and non-broadcast mode */}
      {!isRadioMode && !coverMode && (
        <View style={[styles.modeBadge, { right: 12, left: undefined }]}>
          <Feather name="layers" size={12} color="#FFF" />
          <Text style={styles.modeBadgeText}>
            {hlsMasterUrl ? "HLS ABR" : "MP4"}
          </Text>
        </View>
      )}

      {/* Autoplay-policy overlay — surfaced when the browser blocks the
          initial play() call. Tapping calls play() again from a real user
          gesture, which always succeeds. Without this overlay the video
          would appear loaded but stuck on its first frame with no UX. */}
      {!isRadioMode && webNeedsPlayGesture && (
        <Pressable
          onPress={() => {
            const v = webVideoRef.current;
            if (!v) return;
            const r = v.play();
            if (r && typeof r.then === "function") {
              r.then(() => setWebNeedsPlayGesture(false)).catch(() => {});
            } else {
              setWebNeedsPlayGesture(false);
            }
          }}
          style={{
            position: "absolute",
            top: 0, left: 0, right: 0, bottom: 0,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.55)",
          }}
        >
          <View style={{
            width: 72, height: 72, borderRadius: 36,
            backgroundColor: "#DC2626",
            alignItems: "center", justifyContent: "center",
          }}>
            <Feather name="play" size={32} color="#FFF" />
          </View>
          <Text style={{ color: "#FFF", marginTop: 12, fontWeight: "600" }}>
            Tap to start playback
          </Text>
        </Pressable>
      )}
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

const audioStyles = StyleSheet.create({
  card: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingVertical: 20,
    paddingHorizontal: 16,
    minHeight: 240,
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
  metaArtist: { fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.5)", textAlign: "center" },
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
