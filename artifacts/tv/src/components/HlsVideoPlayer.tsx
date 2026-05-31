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
const WATCHDOG_MS        = 9_000;
/**
 * How long a `stalled` or `waiting` event may persist before we attempt
 * a load() + play() recovery. 15 s gives hls.js enough time to exhaust
 * its own retry cycle (fragLoadingMaxRetry×delay ≈ 8 s) before we step
 * in — preventing a double-recovery on transient congestion. Chosen to
 * be longer than WATCHDOG_MS (9 s) so the one-shot initial-load watchdog
 * fires first; this timer covers stalls during ongoing playback.
 */
const STALL_FAIL_MS      = 15_000;

type Slot = "A" | "B";

function levelLabel(h?: number): string {
  if (!h) return "Auto";
  if (h >= 2160) return "4K";
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
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      // Tizen 5+ has native HLS support via the browser engine; set src and
      // mark the slot loaded. `setLoaded` must be called so the preload effect
      // doesn't re-fetch the same URL and so instant-swap detection works.
      video.src = url;
      video.load();
      setLoaded(slot, url);
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
      let mediaErrCount = 0;
      const hls = new HlsLib({
        enableWorker: true,
        // 30 s forward buffer is sufficient for smooth broadcast replay on
        // typical broadband; the previous 60 s caused gradual VRAM exhaustion
        // on Samsung Tizen / LG webOS after hours of continuous 24/7 playback
        // (these chipsets have ~1.5–2 GB total and keep YUV textures in GPU
        // memory proportional to the buffered segment count).
        // backBufferLength 0: broadcast TV never seeks backward — freeing back-
        // buffer VRAM immediately after the playhead advances gives a
        // significant long-session stability improvement on TV hardware.
        maxBufferLength: 30,
        backBufferLength: 0,
        maxMaxBufferLength: 60,
        startLevel: -1,              // auto-select by bandwidth probe
        capLevelToPlayerSize: true,  // don't load 1080p into a small container
        debug: false,
        // Start ABR with an 8 Mbps optimistic estimate — ensures fast
        // connections open at the highest available rendition instead of 360p.
        abrEwmaDefaultEstimate: 8_000_000,
        // Conservative bandwidth estimate (0.92) reduces unnecessary quality
        // downswitches during brief link fluctuations — keeps a stable level.
        // Faster up-factor (0.82) recovers quality within 2–3 stable segments
        // after a bandwidth dip without oscillating, matched to LiveBroadcastV2.
        abrBandWidthFactor: 0.92,
        abrBandWidthUpFactor: 0.82,
        // Fetch next fragment before current one ends (zero-gap transitions).
        startFragPrefetch: true,
        // SW AES fallback for Smart TV runtimes without HW crypto.
        enableSoftwareAES: true,
        maxFragLookUpTolerance: 0.2,
        // Retry on MSE append errors (codec/buffer pipeline hiccups on Tizen)
        // before escalating to a fatal error and triggering a full reload.
        appendErrorMaxRetry: 3,
        // Buffer health / segment continuity
        // highBufferWatchdogPeriod: nudge stalled high-buffer streams every 3 s
        // (catches the rare case where the decode pipeline is frozen even though
        // the buffer is ahead of the playhead — common on some LG webOS builds).
        highBufferWatchdogPeriod: 3,
        // maxBufferHole: bridge fragment discontinuities ≤ 250 ms so the player
        // jumps over tiny timestamp gaps instead of stalling. Default is 500 ms;
        // the tighter 250 ms threshold produces crisper segment joins and avoids
        // audible pops on content with minor mux imperfections.
        maxBufferHole: 0.25,
        // progressive: deliver decoded frames as bytes arrive rather than waiting
        // for the full 2 s segment — meaningful latency reduction on slower links.
        progressive: true,
        // Retry tuning
        lowLatencyMode: false,
        fragLoadingMaxRetry: 10,
        fragLoadingRetryDelay: 500,
        fragLoadingMaxRetryTimeout: 8_000,
        manifestLoadingMaxRetry: 8,
        manifestLoadingRetryDelay: 500,
        levelLoadingMaxRetry: 8,
        levelLoadingRetryDelay: 500,
        nudgeMaxRetry: 8,
        nudgeOffset: 0.3,
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
      let stallLevelDropped = false;
      hls.on(HlsLib.Events.ERROR, (_e, data) => {
        // ABR stall-drop: on non-fatal load stalls, immediately drop to the
        // lowest available rendition (if not already there) to shed a bitrate
        // that the current link cannot sustain. Regardless of the starting
        // level, always schedule an auto-recovery timer so the ABR engine
        // returns to automatic quality selection after 30 s of stable play.
        //
        // Previous bug: the recovery timer was inside the `currentLevel > 0`
        // guard, so streams already at level 0 (e.g. on a slow connection where
        // HLS.js had already auto-selected the lowest rendition) never scheduled
        // the recovery — meaning the ABR engine stayed pinned at level 0
        // permanently even after the connection recovered, causing sustained
        // low-quality video for the rest of the session.
        if (!data.fatal) {
          const isLoadStall =
            data.details === HlsLib.ErrorDetails.FRAG_LOAD_TIMEOUT ||
            data.details === HlsLib.ErrorDetails.FRAG_LOAD_ERROR ||
            data.details === HlsLib.ErrorDetails.LEVEL_LOAD_TIMEOUT ||
            data.details === HlsLib.ErrorDetails.LEVEL_LOAD_ERROR;
          if (isLoadStall && !stallLevelDropped) {
            stallLevelDropped = true;
            if (hls.currentLevel > 0) {
              hls.currentLevel = 0; // drop to lowest bitrate
            }
            // Always schedule auto-recovery — fires even when already at level 0.
            setTimeout(() => {
              try { stallLevelDropped = false; hls.currentLevel = -1; } catch { /* destroyed */ }
            }, 30_000);
          }
          return;
        }
        if (slot !== activeSlotRef.current) return;
        // Two-stage MEDIA_ERROR recovery — flush MSE pipeline before
        // giving up. Handles codec/decoder reset issues on Samsung/LG TVs.
        if (data.type === HlsLib.ErrorTypes.MEDIA_ERROR) {
          if (mediaErrCount === 0) {
            mediaErrCount++;
            hls.recoverMediaError();
            return;
          }
          if (mediaErrCount === 1) {
            mediaErrCount++;
            hls.swapAudioCodec();
            hls.recoverMediaError();
            return;
          }
        }
        handleError(slot);
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
      // Instant swap: the inactive slot already has the desired content
      // buffered, so we can transition with zero rebuffer time.
      const incoming = getVideo(inactive)!;
      const outgoing = getVideo(slot);
      incoming.muted  = false;
      incoming.volume = 1;
      incoming.play().catch(() => {});
      try { outgoing?.pause(); } catch { /* noop */ }
      // Clear the outgoing slot's loaded-URL so the preload effect treats it
      // as available for the NEXT nextHlsUrl. Without this, the outgoing slot
      // retains the old URL, and a subsequent nextHlsUrl that matches it would
      // be a false-positive "already preloaded" hit.
      setLoaded(slot, null);
      const nextSlot: Slot = slot === "A" ? "B" : "A";
      activeSlotRef.current = nextSlot;
      setActiveSlot(nextSlot);
      setLoading(false);
      // Start the stall watchdog for the newly-active slot so that a preloaded
      // video that stalls mid-play (HLS buffer underrun after the swap) is
      // caught and recovered — the watchdog is normally started in the
      // canplay handler of the fresh-load path but is bypassed here.
      startWatchdog();
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

  // ── Continuous stall watchdog ─────────────────────────────────────────────
  //
  // hls.js handles most HLS-level stalls internally via its retry/error cycle.
  // However, on Smart TV browsers (Tizen, webOS) the underlying <video> element
  // can stall without firing an hls.js fatal error — manifesting as a frozen
  // frame while audio continues (or silence). The `stalled` and `waiting` events
  // from the video element bridge this gap:
  //
  //   stalled — browser stopped downloading data (network-level stall)
  //   waiting  — playback paused waiting for more data (MSE buffer drained)
  //
  // When either fires we arm a timer. If the video doesn't recover within
  // STALL_FAIL_MS the timer fires a load() + play() recovery attempt —
  // identical to what the one-shot WATCHDOG_MS timer does after canplay,
  // but applicable throughout the entire playback lifetime.
  //
  // The timer is cancelled immediately when the video proves it has recovered:
  //   `playing`    — decoder resumed
  //   `timeupdate` — time is advancing (proxy for "playing without stutter")
  //   `canplay`    — buffer refilled
  //
  // We re-run this effect whenever the active slot or the current URL changes
  // so listeners always target the correct <video> element.

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
  // activeSlot state drives slot change re-runs; hlsUrl ensures we
  // reattach when a new stream loads into the same slot.
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
      // Destroy hls.js instances and explicitly release the GPU video texture.
      // On Samsung Tizen and LG webOS the compositor keeps the YUV texture
      // in VRAM until the <video> src is cleared and load() is called — skipping
      // this step causes a steady GPU memory leak when navigating between
      // catalogue items or switching live/VOD modes. hls.destroy() alone only
      // detaches MSE; it does not release the decoded frame buffer.
      for (const slot of ["A", "B"] as const) {
        try { getHls(slot)?.destroy(); } catch { /* noop */ }
        setHls(slot, null);
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
          areas that object-contain leaves around non-16:9 content.
          willChange+translateZ promote the element to its own GPU compositor
          layer, enabling zero-copy hardware decode and preventing overlay
          repaints (controls, title, badge) from invalidating the video pipeline. */}
      <video
        ref={videoA}
        style={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          objectFit: "contain",
          opacity: activeSlot === "A" ? 1 : 0,
          transition: "opacity 0.18s ease",
          zIndex: activeSlot === "A" ? 2 : 1,
          // willChange includes opacity so the compositor pre-promotes the
          // layer before the opacity animation begins — prevents a flash on
          // first slot swap caused by late promotion.
          willChange: "transform, opacity",
          transform: "translateZ(0)",
          // Prevent back-face ghost frames on 3D-transform hardware paths
          // (some AMD/Mali GPU drivers on Fire TV / LG webOS).
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
          {/* Cinematic SVG ring spinner — matches LiveBroadcastV2 style */}
          <div style={{ position: "relative", width: 52, height: 52 }}>
            <svg
              viewBox="0 0 52 52"
              style={{
                position: "absolute", inset: 0, width: "100%", height: "100%",
                animation: "hls-spin 1.4s linear infinite",
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
              animation: "hls-pulse 2s ease-in-out infinite",
            }} />
          </div>
          <span style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, fontWeight: 500, letterSpacing: "0.05em" }}>
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
          // Taller gradient for better legibility over bright content
          background: "linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.6) 55%, transparent 100%)",
          padding: "56px 40px 28px",
        }}>
          {/* Title + quality row */}
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
              {qualityLabel}
            </div>
          </div>

          {/* Time display */}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,0.55)", marginBottom: 8 }}>
            <span>{fmtTime(currentTime)}</span>
            <span style={{ color: "rgba(255,255,255,0.35)" }}>
              {duration > 0 ? `−${fmtTime(Math.max(0, duration - currentTime))}` : ""}
            </span>
          </div>

          {/* Progress bar — 6px with interactive scrub */}
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
            {/* Buffered range — light tint showing what's preloaded */}
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
              {/* Scrub thumb */}
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
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes hls-spin { to { transform: rotate(360deg); } }
        @keyframes hls-pulse {
          0%, 100% { opacity: 0.4; transform: scale(0.85); }
          50%       { opacity: 1;   transform: scale(1.15); }
        }
      `}</style>
    </div>
  );
}
