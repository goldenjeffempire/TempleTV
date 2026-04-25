import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { BroadcastItem } from "../lib/api";

interface LiveBroadcastVideoProps {
  item: BroadcastItem | null;
  /** Position into the current item (seconds) at the time the payload was fetched. */
  positionSecs: number;
  /** Server time (epoch ms) when the payload was generated — used for drift correction. */
  serverTimeMs: number;
  onError?: () => void;
}

/**
 * Hero-embedded live broadcast surface.
 *
 * This is NOT a preview, NOT a thumbnail loop, and NOT a fresh-start playthrough
 * of the current item. It joins the 24/7 ON AIR broadcast at the exact second
 * the server says is currently airing, and stays in sync with that timeline.
 *
 * Synchronization model
 * ─────────────────────
 *  • Initial seek: positionSecs + (now - serverTimeMs)/1000 — the wall-clock
 *    offset between when the server measured `positionSecs` and right now.
 *  • Drift correction: every 12s we compare the element's currentTime against
 *    the freshly recomputed live offset; if they diverge by more than 4s we
 *    seek to catch up. Small drift is left alone to avoid audible jumps.
 *  • Item swap: when the broadcast pipeline advances to a new item (item.id
 *    changes), we tear down the engine and re-init from the new item's start.
 *  • No loop: looping would re-show the same item forever and immediately
 *    desync from the queue. The server-driven SSE pipeline is what swaps to
 *    the next item — this component just rides along.
 *
 * Rendering
 * ─────────
 *  Two stacked layers — a blurred background fill (objectFit: cover) so the
 *  hero never shows letterbox bars, and a foreground video at objectFit:
 *  contain so the actual frame is never cropped. Both layers run from the
 *  same source/engine for perfect frame alignment.
 *
 * Audio
 * ─────
 *  Always muted: this is an ambient hero, not the dedicated player. Browsers
 *  block autoplay with audio anyway. The "Watch Temple TV" CTA navigates to
 *  the full Player which unmutes and gives the user controls.
 */
