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
 */

import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";
import { keyEventToAction } from "../lib/tvKeys";
import { isTizen } from "../lib/platform";
import { registerStreamReconnect } from "../lib/lifecycle";

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
}

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

export function HlsVideoPlayer({
  hlsUrl,
  title,
  onBack,
  startPositionSecs = 0,
}: HlsVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Samsung AVPlay: tracks whether we're using the native avplay engine
  const avplayActiveRef = useRef(false);
  const avplayPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [showControls, setShowControls] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const [isLoaded, setIsLoaded] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekOsd, setSeekOsd] = useState<string | null>(null);
  const [qualityLabel, setQualityLabel] = useState("Auto");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retries, setRetries] = useState(0);
  // Mirror `retries` in a ref so HLS event-handler closures (created once
  // per `initHls` call) always see the live counter — without this they
  // capture the value at the time the handler was registered, which makes
  // the `retries < 3` gate read 0 forever and effectively gives unbounded
  // recoveries per stream.
  const retriesRef = useRef(0);
  useEffect(() => { retriesRef.current = retries; }, [retries]);
  // Autoplay-blocked overlay: shown when video.play() is rejected by the
  // browser's autoplay policy (typically after navigation transitions even
  // when there was a recent user gesture). Distinct from `error` because the
  // video is loaded and ready — the user just needs to confirm playback.
  const [needsPlayGesture, setNeedsPlayGesture] = useState(false);

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
      // Check the *current* video element's readyState — if it's already
      // playable, the watchdog is stale (events races) and we suppress.
      const v = videoRef.current;
      if (v && v.readyState >= 2) return; // HAVE_CURRENT_DATA or better
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

  // ── HLS initialisation ────────────────────────────────────────────────────
  const initHls = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    // Tear down previous instance
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    setError(null);
    setNeedsPlayGesture(false);
    setIsLoaded(false);
    setIsBuffering(true);
    armLoadWatchdog();

    // ── Plain video detection (MP4, WebM, MOV, etc.) ─────────────────────
    // hls.js cannot parse non-HLS manifests. If the URL points to a plain
    // video file, play it directly via the native <video> element to avoid
    // a fatal parse error and blank screen.
    const isPlainVideo = /\.(mp4|webm|ogg|mov|avi|mkv|m4v)(\?[^#]*)?$/i.test(hlsUrl);
    if (isPlainVideo) {
      video.src = hlsUrl;
      video.load();
      const onReady = () => {
        if (startPositionSecs > 0) {
          try { video.currentTime = startPositionSecs; } catch {}
        }
        setIsLoaded(true);
        setIsBuffering(false);
        clearLoadWatchdog();
        attemptPlay(video);
        video.removeEventListener("loadeddata", onReady);
      };
      video.addEventListener("loadeddata", onReady);
      // Optimistically attempt play immediately too — if the file is cached
      // or loadeddata is delayed, this gets us to playback faster. The
      // attemptPlay() call surfaces autoplay rejection cleanly.
      attemptPlay(video);
      return;
    }

    if (Hls.isSupported()) {
      // ── hls.js path (Chromium, Firefox, Samsung/LG/Fire TV browsers) ──────
      const hls = new Hls({
        // Start with the lowest quality to minimise startup time.
        startLevel: -1,           // -1 = let ABR pick
        autoStartLoad: true,
        lowLatencyMode: false,    // VOD mode
        // Let hls.js handle the initial seek internally — it ensures the seek
        // lands after segments are buffered, preventing hangs on Smart TV decoders.
        // -1 means "default" (beginning for VOD, live edge for live).
        startPosition: startPositionSecs > 0 ? startPositionSecs : -1,
        // Conservative buffer targets for TV RAM constraints.
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferSize: 60 * 1_000 * 1_000,  // 60 MB
        // Faster ABR level switching for better quality ramp-up.
        abrEwmaFastLive: 3,
        abrEwmaSlowLive: 9,
        // Retry config: 3 auto-retries with exponential back-off.
        manifestLoadingMaxRetry: 3,
        manifestLoadingRetryDelay: 1_000,
        levelLoadingMaxRetry: 3,
        levelLoadingRetryDelay: 500,
        fragLoadingMaxRetry: 3,
        fragLoadingRetryDelay: 500,
        // Explicitly omit credentials on cross-origin XHR — we never need
        // cookies on segment requests, and including them would force the
        // server's CORS to echo a specific origin (instead of '*'), which
        // breaks playback on origins outside the production allow-list.
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        },
      });

      hlsRef.current = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        // IMPORTANT: Don't flip `isLoaded`/`isBuffering` here. MANIFEST_PARSED
        // only means the manifest XHR succeeded — segments may still stall
        // before any frame is decoded. If we cleared the loading veil now,
        // the user would see a frozen first-frame state with no spinner and
        // no error. The video element's `canplay`/`playing` listeners drive
        // those flags and the watchdog clear once real media data arrives.
        attemptPlay(video);
        // Report available quality levels to the OSD.
        setQualityLabel(`Auto (${data.levels.length} levels)`);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        const level = hls.levels[data.level];
        setQualityLabel(level ? levelLabel(level.height) : "Auto");
      });

      // Buffering state is driven by the video element's waiting/playing events
      // (handled in the video event listener effect below). No hls.js event needed.

      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[HlsVideoPlayer] hls.js error:", {
            type: data.type,
            details: data.details,
            fatal: data.fatal,
          });
        }
        if (data.fatal) {
          // Read from the ref — the captured `retries` in this closure is
          // stale because we don't re-register the handler on each retry.
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && retriesRef.current < 3) {
            hls.startLoad();
            setRetries((r) => r + 1);
            armLoadWatchdog();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && retriesRef.current < 3) {
            hls.recoverMediaError();
            setRetries((r) => r + 1);
            armLoadWatchdog();
          } else {
            clearLoadWatchdog();
            setError("Stream unavailable. Please check your connection and try again.");
            setIsBuffering(false);
          }
        }
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // ── Native HLS path (Safari, iOS, some Samsung firmware) ─────────────
      video.src = hlsUrl;
      video.load();
      const onReady = () => {
        if (startPositionSecs > 0) {
          try { video.currentTime = startPositionSecs; } catch {}
        }
        setIsLoaded(true);
        setIsBuffering(false);
        clearLoadWatchdog();
        attemptPlay(video);
        video.removeEventListener("loadeddata", onReady);
      };
      video.addEventListener("loadeddata", onReady);
      attemptPlay(video);
    } else if (isTizen && window.webapis?.avplay) {
      // ── Samsung AVPlay path (older Tizen without MSE / hls.js support) ───
      // AVPlay is Samsung's native media engine — supports HLS out-of-the-box.
      // It renders fullscreen natively so the HTML video element is hidden.
      // IMPORTANT: AVPlay does not surface progress through the HTML video
      // element's readyState, so the watchdog's readyState guard cannot
      // suppress false timeouts on this path. We must clear the watchdog
      // explicitly when AVPlay reports playable readiness.
      const avplay = window.webapis.avplay;
      try {
        avplay.open(hlsUrl);
        // Fill the full HD raster — AVPlay clips to this rect inside the page.
        const W = window.screen?.width ?? 1920;
        const H = window.screen?.height ?? 1080;
        avplay.setDisplayRect(0, 0, W, H);
        avplay.setListener({
          onbufferingstart: () => setIsBuffering(true),
          onbufferingcomplete: () => {
            setIsBuffering(false);
            setIsLoaded(true);
            // Buffering complete = AVPlay has decoded enough data to play.
            // Cancel the load watchdog so it doesn't fire a stale error.
            clearLoadWatchdog();
          },
          oncurrentplaytime: (ms) => {
            setCurrentTime(ms / 1_000);
            // Receiving playtime callbacks proves playback is alive — also
            // an unambiguous signal to clear any pending watchdog.
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
        // NOTE: don't set `isLoaded`/`isBuffering` here. `avplay.play()`
        // returns synchronously before any frame is decoded. The
        // `onbufferingcomplete` and `oncurrentplaytime` listeners flip
        // those flags (and clear the watchdog) once playback is actually
        // alive — protecting us against AVPlay open() succeeding but the
        // pipeline silently failing to produce frames.
        // Poll duration (not always available immediately via event).
        if (avplayPollRef.current) clearInterval(avplayPollRef.current);
        avplayPollRef.current = setInterval(() => {
          try {
            const dur = avplay.getDuration?.() ?? 0;
            if (dur > 0) setDuration(dur / 1_000);
          } catch {}
        }, 2_000);
        // Hide the HTML video element — AVPlay renders separately.
        if (videoRef.current) videoRef.current.style.display = "none";
      } catch {
        try { avplay.close(); } catch {}
        avplayActiveRef.current = false;
        clearLoadWatchdog();
        setError("Playback failed. Please try again.");
      }
    } else {
      clearLoadWatchdog();
      setError("HLS streaming is not supported by this browser. Please update your browser or TV firmware.");
    }
  }, [hlsUrl, startPositionSecs, retries, armLoadWatchdog, attemptPlay, clearLoadWatchdog]);

  // Reset the retry counter whenever the source URL changes so each fresh
  // stream gets the full 3-retry budget (otherwise switching to a new stream
  // after a previous one exhausted retries would skip the recovery path).
  // Reset the ref synchronously too — `setRetries(0)` is async and the
  // initHls effect can run before the state-mirroring effect updates the
  // ref, leaving a tiny window where handlers see the previous count.
  useEffect(() => {
    retriesRef.current = 0;
    setRetries(0);
  }, [hlsUrl]);

  useEffect(() => {
    initHls();
    // ── Lifecycle reconnect on TV resume (suspend → resume) ───────────────
    const offReconnect = registerStreamReconnect(() => {
      // Only reconnect if not already destroyed.
      if (avplayActiveRef.current) {
        // AVPlay: just resume
        try { window.webapis?.avplay?.play(); setIsPlaying(true); } catch {}
      } else {
        initHls();
      }
    });
    return () => {
      offReconnect();
      // ── AVPlay teardown ─────────────────────────────────────────────────
      if (avplayActiveRef.current) {
        try { window.webapis?.avplay?.stop(); } catch {}
        try { window.webapis?.avplay?.close(); } catch {}
        avplayActiveRef.current = false;
      }
      if (avplayPollRef.current) { clearInterval(avplayPollRef.current); avplayPollRef.current = null; }
      // ── hls.js teardown ─────────────────────────────────────────────────
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (seekOsdTimer.current) clearTimeout(seekOsdTimer.current);
      // Cancel any pending watchdog so it doesn't surface a stale error
      // after unmount or when navigating to a different stream.
      if (loadWatchdog.current) {
        clearTimeout(loadWatchdog.current);
        loadWatchdog.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlsUrl]);

  // ── Video element event listeners ────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => {
      setIsPlaying(true);
      setNeedsPlayGesture(false);
    };
    const onPause = () => setIsPlaying(false);
    const onWaiting = () => setIsBuffering(true);
    const onPlaying = () => {
      setIsBuffering(false);
      setIsLoaded(true);
      setNeedsPlayGesture(false);
      clearLoadWatchdog();
    };
    const onCanPlay = () => {
      // First time the element has enough data to begin playback. Cancel
      // the watchdog and clear any spurious loading veil.
      setIsLoaded(true);
      clearLoadWatchdog();
    };
    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onDurationChange = () => {
      if (Number.isFinite(video.duration)) setDuration(video.duration);
    };
    const onError = () => {
      // Surface a useful diagnostic for both HLS and native paths. The
      // <video>'s MediaError code helps distinguish CORS/network/decode
      // failures during incident triage.
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
      // For the hls.js path, hls.js's own ERROR handler already manages
      // recovery and surfacing — don't double-report.
      if (!hlsRef.current) {
        setError(msg);
        setIsBuffering(false);
        clearLoadWatchdog();
      }
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("durationchange", onDurationChange);
    video.addEventListener("error", onError);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("durationchange", onDurationChange);
      video.removeEventListener("error", onError);
    };
  }, [clearLoadWatchdog]);

  // ── Keyboard / remote control ─────────────────────────────────────────────
  useEffect(() => {
    resetHideTimer();

    const handler = (e: KeyboardEvent) => {
      const action = keyEventToAction(e);

      if (error) {
        if (action === "select") { e.preventDefault(); setRetries(0); initHls(); }
        else if (action === "back" || action === "exit") { e.preventDefault(); onBack(); }
        return;
      }

      const video = videoRef.current;
      const avplay = avplayActiveRef.current ? window.webapis?.avplay : undefined;

      // ── Autoplay-blocked overlay: SELECT / play resumes playback ──────────
      // The video is loaded but the browser blocked auto-start. Any of the
      // standard "go" actions (SELECT / play / playpause) should consume the
      // gesture and start playback. BACK exits.
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

      switch (action) {
        case "back":
        case "exit":
          e.preventDefault();
          onBack();
          break;

        case "playpause":
          e.preventDefault();
          if (avplay) {
            if (isPlaying) { try { avplay.pause(); setIsPlaying(false); } catch {} }
            else { try { avplay.play(); setIsPlaying(true); } catch {} }
          } else if (video) {
            if (video.paused) video.play().catch(() => {});
            else video.pause();
          }
          resetHideTimer();
          break;

        case "play":
          e.preventDefault();
          if (avplay) { try { avplay.play(); setIsPlaying(true); } catch {} }
          else if (video) video.play().catch(() => {});
          resetHideTimer();
          break;

        case "pause":
        case "stop":
          e.preventDefault();
          if (avplay) { try { avplay.pause(); setIsPlaying(false); } catch {} }
          else if (video) video.pause();
          resetHideTimer();
          break;

        case "fastforward": {
          e.preventDefault();
          if (avplay) {
            const pos = (avplay.getCurrentTime?.() ?? currentTime * 1_000) + SEEK_STEP * 1_000;
            try { avplay.seekTo(Math.floor(pos)); } catch {}
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
            try { avplay.seekTo(Math.floor(pos)); } catch {}
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

        // Pressing Enter in error-free state toggles play/pause.
        case "select":
          e.preventDefault();
          if (avplay) {
            if (isPlaying) { try { avplay.pause(); setIsPlaying(false); } catch {} }
            else { try { avplay.play(); setIsPlaying(true); } catch {} }
          } else if (video) {
            if (video.paused) video.play().catch(() => {});
            else video.pause();
          }
          resetHideTimer();
          break;

        // Left arrow: reveal controls if hidden.
        case "left":
          if (!showControls) {
            e.preventDefault();
            resetHideTimer();
          }
          break;

        // F key / fullscreen key.
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
  }, [onBack, showControls, error, isPlaying, toggleFullscreen, initHls]);

  // Progress bar click handler
  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.currentTime = pct * duration;
  }, [duration]);

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

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
      {/* ── Video element ─────────────────────────────────────────────────── */}
      {/*
        NOTE: We intentionally do NOT set `crossOrigin` on the <video>. With
        `crossOrigin="anonymous"`, the browser performs CORS validation on the
        media response and blocks playback if the server doesn't echo a
        matching `Access-Control-Allow-Origin` for the current page origin.
        Our broadcast queue stores absolute production URLs whose CORS allow-
        list is restricted to a fixed set of production origins, which would
        break playback on Replit dev previews, custom domains, embedded
        contexts, etc. We never read pixels off the video (no canvas /
        WebGL), so CORS isn't required — omitting the attribute lets the
        browser perform a normal media request that always works.
      */}
      <video
        ref={videoRef}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          display: "block",
          background: "#000",
        }}
        playsInline
        preload="auto"
      />

      {/* ── Cinematic loading veil ─────────────────────────────────────────── */}
      {!isLoaded && !error && (
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
            background: "radial-gradient(circle at 50% 40%, #1a0010 0%, #050505 70%)",
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

      {/* ── Buffering spinner (mid-playback) ─────────────────────────────── */}
      {isLoaded && isBuffering && !error && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.35)",
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

      {/* ── Autoplay-blocked overlay ──────────────────────────────────────── */}
      {/*
        Shown when video.play() is rejected by the browser's autoplay policy
        (NotAllowedError). The video is fully loaded; the user just needs to
        confirm playback with a gesture. Distinct from the error state because
        recovery requires SELECT (not retry).
      */}
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
            background: "radial-gradient(circle at 50% 40%, rgba(26,0,16,0.85) 0%, rgba(0,0,0,0.92) 70%)",
            zIndex: 9,
            cursor: "pointer",
          }}
          onClick={() => {
            const v = videoRef.current;
            if (v) attemptPlay(v);
          }}
        >
          <button
            autoFocus
            onClick={(e) => {
              e.stopPropagation();
              const v = videoRef.current;
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
              onClick={() => { setRetries(0); initHls(); }}
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
            background: "linear-gradient(to bottom, rgba(0,0,0,0.88) 0%, transparent 100%)",
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

      {/* ── Bottom control bar (progress + hint keys) ─────────────────────── */}
      {!error && (
        <div
          className="tt-hide-on-touch"
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            background: "linear-gradient(to top, rgba(0,0,0,0.88) 0%, transparent 100%)",
            padding: "clamp(32px, 6vw, 60px) var(--tv-safe-h, 60px) clamp(16px, 2.4vw, 24px)",
            pointerEvents: "none",
            opacity: showControls ? 1 : 0,
            transition: "opacity 0.3s ease",
            zIndex: 10,
          }}
        >
          {/* Progress / seek bar */}
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
              {/* Scrubber thumb */}
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

          {/* Time display */}
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

          {/* Hint strip */}
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
