/**
 * HlsVideoPlayer — Production HLS player for Temple TV Smart TV
 *
 * Supports:
 *  • hls.js ABR on Chromium/Firefox (Samsung, LG, Fire TV browsers)
 *  • Native HLS on Safari / WKWebView (iOS, macOS, some Smart TV stacks)
 *  • HTML5 fullscreen API  (F key / remote fullscreen button)
 *  • D-pad & media-key remote controls via tvKeys.ts
 *  • Quality-level OSD (shows Auto / 1080p / 720p / …)
 *  • Seek OSD (+15 s / −15 s flash)
 *  • Auto-hide controls after 5 s
 *  • Buffering spinner + cinematic loading veil
 *  • Error recovery with 3-attempt exponential back-off
 *  • A/B double-buffered playback for seamless queue transitions
 *
 * A/B double-buffering
 * ────────────────────
 * Two <video> elements + two hls.js instances are mounted at all times.
 * One is the "active" slot (visible, audible, currently playing); the
 * other is the "inactive" slot (hidden, muted, paused on first frame of
 * the upcoming queue item). When `nextHlsUrl` changes, the inactive slot
 * silently preloads it. When `hlsUrl` then advances to that URL, we swap
 * which slot is active rather than tearing down and reloading — no
 * spinner, no black frame, no "Loading stream…" veil, no manifest fetch
 * delay. Cold loads (first start, or a queue advance whose URL was never
 * preloaded) still go through the normal init path with the veil.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";
import { keyEventToAction } from "../lib/tvKeys";
import { isTizen } from "../lib/platform";
import { registerStreamReconnect } from "../lib/lifecycle";
import { BroadcastChannelBug } from "./BroadcastChannelBug";

// ── Samsung AVPlay ambient declarations ───────────────────────────────────
declare global {
  interface Window {
    webapis?: {
      avplay?: {
        open: (url: string) => void;
        close: () => void;
        prepare: () => void;
        play: () => void;
        pause: () => void;
        stop: () => void;
        seekTo: (ms: number) => void;
        getCurrentTime: () => number;
        getDuration: () => number;
        setDisplayRect: (x: number, y: number, w: number, h: number) => void;
        setListener: (listener: {
          onbufferingstart?: () => void;
          onbufferingcomplete?: () => void;
          oncurrentplaytime?: (ms: number) => void;
          onevent?: (type: string, data: unknown) => void;
          onerror?: (msg: string) => void;
        }) => void;
      };
    };
  }
}

interface HlsVideoPlayerProps {
  hlsUrl: string;
  title: string;
  onBack: () => void;
  /** Resume playback at this position (seconds). Defaults to 0. */
  startPositionSecs?: number;
  /**
   * URL of the *next* item the player should expect after `hlsUrl`. When
   * set, the inactive A/B slot quietly preloads this URL so a subsequent
   * change of `hlsUrl` to this same value is a 1-frame cut, not a fresh
   * load. Safe to leave undefined for ordinary VOD playback.
   */
  nextHlsUrl?: string | null;
  /**
   * When true, this is a LIVE broadcast surface (server-driven 24/7 stream).
   * In live mode the player enforces TV-station behavior:
   *   • No bottom control bar (no progress scrubber, no time display, no
   *     SPACE/play/pause hint strip)
   *   • Playpause / play / pause / stop / fastforward / rewind keys are
   *     ignored — the user CANNOT pause or seek the live broadcast
   *   • BACK / EXIT still navigate away (lets the user leave the stream)
   *   • Fullscreen toggle is preserved (it's a viewport control, not a
   *     playback control)
   * VOD (isLive=false / undefined) keeps the full control surface so users
   * can pause, seek, and scrub on-demand sermons.
   */
  isLive?: boolean;
}

type Slot = "A" | "B";

const SEEK_STEP = 15;
const CONTROLS_HIDE_DELAY = 5_000;

// Quality display helper
function levelLabel(height: number | undefined): string {
  if (!height) return "Auto";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  if (height >= 480) return "480p";
  if (height >= 360) return "360p";
  return "240p";
}

