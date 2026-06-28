/**
 * Mp4VideoPlayer — Production MP4 player for Temple TV Smart TV.
 *
 * Exported as HlsVideoPlayer for backwards compatibility with callers.
 * All content is raw MP4 — no hls.js, no manifests, no segments.
 *
 * Features:
 *  • A/B dual-buffer: inactive slot preloads `nextHlsUrl` for instant cuts
 *  • D-pad + media-key remote controls (tvKeys.ts)
 *  • Seek OSD (+15 s / −15 s flash)
 *  • Auto-hide controls after 5 s
 *  • Buffering spinner + cinematic loading veil
 *  • Stall-recovery watchdog for 24/7 broadcast stability
 *  • Failover chain: primary → failoverHlsUrl → onSkipItem()
 *
 * Live mode (isLive=true):
 *  • No control bar — TV-channel behavior, no pause/seek/progress
 *  • BACK still navigates away
 *
 * VOD mode (isLive=false):
 *  • Full playback controls with progress scrubber
 *  • onProgress callback for resume-point persistence
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { keyEventToAction } from "../lib/tvKeys";
import { BroadcastChannelBug } from "./BroadcastChannelBug";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface HlsVideoPlayerProps {
  /** Primary MP4 URL (prop name kept for backwards compatibility). */
  hlsUrl: string;
  title: string;
  onBack: () => void;
  /** Resume playback at this position (seconds). Defaults to 0. */
  startPositionSecs?: number;
  /**
   * URL of the next item to preload in the inactive slot. When `hlsUrl`
   * advances to this URL the player swaps instead of reloading — instant cut.
   */
  nextHlsUrl?: string | null;
  /** Live mode: no controls, no pause/seek. */
  isLive?: boolean;
  /** Called when this item fails and the queue should advance. */
  onSkipItem?: () => void;
  /** Primary-failure fallback URL before onSkipItem() is called. */
  failoverHlsUrl?: string | null;
  /** Periodic (≈5 s) VOD progress callback for resume-point persistence. */
  onProgress?: (positionSecs: number, durationSecs: number) => void;
  /**
   * Thumbnail / poster URL for the current item.
   * A blurred, darkened version fills letterbox/pillarbox areas —
   * the cinematic ambient technique used by Netflix, Apple TV+, Disney+.
   */
  thumbnailUrl?: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SEEK_STEP          = 15;
const CONTROLS_HIDE_MS   = 5_000;
const PROGRESS_TICK_MS   = 5_000;
const MAX_RETRIES        = 3;
const WATCHDOG_MS        = 9_000;
/**
 * How long a `stalled` or `waiting` event may persist before we attempt a
 * load() + play() recovery. 15 s gives the browser enough time to exhaust its
 * own retry before we step in — preventing double-recovery on transient
 * congestion. Longer than WATCHDOG_MS (9 s) so the one-shot initial-load
 * watchdog fires first; this timer covers stalls during ongoing playback.
 */
const STALL_FAIL_MS      = 15_000;

