import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { BroadcastItem } from "../lib/api";

/**
 * Structural shape of "the next thing to play" — accepts both the rich
 * `BroadcastItem` from REST and the slimmer `BroadcastNextItem` from the
 * SSE sync hook. Only `localVideoUrl` and `durationSecs` are read here.
 */
interface NextItemShape {
  localVideoUrl?: string | null;
  durationSecs?: number;
}

interface LiveBroadcastVideoProps {
  item: BroadcastItem | null;
  /** Position into the current item (seconds) at the time the payload was fetched. */
  positionSecs: number;
  /** Server time (epoch ms) when the payload was generated — used for drift correction. */
  serverTimeMs: number;
  /** Next queued item — preloaded silently into the inactive slot for instant cut-over. */
  nextItem?: NextItemShape | null;
  onError?: () => void;
}

type Slot = "A" | "B";

/**
 * Hero-embedded live broadcast surface with A/B double-buffered playback.
 *
 * This is NOT a preview, NOT a thumbnail loop, and NOT a fresh-start playthrough
 * of the current item. It joins the 24/7 ON AIR broadcast at the exact second
 * the server says is currently airing, and stays in sync with that timeline.
 *
 * Seamless transitions
 * ────────────────────
 * Two foreground + two background <video> elements are mounted at all times.
 * One slot is "active" (visible, playing, audio-able) and the other is
 * "inactive" (hidden, muted, paused on first frame of the upcoming item).
 * When the broadcast pipeline advances:
 *   • If the inactive slot has already preloaded the new item's URL → we simply
 *     swap which slot is visible. No teardown, no manifest fetch, no spinner,
 *     no black frame.
 *   • If preload missed (rare — the URL changed without warning) → we load
 *     the new URL into the inactive slot and swap once it's ready, leaving
 *     the previous slot showing until the new one decodes its first frame.
 *
 * Synchronization
 * ───────────────
 *  • Initial seek: positionSecs + (now - serverTimeMs)/1000.
 *  • Drift correction: every 12s we compare the active element's currentTime
 *    against the freshly recomputed live offset; if they diverge by more than
 *    4s we seek to catch up.
 *  • No loop: looping would re-show the same item forever and immediately
 *    desync from the queue.
 *
 * Audio
 * ─────
 *  Always muted: this is an ambient hero, not the dedicated player.
 */
