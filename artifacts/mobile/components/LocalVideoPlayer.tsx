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
  /**
   * Round 6: when true, this player is rendering a "live broadcast" stream
   * (a station-driven queue item, not an on-demand sermon the user chose).
   * Native and web chrome — the timeline scrubber, time readout, and
   * fullscreen seek hotkeys — are suppressed so the broadcast cannot be
   * scrubbed or rewound. Play/pause is still possible via the in-app
   * overlay; the directive only forbids time-position UI and seek.
   */
  isBroadcastLive?: boolean;
  /**
   * Round 7 (broadcast continuity): URL of the *next* item the broadcast
   * queue will air after `videoUrl`. When provided, the web player loads
   * it silently into the inactive A/B slot so the eventual cut feels like
   * a real TV channel transition — no spinner, no black frame, no
   * manifest fetch delay. Safe to omit for non-broadcast playback.
   */
  nextVideoUrl?: string;
  nextHlsMasterUrl?: string;
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
  isBroadcastLive = false,
  nextVideoUrl,
  nextHlsMasterUrl,
}: LocalVideoPlayerProps) {
  const effectiveUrl = hlsMasterUrl || videoUrl;
  // Computed next-item URL for the inactive A/B slot. Mirrors
  // `effectiveUrl` selection: prefer HLS, fall back to plain MP4.
  const effectiveNextUrl = nextHlsMasterUrl || nextVideoUrl || null;
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

  // ── Web A/B double-buffered playback ───────────────────────────────────
  // Two <video> elements stay mounted at all times so a queue advance can
  // be a 1-frame cut to a slot that already has the upcoming item primed,
  // rather than a teardown-and-reload of the only video element. The
  // active slot is visible / audible; the inactive slot is hidden /
  // muted but holding a decoded first frame of `effectiveNextUrl`.
  const webVideoRefA = useRef<HTMLVideoElement | null>(null);
  const webVideoRefB = useRef<HTMLVideoElement | null>(null);
  const webHlsRefA = useRef<any>(null);
  const webHlsRefB = useRef<any>(null);
  const webLoadedUrlA = useRef<string | null>(null);
  const webLoadedUrlB = useRef<string | null>(null);
  const [webActiveSlot, setWebActiveSlot] = useState<"A" | "B">("A");
  const webActiveSlotRef = useRef<"A" | "B">("A");
  useEffect(() => { webActiveSlotRef.current = webActiveSlot; }, [webActiveSlot]);
  // Compatibility shim: external callers (player context play/pause/seek
  // refs) need a stable handle to "the currently visible video element".
  // We keep this in sync with the active slot below.
  const webVideoRef = useRef<HTMLVideoElement | null>(null);
  // Web-only: watchdog timer that surfaces a stalled-load failure if the
  // <video> element makes no progress within WEB_LOAD_WATCHDOG_MS. Without
  // this, CORS-blocked or stalled requests would hang the loading veil
  // indefinitely. Mirrors the TV HlsVideoPlayer's watchdog behaviour.
  const webLoadWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const WEB_LOAD_WATCHDOG_MS = 15_000;
  const [webNeedsPlayGesture, setWebNeedsPlayGesture] = useState(false);

  const getWebVideo = useCallback((slot: "A" | "B"): HTMLVideoElement | null =>
    slot === "A" ? webVideoRefA.current : webVideoRefB.current, []);
  const getWebHls = useCallback((slot: "A" | "B"): any =>
    slot === "A" ? webHlsRefA.current : webHlsRefB.current, []);
  const setWebHls = useCallback((slot: "A" | "B", h: any) => {
    if (slot === "A") webHlsRefA.current = h; else webHlsRefB.current = h;
  }, []);
  const getWebLoadedUrl = useCallback((slot: "A" | "B"): string | null =>
    slot === "A" ? webLoadedUrlA.current : webLoadedUrlB.current, []);
  const setWebLoadedUrl = useCallback((slot: "A" | "B", u: string | null) => {
    if (slot === "A") webLoadedUrlA.current = u; else webLoadedUrlB.current = u;
  }, []);
  const otherWebSlot = (slot: "A" | "B"): "A" | "B" => slot === "A" ? "B" : "A";

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

  // ── Web A/B watchdog & helpers ───────────────────────────────────────
  const clearWebWatchdog = useCallback(() => {
    if (webLoadWatchdog.current) {
      clearTimeout(webLoadWatchdog.current);
      webLoadWatchdog.current = null;
    }
  }, []);

  // Load `url` into the given slot. `mode === "active"` means this slot is
  // (or will become) the visible/audible one — autoplay + watchdog +
  // seekToStart are applied. `mode === "preload"` silently primes the
  // hidden slot with the next item: muted, paused, holding metadata so the
  // eventual swap is a 1-frame cut, not a buffering pause.
  const loadIntoWebSlot = useCallback((slot: "A" | "B", url: string, mode: "active" | "preload") => {
    if (Platform.OS !== "web") return;
    const video = getWebVideo(slot);
    if (!video) return;

    // If this slot already holds the requested URL, nothing to do — most
    // commonly hit when the swap path runs and the inactive slot already
    // has the upcoming item primed.
    if (getWebLoadedUrl(slot) === url) {
      if (mode === "active") {
        // Re-activating an already-loaded slot: just play.
        try { if (autoPlay) void video.play(); } catch { /* noop */ }
      }
      return;
    }

    // Tear down any prior hls instance bound to this slot before rebinding.
    const prev = getWebHls(slot);
    if (prev) { try { prev.destroy(); } catch { /* noop */ } setWebHls(slot, null); }

    setWebLoadedUrl(slot, url);
    video.muted = mode === "preload";

    const armWatchdog = () => {
      if (mode !== "active") return;
      clearWebWatchdog();
      webLoadWatchdog.current = setTimeout(() => {
        if (video.readyState >= 2) return;
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[LocalVideoPlayer] web load watchdog fired — stalled", url);
        }
        if (isMountedRef.current) { setLoading(false); onError?.(); }
      }, WEB_LOAD_WATCHDOG_MS);
    };

    const safePlay = () => {
      if (mode !== "active" || !autoPlay) return;
      const r = video.play();
      if (r && typeof r.then === "function") {
        r.then(() => {
          if (isMountedRef.current) setWebNeedsPlayGesture(false);
        }).catch((err: any) => {
          if (err && err.name === "NotAllowedError" && isMountedRef.current) {
            setWebNeedsPlayGesture(true);
            setLoading(false);
            clearWebWatchdog();
          } else if (typeof console !== "undefined" && console.warn) {
            console.warn("[LocalVideoPlayer] web video.play() rejected:", err);
          }
        });
      }
    };

    const seekToStart = () => {
      if (mode === "active" && startPositionMs > 0) {
        try { video.currentTime = startPositionMs / 1000; } catch { /* noop */ }
      }
    };

    const isPlainVideo = /\.(mp4|webm|ogg|mov|avi|mkv|m4v)(\?[^#]*)?$/i.test(url);

    if (isPlainVideo) {
      video.src = url;
      try { video.load(); } catch { /* noop */ }
      armWatchdog();
      const onReady = () => {
        seekToStart();
        safePlay();
        video.removeEventListener("loadedmetadata", onReady);
      };
      video.addEventListener("loadedmetadata", onReady, { once: true });
      if (mode === "active") safePlay();
      return;
    }

    // HLS path
    let Hls: any;
    try { Hls = require("hls.js"); } catch { return; }
    const HlsClass = Hls?.default ?? Hls;
    if (!HlsClass) return;

    if (HlsClass.isSupported && HlsClass.isSupported()) {
      const hls = new HlsClass({
        startLevel: -1,
        maxBufferLength: 30,
        xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = false; },
      });
      setWebHls(slot, hls);
      hls.loadSource(url);
      hls.attachMedia(video);
      armWatchdog();
      hls.on("hlsManifestParsed", () => {
        seekToStart();
        safePlay();
      });
      hls.on("hlsError", (_e: any, data: any) => {
        if (data?.fatal && webActiveSlotRef.current === slot) {
          clearWebWatchdog();
          if (typeof console !== "undefined" && console.warn) {
            console.warn("[LocalVideoPlayer] fatal hls error on slot", slot, ":", data.type, data.details);
          }
          if (isMountedRef.current) { setLoading(false); onError?.(); }
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      armWatchdog();
      const onReady = () => {
        seekToStart();
        safePlay();
        video.removeEventListener("loadedmetadata", onReady);
      };
      video.addEventListener("loadedmetadata", onReady, { once: true });
      if (mode === "active") safePlay();
    } else {
      video.src = url;
      armWatchdog();
      const onReady = () => {
        seekToStart();
        safePlay();
        video.removeEventListener("loadedmetadata", onReady);
      };
      video.addEventListener("loadedmetadata", onReady, { once: true });
      if (mode === "active") safePlay();
    }
  }, [autoPlay, startPositionMs, onError, getWebVideo, getWebHls, setWebHls, getWebLoadedUrl, setWebLoadedUrl, clearWebWatchdog]);

  // Pause and silence the slot we are leaving so it stops competing for
  // the audio device and the decoder.
  const quiesceWebSlot = useCallback((slot: "A" | "B") => {
    const v = getWebVideo(slot);
    if (!v) return;
    try { v.pause(); } catch { /* noop */ }
    v.muted = true;
  }, [getWebVideo]);

  // Promote the other slot to active: unmute, ensure context refs point
  // at it, and play. Assumes the slot has already been loaded via
  // loadIntoWebSlot(other, _, "preload"). If the other slot's URL doesn't
  // match the requested target, the caller should fall back to a cold
  // load on the active slot instead of swapping.
  const swapWebSlots = useCallback(() => {
    const cur = webActiveSlotRef.current;
    const other = otherWebSlot(cur);
    const otherVideo = getWebVideo(other);
    if (!otherVideo) return false;
    quiesceWebSlot(cur);
    otherVideo.muted = false;
    webActiveSlotRef.current = other;
    setWebActiveSlot(other);
    if (autoPlay) {
      const r = otherVideo.play();
      if (r && typeof r.then === "function") r.catch(() => { /* handled by listener effect */ });
    }
    return true;
  }, [autoPlay, getWebVideo, quiesceWebSlot]);

  // ── Effect: drive the *active* slot to play `effectiveUrl` ────────────
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!effectiveUrl) return;
    const cur = webActiveSlotRef.current;
    const other = otherWebSlot(cur);
    // Fast path: the inactive slot already has the requested URL primed
    // from a previous preload. Swap to it instantly.
    if (getWebLoadedUrl(other) === effectiveUrl && getWebVideo(other)) {
      swapWebSlots();
      return;
    }
    // Cold load on the currently active slot.
    loadIntoWebSlot(cur, effectiveUrl, "active");
  }, [effectiveUrl, loadIntoWebSlot, swapWebSlots, getWebLoadedUrl, getWebVideo]);

  // ── Effect: silently preload `effectiveNextUrl` into the inactive slot
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!effectiveNextUrl) return;
    const inactive = otherWebSlot(webActiveSlotRef.current);
    // Don't trample the active slot if (somehow) the next URL equals the
    // currently playing URL.
    if (getWebLoadedUrl(webActiveSlotRef.current) === effectiveNextUrl) return;
    loadIntoWebSlot(inactive, effectiveNextUrl, "preload");
  }, [effectiveNextUrl, webActiveSlot, loadIntoWebSlot, getWebLoadedUrl]);

  // ── Effect: keep the legacy `webVideoRef` and player-context refs
  // pointed at whichever slot is currently active.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const v = getWebVideo(webActiveSlot);
    webVideoRef.current = v;
    if (v) {
      playerPlayRef.current = () => v.play().catch(() => {});
      playerPauseRef.current = () => { v.pause(); };
      playerSeekRef.current = (t: number) => { try { v.currentTime = t; } catch { /* noop */ } };
    }
  }, [webActiveSlot, getWebVideo, playerPlayRef, playerPauseRef, playerSeekRef]);

  // ── Effect: cleanup hls instances on unmount ─────────────────────────
  useEffect(() => () => {
    clearWebWatchdog();
    if (webHlsRefA.current) { try { webHlsRefA.current.destroy(); } catch {} webHlsRefA.current = null; }
    if (webHlsRefB.current) { try { webHlsRefB.current.destroy(); } catch {} webHlsRefB.current = null; }
  }, [clearWebWatchdog]);

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
            // Round 6: native chrome (scrubber + time + seek hotkeys) is
            // suppressed when this is a broadcast/live surface, so the
            // viewer cannot rewind or fast-forward the station feed.
            useNativeControls={!isBroadcastLive}
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

  // Web HLS player using hls.js — A/B double-buffered.
  // Both <video> elements stay mounted at all times. The "active" slot is
  // visible/audible and drives the player-context callbacks; the inactive
  // slot is hidden, muted, and silently primed with the upcoming queue
  // item via the preload effect above. On `effectiveUrl` change we either
  // (a) swap to the inactive slot if it already has the requested URL —
  // a 1-frame cut, no manifest fetch, no spinner — or (b) cold-load the
  // active slot. In radio mode the active slot is hidden behind the audio
  // card overlay; we keep both elements alive so the audio source survives.
  const renderSlotVideo = (slot: "A" | "B") => {
    const isActive = webActiveSlot === slot;
    return React.createElement("video", {
      key: `slot-${slot}`,
      ref: (el: HTMLVideoElement | null) => {
        if (slot === "A") (webVideoRefA as any).current = el;
        else (webVideoRefB as any).current = el;
        // The active-slot tracking effect above keeps webVideoRef and the
        // player-context refs (play/pause/seek) pointed at the visible
        // element, so we don't wire them inline here.
      },
      controls: isActive && !isRadioMode && !isBroadcastLive,
      playsInline: true,
      preload: "auto",
      // Intentionally NOT setting `crossOrigin` — see prior comment.
      style: {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "contain",
        background: "#000",
        display: "block",
        // Hide the inactive slot. We keep it laid out (not display:none) so
        // its decoder pipeline stays warm and the swap is a real 1-frame
        // cut rather than a re-mount.
        opacity: isActive ? 1 : 0,
        pointerEvents: isActive ? "auto" : "none",
        zIndex: isActive ? 2 : 1,
      },
      // Only the active slot drives external callbacks. The inactive slot
      // firing onEnded/onPlay would cascade into the broadcast handler and
      // tear down the very transition we're trying to make seamless.
      onPlay: isActive ? () => onPlay?.() : undefined,
      onPause: isActive ? () => onPause?.() : undefined,
      onEnded: isActive ? () => onEnd?.() : undefined,
      onError: isActive ? () => onError?.() : undefined,
      onTimeUpdate: isActive
        ? (e: any) => {
            const v = e.target as HTMLVideoElement;
            if (v.duration) updatePlayback(v.currentTime, v.duration);
          }
        : undefined,
    });
  };

  return (
    <View style={[styles.container, !isRadioMode && { height: playerHeight }]}>
      {/* A/B video stack — always mounted, hidden offscreen in radio mode */}
      <View
        style={
          isRadioMode
            ? { position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }
            : { flex: 1, position: "relative" }
        }
      >
        {renderSlotVideo("A")}
        {renderSlotVideo("B")}
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
