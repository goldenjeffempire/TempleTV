/**
 * LiveBroadcastV2 — TV broadcast surface backed by `@workspace/player-core`.
 *
 * Replaces the v1 `LiveBroadcastVideo` for the new control plane. The shared
 * `useV2Broadcast` hook owns the FSM, A/B-buffer adapter, transport, and
 * watchdog — this component only:
 *   • mounts two persistent <video> elements (the "buffers"),
 *   • injects hls.js via `attachHls` (TV bundle already ships hls.js),
 *   • renders 10-foot UI overlays driven by the FSM snapshot.
 *
 * Layout strategy — two variants:
 *   "hero"   → object-cover: fills the entire container with no black bars.
 *              The video is centre-cropped if its aspect ratio differs from
 *              the container — acceptable for a background hero preview.
 *   "player" → object-contain: full video frame always visible, centred.
 *              The cinematic ambient blur layer fills any letterbox/pillarbox
 *              areas that object-contain leaves around non-16:9 content.
 *
 * Container is always position:absolute / inset:0 so it fills its parent
 * reliably regardless of whether the parent propagates height via percentage
 * chains or flex/grid sizing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { useV2Broadcast } from "@workspace/player-core/react";
import { resolveApiOrigin } from "../lib/api";

// ── Midnight Prayers channel switching ───────────────────────────────────────

interface MPScheduleConfig {
  enabled: boolean;
  startHour: number;
  endHour: number;
}

function isInMpWindow(cfg: MPScheduleConfig): boolean {
  if (!cfg.enabled) return false;
  const h = new Date().getHours();
  return cfg.endHour > cfg.startHour
    ? h >= cfg.startHour && h < cfg.endHour
    : h >= cfg.startHour || h < cfg.endHour;
}

/**
 * Fetches the Midnight Prayers schedule config once and then polls the local
 * clock every 60 s to decide which broadcast channel to subscribe to.
 * Returns the baseUrl the player should use for the current moment.
 */