export function LiveBroadcastVideo({
  item,
  positionSecs,
  serverTimeMs,
  onError,
}: LiveBroadcastVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);
  const hlsFgRef = useRef<Hls | null>(null);
  const hlsBgRef = useRef<Hls | null>(null);
  const [ready, setReady] = useState(false);

  // Snapshot the latest sync data and callbacks in refs so the drift-check
  // interval and late-firing event handlers always see fresh values without
  // retriggering the heavy init effect on every poll. Critically, `onError`
  // is held in a ref so an inline `() => ...` from the parent doesn't churn
  // the engine on every parent re-render.
  const positionSecsRef = useRef(positionSecs);
  const serverTimeMsRef = useRef(serverTimeMs);
  const onErrorRef = useRef(onError);
  useEffect(() => { positionSecsRef.current = positionSecs; }, [positionSecs]);
  useEffect(() => { serverTimeMsRef.current = serverTimeMs; }, [serverTimeMs]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  // The video URL we should play. This intentionally does not depend on
  // positionSecs/serverTimeMs — we don't want to tear down the engine just
  // because the server published a new position payload.
  const url = item?.localVideoUrl ?? null;
  const itemId = item?.id ?? null;
  const durationSecs = item?.durationSecs ?? 0;

  // Compute the live offset for the *current item* — clamped to the item's
  // duration to avoid seeking past the end of a video while the server is
  // still in the middle of swapping to the next one.
  const computeLiveOffset = (): number => {
    const drift = (Date.now() - serverTimeMsRef.current) / 1000;
    const target = positionSecsRef.current + drift;
    if (durationSecs > 0) {
      return Math.max(0, Math.min(target, durationSecs - 0.5));
    }
    return Math.max(0, target);
  };

  // ── Engine init: re-runs only when the item swaps or the URL changes ──
  useEffect(() => {
    setReady(false);
    const fg = videoRef.current;
    const bg = bgVideoRef.current;
    if (!fg || !bg || !url) return;

    // Tear down any previous HLS instance before mounting a new one.
    const teardown = () => {
      try { hlsFgRef.current?.destroy(); } catch { /* noop */ }
      try { hlsBgRef.current?.destroy(); } catch { /* noop */ }
      hlsFgRef.current = null;
      hlsBgRef.current = null;
    };
    teardown();

    const isHls = /\.m3u8(\?|$)/i.test(url);
    let cancelled = false;

    const seekToLive = (el: HTMLVideoElement) => {
      const t = computeLiveOffset();
      try { el.currentTime = t; } catch { /* some streams reject early seeks */ }
    };

    const armNativeOrMp4 = (el: HTMLVideoElement, isForeground: boolean) => {
      // Same source; native HLS in Safari, plain MP4 elsewhere.
      el.src = url;
      const onLoaded = () => {
        seekToLive(el);
        // Try to play (muted autoplay is allowed). Failures are non-fatal —
        // any user interaction with the page will unblock it.
        el.play().catch(() => { /* autoplay-policy: ignored, hero is ambient */ });
        if (isForeground && !cancelled) setReady(true);
        el.removeEventListener("loadedmetadata", onLoaded);
      };
      el.addEventListener("loadedmetadata", onLoaded);
    };

    const armHls = (el: HTMLVideoElement, isForeground: boolean) => {
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          // Match HlsVideoPlayer: don't include credentials so the prod CDN's
          // CORS allow-list isn't required to echo a specific origin.
          xhrSetup: (xhr) => { xhr.withCredentials = false; },
        });
        if (isForeground) hlsFgRef.current = hls;
        else hlsBgRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(el);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          seekToLive(el);
          el.play().catch(() => { /* autoplay-policy */ });
          if (isForeground && !cancelled) setReady(true);
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal && isForeground && !cancelled) onErrorRef.current?.();
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
      teardown();
      // Reset src so the next mount cleanly attaches.
      try { fg.removeAttribute("src"); fg.load(); } catch { /* noop */ }
      try { bg.removeAttribute("src"); bg.load(); } catch { /* noop */ }
    };
    // `onError` is intentionally read via onErrorRef inside the effect so an
    // inline parent callback doesn't churn the engine on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, itemId]);

  // ── Drift correction loop ─────────────────────────────────────────────
  // Every 12s, if the foreground video has drifted more than 4s from the
  // expected live offset, jump to catch up. We keep the threshold loose so
  // micro-stutters from buffering don't cause user-visible re-seeks.
  useEffect(() => {
    if (!url) return;
    const tick = setInterval(() => {
      const fg = videoRef.current;
      const bg = bgVideoRef.current;
      if (!fg || fg.readyState < 2) return;
      const expected = computeLiveOffset();
      const drift = Math.abs(fg.currentTime - expected);
      if (drift > 4) {
        try { fg.currentTime = expected; } catch { /* noop */ }
        try { if (bg) bg.currentTime = expected; } catch { /* noop */ }
      } else if (bg && Math.abs(bg.currentTime - fg.currentTime) > 0.4) {
        // Keep the blur layer aligned with the foreground so they don't
        // show different frames.
        try { bg.currentTime = fg.currentTime; } catch { /* noop */ }
      }
    }, 12_000);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, itemId]);

  if (!url) return null;

  return (
    <>
      {/* Blurred backdrop layer — fills the whole frame so we never see
          letterbox bars at the edges. */}
      <video
        ref={bgVideoRef}
        muted
        autoPlay
        playsInline
        // Intentionally omit crossOrigin: prod CDN CORS doesn't whitelist
        // every origin we render on (Replit dev preview, custom domains,
        // embeds) and we never need to read pixels from this element.
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          pointerEvents: "none",
          filter: "blur(28px) saturate(1.4) brightness(0.5)",
          transform: "scale(1.08)",
          opacity: ready ? 1 : 0,
          transition: "opacity 1200ms ease",
        }}
      />
      {/* Foreground content layer — original aspect ratio, never cropped. */}
      <video
        ref={videoRef}
        muted
        autoPlay
        playsInline
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
          pointerEvents: "none",
          opacity: ready ? 1 : 0,
          transition: "opacity 1400ms ease",
        }}
      />
    </>
  );
}
