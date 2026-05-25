/**
 * HlsVideoPlayer — Production HLS/MP4 player for Temple TV Smart TV.
 *
 * Rebuilt from scratch. Supports:
 *  • hls.js ABR on Chromium/Firefox (Samsung, LG, Fire TV browsers)
 *  • Native HLS on Safari / WKWebView / some Smart TV stacks
 *  • Samsung AVPlay (Tizen) via webapis.avplay
 *  • A/B dual-buffer: inactive slot preloads `nextHlsUrl` for instant cuts
 *  • D-pad + media-key remote controls (tvKeys.ts)
 *  • Quality-level OSD (Auto / 1080p / 720p / …)
 *  • Seek OSD (+15 s / −15 s flash)
 *  • Auto-hide controls after 5 s
 *  • Buffering spinner + cinematic loading veil
 *  • OMEGA failover chain: primary → failoverHlsUrl → onSkipItem()
 *
 * Live mode (isLive=true):
 *  • No control bar — TV-channel behavior, no pause/seek/progress
 *  • BACK still navigates away
 *
 * VOD mode (isLive=false):
 *  • Full playback controls with progress scrubber, quality selector
 *  • onProgress callback for persist resume points
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { keyEventToAction } from "../lib/tvKeys";
import { BroadcastChannelBug } from "./BroadcastChannelBug";
import { isPlainVideoUrl } from "@workspace/broadcast-sync";

// ── Samsung AVPlay ambient declarations ───────────────────────────────────────
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
        setListener: (l: {
          onbufferingstart?: () => void;
          onbufferingcomplete?: () => void;
          oncurrentplaytime?: (ms: number) => void;
          onerror?: (msg: string) => void;
        }) => void;
      };
    };
  }
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface HlsVideoPlayerProps {
  hlsUrl: string;
  title: string;
  onBack: () => void;
  /** Resume playback at this position (seconds). Defaults to 0. */
  startPositionSecs?: number;
  /**
   * URL of the next item to preload in the inactive slot. When `hlsUrl`
   * then advances to this URL the player swaps instead of reloading.
   */
  nextHlsUrl?: string | null;
  /** Live mode: no controls, no pause/seek. */
  isLive?: boolean;
  /** Called when this live item fails and the queue should advance. */
  onSkipItem?: () => void;
  /** Primary-failure fallback URL before onSkipItem() is called. */
  failoverHlsUrl?: string | null;
  /** Periodic (≈5 s) VOD progress callback for resume-point persistence. */
  onProgress?: (positionSecs: number, durationSecs: number) => void;
  /**
   * Thumbnail / poster URL for the current item.
   * When provided, a blurred, darkened version fills letterbox/pillarbox
   * areas produced by object-contain — the same cinematic ambient technique
   * used by Netflix, Apple TV+, and Disney+. Omitting this prop is safe;
   * the player falls back to a plain black background.
   */
  thumbnailUrl?: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SEEK_STEP          = 15;
const CONTROLS_HIDE_MS   = 5_000;
const PROGRESS_TICK_MS   = 5_000;
const MAX_RETRIES        = 3;
const WATCHDOG_MS        = 15_000;

type Slot = "A" | "B";

function levelLabel(h?: number): string {
  if (!h) return "Auto";
  if (h >= 1080) return "1080p";
  if (h >= 720)  return "720p";
  if (h >= 480)  return "480p";
  if (h >= 360)  return "360p";
  return "240p";
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
}