type Slot = "A" | "B";

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${m}:${String(ss).padStart(2, "0")}`;
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

  // Failover + retry state
  const retryCount = useRef(0);
  const usingFailover = useRef(false);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // UI state
  const [loading, setLoading]         = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]       = useState(0);
  const [seekOsd, setSeekOsd]         = useState<"+15s" | "-15s" | null>(null);
  const [isFs, setIsFs]               = useState(false);
  const seekOsdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlsHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const getVideo = (slot: Slot) => slot === "A" ? videoA.current : videoB.current;
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

  // ── MP4 loader ───────────────────────────────────────────────────────────
  //
  // Direct <video src> assignment — no hls.js, no MSE, no manifest parsing.
  // Native browser/Smart TV MP4 decode gives zero-gap A/B transitions and
  // eliminates the hls.js VRAM overhead that caused long-session instability
  // on Samsung Tizen / LG webOS chipsets.

  const loadVideo = useCallback((slot: Slot, video: HTMLVideoElement, url: string) => {
    // Clear any previously loaded src so the browser releases the decode buffer
    // before assigning the new one.  On Samsung Tizen / LG webOS skipping this
    // step causes the compositor to keep a stale YUV texture in VRAM.
    try { video.pause(); } catch { /* noop */ }
    try { video.removeAttribute("src"); video.load(); } catch { /* noop */ }

    video.src = url;
    video.load();
    setLoaded(slot, url);
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
      retryCount.current = 0;
      const v = getVideo(slot);
      if (v) loadVideo(slot, v, failoverHlsUrl);
      return;
    }
    onSkipItem?.();
  }, [failoverHlsUrl, loadVideo, onSkipItem]);

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

    // Instant swap: the inactive slot already has the desired content buffered.
    if (getLoaded(inactive) === hlsUrl) {
      const incoming = getVideo(inactive)!;
      const outgoing = getVideo(slot);
      incoming.muted  = false;
      incoming.volume = 1;
      incoming.play().catch(() => {});
      try { outgoing?.pause(); } catch { /* noop */ }
      // Clear the outgoing slot so the preload effect treats it as available
      // for the NEXT nextHlsUrl.
      setLoaded(slot, null);
      const nextSlot: Slot = slot === "A" ? "B" : "A";
      activeSlotRef.current = nextSlot;
      setActiveSlot(nextSlot);
      setLoading(false);
      startWatchdog();
      return;
    }

    // Fresh load into active slot.
    const v = getVideo(slot);
    if (!v) return;
    loadVideo(slot, v, hlsUrl);

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
    loadVideo(inactive, v, nextHlsUrl);
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

  useEffect(() => {
    const onFsChange = () => {
      setIsFs(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
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

  // ── Continuous stall watchdog ─────────────────────────────────────────────
  //
  // On Smart TV browsers (Tizen, webOS) the <video> element can stall without
  // firing a fatal error — manifesting as a frozen frame. `stalled` and
  // `waiting` events bridge this gap: if the video hasn't recovered within
  // STALL_FAIL_MS we reload and resume.

  useEffect(() => {
    const v = getVideo(activeSlotRef.current);
    if (!v) return;

    const clearStall = () => {
      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
    };

    const onStall = () => {
      clearStall();
      stallTimerRef.current = setTimeout(() => {
        const vid = getVideo(activeSlotRef.current);
        if (vid && !vid.paused && vid.readyState < 3) {
          vid.load();
          vid.play().catch(() => {});
        }
      }, STALL_FAIL_MS);
    };

    v.addEventListener("stalled", onStall);
    v.addEventListener("waiting", onStall);
    v.addEventListener("playing", clearStall);
    v.addEventListener("timeupdate", clearStall);
    v.addEventListener("canplay", clearStall);

    return () => {
      clearStall();
      v.removeEventListener("stalled", onStall);
      v.removeEventListener("waiting", onStall);
      v.removeEventListener("playing", clearStall);
      v.removeEventListener("timeupdate", clearStall);
      v.removeEventListener("canplay", clearStall);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlot, hlsUrl]);

  // ── Cleanup ───────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (controlsHideTimer.current) clearTimeout(controlsHideTimer.current);
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
      if (seekOsdTimer.current) clearTimeout(seekOsdTimer.current);
      if (progressTimer.current) clearInterval(progressTimer.current);
      // Explicitly release the GPU video texture on Samsung Tizen / LG webOS.
      // The compositor keeps the YUV texture in VRAM until src is cleared and
      // load() is called — skipping this causes steady GPU memory leaks when
      // navigating between catalogue items or switching live/VOD modes.
      for (const slot of ["A", "B"] as const) {
        const v = getVideo(slot);
        if (v) {
          try { v.pause(); } catch { /* noop */ }
          try { v.removeAttribute("src"); v.load(); } catch { /* noop */ }
        }
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative", width: "100%", height: "100%", background: "#000",
        // overflow:hidden clips the ambient background blur edges.
        // In fullscreen this same clip causes the GPU compositor to paint the
        // video texture only within the pre-fullscreen bounds → black screen.
        // Clear it in fullscreen mode and rely on the container bg for the rest.
        overflow: isFs ? "visible" : "hidden",
        contain: isFs ? "layout style" : "layout style paint",
        isolation: "isolate",
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

      {/* Slot A — active/inactive surface. */}
      <video
        ref={videoA}
        style={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          objectFit: "contain",
          opacity: activeSlot === "A" ? 1 : 0,
          transition: "opacity 0.18s ease",
          zIndex: activeSlot === "A" ? 2 : 1,
          willChange: "transform, opacity",
          transform: "translateZ(0)",
          WebkitBackfaceVisibility: "hidden",
          backfaceVisibility: "hidden",
          display: "block",
        }}
        playsInline autoPlay preload="auto" muted={activeSlot !== "A"}
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
          transition: "opacity 0.18s ease",
          zIndex: activeSlot === "B" ? 2 : 1,
          willChange: "transform, opacity",
          transform: "translateZ(0)",
          WebkitBackfaceVisibility: "hidden",
          backfaceVisibility: "hidden",
          display: "block",
        }}
        playsInline autoPlay preload="auto" muted={activeSlot !== "B"}
        onTimeUpdate={activeSlot === "B" ? handleTimeUpdate : undefined}
        onError={() => handleError("B")}
        onPlaying={() => { if (activeSlot === "B") setLoading(false); }}
        onWaiting={() => { if (activeSlot === "B") setLoading(true); }}
      />

      {/* Loading veil */}
      {loading && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 10,
          background: "radial-gradient(ellipse at center, rgba(15,5,25,0.88) 0%, rgba(0,0,0,0.78) 100%)",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexDirection: "column", gap: 18,
        }}>
          <div style={{ position: "relative", width: 52, height: 52 }}>
            <svg
              viewBox="0 0 52 52"
              style={{
                position: "absolute", inset: 0, width: "100%", height: "100%",
                animation: "mp4-spin 1.4s linear infinite",
              }}
            >
              <circle cx="26" cy="26" r="22" fill="none" stroke="rgba(167,139,250,0.18)" strokeWidth="3" />
              <circle
                cx="26" cy="26" r="22" fill="none"
                stroke="rgba(167,139,250,0.85)" strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray="34.56 103.67"
                strokeDashoffset="0"
              />
            </svg>
            <div style={{
              position: "absolute", inset: "30%", borderRadius: "50%",
              background: "rgba(167,139,250,0.6)",
              animation: "mp4-pulse 2s ease-in-out infinite",
            }} />
          </div>
          <span style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, fontWeight: 500, letterSpacing: "0.05em" }}>
            Loading…
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

      {/* Back button */}
      {(controlsVisible || isLive) && (
        <button
          onClick={onBack}
          style={{
            position: "absolute",
            top: "var(--tv-safe-v, 24px)",
            left: "var(--tv-safe-h, 32px)",
            zIndex: 30,
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

      {/* VOD control bar */}
      {!isLive && controlsVisible && (
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 30,
          background: "linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.6) 55%, transparent 100%)",
          paddingTop: 56,
          paddingLeft: "var(--tv-safe-h, 40px)",
          paddingRight: "var(--tv-safe-h, 40px)",
          paddingBottom: "var(--tv-safe-v, 28px)",
        }}>
          {/* Title row */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14, gap: 16 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.12em", color: "rgba(255,255,255,0.45)", textTransform: "uppercase", marginBottom: 4 }}>
                Now Playing
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#fff", lineHeight: 1.25, maxWidth: "80vw", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {title}
              </div>
            </div>
            <div style={{
              flexShrink: 0, background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 700,
              color: "rgba(255,255,255,0.7)", backdropFilter: "blur(8px)", alignSelf: "flex-end",
            }}>
              MP4
            </div>
          </div>

          {/* Time display */}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,0.55)", marginBottom: 8 }}>
            <span>{fmtTime(currentTime)}</span>
            <span style={{ color: "rgba(255,255,255,0.35)" }}>
              {duration > 0 ? `−${fmtTime(Math.max(0, duration - currentTime))}` : ""}
            </span>
          </div>

          {/* Progress bar */}
          <div
            style={{
              height: 6, borderRadius: 3, background: "rgba(255,255,255,0.18)",
              marginBottom: 16, cursor: "pointer", position: "relative",
            }}
            onClick={(e) => {
              const v = getVideo(activeSlotRef.current);
              if (!v || !duration) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              v.currentTime = pct * duration;
            }}
          >
            {/* Buffered range */}
            <div style={{
              position: "absolute", top: 0, left: 0, height: "100%", borderRadius: 3,
              background: "rgba(255,255,255,0.15)",
              width: (() => {
                const v = videoA.current ?? videoB.current;
                if (!v || !duration || !v.buffered.length) return "0%";
                const end = v.buffered.end(v.buffered.length - 1);
                return `${Math.min(100, (end / duration) * 100)}%`;
              })(),
            }} />
            {/* Playback fill */}
            <div style={{ width: `${progress}%`, height: "100%", background: "#a855f7", borderRadius: 3, transition: "width 0.4s linear", position: "relative" }}>
              <div style={{
                position: "absolute", right: -6, top: "50%", transform: "translateY(-50%)",
                width: 14, height: 14, borderRadius: "50%", background: "#fff",
                boxShadow: "0 0 6px rgba(168,85,247,0.8)",
              }} />
            </div>
          </div>

          {/* Key hint row */}
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.28)", textAlign: "center", letterSpacing: "0.04em" }}>
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
        @keyframes mp4-spin { to { transform: rotate(360deg); } }
        @keyframes mp4-pulse {
          0%, 100% { opacity: 0.4; transform: scale(0.85); }
          50%       { opacity: 1;   transform: scale(1.15); }
        }
      `}</style>
    </div>
  );
}
