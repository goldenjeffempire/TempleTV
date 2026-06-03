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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
    const ctrl = new AbortController();
    const apiOrigin = resolveApiOrigin();
    fetch(`${apiOrigin}/api/midnight-prayers/config`, { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<MPScheduleConfig>) : null))
      .then((data) => { if (data) setCfg(data); })
      .catch(() => { /* ignore — stay on main channel */ });
    return () => ctrl.abort();
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
  // Track the recovery timer so we can cancel it when the HLS instance is
  // destroyed (navigation away, buffer swap). Without this, a 30 s timer
  // created just before navigation fires after hls.destroy(), calling
  // hls.currentLevel = -1 on a dead instance — which silently throws on
  // some hls.js versions and holds the stale closure in memory.
  let stallRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
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
      stallRecoveryTimer = setTimeout(() => {
        stallRecoveryTimer = null;
        stallLevelDropped = false;
        try { hls.currentLevel = -1; } catch { /* hls already destroyed */ }
      }, 30_000);
    }
  };

  const hls = new Hls({
    // ── Latency / buffer ─────────────────────────────────────────────
    lowLatencyMode: false,          // stability over latency for broadcast replay
    // 30 s forward buffer is sufficient for smooth broadcast replay.
    // The previous 60 s caused gradual VRAM exhaustion on Samsung Tizen /
    // LG webOS after hours of 24/7 playback — these chipsets keep YUV
    // textures in GPU memory proportional to buffered segment count.
    // backBufferLength 0: broadcast never seeks backward; freeing back-buffer
    // VRAM immediately after the playhead advances gives a significant
    // long-session stability improvement on TV hardware.
    backBufferLength: 0,
    maxBufferLength: 30,            // build 30 s ahead — ample for smooth relay
    maxMaxBufferLength: 60,         // cap at 60 s on very fast connections
    highBufferWatchdogPeriod: 3,    // nudge stalled high-buffer streams every 3 s

    // ── ABR / quality ────────────────────────────────────────────────
    startLevel: -1,                 // auto — let EWMA bandwidth probe pick first level
    capLevelToPlayerSize: true,     // never load 1080p into a 480p container
    // Start ABR with an optimistic 10 Mbps baseline. On fast connections this
    // causes hls.js to probe the highest rendition first instead of always
    // opening at 360p; on slow links it converges down within 2–3 segments.
    abrEwmaDefaultEstimate: 10_000_000,
    abrBandWidthFactor: 0.92,       // conservative BW estimate — prefer stream stability
    abrBandWidthUpFactor: 0.82,     // ramps up once link is confirmed stable
    abrEwmaFastLive: 3.0,           // fast EMA for live BW variance response
    abrEwmaSlowLive: 9.0,           // slow EMA baseline for stable quality selection
    maxBufferHole: 0.25,            // bridge fragment discontinuities ≤ 250 ms — crisper
                                    //   segment joins vs the old 500 ms gap-bridge

    // ── Reliability ──────────────────────────────────────────────────
    enableWorker: true,             // offload muxer/demuxer to Web Worker thread
    workerPath: undefined,          // use inline worker (no external path needed)
    autoStartLoad: true,
    startFragPrefetch: true,        // fetch next fragment before current ends (zero-gap)
    // Enable software AES-128 fallback for Smart TV chipsets lacking hardware
    // crypto acceleration (some WebOS 3.x, Tizen 2.x). Without this, HW
    // crypto failures cause silent stalls with no error event.
    enableSoftwareAES: true,
    maxFragLookUpTolerance: 0.15,   // tighter fragment boundary matching — reduces gaps
    appendErrorMaxRetry: 8,         // retry MSE append errors before escalating to fatal
    progressive: true,              // progressive MP4 fallback — deliver decoded frames
                                    //   as bytes arrive rather than waiting for full segment

    // ── Frame pacing ─────────────────────────────────────────────────
    // Disable the 6 s live sync nudge — we are replaying a VOD-style queue,
    // not a true low-latency live edge; nudging causes jarring seek artifacts.
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 10,

    // ── Retry budgets ────────────────────────────────────────────────
    fragLoadingMaxRetry: 12,
    fragLoadingRetryDelay: 400,
    fragLoadingMaxRetryTimeout: 6_000,
    manifestLoadingMaxRetry: 10,
    manifestLoadingRetryDelay: 400,
    levelLoadingMaxRetry: 10,
    levelLoadingRetryDelay: 400,
    nudgeMaxRetry: 10,
    nudgeOffset: 0.2,               // smaller nudge — less perceptible seek on stall recovery
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

  // Cancel the stall-recovery timer if it is still pending when this HLS
  // instance is torn down. Prevents hls.currentLevel = -1 from firing on
  // a destroyed instance and plugs the 30 s closure memory leak.
  const originalDestroy = hls.destroy.bind(hls);
  hls.destroy = () => {
    if (stallRecoveryTimer !== null) {
      clearTimeout(stallRecoveryTimer);
      stallRecoveryTimer = null;
    }
    originalDestroy();
  };

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
    // Explicitly clear the video src after hls.destroy() so that older
    // Tizen / WebOS runtimes release the GPU texture and audio hardware.
    // Without this the last decoded frame can stay resident in GPU memory.
    video.removeAttribute("src");
    video.load();
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

  // YouTube sources (kind="youtube") must not be loaded natively — the
  // <video> element cannot play them and would fire `error` → buffer-error →
  // RECOVERING_PRIMARY cascade. Providing a no-op `attachYouTube` signals the
  // web adapter to skip native loading entirely. The actual YouTube content is
  // displayed via the iframe rendered below (zIndex 5, above the video buffers).
  const attachYouTube = useCallback(
    (_video: HTMLVideoElement, _url: string): (() => void) => () => {},
    [],
  );
  const { snapshot, connected, attach } = useV2Broadcast({ baseUrl: effectiveBaseUrl, attachHls, attachYouTube });
  const fatalFiredRef = useRef(false);

  // Local video element refs — shadow attach.A / attach.B so we can find the
  // correct DOM element for PiP buffer-swap re-entry without exposing
  // internals from the player-core hook.
  const videoRefA = useRef<HTMLVideoElement | null>(null);
  const videoRefB = useRef<HTMLVideoElement | null>(null);
  const prevActiveBufferId = useRef(snapshot.activeBufferId);

  useEffect(() => {
    if (snapshot.state === "FATAL" && !fatalFiredRef.current) {
      fatalFiredRef.current = true;
      onFatal?.();
    }
    if (snapshot.state !== "FATAL") fatalFiredRef.current = false;
  }, [snapshot.state, onFatal]);

  // PiP buffer-swap re-entry: when the broadcast advances to the next queue
  // item the player-core performs an A/B buffer handoff — the previously
  // inactive buffer becomes active.  If a PiP window is open it stays pinned
  // to the old buffer's <video> element and would show stale content.  This
  // effect detects the swap and immediately moves the PiP window to the new
  // active element so the viewer sees the correct (current) stream.
  useEffect(() => {
    if (prevActiveBufferId.current === snapshot.activeBufferId) return;
    prevActiveBufferId.current = snapshot.activeBufferId;

    if (!document.pictureInPictureElement) return;

    const newActiveEl =
      snapshot.activeBufferId === "A" ? videoRefA.current : videoRefB.current;
    if (!newActiveEl || newActiveEl === document.pictureInPictureElement) return;

    document
      .exitPictureInPicture()
      .then(() => newActiveEl.requestPictureInPicture())
      .catch(() => { /* PiP may not be available — best effort */ });
  }, [snapshot.activeBufferId]);

  const server = snapshot.lastServerSnapshot;

  // ── Override loading tracker (TV/web) ─────────────────────────────────────
  // Tracks whether an HLS/RTMP live override has started producing frames.
  // Cleared whenever LIVE_OVERRIDE_ACTIVE is (re-)entered so each new override
  // activation shows the "Tuning in…" loading overlay until the browser fires
  // `playing` on the active video element.
  const [overridePlaying, setOverridePlaying] = useState(false);
  useEffect(() => {
    if (snapshot.state !== "LIVE_OVERRIDE_ACTIVE") {
      setOverridePlaying(false);
      return;
    }
    // YouTube override: rendered via iframe — no native <video> event fires.
    if (server?.override?.kind === "youtube") return;
    // HLS/RTMP override: watch the active video element for the first `playing`
    // event.  Once the browser starts rendering frames we clear the overlay.
    const videoEl = snapshot.activeBufferId === "A" ? videoRefA.current : videoRefB.current;
    if (!videoEl) return;
    const onPlaying = () => setOverridePlaying(true);
    videoEl.addEventListener("playing", onPlaying);
    return () => videoEl.removeEventListener("playing", onPlaying);
  }, [snapshot.state, snapshot.activeBufferId, server?.override?.kind]);

  type OverlayContent = { primary: string; secondary?: string; showRefresh?: boolean } | null;

  const overlay = useMemo((): OverlayContent => {
    if (snapshot.state === "OFFLINE_HOLD") return { primary: "Reconnecting to broadcast…" };
    if (snapshot.state === "FATAL") return {
      primary: "Stream temporarily unavailable.",
      secondary: "Auto-retrying in 30 seconds — or press Try Again now.",
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
      snapshot.state === "RECOVERING_FAILOVER"
    ) return { primary: "Tuning in…" };
    // SKIP_PENDING: exhausted retries, waiting for server to advance queue.
    if (snapshot.state === "SKIP_PENDING") return { primary: "Checking stream quality…" };
    // LIVE_OVERRIDE_ACTIVE with HLS/RTMP: show "Tuning in…" while the manifest
    // is fetching and the decoder is starting.  Once the browser fires `playing`
    // (overridePlaying=true) the overlay clears and the live stream is visible.
    // YouTube overrides are handled via iframe — no native `playing` event
    // fires and no loading overlay is needed.
    if (snapshot.state === "LIVE_OVERRIDE_ACTIVE" && server?.override?.kind !== "youtube") {
      if (!overridePlaying) return { primary: "Tuning in…" };
      return null;
    }
    // All remaining states: off air only if the server genuinely has no content.
    if (server && !server.current && !server.override) return {
      primary: "Temple TV is currently off-air.",
      secondary: "We'll be back shortly.",
    };
    return null;
  }, [snapshot.state, server, overridePlaying]);

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
        // contain: layout + style + paint — creates an independent paint and
        // layout boundary. Overlay animations (badge pulse, spinner, title chip)
        // trigger repaints only within this element's subtree, not across the
        // entire Home/Player page tree. Critical on Tizen 4–6 and webOS 5–6
        // where a 60 fps badge-pulse animation without containment invalidates
        // the entire page layout on every frame, causing compositing jank.
        contain: "layout style paint",
        // isolation:isolate is belt-and-suspenders: prevents mix-blend-mode on
        // any descendant overlay from collapsing the video GPU layer.
        isolation: "isolate",
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

      {/* ── YouTube iframe ─────────────────────────────────────────────────
          Rendered when the current item OR the active override is a YouTube
          source (kind="youtube"). Override is checked first so that an admin
          YouTube takeover (LIVE_OVERRIDE_ACTIVE) is always rendered here.
          The iframe sits above the native <video> buffers (zIndex 5) but
          below overlays (zIndex 20+). The video buffers stay mounted so the
          player-core FSM continues to run — they are harmlessly invisible
          behind the iframe. Native loading of YouTube URLs is suppressed in
          the web adapter (see web.ts: kind === "youtube" early-return) so the
          FSM stays in LIVE_OVERRIDE_ACTIVE without entering RECOVERING_PRIMARY.
          autoplay=1 requires the iframe to be rendered after a user gesture
          on most browsers; Smart TV platforms typically permit autoplay in
          fullscreen embedded contexts.                                      */}
      {(() => {
        // Check active override first (LIVE_OVERRIDE_ACTIVE with YouTube kind).
        const overrideKind = server?.override?.kind;
        const overrideUrl  = server?.override?.url;
        if (overrideKind === "youtube" && overrideUrl) {
          let ytId: string | null = null;
          try { ytId = new URL(overrideUrl).searchParams.get("v"); } catch { /* ignore */ }
          if (ytId) return (
            <iframe
              key={`override-${ytId}`}
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
              title={server?.override?.title ?? "Temple TV — YouTube Override"}
            />
          );
        }
        // Fall back to current queue item's YouTube source.
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
        ref={(el) => { videoRefA.current = el; attach.A(el); }}
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
          willChange: "transform, opacity",
          transform: "translateZ(0)",
          // backfaceVisibility: hidden prevents the browser from re-compositing
          // the back face of the GPU layer on 3D transforms, eliminating a
          // flash/ghost frame that can appear during buffer swap on some GPU drivers.
          WebkitBackfaceVisibility: "hidden",
          backfaceVisibility: "hidden",
          // Smooth opacity transition for A/B buffer crossfade — the web adapter
          // sets opacity:0/1 directly; this CSS transition eases the visibility
          // change at 250 ms so buffer swaps feel like a dissolve cut, not a hard cut.
          transition: "opacity 250ms ease",
        }}
        playsInline
        autoPlay
        preload="auto"
      />
      {/* Buffer B — preload + hand-off target */}
      <video
        ref={(el) => { videoRefB.current = el; attach.B(el); }}
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
          willChange: "transform, opacity",
          transform: "translateZ(0)",
          WebkitBackfaceVisibility: "hidden",
          backfaceVisibility: "hidden",
          transition: "opacity 250ms ease",
        }}
        playsInline
        muted
        preload="auto"
      />

      {/* Connection-loss strip (non-blocking) */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 30,
          background: "linear-gradient(90deg, rgba(180,83,9,0.97) 0%, rgba(217,119,6,0.97) 50%, rgba(180,83,9,0.97) 100%)",
          color: "#fff",
          textAlign: "center",
          fontSize: "clamp(10px, 1.1vw, 13px)",
          fontWeight: 700,
          letterSpacing: "0.06em",
          padding: "7px 12px",
          paddingTop: "max(env(safe-area-inset-top, 0px), 7px)",
          opacity: connected ? 0 : 1,
          pointerEvents: connected ? "none" : "auto",
          transition: "opacity 400ms ease",
          boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "#fff", opacity: 0.9 }} />
        RECONNECTING TO BROADCAST
      </div>

      {/* ON AIR badge — top-right */}
      <div
        style={{
          position: "absolute",
          // Use TV safe-area variable when available (TV app), fall back to
          // responsive clamp for admin preview context which has no --tv-safe-*.
          top: "var(--tv-safe-v, clamp(12px, 2.5vh, 24px))",
          right: "var(--tv-safe-h, clamp(12px, 2.5vw, 24px))",
          zIndex: 20,
          display: "flex",
          alignItems: "center",
          gap: "clamp(5px, 0.6vw, 8px)",
          background: "rgba(109,40,217,0.92)",
          color: "#fff",
          padding: "clamp(4px, 0.6vh, 7px) clamp(10px, 1.1vw, 14px)",
          borderRadius: 999,
          border: "1px solid rgba(167,139,250,0.35)",
          boxShadow: "0 0 0 1px rgba(109,40,217,0.3), 0 4px 24px rgba(109,40,217,0.55), 0 0 48px rgba(109,40,217,0.2)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          opacity: isOnAir ? 1 : 0,
          transform: isOnAir ? "scale(1)" : "scale(0.85)",
          pointerEvents: "none",
          transition: "opacity 600ms cubic-bezier(0.16,1,0.3,1), transform 600ms cubic-bezier(0.16,1,0.3,1), box-shadow 600ms ease",
          paddingTop: "max(env(safe-area-inset-top, 0px), clamp(4px, 0.6vh, 7px))",
        }}
      >
        <span
          style={{
            position: "relative",
            display: "inline-flex",
            width: "clamp(7px, 0.7vw, 9px)",
            height: "clamp(7px, 0.7vw, 9px)",
          }}
        >
          <span
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              background: "#c4b5fd",
              opacity: 0.7,
              animation: "ping 1.4s cubic-bezier(0,0,0.2,1) infinite",
            }}
          />
          <span
            style={{
              position: "relative",
              display: "inline-flex",
              borderRadius: "50%",
              width: "100%",
              height: "100%",
              background: "#e9d5ff",
              boxShadow: "0 0 6px rgba(233,213,255,0.8)",
            }}
          />
        </span>
        <span
          style={{
            fontSize: "clamp(9px, 0.9vw, 12px)",
            fontWeight: 800,
            letterSpacing: "0.14em",
            textTransform: "uppercase" as const,
          }}
        >
          On Air
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
          background: overlay?.showRefresh
            ? "rgba(0,0,0,0.82)"
            : "radial-gradient(ellipse at center, rgba(15,5,25,0.88) 0%, rgba(0,0,0,0.78) 100%)",
          opacity: overlay ? 1 : 0,
          pointerEvents: overlay ? "auto" : "none",
          transition: "opacity 500ms ease",
          backdropFilter: overlay ? "blur(2px)" : "none",
          WebkitBackdropFilter: overlay ? "blur(2px)" : "none",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "clamp(10px, 1.5vh, 20px)",
            padding: "0 clamp(16px, 4vw, 48px)",
            maxWidth: "clamp(280px, 55vw, 700px)",
          }}
        >
          {/* Loading spinner — shown for non-fatal, non-refresh states */}
          {overlay && !overlay.showRefresh && (
            <div style={{
              position: "relative",
              width: "clamp(36px, 4vw, 52px)",
              height: "clamp(36px, 4vw, 52px)",
              marginBottom: "clamp(2px, 0.4vh, 6px)",
            }}>
              {/* Outer ring */}
              <svg
                viewBox="0 0 52 52"
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  animation: "broadcast-spin 1.4s linear infinite",
                }}
              >
                <circle
                  cx="26" cy="26" r="22"
                  fill="none"
                  stroke="rgba(167,139,250,0.18)"
                  strokeWidth="3"
                />
                <circle
                  cx="26" cy="26" r="22"
                  fill="none"
                  stroke="rgba(167,139,250,0.85)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray="34.56 103.67"
                  strokeDashoffset="0"
                />
              </svg>
              {/* Inner pulse dot */}
              <div style={{
                position: "absolute",
                inset: "30%",
                borderRadius: "50%",
                background: "rgba(167,139,250,0.6)",
                animation: "broadcast-pulse 2s ease-in-out infinite",
              }} />
            </div>
          )}
          <p
            style={{
              fontSize: "clamp(14px, 2.2vw, 24px)",
              fontWeight: 600,
              letterSpacing: "0.03em",
              color: "#fff",
              textAlign: "center",
              margin: 0,
              textShadow: "0 2px 16px rgba(0,0,0,0.6)",
            }}
          >
            {overlay?.primary ?? ""}
          </p>
          {overlay?.secondary && (
            <p
              style={{
                fontSize: "clamp(11px, 1.4vw, 17px)",
                fontWeight: 400,
                color: "rgba(255,255,255,0.65)",
                textAlign: "center",
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {overlay.secondary}
            </p>
          )}
          {overlay?.showRefresh && (
            <button
              onClick={() => window.location.reload()}
              style={{
                marginTop: "clamp(6px, 1vh, 14px)",
                padding: "clamp(10px, 1.2vh, 14px) clamp(24px, 3vw, 40px)",
                background: "rgba(109,40,217,0.85)",
                border: "1px solid rgba(167,139,250,0.4)",
                borderRadius: 10,
                color: "#fff",
                fontSize: "clamp(12px, 1.3vw, 16px)",
                fontWeight: 600,
                cursor: "pointer",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                transition: "background 200ms ease, box-shadow 200ms ease",
                boxShadow: "0 4px 20px rgba(109,40,217,0.4)",
                letterSpacing: "0.02em",
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLButtonElement).style.background = "rgba(124,58,237,0.95)";
                (e.target as HTMLButtonElement).style.boxShadow = "0 6px 28px rgba(109,40,217,0.6)";
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLButtonElement).style.background = "rgba(109,40,217,0.85)";
                (e.target as HTMLButtonElement).style.boxShadow = "0 4px 20px rgba(109,40,217,0.4)";
              }}
            >
              Try Again
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
            // Multi-stop cinematic gradient — deep black at bottom for title
            // legibility, dissolving to transparent near center so the video
            // breathes without a visible gradient ceiling.
            background: "linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.72) 30%, rgba(0,0,0,0.36) 60%, transparent 100%)",
            padding: "clamp(48px, 7vh, 80px) clamp(20px, 3.5vw, 52px) clamp(16px, 3vh, 36px)",
            paddingBottom: "max(env(safe-area-inset-bottom, 0px), clamp(16px, 3vh, 36px))",
            display: "flex",
            flexDirection: "column",
            gap: "clamp(4px, 0.6vh, 8px)",
            opacity: isOnAir ? 1 : 0,
            transform: isOnAir ? "translateY(0)" : "translateY(8px)",
            transition: "opacity 700ms cubic-bezier(0.16,1,0.3,1), transform 700ms cubic-bezier(0.16,1,0.3,1)",
            pointerEvents: "none",
          }}
        >
          {/* Now Playing label */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: "clamp(3px, 0.5vh, 6px)",
          }}>
            <div style={{
              width: 3,
              height: "clamp(10px, 1.2vh, 14px)",
              borderRadius: 999,
              background: "rgba(167,139,250,0.8)",
              flexShrink: 0,
            }} />
            <span style={{
              fontSize: "clamp(9px, 0.8vw, 11px)",
              fontWeight: 700,
              letterSpacing: "0.18em",
              color: "rgba(196,181,253,0.75)",
              textTransform: "uppercase" as const,
            }}>
              Now Playing
            </span>
          </div>
          {/* Programme title */}
          <p style={{
            margin: 0,
            fontSize: "clamp(15px, 2vw, 30px)",
            fontWeight: 800,
            letterSpacing: "-0.01em",
            color: "#fff",
            lineHeight: 1.18,
            textShadow: "0 2px 16px rgba(0,0,0,0.7), 0 4px 32px rgba(0,0,0,0.4)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}>
            {title}
          </p>
          {/* Up Next chip — appears when the next item title is known */}
          {server?.next?.title && (
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: "clamp(5px, 0.6vw, 8px)",
              marginTop: "clamp(8px, 1.1vh, 14px)",
              padding: "clamp(4px, 0.5vh, 6px) clamp(10px, 1.1vw, 14px)",
              background: "rgba(109,40,217,0.22)",
              border: "1px solid rgba(167,139,250,0.22)",
              borderRadius: 999,
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              width: "fit-content",
              maxWidth: "80%",
            }}>
              <span style={{
                fontSize: "clamp(7px, 0.65vw, 10px)",
                fontWeight: 700,
                letterSpacing: "0.14em",
                color: "rgba(196,181,253,0.65)",
                textTransform: "uppercase" as const,
                flexShrink: 0,
              }}>
                Up Next
              </span>
              <div style={{
                width: 1,
                height: "0.9em",
                background: "rgba(167,139,250,0.25)",
                flexShrink: 0,
              }} />
              <span style={{
                fontSize: "clamp(10px, 0.9vw, 13px)",
                fontWeight: 500,
                color: "rgba(255,255,255,0.75)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {server.next.title}
              </span>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes ping {
          75%, 100% { transform: scale(2.2); opacity: 0; }
        }
        @keyframes broadcast-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes broadcast-pulse {
          0%, 100% { opacity: 0.4; transform: scale(0.8); }
          50%       { opacity: 0.9; transform: scale(1.15); }
        }
      `}</style>
    </div>
  );
}