function useMidnightPrayersSwitch(mainBaseUrl: string): string {
  const [cfg, setCfg] = useState<MPScheduleConfig | null>(null);
  const [inWindow, setInWindow] = useState(false);

  useEffect(() => {
    const apiOrigin = resolveApiOrigin();
    fetch(`${apiOrigin}/api/midnight-prayers/config`)
      .then((r) => (r.ok ? (r.json() as Promise<MPScheduleConfig>) : null))
      .then((data) => { if (data) setCfg(data); })
      .catch(() => { /* ignore — stay on main channel */ });
  }, []);

  useEffect(() => {
    if (!cfg) return;
    const check = () => setInWindow(isInMpWindow(cfg));
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, [cfg]);

  if (!cfg || !inWindow) return mainBaseUrl;
  return `${resolveApiOrigin()}/api/midnight-prayers`;
}

interface Props {
  /**
   * Base URL for the v2 broadcast API.
   * Defaults to `resolveApiOrigin() + "/api/broadcast-v2"`.
   */
  baseUrl?: string;
  /** Channel id — multi-channel comes after cut-over. */
  channelId?: string;
  /** Bubble fatal player state up to parent so it can route to fallback UI. */
  onFatal?: () => void;
  /**
   * "hero"   → object-cover fills the frame (no black bars; slight centre-crop
   *            on non-16:9 sources). Use for hero preview banners.
   * "player" → object-contain shows the full video frame (black bars filled by
   *            the ambient blur layer). Use for full-screen playback.
   * @default "player"
   */
  variant?: "hero" | "player";
}

/**
 * Attach an HLS source to a <video> element via hls.js (non-WebKit) or
 * native HLS (Safari / WebKit-based Smart TVs).
 *
 * Key improvements over the previous version:
 *
 * Native HLS (Safari/WebKit):
 *   - Silent reload recovery: on a first `error` event the element is
 *     reset and reloaded once before propagating. Covers CDN transient
 *     failures that WebKit's built-in HLS engine doesn't retry.
 *
 * hls.js path:
 *   - `startLevel: -1`  → auto-ABR from the first segment rather than
 *     always starting at rendition 0 (which may be 240p on a fast link).
 *   - Larger buffers (60 s forward, 60 s back) so brief pauses / tab
 *     switches never drain the buffer completely.
 *   - `startFragPrefetch: true` → fetches the next fragment in the
 *     playlist before the current one finishes, eliminating the small
 *     decode gap between segments on slow-manifest servers.
 *   - HLS.Events.ERROR handler with two-stage MEDIA_ERROR recovery:
 *       1. `recoverMediaError()` — flushes the codec pipeline without
 *          destroying the MSE source buffer (fast, lossless).
 *       2. `swapAudioCodec() + recoverMediaError()` — handles AAC/HE-AAC
 *          codec confusion on some Smart TV chipsets.
 *     Fatal NETWORK_ERROR (all retries exhausted) or unrecoverable
 *     MEDIA_ERROR dispatches a synthetic "error" event on the <video>
 *     element so the player-core web adapter transitions the FSM to
 *     RECOVERING_PRIMARY immediately rather than waiting 15 s for the
 *     stall watchdog to fire.
 *   - FRAG_LOAD_TIMEOUT stall recovery: when a fragment stall is detected
 *     by hls.js, the current quality level is immediately dropped to the
 *     lowest available rendition before hls.js invokes its retry budget.
 *     This prevents a quality-induced stall from exhausting all retries
 *     at a high bitrate when a lower rendition would have succeeded.
 */
function attachHls(video: HTMLVideoElement, url: string): () => void {
  // ── Native HLS path (Safari / WebKit-based TVs) ─────────────────────
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    let nativeRetried = false;
    const handleNativeError = () => {
      if (!nativeRetried && video.error?.code === MediaError.MEDIA_ERR_NETWORK) {
        // One silent reload for transient network blips. If it fails again
        // the video element fires another `error` which propagates normally
        // to the player-core web adapter.
        nativeRetried = true;
        video.load();
        void video.play().catch(() => { /* autoplay policy — stall watchdog handles */ });
        return;
      }
      // Propagate all other errors (MEDIA_ERR_DECODE etc.) or the second
      // network error immediately — let the FSM run its recovery cycle.
    };
    video.addEventListener("error", handleNativeError);
    video.src = url;
    return () => {
      video.removeEventListener("error", handleNativeError);
      video.removeAttribute("src");
      video.load();
    };
  }

  // ── hls.js fallback (all other browsers / TV runtimes) ──────────────
  if (!Hls.isSupported()) {
    // Last-resort direct src assignment (old Smart TV browsers that support
    // neither native HLS nor MSE). Playback may fail silently on such
    // devices, but the player-core stall watchdog will catch it.
    video.src = url;
    return () => {
      video.removeAttribute("src");
      video.load();
    };
  }

  let mediaErrorCount = 0;

  // ── ABR quality cap on stall ─────────────────────────────────────────
  // When hls.js detects a fragment-load timeout (non-fatal), immediately
  // drop to the lowest available quality level. This prevents a single
  // high-bitrate stall from consuming the entire frag retry budget when a
  // lower rendition would succeed. The ABR engine will ramp back up once
  // bandwidth is confirmed stable.
  //
  // We listen for ALL non-fatal errors rather than only FRAG_LOAD_TIMEOUT
  // because hls.js may classify a congested link as FRAG_LOAD_ERROR before
  // the timeout fires. Both ultimately indicate "current level too heavy".
  let stallLevelDropped = false;
  const handleHlsStallDrop = (_evt: unknown, data: { fatal: boolean; details: string }) => {
    if (data.fatal) return; // fatal errors handled below in the main error listener
    if (stallLevelDropped) return; // only drop once per hls instance
    const isLoadStall =
      data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT ||
      data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
      data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
      data.details === Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT;
    if (!isLoadStall) return;
    const currentLevel = hls.currentLevel;
    const lowestLevel = 0;
    if (currentLevel > lowestLevel) {
      stallLevelDropped = true;
      hls.currentLevel = lowestLevel;
      // Allow ABR to recover after 30 s of stable play at the lower level.
      setTimeout(() => {
        stallLevelDropped = false;
        hls.currentLevel = -1; // auto
      }, 30_000);
    }
  };

  const hls = new Hls({
    // ── Latency / buffer ─────────────────────────────────────────────
    lowLatencyMode: false,          // stability over latency for broadcast replay
    backBufferLength: 60,           // keep 60 s behind playhead — instant resume after
                                    //   screen-dim/lock/tab-switch without re-buffering
    maxBufferLength: 60,            // build 60 s ahead — eliminates mid-segment rebuffers
    maxMaxBufferLength: 120,        // allow up to 2 min buffer on very fast connections

    // ── ABR / quality ────────────────────────────────────────────────
    startLevel: -1,                 // auto — let EWMA bandwidth probe pick first level
    capLevelToPlayerSize: true,     // never load 1080p into a 480p container
    // Start ABR with an optimistic 8 Mbps baseline. On fast connections this
    // causes hls.js to probe the highest rendition first instead of always
    // opening at 360p; on slow links it converges down within 2–3 segments.
    // 8 Mbps is above our highest rendition (4.5 Mbps 1080p) so ABR always
    // starts with the best quality the container size permits.
    abrEwmaDefaultEstimate: 8_000_000,
    abrBandWidthFactor: 0.90,       // conservative BW estimate — prefer stream stability
    abrBandWidthUpFactor: 0.75,     // moderate upgrade speed — ramps up once link is stable

    // ── Reliability ──────────────────────────────────────────────────
    enableWorker: true,             // offload muxer/demuxer to Web Worker thread
    autoStartLoad: true,
    startFragPrefetch: true,        // fetch next fragment before current ends (zero-gap)
    // Enable software AES-128 fallback for Smart TV chipsets lacking hardware
    // crypto acceleration (some WebOS 3.x, Tizen 2.x). Without this, HW
    // crypto failures cause silent stalls with no error event.
    enableSoftwareAES: true,
    maxFragLookUpTolerance: 0.2,    // tighter fragment boundary matching

    // ── Retry budgets ────────────────────────────────────────────────
    fragLoadingMaxRetry: 10,
    fragLoadingRetryDelay: 500,
    fragLoadingMaxRetryTimeout: 8_000,
    manifestLoadingMaxRetry: 8,
    manifestLoadingRetryDelay: 500,
    levelLoadingMaxRetry: 8,
    levelLoadingRetryDelay: 500,
    nudgeMaxRetry: 8,
    nudgeOffset: 0.3,               // small nudge avoids large seek on stall recovery
  });

  // ── Fatal error recovery ─────────────────────────────────────────────
  // hls.js distinguishes MEDIA_ERROR (codec/MSE issue — often recoverable)
  // from NETWORK_ERROR (all retries exhausted — not recoverable).
  //
  // Without this handler, a fatal error silently kills the hls instance.
  // The <video> element may never fire `error` (MSE errors don't always
  // propagate to the media element's error attribute), so the player-core
  // stall watchdog would wait 15 s before triggering FSM recovery. With
  // this handler the FSM learns about the failure in <1 s.
  hls.on(Hls.Events.ERROR, handleHlsStallDrop);

  hls.on(Hls.Events.ERROR, (_evt, data) => {
    if (!data.fatal) return; // non-fatal: hls.js self-heals internally

    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      if (mediaErrorCount === 0) {
        // First attempt: soft MSE pipeline flush — fast, no re-download.
        mediaErrorCount++;
        hls.recoverMediaError();
        return;
      }
      if (mediaErrorCount === 1) {
        // Second attempt: swap audio codec (fixes AAC/HE-AAC confusion on
        // some Smart TV chipsets, e.g. WebOS 4, Tizen 4) then re-flush.
        mediaErrorCount++;
        hls.swapAudioCodec();
        hls.recoverMediaError();
        return;
      }
      // Two recovery attempts failed — fall through to synthetic error.
    }

    // Fatal NETWORK_ERROR (all manifest/fragment retries exhausted) or
    // unrecoverable MEDIA_ERROR: dispatch a synthetic `error` event on
    // the <video> element.  The player-core web adapter's `error` listener
    // sends `buffer-error` to the FSM so it immediately enters
    // RECOVERING_PRIMARY rather than waiting for the stall watchdog.
    try {
      video.dispatchEvent(new Event("error"));
    } catch {
      // Some older TV browsers throw on dispatchEvent for media elements.
      // The stall watchdog will catch the frozen stream within 15 s.
    }
  });

  hls.loadSource(url);
  hls.attachMedia(video);

  // After a fullscreen transition the browser finishes re-compositing before
  // firing fullscreenchange.  At that point clientWidth/clientHeight reflect
  // the new viewport dimensions.  Calling hls.currentLevel = -1 forces the
  // ABR engine to re-evaluate quality at the correct size rather than the
  // stale pre-transition value it may have cached via capLevelToPlayerSize.
  // Without this, quality can be locked to the pre-fullscreen rendition for
  // up to ~5 seconds and the level-switch pipeline flush freezes video while
  // audio (separately buffered) continues unaffected.
  const onFsChange = () => {
    if (!document.fullscreenElement) return;
    // Double rAF: first ensures the browser has committed the fullscreen
    // layout; second gives hls.js a tick to observe the new dimensions.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      hls.currentLevel = -1; // re-trigger auto ABR at fullscreen dimensions
    }));
  };
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);

  return () => {
    document.removeEventListener("fullscreenchange", onFsChange);
    document.removeEventListener("webkitfullscreenchange", onFsChange);
    try { hls.destroy(); } catch { /* ignore */ }
  };
}