export function LiveBroadcastVideo({
  item,
  positionSecs,
  serverTimeMs,
  nextItem,
  onError,
}: LiveBroadcastVideoProps) {
  // Foreground (objectFit: contain) and background (objectFit: cover, blurred)
  // for each slot. Both slots in a pair share the same source/engine so the
  // blur never shows a different frame than the foreground.
  const fgRefA = useRef<HTMLVideoElement | null>(null);
  const fgRefB = useRef<HTMLVideoElement | null>(null);
  const bgRefA = useRef<HTMLVideoElement | null>(null);
  const bgRefB = useRef<HTMLVideoElement | null>(null);

  // hls.js instances per slot per layer (4 total). Tracked separately so we
  // can destroy a slot's instances cleanly when reusing it for a new URL.
  const hlsFgARef = useRef<Hls | null>(null);
  const hlsFgBRef = useRef<Hls | null>(null);
  const hlsBgARef = useRef<Hls | null>(null);
  const hlsBgBRef = useRef<Hls | null>(null);

  // Which URL each slot has loaded (null = empty). Used to decide whether a
  // queue advance can be served by an instant swap or requires a fresh load.
  const loadedUrlA = useRef<string | null>(null);
  const loadedUrlB = useRef<string | null>(null);
  // Per-slot "ready" flag — true once that slot's foreground element has
  // produced a frame and is safe to reveal without showing a black box.
  const readyA = useRef(false);
  const readyB = useRef(false);

  const [activeSlot, setActiveSlot] = useState<Slot>("A");
  // True only on the very first cold start before any slot has produced a
  // frame. Used to decide whether to render *anything* visible at all.
  const [hasEverShown, setHasEverShown] = useState(false);

  const positionSecsRef = useRef(positionSecs);
  const serverTimeMsRef = useRef(serverTimeMs);
  const onErrorRef = useRef(onError);
  useEffect(() => { positionSecsRef.current = positionSecs; }, [positionSecs]);
  useEffect(() => { serverTimeMsRef.current = serverTimeMs; }, [serverTimeMs]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  // Network-aware "we're holding because the device is offline" flag.
  // Set by the hls.js error handler when a NETWORK_ERROR fires while
  // navigator.onLine is false; cleared by the `online` listener below
  // after it kicks the slot's hls.js engine to resume loading. Suppresses
  // the onError → broken-item-skip path for the duration of the outage.
  const offlineWaitingRef = useRef(false);
  // ── Online recovery: kick all live hls.js engines on reconnect ─────────
  // The ambient hero has no visible "Reconnecting…" surface (the hero is
  // intentionally chrome-less), but it still needs to recover. On `online`
  // edge, ask every mounted hls.js instance (active + preload, fg + bg)
  // to resume loading. The browser keeps the last decoded frame on the
  // <video> element until the stream picks back up.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOnline = () => {
      if (!offlineWaitingRef.current) return;
      offlineWaitingRef.current = false;
      for (const ref of [hlsFgARef, hlsFgBRef, hlsBgARef, hlsBgBRef]) {
        try { ref.current?.startLoad(); } catch { /* noop */ }
      }
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  const url = item?.localVideoUrl ?? null;
  const itemId = item?.id ?? null;
  const durationSecs = item?.durationSecs ?? 0;
  const nextUrl = nextItem?.localVideoUrl ?? null;
  const nextDurationSecs = nextItem?.durationSecs ?? 0;

  const computeLiveOffset = (durSecs: number): number => {
    const drift = (Date.now() - serverTimeMsRef.current) / 1000;
    const target = positionSecsRef.current + drift;
    if (durSecs > 0) return Math.max(0, Math.min(target, durSecs - 0.5));
    return Math.max(0, target);
  };

  // ── Per-slot loader: attaches hls.js (or native HLS / MP4) to a slot's
  //    foreground + background elements. Returns a teardown function.
  //    If `seekTarget` is provided, foreground starts there; otherwise 0.
  //    `onReady` fires when the foreground decodes its first frame.
  const loadSlot = (
    slot: Slot,
    targetUrl: string,
    seekTarget: number | null,
    onReady: () => void,
  ): (() => void) => {
    const fg = slot === "A" ? fgRefA.current : fgRefB.current;
    const bg = slot === "A" ? bgRefA.current : bgRefB.current;
    if (!fg || !bg) return () => {};

    // Destroy any previous engines in this slot.
    const setHlsRef = (layer: "fg" | "bg", h: Hls | null) => {
      if (slot === "A") {
        if (layer === "fg") hlsFgARef.current = h;
        else hlsBgARef.current = h;
      } else {
        if (layer === "fg") hlsFgBRef.current = h;
        else hlsBgBRef.current = h;
      }
    };
    const getHlsRef = (layer: "fg" | "bg"): Hls | null => {
      if (slot === "A") return layer === "fg" ? hlsFgARef.current : hlsBgARef.current;
      return layer === "fg" ? hlsFgBRef.current : hlsBgBRef.current;
    };
    try { getHlsRef("fg")?.destroy(); } catch { /* noop */ }
    try { getHlsRef("bg")?.destroy(); } catch { /* noop */ }
    setHlsRef("fg", null);
    setHlsRef("bg", null);

    if (slot === "A") { loadedUrlA.current = targetUrl; readyA.current = false; }
    else { loadedUrlB.current = targetUrl; readyB.current = false; }

    let cancelled = false;
    const isHls = /\.m3u8(\?|$)/i.test(targetUrl);

    const seekIfNeeded = (el: HTMLVideoElement) => {
      if (seekTarget === null) return;
      try { el.currentTime = seekTarget; } catch { /* noop */ }
    };

    const armNativeOrMp4 = (el: HTMLVideoElement, isForeground: boolean) => {
      el.src = targetUrl;
      const onLoaded = () => {
        seekIfNeeded(el);
        // Always try to play — muted autoplay is allowed everywhere.
        el.play().catch(() => { /* ambient — ignore */ });
        if (isForeground && !cancelled) {
          if (slot === "A") readyA.current = true; else readyB.current = true;
          onReady();
        }
        el.removeEventListener("loadedmetadata", onLoaded);
      };
      el.addEventListener("loadedmetadata", onLoaded);
    };

    const armHls = (el: HTMLVideoElement, isForeground: boolean) => {
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          xhrSetup: (xhr) => { xhr.withCredentials = false; },
        });
        setHlsRef(isForeground ? "fg" : "bg", hls);
        hls.loadSource(targetUrl);
        hls.attachMedia(el);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          seekIfNeeded(el);
          el.play().catch(() => { /* ambient */ });
          if (isForeground && !cancelled) {
            if (slot === "A") readyA.current = true; else readyB.current = true;
            onReady();
          }
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal || !isForeground || cancelled) return;
          // Network-aware: when the device is offline, the right
          // behavior is to NOT escalate to onError — the parent surface
          // would route that to a broken-item skip. Hold the slot,
          // wait for `online`, and ask hls.js to resume loading; the
          // slot's last decoded frame stays on screen in the meantime.
          // Only NETWORK_ERROR is treated this way — MEDIA_ERROR and
          // OTHER_ERROR still escalate so genuinely broken URLs roll
          // forward to the next queue item.
          const offline = typeof navigator !== "undefined" && navigator.onLine === false;
          const isNetwork = data.type === Hls.ErrorTypes.NETWORK_ERROR;
          if (isNetwork && offline) {
            offlineWaitingRef.current = true;
            return;
          }
          if (isNetwork) {
            // Online but a network-class error — try one quiet
            // recovery before escalating. hls.startLoad is a no-cost
            // re-fetch of the failing segment.
            try { hls.startLoad(); } catch { /* noop */ }
            return;
          }
          onErrorRef.current?.();
        });
      } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
        armNativeOrMp4(el, isForeground);
      } else if (isForeground && !cancelled) {
        onErrorRef.current?.();
      }
    };

    if (isHls) {
      armHls(fg, true);
      armHls(bg, false);
    } else {
      armNativeOrMp4(fg, true);
      armNativeOrMp4(bg, false);
    }

    return () => {
      cancelled = true;
      try { getHlsRef("fg")?.destroy(); } catch { /* noop */ }
      try { getHlsRef("bg")?.destroy(); } catch { /* noop */ }
      setHlsRef("fg", null);
      setHlsRef("bg", null);
    };
  };

  // ── Active slot management: ensure the *current* item is loaded into the
  //    active slot. If neither slot has it, load the active slot from
  //    scratch and seek to the live offset.
  useEffect(() => {
    if (!url) return;
    const activeUrl = activeSlot === "A" ? loadedUrlA.current : loadedUrlB.current;
    const inactiveUrl = activeSlot === "A" ? loadedUrlB.current : loadedUrlA.current;

    // Already playing this URL on the active slot — nothing to do.
    if (activeUrl === url) return;

    // The inactive slot has it preloaded — instant swap (no teardown).
    if (inactiveUrl === url) {
      const newSlot: Slot = activeSlot === "A" ? "B" : "A";
      const newFg = newSlot === "A" ? fgRefA.current : fgRefB.current;
      const newBg = newSlot === "A" ? bgRefA.current : bgRefB.current;
      // Resync to live offset and resume playback (preloaded slot was paused).
      if (newFg) {
        try { newFg.currentTime = computeLiveOffset(durationSecs); } catch { /* noop */ }
        newFg.play().catch(() => {});
      }
      if (newBg) {
        try { newBg.currentTime = computeLiveOffset(durationSecs); } catch { /* noop */ }
        newBg.play().catch(() => {});
      }
      setActiveSlot(newSlot);
      setHasEverShown(true);
      return;
    }

    // Fresh load into the active slot (cold start or preload miss).
    const teardown = loadSlot(activeSlot, url, computeLiveOffset(durationSecs), () => {
      setHasEverShown(true);
    });
    return teardown;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, itemId]);

  // ── Inactive slot preloader: keeps the upcoming item warm so the queue
  //    advance feels instantaneous. Never seeks past 0 — preloaded media
  //    is paused at the start, ready to be revealed and resynced on swap.
  useEffect(() => {
    if (!nextUrl) return;
    // Don't preload the next item into the slot the active one already uses.
    const inactive: Slot = activeSlot === "A" ? "B" : "A";
    const inactiveLoaded = inactive === "A" ? loadedUrlA.current : loadedUrlB.current;
    if (inactiveLoaded === nextUrl) return;
    // Don't waste bandwidth if the next item is the same URL as the active one.
    const activeLoaded = activeSlot === "A" ? loadedUrlA.current : loadedUrlB.current;
    if (activeLoaded === nextUrl) return;

    // Preloaded media starts at 0, paused; the swap effect resyncs to the
    // live offset and starts playback when the queue actually advances.
    const teardown = loadSlot(inactive, nextUrl, 0, () => {
      // After preload arms playback, immediately pause so we don't burn data
      // playing the next item ahead of time. We keep it muted so even if a
      // browser races and emits audio for a frame, nobody hears it.
      const el = inactive === "A" ? fgRefA.current : fgRefB.current;
      const elBg = inactive === "A" ? bgRefA.current : bgRefB.current;
      if (el) { try { el.pause(); el.currentTime = 0; } catch { /* noop */ } }
      if (elBg) { try { elBg.pause(); elBg.currentTime = 0; } catch { /* noop */ } }
    });
    return teardown;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextUrl, activeSlot]);

  // ── Drift correction loop: keeps the active slot in lockstep with server
  //    time. Loose threshold so micro-stutters from buffering don't cause
  //    user-visible re-seeks.
  useEffect(() => {
    if (!url) return;
    const tick = setInterval(() => {
      const fg = activeSlot === "A" ? fgRefA.current : fgRefB.current;
      const bg = activeSlot === "A" ? bgRefA.current : bgRefB.current;
      if (!fg || fg.readyState < 2) return;
      const expected = computeLiveOffset(durationSecs);
      const drift = Math.abs(fg.currentTime - expected);
      if (drift > 4) {
        try { fg.currentTime = expected; } catch { /* noop */ }
        try { if (bg) bg.currentTime = expected; } catch { /* noop */ }
      } else if (bg && Math.abs(bg.currentTime - fg.currentTime) > 0.4) {
        try { bg.currentTime = fg.currentTime; } catch { /* noop */ }
      }
    }, 12_000);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, itemId, activeSlot, durationSecs]);

  // Unmount: destroy all engines.
  useEffect(() => {
    return () => {
      try { hlsFgARef.current?.destroy(); } catch { /* noop */ }
      try { hlsFgBRef.current?.destroy(); } catch { /* noop */ }
      try { hlsBgARef.current?.destroy(); } catch { /* noop */ }
      try { hlsBgBRef.current?.destroy(); } catch { /* noop */ }
    };
  }, []);

  if (!url) return null;

  // Reference nextDurationSecs so it's not flagged unused — it's available
  // for downstream sizing/UI hints if/when we surface upcoming-item metadata.
  void nextDurationSecs;

  const slotStyle = (slot: Slot, layer: "bg" | "fg"): React.CSSProperties => {
    const isActive = slot === activeSlot;
    const base: React.CSSProperties = {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      // The active slot is visible once the surface has ever shown a frame
      // (covers cold-start fade-in). Inactive slots are always invisible —
      // they're warming up the next item in the queue.
      opacity: isActive && hasEverShown ? 1 : 0,
      // Long fade only for the very first reveal; subsequent swaps are
      // visually instantaneous (1 frame) so the cut feels like a TV channel.
      transition: hasEverShown ? "opacity 60ms linear" : (layer === "fg" ? "opacity 1400ms ease" : "opacity 1200ms ease"),
    };
    if (layer === "bg") {
      return {
        ...base,
        objectFit: "cover",
        filter: "blur(28px) saturate(1.4) brightness(0.5)",
        transform: "scale(1.08)",
      };
    }
    return {
      ...base,
      objectFit: "contain",
    };
  };

  return (
    <>
      {/* Slot A: bg + fg */}
      <video ref={bgRefA} muted autoPlay playsInline style={slotStyle("A", "bg")} />
      <video ref={fgRefA} muted autoPlay playsInline style={slotStyle("A", "fg")} />
      {/* Slot B: bg + fg */}
      <video ref={bgRefB} muted autoPlay playsInline style={slotStyle("B", "bg")} />
      <video ref={fgRefB} muted autoPlay playsInline style={slotStyle("B", "fg")} />
    </>
  );
}