function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function isPlainVideoUrl(url: string): boolean {
  return /\.(mp4|webm|ogg|mov|avi|mkv|m4v)(\?[^#]*)?$/i.test(url);
}

export function HlsVideoPlayer({
  hlsUrl,
  title,
  onBack,
  startPositionSecs = 0,
  nextHlsUrl = null,
  isLive = false,
}: HlsVideoPlayerProps) {
  // ── A/B slot DOM refs ────────────────────────────────────────────────────
  // Both <video> elements stay mounted. One is active (visible, audible);
  // the other preloads `nextHlsUrl` on the inactive slot.
  const videoRefA = useRef<HTMLVideoElement | null>(null);
  const videoRefB = useRef<HTMLVideoElement | null>(null);
  // Per-slot hls.js engine (or null when slot is empty / using native /
  // plain MP4). Kept independent so each slot can own and tear down its
  // own engine without affecting the other.
  const hlsARef = useRef<Hls | null>(null);
  const hlsBRef = useRef<Hls | null>(null);
  // Per-slot loaded URL — null = empty. The hlsUrl-change effect uses
  // these to decide between an instant swap and a fresh load.
  const loadedUrlA = useRef<string | null>(null);
  const loadedUrlB = useRef<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  // Samsung AVPlay (single-engine fallback path; no double-buffering)
  const avplayActiveRef = useRef(false);
  const avplayPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [activeSlot, setActiveSlot] = useState<Slot>("A");
  // Mirror in a ref so synchronous code paths (init, swap, watchdog) don't
  // race the React render cycle.
  const activeSlotRef = useRef<Slot>("A");
  useEffect(() => { activeSlotRef.current = activeSlot; }, [activeSlot]);

  // Convenience accessors. NEVER cache the result — refs change as React
  // mounts / remounts elements and slot-swap reassigns instances.
  const getVideo = (slot: Slot): HTMLVideoElement | null =>
    slot === "A" ? videoRefA.current : videoRefB.current;
  const getHls = (slot: Slot): Hls | null =>
    slot === "A" ? hlsARef.current : hlsBRef.current;
  const setHls = (slot: Slot, h: Hls | null) => {
    if (slot === "A") hlsARef.current = h; else hlsBRef.current = h;
  };
  const setLoadedUrl = (slot: Slot, u: string | null) => {
    if (slot === "A") loadedUrlA.current = u; else loadedUrlB.current = u;
  };
  const getLoadedUrl = (slot: Slot): string | null =>
    slot === "A" ? loadedUrlA.current : loadedUrlB.current;
  const otherSlot = (slot: Slot): Slot => (slot === "A" ? "B" : "A");

  const [showControls, setShowControls] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  // True once the active slot has produced any frame at any point in this
  // mount's lifetime. Once true, the cinematic loading veil never shows
  // again — queue advances must feel like a TV channel cut, not a reload.
  const [hasEverShown, setHasEverShown] = useState(false);
  const hasEverShownRef = useRef(false);
  const markEverShown = useCallback(() => {
    if (hasEverShownRef.current) return;
    hasEverShownRef.current = true;
    setHasEverShown(true);
  }, []);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekOsd, setSeekOsd] = useState<string | null>(null);
  const [qualityLabel, setQualityLabel] = useState("Auto");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retries, setRetries] = useState(0);
  // Mirror `retries` in a ref so HLS event-handler closures (created once
  // per init call) always see the live counter — without this they capture
  // the value at the time the handler was registered, which makes the
  // `retries < 3` gate read 0 forever and effectively gives unbounded
  // recoveries per stream.
  const retriesRef = useRef(0);
  useEffect(() => { retriesRef.current = retries; }, [retries]);
  // Autoplay-blocked overlay: shown when video.play() is rejected by the
  // browser's autoplay policy (typically after navigation transitions even
  // when there was a recent user gesture). Distinct from `error` because the
  // video is loaded and ready — the user just needs to confirm playback.
  const [needsPlayGesture, setNeedsPlayGesture] = useState(false);

  // ── Network-aware "Reconnecting…" state ─────────────────────────────────
  // True when the device has gone offline (or when an HLS NETWORK_ERROR
  // fires while the device is offline) and we're waiting to retry. While
  // this is true we suppress the hard error UI, keep the last visible
  // frame on screen, surface a discreet "Reconnecting…" overlay, and
  // automatically retry as soon as `online` fires. Critically, NETWORK
  // errors raised while offline do NOT consume the per-URL retry budget,
  // so a long disconnect doesn't burn through retries and skip the item.
  const [isOfflineWaiting, setIsOfflineWaiting] = useState(false);
  const isOfflineWaitingRef = useRef(false);
  useEffect(() => { isOfflineWaitingRef.current = isOfflineWaiting; }, [isOfflineWaiting]);
  const offlineRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearOfflineRetryTimer = useCallback(() => {
    if (offlineRetryTimer.current) {
      clearTimeout(offlineRetryTimer.current);
      offlineRetryTimer.current = null;
    }
  }, []);

  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekOsdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Watchdog: fires if the player makes no observable progress (no
  // loadeddata, no playing) within LOAD_WATCHDOG_MS of an init/reset.
  // Without this, CORS rejections, malformed manifests, or stuck connections
  // would leave the user staring at an infinite loading veil.
  const loadWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LOAD_WATCHDOG_MS = 15_000;

  // ── Controls auto-hide ────────────────────────────────────────────────────
  const resetHideTimer = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setShowControls(true);
    hideTimer.current = setTimeout(() => setShowControls(false), CONTROLS_HIDE_DELAY);
  }, []);

  // ── Seek OSD flash ────────────────────────────────────────────────────────
  const showSeekOsd = useCallback((label: string) => {
    setSeekOsd(label);
    if (seekOsdTimer.current) clearTimeout(seekOsdTimer.current);
    seekOsdTimer.current = setTimeout(() => setSeekOsd(null), 1_200);
  }, []);

  // ── Fullscreen helpers ────────────────────────────────────────────────────
  const enterFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (el.requestFullscreen) el.requestFullscreen();
    else if ((el as any).webkitRequestFullscreen) (el as any).webkitRequestFullscreen();
    else if ((el as any).mozRequestFullScreen) (el as any).mozRequestFullScreen();
    else if ((el as any).msRequestFullscreen) (el as any).msRequestFullscreen();
  }, []);

  const exitFullscreen = useCallback(() => {
    if (document.exitFullscreen) document.exitFullscreen();
    else if ((document as any).webkitExitFullscreen) (document as any).webkitExitFullscreen();
  }, []);

  const toggleFullscreen = useCallback(() => {
    isFullscreen ? exitFullscreen() : enterFullscreen();
  }, [isFullscreen, enterFullscreen, exitFullscreen]);

  // Track browser fullscreen-change
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    document.addEventListener("webkitfullscreenchange", handler);
    return () => {
      document.removeEventListener("fullscreenchange", handler);
      document.removeEventListener("webkitfullscreenchange", handler);
    };
  }, []);

  // ── Network status listener ────────────────────────────────────────────
  // When the device flips offline, surface the "Reconnecting…" overlay
  // immediately (don't wait for hls.js to surface the next NETWORK_ERROR).
  // When it flips online, reset the per-URL retry budget, dismiss the
  // overlay, and immediately ask the active hls.js engine to resume
  // loading. The engine remembers where it was, so this typically picks
  // up on the segment that was missing — no item skip, no manual retry.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOnline = () => {
      if (!isOfflineWaitingRef.current) return;
      clearOfflineRetryTimer();
      setRetries(0);
      retriesRef.current = 0;
      setIsOfflineWaiting(false);
      const hls = getHls(activeSlotRef.current);
      try { hls?.startLoad(); } catch { /* noop */ }
      // Also kick the inactive slot (preload) — its engine may have died
      // mid-fetch during the disconnect.
      const inactive = activeSlotRef.current === "A" ? "B" : "A";
      const inactiveHls = getHls(inactive);
      try { inactiveHls?.startLoad(); } catch { /* noop */ }
      armLoadWatchdog();
    };
    const handleOffline = () => {
      // Don't claim "Reconnecting…" while we have nothing playing yet —
      // the cinematic veil is the right surface for cold start.
      if (!hasEverShownRef.current) return;
      setIsOfflineWaiting(true);
      setIsBuffering(false);
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      clearOfflineRetryTimer();
    };
    // armLoadWatchdog and getHls are stable refs/callbacks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Attempt playback and surface autoplay-blocked errors ──────────────────
  // Browser autoplay policies can reject `play()` even after a user gesture
  // (e.g., when the navigation transition consumes the gesture). Catching the
  // rejection lets us show a "Tap to play" overlay instead of failing silently.
  const attemptPlay = useCallback((video: HTMLVideoElement) => {
    const result = video.play();
    if (result && typeof result.then === "function") {
      result
        .then(() => setNeedsPlayGesture(false))
        .catch((err) => {
          // NotAllowedError = autoplay policy rejection (recoverable via gesture).
          // Other errors (AbortError, etc.) are usually transient — log only.
          if (err && err.name === "NotAllowedError") {
            setNeedsPlayGesture(true);
          } else if (typeof console !== "undefined" && console.warn) {
            console.warn("[HlsVideoPlayer] video.play() rejected:", err);
          }
        });
    }
  }, []);

  // ── Load watchdog ─────────────────────────────────────────────────────────
  // If the player makes no progress within LOAD_WATCHDOG_MS, surface an
  // actionable error rather than spinning forever. Cleared by canplay/playing.
  const armLoadWatchdog = useCallback(() => {
    if (loadWatchdog.current) clearTimeout(loadWatchdog.current);
    loadWatchdog.current = setTimeout(() => {
      const v = getVideo(activeSlotRef.current);
      if (v && v.readyState >= 2) return; // already playable, suppress
      // Network-aware: if the device is offline (or already in our
      // offline-waiting state) the right behavior is to keep the last
      // visible frame and show "Reconnecting…", not a hard error. The
      // online-event listener below will rearm playback automatically.
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      if (offline || isOfflineWaitingRef.current) {
        setIsOfflineWaiting(true);
        setIsBuffering(false);
        return;
      }
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[HlsVideoPlayer] Load watchdog fired — no progress within", LOAD_WATCHDOG_MS, "ms");
      }
      setError(
        "We couldn't start the stream. Please check your connection and try again."
      );
      setIsBuffering(false);
    }, LOAD_WATCHDOG_MS);
  }, []);

  const clearLoadWatchdog = useCallback(() => {
    if (loadWatchdog.current) {
      clearTimeout(loadWatchdog.current);
      loadWatchdog.current = null;
    }
  }, []);

  // ── Slot loader ──────────────────────────────────────────────────────────
  // Loads `url` into the given slot's <video> element. Set `mode` to
  //   • "active" — autoplay, unmuted, seek to startPositionSecs, watchdog
  //     armed and `isBuffering` flag controlled. Used for cold start and
  //     fallback when preload missed.
  //   • "preload" — autoplay then immediately pause at frame 0, kept
  //     muted. No state mutation, no watchdog. Used to warm the inactive
  //     slot for the next queue item.
  const loadIntoSlot = useCallback((slot: Slot, url: string, mode: "active" | "preload") => {
    const video = getVideo(slot);
    if (!video) return;

    // Tear down any previous engine in this slot before reusing it.
    const prevHls = getHls(slot);
    if (prevHls) {
      try { prevHls.destroy(); } catch { /* noop */ }
      setHls(slot, null);
    }
    setLoadedUrl(slot, url);

    if (mode === "active") {
      setError(null);
      setNeedsPlayGesture(false);
      // Don't reset `hasEverShown` — the loading veil only shows on
      // absolute first start. Subsequent fresh loads keep the previous
      // frame on screen until the new one decodes (the inactive-slot
      // approach guarantees no black frame for preload-hit transitions).
      armLoadWatchdog();
    }

    const armNativeOrPlain = () => {
      video.src = url;
      video.muted = mode === "preload";
      const onLoaded = () => {
        if (mode === "active") {
          if (startPositionSecs > 0) {
            try { video.currentTime = startPositionSecs; } catch { /* noop */ }
          }
          clearLoadWatchdog();
          attemptPlay(video);
        } else {
          // Preload: seek to 0, decode one frame, then pause.
          try { video.currentTime = 0; } catch { /* noop */ }
          // Calling play() then pause() in sequence forces decoders on
          // most browsers/Smart TVs to actually buffer the first GOP,
          // so a subsequent unmute + play resumes instantly.
          const r = video.play();
          if (r && typeof r.then === "function") {
            r.then(() => video.pause()).catch(() => { /* preload race — ignore */ });
          }
        }
        video.removeEventListener("loadeddata", onLoaded);
      };
      video.addEventListener("loadeddata", onLoaded);
      if (mode === "active") {
        // Optimistically attempt play immediately too — if the file is
        // cached or loadeddata is delayed, this gets us to playback faster.
        attemptPlay(video);
      } else {
        // Trigger the load() so loadeddata fires.
        try { video.load(); } catch { /* noop */ }
      }
    };

    // ── Plain video detection (MP4, WebM, MOV, etc.) ─────────────────────
    if (isPlainVideoUrl(url)) {
      armNativeOrPlain();
      return;
    }

    if (Hls.isSupported()) {
      // ── hls.js path (Chromium, Firefox, Samsung/LG/Fire TV browsers) ─
      // Per-mode buffer budget. The preload slot only needs enough segments
      // to decode the first GOP and survive a few seconds of post-swap
      // playback before its promotion path (`swapToInactive`) tops the
      // budget back up to the active 60 s. Holding 60+ s of segments per
      // slot at all times bloats RSS to ~75 MB on a 24/7 broadcast and
      // pressures GC; capping preload to ~12 s halves that without
      // affecting steady-state playback. Once promoted, `swapToInactive`
      // mutates `hls.config.maxBufferLength/maxMaxBufferLength` so the
      // engine can refill to the full active budget transparently.
      const isPreload = mode === "preload";
      const hls = new Hls({
        startLevel: -1,
        autoStartLoad: true,
        lowLatencyMode: false,
        // Only seek into the future for the active slot. Preload starts at 0
        // and is repositioned on swap by the active-load logic.
        startPosition: mode === "active" && startPositionSecs > 0 ? startPositionSecs : -1,
        maxBufferLength: isPreload ? 24 : 60,
        maxMaxBufferLength: isPreload ? 24 : 120,
        maxBufferSize: isPreload ? 20 * 1_000 * 1_000 : 60 * 1_000 * 1_000,
        abrEwmaFastLive: 3,
        abrEwmaSlowLive: 9,
        manifestLoadingMaxRetry: 3,
        manifestLoadingRetryDelay: 1_000,
        levelLoadingMaxRetry: 3,
        levelLoadingRetryDelay: 500,
        fragLoadingMaxRetry: 3,
        fragLoadingRetryDelay: 500,
        xhrSetup: (xhr) => { xhr.withCredentials = false; },
      });
      setHls(slot, hls);
      video.muted = mode === "preload";

      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        if (mode === "active") {
          attemptPlay(video);
          setQualityLabel(`Auto (${data.levels.length} levels)`);
        } else {
          // Preload: prime the decoder by decoding the first GOP, then
          // pause silently. When the swap happens, the slot is already
          // warm and a play() resumes from frame 0 instantly.
          const r = video.play();
          if (r && typeof r.then === "function") {
            r.then(() => video.pause()).catch(() => { /* preload race */ });
          }
        }
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        // Only update the OSD for the *active* slot's quality changes;
        // background preload level switches would otherwise jitter the badge.
        if (slot !== activeSlotRef.current) return;
        const level = hls.levels[data.level];
        setQualityLabel(level ? levelLabel(level.height) : "Auto");
      });

      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[HlsVideoPlayer] hls.js error:", {
            slot,
            mode,
            type: data.type,
            details: data.details,
            fatal: data.fatal,
          });
        }
        if (!data.fatal) return;
        // Preload errors must NEVER surface to the user — they just leave
        // the slot empty, and the next swap will fall back to a cold load.
        if (mode === "preload") {
          try { hls.destroy(); } catch { /* noop */ }
          setHls(slot, null);
          setLoadedUrl(slot, null);
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          // Network-aware: when the device itself is offline, do NOT
          // consume the per-URL retry budget — a long disconnect would
          // otherwise burn through 3 retries in seconds and skip the
          // item. Hold the slot, surface the "Reconnecting…" overlay,
          // and schedule a backoff retry. The window-level `online`
          // listener below short-circuits the wait the moment the
          // device reconnects.
          const offline = typeof navigator !== "undefined" && navigator.onLine === false;
          if (offline || isOfflineWaitingRef.current) {
            setIsOfflineWaiting(true);
            setIsBuffering(false);
            clearLoadWatchdog();
            clearOfflineRetryTimer();
            offlineRetryTimer.current = setTimeout(() => {
              try { hls.startLoad(); } catch { /* noop */ }
              armLoadWatchdog();
            }, 4_000);
            return;
          }
          if (retriesRef.current < 3) {
            hls.startLoad();
            setRetries((r) => r + 1);
            armLoadWatchdog();
          } else {
            // Online but still failing: one last grace check — if the
            // browser flips offline between fatal and the budget read,
            // treat it as offline rather than skipping the item.
            const flippedOffline = typeof navigator !== "undefined" && navigator.onLine === false;
            if (flippedOffline) {
              setIsOfflineWaiting(true);
              setIsBuffering(false);
              clearLoadWatchdog();
              return;
            }
            clearLoadWatchdog();
            setError("Stream unavailable. Please check your connection and try again.");
            setIsBuffering(false);
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && retriesRef.current < 3) {
          hls.recoverMediaError();
          setRetries((r) => r + 1);
          armLoadWatchdog();
        } else {
          clearLoadWatchdog();
          setError("Stream unavailable. Please check your connection and try again.");
          setIsBuffering(false);
        }
      });

      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS path (Safari, iOS, some Samsung firmware)
      armNativeOrPlain();
    } else if (mode === "active" && isTizen && window.webapis?.avplay) {
      // ── Samsung AVPlay path (older Tizen without MSE / hls.js support)
      // AVPlay is single-engine, so this path skips A/B buffering. Queue
      // transitions on AVPlay devices fall back to the legacy reload
      // behavior — acceptable because AVPlay devices are a small minority.
      const avplay = window.webapis.avplay;
      try {
        avplay.open(url);
        const W = window.screen?.width ?? 1920;
        const H = window.screen?.height ?? 1080;
        avplay.setDisplayRect(0, 0, W, H);
        avplay.setListener({
          onbufferingstart: () => setIsBuffering(true),
          onbufferingcomplete: () => {
            setIsBuffering(false);
            markEverShown();
            clearLoadWatchdog();
          },
          oncurrentplaytime: (ms) => {
            setCurrentTime(ms / 1_000);
            markEverShown();
            clearLoadWatchdog();
          },
          onerror: (msg) => {
            setError(`Playback error: ${msg}`);
            setIsBuffering(false);
            clearLoadWatchdog();
          },
        });
        if (startPositionSecs > 0) avplay.seekTo(Math.floor(startPositionSecs * 1_000));
        avplay.prepare();
        avplay.play();
        avplayActiveRef.current = true;
        setIsPlaying(true);
        if (avplayPollRef.current) clearInterval(avplayPollRef.current);
        avplayPollRef.current = setInterval(() => {
          try {
            const dur = avplay.getDuration?.() ?? 0;
            if (dur > 0) setDuration(dur / 1_000);
          } catch { /* noop */ }
        }, 2_000);
        if (video) video.style.display = "none";
      } catch {
        try { avplay.close(); } catch { /* noop */ }
        avplayActiveRef.current = false;
        clearLoadWatchdog();
        setError("Playback failed. Please try again.");
      }
    } else if (mode === "active") {
      clearLoadWatchdog();
      setError("HLS streaming is not supported by this browser. Please update your browser or TV firmware.");
    }
  }, [startPositionSecs, armLoadWatchdog, attemptPlay, clearLoadWatchdog, markEverShown]);

  // ── Slot swap ────────────────────────────────────────────────────────────
  // Promotes the inactive slot to active. Used when `hlsUrl` advances to a
  // URL that the inactive slot has already preloaded — no engine teardown,
  // no network fetch, no veil. Old active slot becomes inactive and is
  // immediately freed so it can be reused for the next preload.
  const swapToInactive = useCallback(() => {
    const oldSlot = activeSlotRef.current;
    const newSlot = otherSlot(oldSlot);
    const newVideo = getVideo(newSlot);
    if (!newVideo) return;

    // Promote the slot's hls.js buffer budget from preload (12 s / 20 MB)
    // to active (60 s / 60 MB). Without this, the slot would keep its
    // capped preload budget after promotion and start back-pressuring the
    // network buffer ~10 s into playback, causing visible re-buffering on
    // long items. Mutating `hls.config` is supported by hls.js and takes
    // effect on the next buffer fill cycle.
    const newHls = getHls(newSlot);
    if (newHls) {
      try {
        newHls.config.maxBufferLength = 60;
        newHls.config.maxMaxBufferLength = 120;
        newHls.config.maxBufferSize = 60 * 1_000 * 1_000;
      } catch { /* noop — older hls.js versions may surface a frozen config */ }
    }

    // Resume playback on the newly-active slot.
    newVideo.muted = false;
    if (startPositionSecs > 0) {
      try { newVideo.currentTime = startPositionSecs; } catch { /* noop */ }
    } else {
      // Preloaded slot was paused at frame 0 — make sure we restart from
      // the top rather than wherever a stray play() ticked it to.
      try { newVideo.currentTime = 0; } catch { /* noop */ }
    }
    attemptPlay(newVideo);

    // Tear down the OUTGOING slot's engine. Its <video> element stays
    // mounted (just hidden, ready to host the next preload).
    const oldVideo = getVideo(oldSlot);
    if (oldVideo) {
      try { oldVideo.pause(); } catch { /* noop */ }
      oldVideo.muted = true;
    }
    const oldHls = getHls(oldSlot);
    if (oldHls) {
      try { oldHls.destroy(); } catch { /* noop */ }
      setHls(oldSlot, null);
    }
    if (oldVideo) {
      try { oldVideo.removeAttribute("src"); oldVideo.load(); } catch { /* noop */ }
    }
    setLoadedUrl(oldSlot, null);

    // Flip activeSlot. This re-runs the listener-attachment effect (deps
    // include activeSlot) which re-binds video event handlers to the new
    // active element so currentTime/duration/etc reflect the right source.
    activeSlotRef.current = newSlot;
    setActiveSlot(newSlot);
    // Always reset retry budget — the new stream is a fresh attempt.
    retriesRef.current = 0;
    setRetries(0);
    // Visible state housekeeping for the new active slot.
    setError(null);
    setNeedsPlayGesture(false);
    setIsPlaying(true);
    setIsBuffering(false);
    markEverShown();
    clearLoadWatchdog();
    // Reset the per-stream metadata; the new active video's events will
    // refill these immediately via the listener effect.
    setCurrentTime(0);
    setDuration(Number.isFinite(newVideo.duration) ? newVideo.duration : 0);
  }, [attemptPlay, clearLoadWatchdog, markEverShown, startPositionSecs]);

  // Reset the retry counter whenever the source URL changes so each fresh
  // stream gets the full 3-retry budget.
  useEffect(() => {
    retriesRef.current = 0;
    setRetries(0);
  }, [hlsUrl]);

  // Tracks a URL staged on the inactive slot during a cold-path channel
  // change. The pending-promotion effect below watches it and swaps when
  // the staged slot reports it can play, so the visible slot keeps its
  // last frame on screen during the manifest fetch instead of going black.
  const pendingPromotionUrlRef = useRef<string | null>(null);

  // ── Active-URL effect: cold load OR swap-to-preloaded ────────────────────
  useEffect(() => {
    if (!hlsUrl) return;
    // Already playing this URL on the active slot — nothing to do.
    if (getLoadedUrl(activeSlotRef.current) === hlsUrl) return;
    // Inactive slot has it preloaded AND the slot's <video> has actually
    // decoded its first frame — instant swap. Without the readyState
    // check, an early swap (e.g. the proactive wall-clock advance fires
    // ~200 ms before the active video ends, but the inactive preload
    // hasn't finished its first GOP yet because the CDN is slow) would
    // promote a black frame to the active slot. The pending-promotion
    // staging below handles "almost-warm" by waiting for `canplay` on
    // the same slot — no engine teardown, no black frame, no veil.
    const inactive = otherSlot(activeSlotRef.current);
    if (getLoadedUrl(inactive) === hlsUrl) {
      const inactiveVideo = getVideo(inactive);
      if (inactiveVideo && inactiveVideo.readyState >= 2) {
        pendingPromotionUrlRef.current = null;
        swapToInactive();
        return;
      }
      // Slot is staged but not warm — fall through to the pending-
      // promotion path which waits for `canplay` and then swaps. We
      // don't tear down the in-flight load.
      pendingPromotionUrlRef.current = hlsUrl;
      return;
    }
    // Cold path. To avoid blacking out the visible slot while a fresh
    // manifest loads, route the load through the INACTIVE slot first
    // (preload mode), then promote it once the new URL has actually
    // matched into the inactive slot's loadedUrl. The active slot keeps
    // showing its current frame until the swap occurs.
    //
    // First-ever start (no previous frame) is handled by the cinematic
    // veil — `hasEverShown` is still false, so the active-slot direct
    // load below shows the veil while the very first frame decodes.
    if (!hasEverShownRef.current || avplayActiveRef.current) {
      pendingPromotionUrlRef.current = null;
      loadIntoSlot(activeSlotRef.current, hlsUrl, "active");
      return;
    }
    // Stage the new URL on the inactive slot. The preload effect that
    // watches `nextHlsUrl` would normally do this, but a cold-path
    // change means `nextHlsUrl` either didn't match or wasn't set, so
    // we drive the staging directly. The pending-promotion effect below
    // watches for it to become ready and performs the swap.
    pendingPromotionUrlRef.current = hlsUrl;
    if (getLoadedUrl(inactive) !== hlsUrl) {
      loadIntoSlot(inactive, hlsUrl, "preload");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlsUrl]);

  // ── Pending-promotion watcher ────────────────────────────────────────────
  // When a cold-path URL is staged on the inactive slot, this effect
  // promotes it as soon as the slot's <video> reports it can play. The
  // active slot keeps displaying the previous frame until the swap so the
  // viewer never sees a black gap or spinner during channel changes.
  useEffect(() => {
    const target = pendingPromotionUrlRef.current;
    if (!target) return;
    const inactive = otherSlot(activeSlotRef.current);
    const v = getVideo(inactive);
    if (!v) return;
    // If the inactive slot already has the URL ready, swap immediately.
    if (getLoadedUrl(inactive) === target && v.readyState >= 2) {
      pendingPromotionUrlRef.current = null;
      swapToInactive();
      return;
    }
    let done = false;
    const tryPromote = () => {
      if (done) return;
      if (getLoadedUrl(inactive) !== target) return;
      if (v.readyState < 2) return;
      done = true;
      pendingPromotionUrlRef.current = null;
      swapToInactive();
    };
    v.addEventListener("loadeddata", tryPromote);
    v.addEventListener("canplay", tryPromote);
    v.addEventListener("playing", tryPromote);
    // Safety: if the inactive slot can't get ready within a short window,
    // fall back to a hard cold-load on the active slot so the viewer at
    // least sees the new stream (with the veil if needed). We keep this
    // tighter than `LOAD_WATCHDOG_MS` (which is the cold-start budget for
    // the active slot itself): the active slot is still showing the OLD
    // program here, so every additional second is a stale-frame freeze
    // for the viewer. 5 s is long enough for a slow CDN handshake but
    // short enough that a misconfigured next URL recovers quickly.
    const PROMOTION_FALLBACK_MS = 5_000;
    const fallback = setTimeout(() => {
      if (done) return;
      if (pendingPromotionUrlRef.current !== target) return;
      done = true;
      pendingPromotionUrlRef.current = null;
      loadIntoSlot(activeSlotRef.current, target, "active");
    }, PROMOTION_FALLBACK_MS);
    return () => {
      v.removeEventListener("loadeddata", tryPromote);
      v.removeEventListener("canplay", tryPromote);
      v.removeEventListener("playing", tryPromote);
      clearTimeout(fallback);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlsUrl, activeSlot]);

  // ── Inactive-URL effect: silently preload the next queue item ────────────
  useEffect(() => {
    if (!nextHlsUrl) return;
    if (avplayActiveRef.current) return; // AVPlay path doesn't double-buffer
    const inactive = otherSlot(activeSlotRef.current);
    // Already preloaded on the inactive slot — nothing to do.
    if (getLoadedUrl(inactive) === nextHlsUrl) return;
    // Don't preload what's already playing on the active slot.
    if (getLoadedUrl(activeSlotRef.current) === nextHlsUrl) return;
    loadIntoSlot(inactive, nextHlsUrl, "preload");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextHlsUrl, activeSlot]);

  // ── Lifecycle reconnect on TV resume (suspend → resume) ──────────────────
  useEffect(() => {
    const offReconnect = registerStreamReconnect(() => {
      if (avplayActiveRef.current) {
        try { window.webapis?.avplay?.play(); setIsPlaying(true); } catch { /* noop */ }
      } else {
        // Reload the active slot from scratch.
        if (hlsUrl) loadIntoSlot(activeSlotRef.current, hlsUrl, "active");
      }
    });
    return () => {
      offReconnect();
      // Full teardown on unmount.
      if (avplayActiveRef.current) {
        try { window.webapis?.avplay?.stop(); } catch { /* noop */ }
        try { window.webapis?.avplay?.close(); } catch { /* noop */ }
        avplayActiveRef.current = false;
      }
      if (avplayPollRef.current) { clearInterval(avplayPollRef.current); avplayPollRef.current = null; }
      try { hlsARef.current?.destroy(); } catch { /* noop */ }
      try { hlsBRef.current?.destroy(); } catch { /* noop */ }
      hlsARef.current = null;
      hlsBRef.current = null;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (seekOsdTimer.current) clearTimeout(seekOsdTimer.current);
      if (loadWatchdog.current) {
        clearTimeout(loadWatchdog.current);
        loadWatchdog.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Active video element listeners ───────────────────────────────────────
  // Re-binds whenever the active slot changes so currentTime/duration/etc.
  // always reflect the slot the user is actually watching.
  useEffect(() => {
    const video = getVideo(activeSlot);
    if (!video) return;

    const onPlay = () => {
      setIsPlaying(true);
      setNeedsPlayGesture(false);
    };
    const onPause = () => setIsPlaying(false);
    const onWaiting = () => {
      // Only show the mid-playback buffering spinner if the slot has
      // already decoded at least one frame — otherwise the cinematic veil
      // is the right visual.
      if (hasEverShownRef.current) setIsBuffering(true);
    };
    const onPlaying = () => {
      setIsBuffering(false);
      markEverShown();
      setNeedsPlayGesture(false);
      clearLoadWatchdog();
    };
    const onCanPlay = () => {
      markEverShown();
      clearLoadWatchdog();
    };
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      // ── Pre-emptive seamless cut-over ───────────────────────────────────
      // The native `ended` event has ~100–300 ms of HLS end-of-stream
      // dead-air baked in (hls.js drains its internal buffers, the media
      // element decodes the last sample, fires `ended`, and only then can
      // we promote the inactive slot). When the inactive slot is already
      // primed with the *next* queue item, we can promote it ~350 ms BEFORE
      // the active stream's natural end and the viewer sees a true 1-frame
      // cut between programs — exactly how broadcast TV feels.
      if (avplayActiveRef.current) return; // single-engine path, no A/B
      const dur = video.duration;
      if (!Number.isFinite(dur) || dur <= 0) return;
      const remaining = dur - video.currentTime;
      if (remaining > 0.4) return;
      const inactive = otherSlot(activeSlotRef.current);
      const inactiveUrl = getLoadedUrl(inactive);
      const inactiveVideo = getVideo(inactive);
      if (!inactiveUrl || !inactiveVideo) return;
      // Don't pre-empt to the URL we're currently playing — it would just
      // restart this video. Wait for the SSE-driven hlsUrl change.
      if (inactiveUrl === getLoadedUrl(activeSlotRef.current)) return;
      // Inactive must be at least loadable; if it's still warming we let
      // `ended` (with its dead-air) be the safety net rather than promote
      // a slot that would immediately show a buffering spinner.
      if (inactiveVideo.readyState < 2) return;
      pendingPromotionUrlRef.current = null;
      swapToInactive();
    };
    const onDurationChange = () => {
      if (Number.isFinite(video.duration)) setDuration(video.duration);
    };
    const onError = () => {
      const code = video.error?.code;
      const msgMap: Record<number, string> = {
        1: "Playback was interrupted.",
        2: "Network error while loading the stream.",
        3: "The video could not be decoded by this device.",
        4: "This stream's format is not supported on this device.",
      };
      const msg = (code && msgMap[code]) || "Playback failed. Please try again.";
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[HlsVideoPlayer] video error:", { code, message: video.error?.message });
      }
      // Only surface plain-element errors when the active slot has no
      // hls.js engine — otherwise hls.js's own ERROR handler manages it.
      if (!getHls(activeSlot)) {
        setError(msg);
        setIsBuffering(false);
        clearLoadWatchdog();
      }
    };
    // ── Autonomous queue advance on `ended` ─────────────────────────────
    // The server's transition SSE may arrive a moment after the active
    // video finishes (broadcast ticker is on a 500ms interval, plus
    // network RTT). Without this handler the viewer would see a black
    // frame between the active video reaching its end and the SSE-driven
    // hlsUrl change firing the swap. If the inactive slot has the next
    // queue item already primed (the common path — preload runs as soon
    // as the broadcast payload exposes nextItem), promote it now and let
    // the SSE-driven hlsUrl change land harmlessly when it arrives.
    //
    // We DO NOT seek back / loop the current video — looping the same
    // sermon for a few hundred milliseconds would be jarring and the
    // pending swap would interrupt it anyway.
    const onEnded = () => {
      if (avplayActiveRef.current) return; // single-engine path, no A/B
      const inactive = otherSlot(activeSlotRef.current);
      const inactiveUrl = getLoadedUrl(inactive);
      const inactiveVideo = getVideo(inactive);
      if (!inactiveUrl || !inactiveVideo) return;
      // Don't swap to the same URL we just finished — that would just
      // restart the current video. Wait for the SSE-driven hlsUrl change.
      if (inactiveUrl === getLoadedUrl(activeSlotRef.current)) return;
      // Inactive slot must be at least loadable; preload primes it to
      // readyState 4 normally, but guard so a half-warm slot doesn't
      // trade a black frame for a buffering spinner.
      if (inactiveVideo.readyState < 2) return;
      pendingPromotionUrlRef.current = null;
      swapToInactive();
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("durationchange", onDurationChange);
    video.addEventListener("error", onError);
    video.addEventListener("ended", onEnded);

    // Sync state immediately for the new active slot (covers swap case
    // where the slot is already mid-play).
    setIsPlaying(!video.paused);
    if (Number.isFinite(video.duration)) setDuration(video.duration);
    setCurrentTime(video.currentTime);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("durationchange", onDurationChange);
      video.removeEventListener("error", onError);
      video.removeEventListener("ended", onEnded);
    };
  }, [activeSlot, clearLoadWatchdog, markEverShown, swapToInactive]);

  // ── Keyboard / remote control ─────────────────────────────────────────────
  useEffect(() => {
    resetHideTimer();

    const handler = (e: KeyboardEvent) => {
      const action = keyEventToAction(e);

      if (error) {
        if (action === "select") { e.preventDefault(); setRetries(0); if (hlsUrl) loadIntoSlot(activeSlotRef.current, hlsUrl, "active"); }
        else if (action === "back" || action === "exit") { e.preventDefault(); onBack(); }
        return;
      }

      const video = getVideo(activeSlotRef.current);
      const avplay = avplayActiveRef.current ? window.webapis?.avplay : undefined;

      // ── Autoplay-blocked overlay: SELECT / play resumes playback ──────
      if (needsPlayGesture) {
        if (action === "back" || action === "exit") {
          e.preventDefault();
          onBack();
          return;
        }
        if (action === "select" || action === "play" || action === "playpause") {
          e.preventDefault();
          if (video) attemptPlay(video);
          return;
        }
      }

      // ── LIVE-MODE GUARD ───────────────────────────────────────────────
      if (isLive) {
        switch (action) {
          case "back":
          case "exit":
            e.preventDefault();
            onBack();
            return;
          case "playpause":
          case "play":
          case "pause":
          case "stop":
          case "fastforward":
          case "rewind":
          case "select":
            e.preventDefault();
            resetHideTimer();
            return;
        }
      }

      switch (action) {
        case "back":
        case "exit":
          e.preventDefault();
          onBack();
          break;

        case "playpause":
          e.preventDefault();
          if (avplay) {
            if (isPlaying) { try { avplay.pause(); setIsPlaying(false); } catch { /* noop */ } }
            else { try { avplay.play(); setIsPlaying(true); } catch { /* noop */ } }
          } else if (video) {
            if (video.paused) video.play().catch(() => {});
            else video.pause();
          }
          resetHideTimer();
          break;

        case "play":
          e.preventDefault();
          if (avplay) { try { avplay.play(); setIsPlaying(true); } catch { /* noop */ } }
          else if (video) video.play().catch(() => {});
          resetHideTimer();
          break;

        case "pause":
        case "stop":
          e.preventDefault();
          if (avplay) { try { avplay.pause(); setIsPlaying(false); } catch { /* noop */ } }
          else if (video) video.pause();
          resetHideTimer();
          break;

        case "fastforward": {
          e.preventDefault();
          if (avplay) {
            const pos = (avplay.getCurrentTime?.() ?? currentTime * 1_000) + SEEK_STEP * 1_000;
            try { avplay.seekTo(Math.floor(pos)); } catch { /* noop */ }
          } else if (video) {
            video.currentTime = Math.min(video.duration || Infinity, video.currentTime + SEEK_STEP);
          }
          showSeekOsd(`+${SEEK_STEP}s`);
          resetHideTimer();
          break;
        }

        case "rewind": {
          e.preventDefault();
          if (avplay) {
            const pos = Math.max(0, (avplay.getCurrentTime?.() ?? currentTime * 1_000) - SEEK_STEP * 1_000);
            try { avplay.seekTo(Math.floor(pos)); } catch { /* noop */ }
          } else if (video) {
            video.currentTime = Math.max(0, video.currentTime - SEEK_STEP);
          }
          showSeekOsd(`−${SEEK_STEP}s`);
          resetHideTimer();
          break;
        }

        case "info":
          e.preventDefault();
          toggleFullscreen();
          resetHideTimer();
          break;

        case "select":
          e.preventDefault();
          if (avplay) {
            if (isPlaying) { try { avplay.pause(); setIsPlaying(false); } catch { /* noop */ } }
            else { try { avplay.play(); setIsPlaying(true); } catch { /* noop */ } }
          } else if (video) {
            if (video.paused) video.play().catch(() => {});
            else video.pause();
          }
          resetHideTimer();
          break;

        case "left":
          if (!showControls) {
            e.preventDefault();
            resetHideTimer();
          }
          break;

        default:
          if (e.key === "f" || e.key === "F") {
            e.preventDefault();
            toggleFullscreen();
          }
          resetHideTimer();
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onBack, showControls, error, isPlaying, toggleFullscreen, hlsUrl, isLive, needsPlayGesture, currentTime, attemptPlay]);

  // Progress bar click handler
  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const video = getVideo(activeSlotRef.current);
    if (!video || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.currentTime = pct * duration;
  }, [duration]);

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  // ── Playback-quality telemetry ───────────────────────────────────────────
  // Sample HTMLVideoElement.getVideoPlaybackQuality() every 5 s and POST the
  // delta to the api-server so the admin Live Monitor can display a real
  // viewer-side dropped-frame rate alongside server-side bitrate / latency.
  // Best-effort only — silently no-ops on browsers without the API and on
  // any network failure (admin telemetry must NEVER affect playback).
  useEffect(() => {
    let lastDecoded = 0;
    let lastDropped = 0;
    let lastSlot: Slot | null = null;
    const apiBase = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "";
    const url = `${apiBase}/api/broadcast/playback-telemetry`;

    const tick = () => {
      const slot = activeSlotRef.current;
      const v = getVideo(slot);
      if (!v) return;
      const q = (v as HTMLVideoElement & {
        getVideoPlaybackQuality?: () => { totalVideoFrames: number; droppedVideoFrames: number };
      }).getVideoPlaybackQuality?.();
      if (!q) return;
      // Slot swap (crossfade to fresh element) resets the underlying counters
      // — re-baseline so we don't emit a giant artificial spike.
      if (slot !== lastSlot) {
        lastSlot = slot;
        lastDecoded = q.totalVideoFrames;
        lastDropped = q.droppedVideoFrames;
        return;
      }
      const decodedDelta = Math.max(0, q.totalVideoFrames - lastDecoded);
      const droppedDelta = Math.max(0, q.droppedVideoFrames - lastDropped);
      lastDecoded = q.totalVideoFrames;
      lastDropped = q.droppedVideoFrames;
      if (decodedDelta === 0 && droppedDelta === 0) return;
      try {
        // keepalive so the report still fires during page-unload races
        void fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: "tv", decoded: decodedDelta, dropped: droppedDelta }),
          keepalive: true,
        }).catch(() => {});
      } catch {
        // never let telemetry errors surface to the player
      }
    };

    const handle = setInterval(tick, 5_000);
    return () => clearInterval(handle);
  }, []);

  const slotStyle = (slot: Slot): React.CSSProperties => ({
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "contain",
    display: "block",
    background: "#000",
    // Active slot: visible. Inactive: invisible (still loaded, decoding).
    // Once a frame has ever shown, swaps are 1-frame cuts — no transition.
    opacity: slot === activeSlot ? 1 : 0,
    pointerEvents: slot === activeSlot ? "auto" : "none",
    zIndex: slot === activeSlot ? 1 : 0,
  });

  // ── Effect: playback-quality telemetry → /broadcast/playback-telemetry ─
  // Read the active <video>'s cumulative frame counters every 5 s and POST
  // the delta. This is the only signal the api-server cannot measure on
  // its own — without it, the `droppedFrameRate` on the admin live-monitor
  // is permanently null. Best-effort and silent: never disturbs playback.
  // Slot swaps and counter resets re-baseline so we never emit a spike.
  useEffect(() => {
    const TELEMETRY_INTERVAL_MS = 5_000;
    let baselineSlot: Slot = activeSlotRef.current;
    let baselineDecoded = 0;
    let baselineDropped = 0;

    const tick = () => {
      const slot = activeSlotRef.current;
      const v = getVideo(slot);
      if (!v || typeof v.getVideoPlaybackQuality !== "function") return;
      let q: VideoPlaybackQuality;
      try { q = v.getVideoPlaybackQuality(); } catch { return; }
      const total = q.totalVideoFrames ?? 0;
      const dropped = q.droppedVideoFrames ?? 0;
      if (slot !== baselineSlot || total < baselineDecoded || dropped < baselineDropped) {
        baselineSlot = slot;
        baselineDecoded = total;
        baselineDropped = dropped;
        return;
      }
      const dDec = total - baselineDecoded;
      const dDrop = dropped - baselineDropped;
      baselineDecoded = total;
      baselineDropped = dropped;
      if (dDec <= 0 && dDrop <= 0) return;

      try {
        void fetch(`${window.location.origin}/api/broadcast/playback-telemetry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform: "tv",
            decoded: Math.max(0, Math.round(dDec)),
            dropped: Math.max(0, Math.round(dDrop)),
          }),
        }).catch(() => {});
      } catch {}
    };

    const id = setInterval(tick, TELEMETRY_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        zIndex: 100,
        width: "100vw",
        height: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* ── A/B Video elements ─────────────────────────────────────────────
        NOTE: We intentionally do NOT set `crossOrigin` on either <video>.
        With `crossOrigin="anonymous"`, the browser performs CORS validation
        on the media response and blocks playback if the server doesn't echo
        a matching `Access-Control-Allow-Origin` for the current page origin.
        Our broadcast queue stores absolute production URLs whose CORS
        allow-list is restricted to a fixed set of production origins, which
        would break playback on Replit dev previews, custom domains,
        embedded contexts, etc. We never read pixels off the video (no
        canvas / WebGL), so CORS isn't required — omitting the attribute
        lets the browser perform a normal media request that always works.
      */}
      <video ref={videoRefA} style={slotStyle("A")} playsInline preload="auto" />
      <video ref={videoRefB} style={slotStyle("B")} playsInline preload="auto" muted />

      {/* ── Real-broadcaster channel bug ────────────────────────────────────
          Round 9b: in LIVE mode, render a discreet bottom-right "TEMPLE TV"
          watermark that fades in 3 seconds after each program change. The
          `programKey={hlsUrl}` ties the fade-reset to the same URL change
          that drives the A/B swap, so each new program gets its own grace
          period before the bug re-appears — exactly how real networks ease
          their identifier in once the new content has settled on screen. */}
      {isLive && <BroadcastChannelBug programKey={hlsUrl} />}

      {/* ── Cinematic loading veil (cold start only) ────────────────────────
          Shown ONLY before the very first frame ever decodes in this mount's
          lifetime. Queue advances re-use the previous frame as background
          while the new slot warms up — never showing a spinner / black box. */}
      {!hasEverShown && !error && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 18,
            background: "radial-gradient(circle at 50% 40%, #1a1f2a 0%, #0a0d12 70%)",
            zIndex: 5,
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              border: "3px solid rgba(255,255,255,0.12)",
              borderTopColor: "hsl(0 78% 55%)",
              animation: "tt-spin 0.9s linear infinite",
            }}
          />
          <p style={{ fontSize: 14, letterSpacing: "0.18em", fontWeight: 700, color: "rgba(255,255,255,0.55)", textTransform: "uppercase" }}>
            Loading stream…
          </p>
        </div>
      )}

      {/* ── Buffering spinner (mid-playback only) ───────────────────────────
          Suppressed during the initial cold start (the cinematic veil
          covers that) and during seamless A/B swaps (hasEverShown is true
          and isBuffering is reset by swap). */}
      {hasEverShown && isBuffering && !error && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "radial-gradient(circle at 50% 50%, rgba(13,17,23,0.55) 0%, rgba(10,13,18,0.35) 70%)",
            zIndex: 6,
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              border: "3px solid rgba(255,255,255,0.12)",
              borderTopColor: "#fff",
              animation: "tt-spin 0.9s linear infinite",
            }}
          />
        </div>
      )}

      {/* ── Reconnecting overlay (network-aware) ───────────────────────────
          Shown when the device is offline or the active hls.js engine has
          repeatedly failed with NETWORK_ERROR while offline. The last
          rendered frame stays visible behind it so the viewer sees "we're
          still here, waiting", not "the broadcast is broken". Suppressed
          on cold start (no frame yet) and during a hard error (separate
          surface for that). Auto-dismisses on `online`. */}
      {hasEverShown && isOfflineWaiting && !error && (
        <div
          aria-live="polite"
          aria-label="Reconnecting"
          style={{
            position: "absolute",
            top: 18,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "9px 16px 9px 14px",
            borderRadius: 999,
            background: "rgba(13,17,23,0.78)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            border: "1px solid rgba(255,255,255,0.10)",
            zIndex: 8,
          }}
        >
          <div
            aria-hidden
            style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              border: "2px solid rgba(255,255,255,0.18)",
              borderTopColor: "#FFC97A",
              animation: "tt-spin 0.9s linear infinite",
            }}
          />
          <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: "0.04em", color: "#FFC97A" }}>
            Reconnecting…
          </span>
        </div>
      )}

      {/* ── Autoplay-blocked overlay ──────────────────────────────────────── */}
      {needsPlayGesture && !error && (
        <div
          role="dialog"
          aria-label="Press play to start the stream"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 24,
            background: "radial-gradient(circle at 50% 40%, rgba(26,31,42,0.92) 0%, rgba(10,13,18,0.96) 70%)",
            zIndex: 9,
            cursor: "pointer",
          }}
          onClick={() => {
            const v = getVideo(activeSlotRef.current);
            if (v) attemptPlay(v);
          }}
        >
          <button
            autoFocus
            onClick={(e) => {
              e.stopPropagation();
              const v = getVideo(activeSlotRef.current);
              if (v) attemptPlay(v);
            }}
            aria-label="Play"
            style={{
              width: 96,
              height: 96,
              borderRadius: "50%",
              background: "hsl(0 78% 50%)",
              border: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              boxShadow: "0 0 32px rgba(220,38,38,0.4)",
            }}
          >
            <svg width="40" height="40" viewBox="0 0 24 24" fill="#fff" style={{ marginLeft: 4 }}>
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
          <p style={{ fontSize: "clamp(16px, 2.4vw, 22px)", fontWeight: 700, color: "#fff", margin: 0, textAlign: "center" }}>
            Press play to start the stream
          </p>
          <p className="tt-hide-on-touch" style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", margin: 0 }}>
            Press <strong style={{ color: "#fff" }}>ENTER</strong> to play · <strong style={{ color: "#fff" }}>BACK</strong> to return
          </p>
        </div>
      )}

      {/* ── Error state ───────────────────────────────────────────────────── */}
      {error && (
        <div
          role="alert"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 20,
            padding: "0 var(--tv-safe-h, 60px)",
            textAlign: "center",
            zIndex: 10,
          }}
        >
          <div style={{ fontSize: 48 }}>⚠️</div>
          <h2 style={{ fontSize: "clamp(22px, 3.5vw, 36px)", fontWeight: 700, color: "#fff", margin: 0 }}>
            Playback unavailable
          </h2>
          <p style={{ fontSize: "clamp(14px, 2vw, 18px)", color: "rgba(255,255,255,0.7)", maxWidth: 520, lineHeight: 1.5, margin: 0 }}>
            {error}
          </p>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center" }}>
            <button
              autoFocus
              onClick={() => { setRetries(0); if (hlsUrl) loadIntoSlot(activeSlotRef.current, hlsUrl, "active"); }}
              style={{
                background: "hsl(0 78% 50%)",
                color: "#fff",
                border: "none",
                borderRadius: 12,
                padding: "14px 32px",
                fontSize: 18,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Try again
            </button>
            <button
              onClick={onBack}
              style={{
                background: "rgba(255,255,255,0.12)",
                color: "#fff",
                border: "none",
                borderRadius: 12,
                padding: "14px 32px",
                fontSize: 18,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Back
            </button>
          </div>
          <p className="tt-hide-on-touch" style={{ fontSize: 14, color: "rgba(255,255,255,0.4)" }}>
            Press <strong style={{ color: "#fff" }}>ENTER</strong> to retry · <strong style={{ color: "#fff" }}>BACK</strong> to return
          </p>
        </div>
      )}

      {/* ── Seek OSD ──────────────────────────────────────────────────────── */}
      {seekOsd && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            zIndex: 20,
          }}
        >
          <div
            style={{
              background: "rgba(0,0,0,0.72)",
              backdropFilter: "blur(8px)",
              borderRadius: 16,
              padding: "18px 36px",
              fontSize: "clamp(28px, 4vw, 52px)",
              fontWeight: 800,
              color: "#fff",
            }}
          >
            {seekOsd}
          </div>
        </div>
      )}


      {/* ── Top control bar (back + title + quality badge) ─────────────────── */}
      {!error && showControls && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            background: "linear-gradient(to bottom, rgba(13,17,23,0.82) 0%, rgba(13,17,23,0.42) 55%, transparent 100%)",
            padding: "clamp(14px, 3vw, 28px) var(--tv-safe-h, 60px) clamp(32px, 6vw, 60px)",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <button
              onClick={onBack}
              style={{
                background: "rgba(255,255,255,0.12)",
                border: "none",
                borderRadius: 10,
                padding: "10px 16px",
                color: "#fff",
                fontSize: 16,
                cursor: "pointer",
                pointerEvents: "auto",
                backdropFilter: "blur(4px)",
                flexShrink: 0,
                fontFamily: "inherit",
              }}
              aria-label="Back"
            >
              ← Back
            </button>

            {/* Round 8: in LIVE mode the broadcast surface deliberately
                exposes NO program title, queue metadata, or content
                labels — a real TV channel does not caption its own feed.
                Only the back button, quality badge, and fullscreen
                control remain in the top bar. The flex spacer keeps the
                badge + fullscreen pinned to the right where they were. */}
            {isLive ? (
              <div style={{ flex: 1 }} aria-hidden="true" />
            ) : (
              <h2
                style={{
                  flex: 1,
                  fontSize: "clamp(15px, 2.6vw, 28px)",
                  fontWeight: 700,
                  color: "#fff",
                  margin: 0,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  textShadow: "0 2px 12px rgba(0,0,0,0.6)",
                }}
                title={title}
              >
                {title}
              </h2>
            )}

            {/* Quality level badge */}
            <div
              style={{
                background: "rgba(106,13,173,0.55)",
                border: "1px solid rgba(168,85,247,0.5)",
                borderRadius: 8,
                padding: "5px 12px",
                fontSize: 13,
                fontWeight: 700,
                color: "#e9d5ff",
                flexShrink: 0,
                letterSpacing: "0.04em",
              }}
            >
              {qualityLabel}
            </div>

            {/* Fullscreen toggle */}
            <button
              onClick={toggleFullscreen}
              style={{
                background: "rgba(255,255,255,0.10)",
                border: "none",
                borderRadius: 8,
                padding: "8px 12px",
                color: "#fff",
                cursor: "pointer",
                pointerEvents: "auto",
                flexShrink: 0,
                fontFamily: "inherit",
              }}
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ── ON AIR pill (live-only) ───────────────────────────────────────── */}
      {isLive && !error && (
        <div
          aria-label="Live broadcast indicator"
          style={{
            position: "absolute",
            bottom: "calc(env(safe-area-inset-bottom, 0px) + clamp(20px, 3vw, 32px))",
            left: "var(--tv-safe-h, 60px)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 16px",
            borderRadius: 999,
            background: "rgba(13,17,23,0.65)",
            border: "1px solid rgba(255,255,255,0.18)",
            backdropFilter: "blur(8px)",
            boxShadow: "0 4px 18px rgba(0,0,0,0.4), 0 0 0 1px rgba(220,38,38,0.12)",
            color: "#fff",
            fontSize: "clamp(12px, 1.3vw, 14px)",
            fontWeight: 700,
            letterSpacing: "0.14em",
            zIndex: 10,
            opacity: showControls ? 1 : 0,
            transition: "opacity 0.3s ease",
            pointerEvents: "none",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: "hsl(0 78% 55%)",
              boxShadow: "0 0 10px hsl(0 78% 55% / 0.7)",
              animation: "tt-spin 1.6s ease-in-out infinite alternate",
            }}
          />
          ON AIR
        </div>
      )}

      {/* ── Bottom control bar (progress + hint keys) ─────────────────────── */}
      {!isLive && !error && (
        <div
          className="tt-hide-on-touch"
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            background: "linear-gradient(to top, rgba(13,17,23,0.82) 0%, rgba(13,17,23,0.42) 55%, transparent 100%)",
            padding: "clamp(32px, 6vw, 60px) var(--tv-safe-h, 60px) clamp(16px, 2.4vw, 24px)",
            pointerEvents: "none",
            opacity: showControls ? 1 : 0,
            transition: "opacity 0.3s ease",
            zIndex: 10,
          }}
        >
          {duration > 0 && (
            <div
              onClick={handleProgressClick}
              style={{
                width: "100%",
                height: 4,
                background: "rgba(255,255,255,0.2)",
                borderRadius: 2,
                marginBottom: 14,
                cursor: "pointer",
                pointerEvents: "auto",
                position: "relative",
                overflow: "visible",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  height: "100%",
                  width: `${progress * 100}%`,
                  background: "linear-gradient(90deg, #7c3aed, #a855f7)",
                  borderRadius: 2,
                  transition: "width 0.5s linear",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  top: "50%",
                  left: `${progress * 100}%`,
                  transform: "translate(-50%, -50%)",
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: "#fff",
                  boxShadow: "0 0 0 3px rgba(168,85,247,0.6)",
                }}
              />
            </div>
          )}

          {duration > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <span style={{ fontSize: "clamp(12px, 1.3vw, 15px)", color: "rgba(255,255,255,0.7)", fontWeight: 500 }}>
                {formatTime(currentTime)}
              </span>
              <span style={{ fontSize: "clamp(12px, 1.3vw, 15px)", color: "rgba(255,255,255,0.4)" }}>
                {formatTime(duration)}
              </span>
            </div>
          )}

          <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
            {[
              { key: isPlaying ? "⏸ SPACE" : "▶ SPACE", label: isPlaying ? "Pause" : "Play" },
              { key: "⏮ ←←", label: `−${SEEK_STEP}s` },
              { key: "⏭ →→", label: `+${SEEK_STEP}s` },
              { key: "F", label: "Fullscreen" },
              { key: "ESC / BACK", label: "Exit" },
            ].map((h) => (
              <div key={h.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <kbd style={{
                  background: "rgba(255,255,255,0.10)",
                  border: "1px solid rgba(255,255,255,0.18)",
                  borderRadius: 6,
                  padding: "3px 8px",
                  fontSize: "clamp(11px, 1.1vw, 13px)",
                  color: "rgba(255,255,255,0.65)",
                  fontFamily: "inherit",
                }}>
                  {h.key}
                </kbd>
                <span style={{ fontSize: "clamp(11px, 1.1vw, 13px)", color: "rgba(255,255,255,0.35)" }}>{h.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