export function LiveBroadcastV2({
  baseUrl,
  channelId: _channelId = "main",
  onFatal,
  variant = "player",
}: Props) {
  void _channelId;
  const mainBaseUrl = baseUrl ?? `${resolveApiOrigin()}/api/broadcast-v2`;
  const effectiveBaseUrl = useMidnightPrayersSwitch(mainBaseUrl);
  const { snapshot, connected, attach } = useV2Broadcast({ baseUrl: effectiveBaseUrl, attachHls });
  const fatalFiredRef = useRef(false);

  useEffect(() => {
    if (snapshot.state === "FATAL" && !fatalFiredRef.current) {
      fatalFiredRef.current = true;
      onFatal?.();
    }
    if (snapshot.state !== "FATAL") fatalFiredRef.current = false;
  }, [snapshot.state, onFatal]);

  const server = snapshot.lastServerSnapshot;

  type OverlayContent = { primary: string; secondary?: string; showRefresh?: boolean } | null;

  const overlay = useMemo((): OverlayContent => {
    if (snapshot.state === "OFFLINE_HOLD") return { primary: "Reconnecting to broadcast…" };
    if (snapshot.state === "FATAL") return {
      primary: "We encountered a playback issue.",
      secondary: "Please refresh the page or try again in a moment.",
      showRefresh: true,
    };
    if (server?.failover.active) return { primary: server.failover.reason ?? "On standby" };
    if (snapshot.state === "BOOTSTRAP") return { primary: "Tuning in…" };
    if (snapshot.state === "SYNCING") {
      if (server && !server.current && !server.override) return {
        primary: "Temple TV is currently off-air.",
        secondary: "We'll be back shortly.",
      };
      return { primary: "Tuning in…" };
    }
    // Buffer loading: a new item has been bound but `buffer-ready` hasn't
    // fired yet. Show "Tuning in…" so the user sees feedback during the
    // load phase rather than a silent black screen.
    if (snapshot.state === "PREPARING_ACTIVE") return { primary: "Tuning in…" };
    // Active playback states — never interrupt with an overlay. Content is
    // bound in a buffer and playing; any transient server snapshot gap during
    // a queue advance must not produce a misleading "off air" flash.
    if (
      snapshot.state === "PLAYING" ||
      snapshot.state === "HANDOFF" ||
      snapshot.state === "PREPARING_NEXT"
    ) return null;
    // Recovery states — transient buffer errors, not a true off-air condition.
    if (
      snapshot.state === "RECOVERING_PRIMARY" ||
      snapshot.state === "RECOVERING_FAILOVER" ||
      snapshot.state === "SKIP_PENDING"
    ) return { primary: "Tuning in…" };
    // All remaining states: off air only if the server genuinely has no content.
    if (server && !server.current && !server.override) return {
      primary: "Temple TV is currently off-air.",
      secondary: "We'll be back shortly.",
    };
    return null;
  }, [snapshot.state, server]);

  const title = server?.override?.title ?? server?.current?.title ?? "Temple TV Live";
  const isOnAir = !overlay && !!(server?.current || server?.override);

  const ambientThumb =
    server?.current?.thumbnailUrl ??
    server?.next?.thumbnailUrl ??
    null;

  // hero → object-cover fills frame edge-to-edge (centre-crop on non-16:9).
  // player → object-contain shows full frame; ambient blur fills letterbox.
  const objectFit: "cover" | "contain" = variant === "hero" ? "cover" : "contain";

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "#000",
        overflow: "hidden",
      }}
    >
      {/* ── Cinematic ambient background ──────────────────────────────────────
          In "contain" (player) mode this fills any letterbox/pillarbox areas
          produced by object-contain with a blurred, darkened version of the
          thumbnail. In "cover" (hero) mode the video itself fills the frame,
          but the ambient layer provides a fallback colour wash before the
          stream connects.
          scale(1.15) hides soft blur edges at the container boundary.        */}
      {ambientThumb && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
            backgroundImage: `url(${ambientThumb})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            filter: "blur(48px) brightness(0.2) saturate(1.4)",
            transform: "scale(1.15)",
            pointerEvents: "none",
          }}
        />
      )}

      {/* ── YouTube fallback iframe ────────────────────────────────────────
          Rendered when the current item is a YouTube source (kind="youtube").
          The iframe sits above the native <video> buffers (zIndex 5) but
          below overlays (zIndex 20+). The video buffers stay mounted so the
          player-core FSM continues to run — they are harmlessly invisible
          behind the iframe.
          autoplay=1 requires the iframe to be rendered after a user gesture
          on most browsers; Smart TV platforms typically permit autoplay in
          fullscreen embedded contexts.                                      */}
      {(() => {
        const src = server?.current?.source;
        if (src?.kind !== "youtube") return null;
        let ytId: string | null = null;
        try { ytId = new URL(src.url).searchParams.get("v"); } catch { /* ignore */ }
        if (!ytId) return null;
        return (
          <iframe
            key={ytId}
            src={`https://www.youtube.com/embed/${ytId}?autoplay=1&rel=0&modestbranding=1&enablejsapi=1`}
            allow="autoplay; encrypted-media; fullscreen"
            allowFullScreen
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              border: "none",
              zIndex: 5,
            }}
            title={server?.current?.title ?? "Temple TV — YouTube"}
          />
        );
      })()}

      {/* Buffer A — initially active */}
      <video
        ref={attach.A}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit,
          objectPosition: "center center",
          zIndex: 2,
          display: "block",
          // GPU compositing — promotes the video element to its own compositor
          // layer, enabling zero-copy hardware decoding on Chromium-based browsers
          // and preventing repaints from UI overlays (badges, title chip) from
          // invalidating the video decode pipeline.
          willChange: "transform",
          transform: "translateZ(0)",
        }}
        playsInline
        autoPlay
      />
      {/* Buffer B — preload + hand-off target */}
      <video
        ref={attach.B}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit,
          objectPosition: "center center",
          zIndex: 1,
          opacity: 0,
          display: "block",
          willChange: "transform",
          transform: "translateZ(0)",
        }}
        playsInline
        muted
      />

      {/* Connection-loss strip (non-blocking) */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 30,
          background: "rgba(217,119,6,0.92)",
          color: "#000",
          textAlign: "center",
          fontSize: "clamp(11px, 1.2vw, 14px)",
          fontWeight: 600,
          padding: "6px 12px",
          paddingTop: "max(env(safe-area-inset-top, 0px), 6px)",
          opacity: connected ? 0 : 1,
          pointerEvents: connected ? "none" : "auto",
          transition: "opacity 300ms ease",
        }}
      >
        Reconnecting to broadcast…
      </div>

      {/* ON AIR badge — top-right */}
      <div
        style={{
          position: "absolute",
          top: "clamp(12px, 2.5vh, 24px)",
          right: "clamp(12px, 2.5vw, 24px)",
          zIndex: 20,
          display: "flex",
          alignItems: "center",
          gap: "clamp(5px, 0.6vw, 8px)",
          background: "rgba(220,38,38,0.95)",
          color: "#fff",
          padding: "clamp(4px, 0.6vh, 6px) clamp(8px, 1vw, 12px)",
          borderRadius: 999,
          boxShadow: "0 2px 16px rgba(220,38,38,0.5)",
          opacity: isOnAir ? 1 : 0,
          transform: isOnAir ? "scale(1)" : "scale(0.88)",
          pointerEvents: "none",
          transition: "opacity 500ms ease, transform 500ms ease",
          paddingTop: "max(env(safe-area-inset-top, 0px), clamp(4px, 0.6vh, 6px))",
        }}
      >
        <span
          style={{
            position: "relative",
            display: "inline-flex",
            width: "clamp(7px, 0.8vw, 10px)",
            height: "clamp(7px, 0.8vw, 10px)",
          }}
        >
          <span
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              background: "#fff",
              opacity: 0.75,
              animation: "ping 1s cubic-bezier(0,0,0.2,1) infinite",
            }}
          />
          <span
            style={{
              position: "relative",
              display: "inline-flex",
              borderRadius: "50%",
              width: "100%",
              height: "100%",
              background: "#fff",
            }}
          />
        </span>
        <span
          style={{
            fontSize: "clamp(10px, 1vw, 13px)",
            fontWeight: 800,
            letterSpacing: "0.12em",
          }}
        >
          ON AIR
        </span>
      </div>

      {/* Centred overlay — offline / standby / tuning in / off air / fatal */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(0,0,0,0.72)",
          opacity: overlay ? 1 : 0,
          pointerEvents: overlay ? "auto" : "none",
          transition: "opacity 500ms ease",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "clamp(8px, 1.2vh, 16px)",
            padding: "0 clamp(16px, 4vw, 48px)",
            maxWidth: "clamp(280px, 55vw, 700px)",
          }}
        >
          <p
            style={{
              fontSize: "clamp(15px, 2.5vw, 28px)",
              fontWeight: 600,
              letterSpacing: "0.02em",
              color: "#fff",
              textAlign: "center",
              margin: 0,
            }}
          >
            {overlay?.primary ?? ""}
          </p>
          {overlay?.secondary && (
            <p
              style={{
                fontSize: "clamp(12px, 1.6vw, 20px)",
                fontWeight: 400,
                color: "rgba(255,255,255,0.72)",
                textAlign: "center",
                margin: 0,
              }}
            >
              {overlay.secondary}
            </p>
          )}
          {overlay?.showRefresh && (
            <button
              onClick={() => window.location.reload()}
              style={{
                marginTop: "clamp(4px, 0.8vh, 12px)",
                padding: "clamp(8px, 1vh, 12px) clamp(20px, 2.5vw, 36px)",
                background: "rgba(255,255,255,0.15)",
                border: "1px solid rgba(255,255,255,0.3)",
                borderRadius: 8,
                color: "#fff",
                fontSize: "clamp(12px, 1.4vw, 18px)",
                fontWeight: 500,
                cursor: "pointer",
                backdropFilter: "blur(4px)",
                WebkitBackdropFilter: "blur(4px)",
                transition: "background 200ms ease",
              }}
              onMouseEnter={(e) => { (e.target as HTMLButtonElement).style.background = "rgba(255,255,255,0.25)"; }}
              onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.background = "rgba(255,255,255,0.15)"; }}
            >
              Refresh page
            </button>
          )}
        </div>
      </div>

      {/* Bottom gradient + title block — player variant only */}
      {variant === "player" && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 20,
            // Tall cinematic gradient — fades black from the bottom third up
            // so the title is always legible over any content colour.
            background: "linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.55) 40%, transparent 100%)",
            padding: "clamp(32px, 5vh, 64px) clamp(16px, 3vw, 40px) clamp(14px, 2.5vh, 28px)",
            paddingBottom: "max(env(safe-area-inset-bottom, 0px), clamp(14px, 2.5vh, 28px))",
            display: "flex",
            flexDirection: "column",
            gap: "clamp(3px, 0.5vh, 6px)",
            opacity: isOnAir ? 1 : 0,
            transition: "opacity 600ms ease",
            pointerEvents: "none",
          }}
        >
          {/* Live badge */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: "clamp(2px, 0.4vh, 5px)",
          }}>
            <span style={{
              fontSize: "clamp(9px, 0.85vw, 11px)",
              fontWeight: 700,
              letterSpacing: "0.14em",
              color: "rgba(255,255,255,0.55)",
              textTransform: "uppercase",
            }}>
              Now Playing
            </span>
          </div>
          {/* Programme title */}
          <p style={{
            margin: 0,
            fontSize: "clamp(14px, 1.8vw, 26px)",
            fontWeight: 700,
            letterSpacing: "0.01em",
            color: "#fff",
            lineHeight: 1.2,
            textShadow: "0 1px 8px rgba(0,0,0,0.6)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}>
            {title}
          </p>
        </div>
      )}

      <style>{`
        @keyframes ping {
          75%, 100% { transform: scale(2); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