function isTizen(): boolean {
  return typeof navigator !== "undefined" && /Tizen/i.test(navigator.userAgent);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function HlsVideoPlayer({
  hlsUrl,
  title,
  onBack,
  startPositionSecs = 0,
  nextHlsUrl = null,
  isLive = false,
  onSkipItem,
  failoverHlsUrl = null,
  onProgress,
  thumbnailUrl = null,
}: HlsVideoPlayerProps) {
  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Slot state
  const [activeSlot, setActiveSlot] = useState<Slot>("A");
  const activeSlotRef = useRef<Slot>("A");
  const loadedUrlA = useRef<string | null>(null);
  const loadedUrlB = useRef<string | null>(null);

  // HLS instances
  const hlsARef = useRef<import("hls.js").default | null>(null);
  const hlsBRef = useRef<import("hls.js").default | null>(null);

  // Failover + retry state
  const retryCount = useRef(0);
  const usingFailover = useRef(false);
  const currentFailoverUrl = useRef<string | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // UI state
  const [loading, setLoading]         = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]       = useState(0);
  const [qualityLabel, setQualityLabel] = useState("Auto");
  const [seekOsd, setSeekOsd]         = useState<"+15s" | "-15s" | null>(null);
  const [isFs, setIsFs]               = useState(false);
  const seekOsdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlsHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const getVideo = (slot: Slot) => slot === "A" ? videoA.current : videoB.current;
  const setHls   = (slot: Slot, h: import("hls.js").default | null) => {
    if (slot === "A") hlsARef.current = h; else hlsBRef.current = h;
  };
  const getHls   = (slot: Slot) => slot === "A" ? hlsARef.current : hlsBRef.current;
  const setLoaded = (slot: Slot, url: string | null) => {
    if (slot === "A") loadedUrlA.current = url; else loadedUrlB.current = url;
  };
  const getLoaded = (slot: Slot) => slot === "A" ? loadedUrlA.current : loadedUrlB.current;
  const inactiveSlot = (): Slot => activeSlotRef.current === "A" ? "B" : "A";

  // ── Controls visibility ──────────────────────────────────────────────────

  const showControls = useCallback(() => {
    if (isLive) return;
    setControlsVisible(true);
    if (controlsHideTimer.current) clearTimeout(controlsHideTimer.current);
    controlsHideTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_MS);
  }, [isLive]);

  // ── hls.js loader ────────────────────────────────────────────────────────

  const loadHls = useCallback((slot: Slot, video: HTMLVideoElement, url: string) => {
    const oldHls = getHls(slot);
    if (oldHls) { try { oldHls.destroy(); } catch { /* noop */ } }
    setHls(slot, null);

    if (isTizen() && window.webapis?.avplay) {
      video.src = url;
      return;
    }

    if (isPlainVideoUrl(url)) {
      video.src = url;
      setLoaded(slot, url);
      return;
    }

    import("hls.js").then(({ default: HlsLib }) => {
      const safariNative = (() => {
        const v = document.createElement("video");
        return v.canPlayType("application/vnd.apple.mpegurl") !== "";
      })();
      if (safariNative) {
        video.src = url;
        setLoaded(slot, url);
        return;
      }
      if (!HlsLib.isSupported()) {
        video.src = url;
        setLoaded(slot, url);
        return;
      }
      const hls = new HlsLib({
        enableWorker: true,
        maxBufferLength: 30,
        backBufferLength: 30,
        maxMaxBufferLength: 60,
        startLevel: -1,        // auto-select quality for VOD
        capLevelToPlayerSize: true,
        debug: false,
        // Retry tuning — same profile as LiveBroadcastV2 for consistency
        fragLoadingMaxRetry: 8,
        fragLoadingRetryDelay: 300,
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        nudgeMaxRetry: 5,
        abrBandWidthFactor: 0.95,
        abrBandWidthUpFactor: 0.70,
      });
      hls.attachMedia(video);
      hls.loadSource(url);
      hls.on(HlsLib.Events.MANIFEST_PARSED, () => {
        setLoaded(slot, url);
        if (slot === activeSlotRef.current) {
          video.play().catch(() => {});
        }
      });
      hls.on(HlsLib.Events.LEVEL_SWITCHED, (_e, d) => {
        setQualityLabel(levelLabel(hls.levels[d.level]?.height));
      });
      hls.on(HlsLib.Events.ERROR, (_e, data) => {
        if (data.fatal && slot === activeSlotRef.current) {
          handleError(slot);
        }
      });
      setHls(slot, hls);
    }).catch(() => { video.src = url; setLoaded(slot, url); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Error / failover ──────────────────────────────────────────────────────

  const handleError = useCallback((slot: Slot) => {
    if (slot !== activeSlotRef.current) return;
    retryCount.current += 1;
    if (retryCount.current <= MAX_RETRIES) {
      const v = getVideo(slot);
      if (v) { v.load(); v.play().catch(() => {}); }
      return;
    }
    if (failoverHlsUrl && !usingFailover.current) {
      usingFailover.current = true;
      currentFailoverUrl.current = failoverHlsUrl;
      retryCount.current = 0;
      const v = getVideo(slot);
      if (v) loadHls(slot, v, failoverHlsUrl);
      return;
    }
    onSkipItem?.();
  }, [failoverHlsUrl, loadHls, onSkipItem]);

  // ── Watchdog ──────────────────────────────────────────────────────────────

  const startWatchdog = useCallback(() => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => {
      const v = getVideo(activeSlotRef.current);
      if (!v) return;
      if (v.readyState < 3 && !v.paused) {
        v.load(); v.play().catch(() => {});
      }
    }, WATCHDOG_MS);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Main hlsUrl load effect ───────────────────────────────────────────────

  useEffect(() => {
    if (!hlsUrl) return;
    usingFailover.current = false;
    retryCount.current    = 0;
    setLoading(true);

    const slot = activeSlotRef.current;
    const inactive = slot === "A" ? "B" : "A";

    // Check if the inactive slot already has this URL preloaded.
    if (getLoaded(inactive) === hlsUrl) {
      // Instant swap.
      const incoming = getVideo(inactive)!;
      const outgoing = getVideo(slot);
      incoming.muted  = false;
      incoming.volume = 1;
      incoming.play().catch(() => {});
      try { outgoing?.pause(); } catch { /* noop */ }
      const nextSlot: Slot = slot === "A" ? "B" : "A";
      activeSlotRef.current = nextSlot;
      setActiveSlot(nextSlot);
      setLoading(false);
      return;
    }

    // Fresh load into active slot.
    const v = getVideo(slot);
    if (!v) return;
    loadHls(slot, v, hlsUrl);

    const onCanPlay = () => {
      setLoading(false);
      startWatchdog();
      if (startPositionSecs > 0) {
        try { v.currentTime = startPositionSecs; } catch { /* noop */ }
      }
      v.removeEventListener("canplay", onCanPlay);
    };
    v.addEventListener("canplay", onCanPlay);
    return () => v.removeEventListener("canplay", onCanPlay);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlsUrl]);

  // ── Preload next URL into inactive slot ───────────────────────────────────

  useEffect(() => {
    if (!nextHlsUrl) return;
    const inactive = inactiveSlot();
    if (getLoaded(inactive) === nextHlsUrl) return;
    const v = getVideo(inactive);
    if (!v) return;
    v.muted  = true;
    v.volume = 0;
    loadHls(inactive, v, nextHlsUrl);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextHlsUrl]);

  // ── VOD progress polling ──────────────────────────────────────────────────

  useEffect(() => {
    if (isLive || !onProgress) return;
    progressTimer.current = setInterval(() => {
      const v = getVideo(activeSlotRef.current);
      if (v && !v.paused) onProgress(v.currentTime, v.duration || 0);
    }, PROGRESS_TICK_MS);
    return () => { if (progressTimer.current) clearInterval(progressTimer.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, onProgress]);

  // ── Keyboard / D-pad handler ──────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = keyEventToAction(e);
      if (!action) return;
      if (action === "back") { e.preventDefault(); onBack(); return; }
      if (isLive) return;

      const v = getVideo(activeSlotRef.current);
      if (!v) return;

      showControls();
      if (action === "select" || action === "playpause") {
        e.preventDefault();
        v.paused ? v.play().catch(() => {}) : v.pause();
      } else if (action === "fastforward" || action === "right") {
        e.preventDefault();
        v.currentTime = Math.min(v.currentTime + SEEK_STEP, v.duration || v.currentTime);
        flashSeekOsd("+15s");
      } else if (action === "rewind" || action === "left") {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - SEEK_STEP);
        flashSeekOsd("-15s");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, onBack, showControls]);

  const flashSeekOsd = useCallback((label: "+15s" | "-15s") => {
    setSeekOsd(label);
    if (seekOsdTimer.current) clearTimeout(seekOsdTimer.current);
    seekOsdTimer.current = setTimeout(() => setSeekOsd(null), 1200);
  }, []);

  // ── Fullscreen ────────────────────────────────────────────────────────────

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  }, []);

  // Track fullscreen state and recalibrate HLS ABR after each transition.
  //
  // Problem: capLevelToPlayerSize queries clientWidth/clientHeight to cap the
  // quality level. During a fullscreen transition the container's dimensions
  // are in flux; hls.js may read 0 or the pre-fullscreen size and trigger a
  // quality switch. A quality switch flushes the video decode pipeline, which
  // freezes the frame for 1-3 s while the audio buffer (independently decoded)
  // keeps running — the classic "audio continues, video frozen" symptom.
  //
  // Fix: after fullscreenchange fires (browser has finished compositing and
  // clientWidth/clientHeight now reflect the fullscreen viewport), we use a
  // double rAF to ensure layout is fully settled, then reset the current level
  // to -1 (auto). This forces the ABR engine to re-evaluate at the correct
  // dimensions and pick the optimal quality without a pipeline-flushing switch.
  useEffect(() => {
    const onFsChange = () => {
      const entering = !!document.fullscreenElement;
      setIsFs(entering);
      if (!entering) return;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const hls = activeSlotRef.current === "A" ? hlsARef.current : hlsBRef.current;
        if (hls) hls.currentLevel = -1;
      }));
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Video events (time update, ended) ─────────────────────────────────────

  const handleTimeUpdate = useCallback(() => {
    if (isLive) return;
    const v = getVideo(activeSlotRef.current);
    if (!v) return;
    setCurrentTime(v.currentTime);
    setDuration(v.duration || 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive]);

  // ── Cleanup ───────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (controlsHideTimer.current) clearTimeout(controlsHideTimer.current);
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      if (seekOsdTimer.current) clearTimeout(seekOsdTimer.current);
      if (progressTimer.current) clearInterval(progressTimer.current);
      try { getHls("A")?.destroy(); } catch { /* noop */ }
      try { getHls("B")?.destroy(); } catch { /* noop */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative", width: "100%", height: "100%", background: "#000",
        // overflow:hidden clips the scaled ambient background so blur edges
        // stay invisible. In fullscreen this same clip causes the GPU compositor
        // (Samsung Tizen, LG webOS) to paint the video texture only within the
        // pre-fullscreen bounds → black screen while audio continues. We clear
        // it via the :fullscreen CSS rule AND here via React state so both the
        // CSS-pseudo-class path and older browsers that fire fullscreenchange
        // without supporting :fullscreen are covered.
        overflow: isFs ? "visible" : "hidden",
      }}
      onMouseMove={showControls}
      onTouchStart={showControls}
    >
      {/* ── Cinematic ambient background ────────────────────────────────────
          Blurred, darkened thumbnail fills letterbox/pillarbox areas produced
          by object-contain so non-16:9 sources never show harsh black margins.
          scale(1.15) hides the soft blur edges at the container boundary.   */}
      {thumbnailUrl && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
            backgroundImage: `url(${thumbnailUrl})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            filter: "blur(48px) brightness(0.2) saturate(1.4)",
            transform: "scale(1.15)",
            pointerEvents: "none",
          }}
        />
      )}

      {/* Slot A — active/inactive surface.
          background is intentionally omitted: the ambient layer or the
          container's own bg-#000 shows through the transparent letterbox
          areas that object-contain leaves around non-16:9 content.       */}
      <video
        ref={videoA}
        style={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          objectFit: "contain",
          opacity: activeSlot === "A" ? 1 : 0,
          transition: "opacity 0.15s ease",
          zIndex: activeSlot === "A" ? 2 : 1,
        }}
        playsInline autoPlay muted={activeSlot !== "A"}
        onTimeUpdate={activeSlot === "A" ? handleTimeUpdate : undefined}
        onError={() => handleError("A")}
        onPlaying={() => { if (activeSlot === "A") setLoading(false); }}
        onWaiting={() => { if (activeSlot === "A") setLoading(true); }}
      />
      {/* Slot B — preload surface */}
      <video
        ref={videoB}
        style={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          objectFit: "contain",
          opacity: activeSlot === "B" ? 1 : 0,
          transition: "opacity 0.15s ease",
          zIndex: activeSlot === "B" ? 2 : 1,
        }}
        playsInline autoPlay muted={activeSlot !== "B"}
        onTimeUpdate={activeSlot === "B" ? handleTimeUpdate : undefined}
        onError={() => handleError("B")}
        onPlaying={() => { if (activeSlot === "B") setLoading(false); }}
        onWaiting={() => { if (activeSlot === "B") setLoading(true); }}
      />

      {/* Loading veil */}
      {loading && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 10,
          background: "rgba(0,0,0,0.75)",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexDirection: "column", gap: 16,
        }}>
          <div style={{
            width: 48, height: 48, borderRadius: "50%",
            border: "3px solid rgba(168,85,247,0.3)",
            borderTopColor: "#a855f7",
            animation: "spin 0.9s linear infinite",
          }} />
          <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, fontWeight: 500 }}>
            Loading stream…
          </span>
        </div>
      )}

      {/* Seek OSD */}
      {seekOsd && (
        <div style={{
          position: "absolute", top: "50%", left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 50, pointerEvents: "none",
          background: "rgba(0,0,0,0.7)", borderRadius: 12,
          padding: "10px 24px", fontSize: 22, fontWeight: 700, color: "#fff",
          backdropFilter: "blur(8px)",
        }}>
          {seekOsd}
        </div>
      )}

      {/* Broadcast channel bug (live mode) */}
      {isLive && <BroadcastChannelBug />}

      {/* Back button (always visible on hover / always live) */}
      {(controlsVisible || isLive) && (
        <button
          onClick={onBack}
          style={{
            position: "absolute", top: 24, left: 32, zIndex: 30,
            background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 50, width: 44, height: 44,
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", color: "#fff", fontSize: 20, backdropFilter: "blur(8px)",
          }}
          aria-label="Back"
        >
          ←
        </button>
      )}

      {/* Quality badge */}
      {controlsVisible && !isLive && (
        <div style={{
          position: "absolute", top: 24, right: 32, zIndex: 30,
          background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 8, padding: "4px 10px",
          fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.65)",
          backdropFilter: "blur(8px)",
        }}>
          {qualityLabel}
        </div>
      )}

      {/* VOD control bar */}
      {!isLive && controlsVisible && (
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 30,
          background: "linear-gradient(transparent, rgba(0,0,0,0.85))",
          padding: "32px 40px 24px",
        }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#fff", marginBottom: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {title}
          </div>
          {/* Progress bar */}
          <div
            style={{
              height: 4, borderRadius: 2, background: "rgba(255,255,255,0.2)",
              marginBottom: 8, cursor: "pointer", position: "relative",
            }}
            onClick={(e) => {
              const v = getVideo(activeSlotRef.current);
              if (!v || !duration) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = (e.clientX - rect.left) / rect.width;
              v.currentTime = pct * duration;
            }}
          >
            <div style={{ width: `${progress}%`, height: "100%", background: "#a855f7", borderRadius: 2, transition: "width 0.5s linear" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
            <span>{fmtTime(currentTime)}</span>
            <span>{fmtTime(duration)}</span>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: "rgba(255,255,255,0.3)", textAlign: "center" }}>
            ← −15s &nbsp;·&nbsp; SPACE Play/Pause &nbsp;·&nbsp; → +15s &nbsp;·&nbsp; F Fullscreen &nbsp;·&nbsp; BACK Exit
          </div>
        </div>
      )}

      {/* Fullscreen hotkey (F key) */}
      <button
        style={{ display: "none" }}
        onFocus={toggleFullscreen}
        onClick={toggleFullscreen}
      />

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
    </div>
  );
}
