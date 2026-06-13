/**
 * BroadcastPreviewV2 — admin live preview backed by `@workspace/player-core`.
 *
 * Replaces the v1 `DualBufferPlayer` for the broadcast queue page. Renders
 * exactly what every viewer sees on TV / web / mobile because it consumes
 * the same V2 snapshot stream (`useV2Broadcast` → `/api/broadcast-v2/ws`
 * with SSE fallback). When the admin reorders / adds / removes a queue
 * item, the server-side bus bridge in `broadcast-v2/index.ts` triggers
 * `orchestrator.reload()` and the next snapshot frame ripples through
 * this preview without a refetch.
 *
 * Two persistent <video> buffers are mounted; the FSM owns opacity and
 * z-index via the web adapter. hls.js is injected the same way the TV
 * client does it (native HLS path for WebKit-based browsers).
 *
 * Audio is muted by default — the operator unmutes explicitly to monitor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import Hls from "hls.js";
import { useV2Broadcast } from "@workspace/player-core/react";
import type { V2Source, V2SourceKind } from "@workspace/player-core";
import { apiBase } from "@/lib/api-base";
import { api, HttpError, tokenStore } from "@/lib/api";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  SkipForward,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
} from "lucide-react";

// ── YouTube helpers ────────────────────────────────────────────────────────────

/**
 * Extract the video ID from any common YouTube URL format:
 *   https://www.youtube.com/watch?v=VIDEO_ID
 *   https://youtu.be/VIDEO_ID
 *   https://www.youtube.com/live/VIDEO_ID
 *   https://www.youtube.com/live/VIDEO_ID?si=...
 */
function extractYouTubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("?")[0] || null;
    if (u.pathname.startsWith("/live/")) return u.pathname.split("/live/")[1]?.split("?")[0] || null;
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

interface Props {
  className?: string;
}

// ── hls.js attachment ─────────────────────────────────────────────────────────
// Exact mirror of the production attachHls in LiveBroadcastV2.tsx. Keeping these
// in sync ensures the admin preview uses identical ABR, buffer, stall-recovery,
// and error-handling behaviour to what real viewers experience on TV / web.

function attachHls(video: HTMLVideoElement, url: string): () => void {
  // ── Native HLS path (Safari / WebKit-based browsers) ────────────────────────
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    let nativeRetried = false;
    const handleNativeError = () => {
      const code = video.error?.code;
      // MEDIA_ERR_NETWORK (2): transient network hiccup — one silent reload.
      // MEDIA_ERR_DECODE  (3): WebKit TV chipsets fire this transiently on
      //   segment boundaries; one silent reload clears it (same fix applied
      //   to TV's LiveBroadcastV2.tsx — keep these in sync).
      if (
        !nativeRetried &&
        (code === MediaError.MEDIA_ERR_NETWORK || code === MediaError.MEDIA_ERR_DECODE)
      ) {
        nativeRetried = true;
        video.load();
        void video.play().catch(() => {});
        return;
      }
    };
    video.addEventListener("error", handleNativeError);
    video.src = url;
    return () => {
      video.removeEventListener("error", handleNativeError);
      video.removeAttribute("src");
      video.load();
    };
  }

  if (!Hls.isSupported()) {
    video.src = url;
    return () => {
      video.removeAttribute("src");
      video.load();
    };
  }

  let mediaErrorCount = 0;

  // ── ABR quality cap on stall ─────────────────────────────────────────────────
  // When hls.js detects a fragment-load timeout or error, immediately drop to the
  // lowest available rendition. This prevents a single high-bitrate stall from
  // consuming the entire frag retry budget when a lower rendition would succeed.
  // The ABR engine ramps back up once bandwidth is confirmed stable (30 s).
  let stallLevelDropped = false;
  // Track the ABR recovery timer so we can cancel it when the HLS instance is
  // destroyed. Without this, a 30 s timer created just before navigation fires
  // after hls.destroy(), calling hls.currentLevel = -1 on a dead instance —
  // which silently throws on some hls.js versions and lingers in memory.
  let stallRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

  const handleHlsStallDrop = (_evt: unknown, data: { fatal: boolean; details: string }) => {
    if (data.fatal) return;
    if (stallLevelDropped) return;
    const isLoadStall =
      data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT ||
      data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
      data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
      data.details === Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT;
    if (!isLoadStall) return;
    if (hls.currentLevel > 0) {
      stallLevelDropped = true;
      hls.currentLevel = 0;
      stallRecoveryTimer = setTimeout(() => {
        stallRecoveryTimer = null;
        try { stallLevelDropped = false; hls.currentLevel = -1; } catch { /* destroyed */ }
      }, 30_000);
    }
  };

  const hls = new Hls({
    // ── Latency / buffer ─────────────────────────────────────────────────────
    // Mirrors the production TV player config so admin preview exhibits the
    // same buffering behaviour viewers experience. Buffers reduced from 60/90 s
    // to 30 s to match the TV player update — prevents excessive memory use on
    // the admin tab when the operator leaves the broadcast page open for hours.
    // backBufferLength kept at 30 s (not 0) so admin operators can scrub back
    // to review the last half-minute of air without re-fetching.
    lowLatencyMode: false,           // stability over latency for broadcast replay
    backBufferLength: 30,            // keep 30 s behind playhead — operator review window
    maxBufferLength: 30,             // build 30 s ahead — ample for smooth preview
    maxMaxBufferLength: 60,          // cap at 60 s on very fast connections
    highBufferWatchdogPeriod: 3,     // nudge stalled high-buffer streams every 3 s
    maxBufferHole: 0.25,             // crisper segment joins (was 0.5)

    // ── ABR / quality ─────────────────────────────────────────────────────────
    startLevel: -1,                  // auto — let EWMA bandwidth probe pick first level
    capLevelToPlayerSize: true,      // never load 1080p into a small container
    abrEwmaDefaultEstimate: 10_000_000, // optimistic 10 Mbps start — probes best level first
    abrBandWidthFactor: 0.92,        // conservative BW estimate — prefer stream stability
    abrBandWidthUpFactor: 0.82,      // ramps up once link is confirmed stable
    abrEwmaFastLive: 3.0,
    abrEwmaSlowLive: 9.0,

    // ── Reliability ───────────────────────────────────────────────────────────
    enableWorker: true,              // offload muxer/demuxer to Web Worker thread
    workerPath: undefined,
    autoStartLoad: true,
    startFragPrefetch: true,         // fetch next fragment before current ends (zero-gap)
    enableSoftwareAES: true,
    maxFragLookUpTolerance: 0.15,    // tighter fragment boundary matching
    appendErrorMaxRetry: 8,
    progressive: true,

    // ── Retry budgets ─────────────────────────────────────────────────────────
    fragLoadingMaxRetry: 12,
    fragLoadingRetryDelay: 400,
    fragLoadingMaxRetryTimeout: 6_000,
    manifestLoadingMaxRetry: 10,
    manifestLoadingRetryDelay: 400,
    levelLoadingMaxRetry: 10,
    levelLoadingRetryDelay: 400,
    nudgeMaxRetry: 10,
    nudgeOffset: 0.2,
  });

  hls.on(Hls.Events.ERROR, handleHlsStallDrop);

  hls.on(Hls.Events.ERROR, (_evt, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      if (mediaErrorCount === 0) { mediaErrorCount++; hls.recoverMediaError(); return; }
      if (mediaErrorCount === 1) { mediaErrorCount++; hls.swapAudioCodec(); hls.recoverMediaError(); return; }
    }
    try { video.dispatchEvent(new Event("error")); } catch { /* ignore */ }
  });

  hls.loadSource(url);
  hls.attachMedia(video);

  // After a fullscreen transition hls.js may have stale capLevelToPlayerSize
  // dimensions. Force an ABR re-evaluation at the new viewport size.
  const onFsChange = () => {
    if (!document.fullscreenElement) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      hls.currentLevel = -1;
    }));
  };
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);

  return () => {
    document.removeEventListener("fullscreenchange", onFsChange);
    document.removeEventListener("webkitfullscreenchange", onFsChange);
    if (stallRecoveryTimer !== null) clearTimeout(stallRecoveryTimer);
    try { hls.destroy(); } catch { /* ignore */ }
  };
}

// ── Source failure classification ─────────────────────────────────────────────

/**
 * Whether a source failure is contained to this browser tab or likely
 * visible to real viewers on TV / mobile / web.
 *
 * "preview-only"          — almost certainly a local admin-browser issue
 *                           (CORS, missing auth header, YouTube embed block).
 *                           Real viewers are not affected.
 *
 * "likely-all-surfaces"   — HLS / DASH / generic MP4 failures that may be
 *                           happening on every surface. Operator should check
 *                           the health panel for viewer-side stall reports.
 *
 * "unknown"               — not enough information to classify.
 */
type SourceScope = "preview-only" | "likely-all-surfaces" | "unknown";

interface SourceDiagnosis {
  scope: SourceScope;
  headline: string;
  reason: string;
  viewerNote: string;
  urlHint: string | null;
  typeLabel: string;
}

function classifySourceFailure(
  source: V2Source | null,
): SourceDiagnosis {
  if (!source) {
    return {
      scope: "unknown",
      headline: "No source configured",
      reason: "The broadcast item has no playable source URL.",
      viewerNote:
        "Real viewers are also likely affected. Check the queue item configuration in the admin panel.",
      urlHint: null,
      typeLabel: "—",
    };
  }

  const { kind, url } = source;

  // ── YouTube ──────────────────────────────────────────────────────────────
  if (kind === "youtube") {
    return {
      scope: "preview-only",
      headline: "Preview-only failure",
      reason:
        "YouTube content cannot be loaded as a raw video element in the admin browser. This is expected browser behaviour.",
      viewerNote:
        "YouTube sources cannot air on TV/mobile (no native YouTube playback path). This preview shows a static placeholder; operators should verify the override directly on YouTube.",
      urlHint: url,
      typeLabel: "YouTube",
    };
  }

  // ── MP4 ──────────────────────────────────────────────────────────────────
  if (kind === "mp4") {
    // Detect local upload URLs served from the API server.
    const isApiUpload =
      url.includes("/api/v1/uploads/") ||
      url.includes("/api/uploads/");

    if (isApiUpload) {
      return {
        scope: "likely-all-surfaces",
        headline: "MP4 upload failed to load",
        reason:
          "The MP4 file could not be loaded — the moov metadata block may still be at the end of the file (faststart not yet complete or failed). The video is not streamable until faststart relocates it to the beginning.",
        viewerNote:
          "This can affect real viewers. If the upload was recent, wait 60–120 s for faststart to finish and the queue to reload. If the problem persists: Videos page → find the video → dropdown → Re-apply faststart. If already HLS-ready this error is stale — reload the queue.",
        urlHint: url,
        typeLabel: "MP4 upload",
      };
    }

    return {
      scope: "likely-all-surfaces",
      headline: "May affect real viewers",
      reason:
        "The MP4 source failed to load in this browser. The file may be inaccessible, corrupt, or served without the correct headers.",
      viewerNote:
        "MP4 failures can affect all viewing surfaces. Check the health panel for stall reports from TV and mobile viewers.",
      urlHint: url,
      typeLabel: "MP4",
    };
  }

  // ── HLS / DASH ────────────────────────────────────────────────────────────
  if (kind === "hls" || kind === "dash") {
    const label = kind.toUpperCase();

    // Detect legacy *.onrender.com URLs — these are absolute HLS/upload URLs
    // stored in the production DB before a custom domain was configured. They
    // may fail in the admin preview browser due to CORS restrictions and
    // Render free-tier sleep. Real viewers on TV/mobile are unaffected —
    // the production API rewrites these to the canonical host before emitting
    // broadcast snapshots. prod-sync rewrites them locally too; this branch
    // covers any items synced before the fix and clears operator concern.
    let isRenderHost = false;
    try {
      isRenderHost = new URL(url).hostname.endsWith(".onrender.com");
    } catch { /* malformed URL — treat as normal */ }

    if (isRenderHost) {
      return {
        scope: "preview-only",
        headline: "Preview-only failure (old Render URL)",
        reason:
          `This ${label} stream URL still points to an old Render service hostname. The admin preview browser cannot load it due to CORS restrictions or the Render server being asleep. The production API serves this stream from the canonical domain, so real viewers are unaffected.`,
        viewerNote:
          "Real viewers on TV, mobile, and web receive the stream from the canonical production domain and are not affected by this preview failure. No action is needed.",
        urlHint: url,
        typeLabel: `${label} stream`,
      };
    }

    return {
      scope: "likely-all-surfaces",
      headline: "May affect real viewers",
      reason: `The ${label} stream failed to load in this browser. The manifest URL may be unreachable, expired, or returning an error.`,
      viewerNote: `${label} failures typically affect all surfaces simultaneously. Check the health panel for viewer-side stall reports and verify the stream URL is reachable.`,
      urlHint: url,
      typeLabel: `${label} stream`,
    };
  }

  // ── Fallback ──────────────────────────────────────────────────────────────
  return {
    scope: "unknown",
    headline: "Source load failure",
    reason: "The source failed to load in this preview browser.",
    viewerNote:
      "Use the health panel to verify whether real viewers are affected.",
    urlHint: url,
    typeLabel: "Unknown",
  };
}

// ── Duration formatting ───────────────────────────────────────────────────────

function formatDuration(totalSecs: number): string {
  const s = Math.round(totalSecs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// ── URL display helper ────────────────────────────────────────────────────────

function truncateUrl(url: string, max = 55): string {
  if (url.length <= max) return url;
  return url.slice(0, max - 1) + "…";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function BroadcastPreviewV2({ className }: Props) {
  // `apiBase()` already includes the `/api` prefix (e.g. "/api" in dev,
  // "https://api.templetv.org.ng/api" in split-domain prod), so we append
  // only the v2 sub-path. Including `/api` here produced `/api/api/broadcast-v2`
  // and the transport silently failed → admin preview stayed black.
  const baseUrl = `${apiBase().replace(/\/$/, "")}/broadcast-v2`;
  // enableStallReport: false — the admin preview must never block a source
  // for real viewers. A preview failure (storage credentials unavailable in
  // the admin browser, CORS, or any other admin-environment issue) is not
  // evidence that the source is broken for TV/mobile/web viewers.
  const { snapshot, connected, attach } = useV2Broadcast({
    baseUrl,
    attachHls,
    enableStallReport: false,
    getAuthToken: () => tokenStore.getAccess() || null,
  });
  const [muted, setMuted] = useState(true);
  const aRef = useRef<HTMLVideoElement>(null);
  const bRef = useRef<HTMLVideoElement>(null);

  // ── Stable combined ref callbacks ──────────────────────────────────────────
  // The hook wraps attach.A / attach.B in useCallback so their identities are
  // stable. Wrapping them again in inline JSX lambdas defeats this: React calls
  // the old lambda with null (detachElements → HLS destroyed) then the new
  // lambda with the element (attachElements → HLS re-initialized) on every
  // re-render of this component. The result is a brief preview black-frame on
  // each snapshot update or mute toggle. See react.ts comment for background.
  // aRef / bRef are stable ref-objects so they need not appear in dep-arrays.
  const refCallbackA = useCallback(
    (el: HTMLVideoElement | null) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (aRef as any).current = el;
      attach.A(el);
    },
    [attach.A],
  );
  const refCallbackB = useCallback(
    (el: HTMLVideoElement | null) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (bRef as any).current = el;
      attach.B(el);
    },
    [attach.B],
  );

  // Keep DOM `muted` in sync — the FSM owns play/pause but volume is admin-local.
  useEffect(() => {
    if (aRef.current) aRef.current.muted = muted;
    if (bRef.current) bRef.current.muted = muted;
  }, [muted]);

  const server = snapshot.lastServerSnapshot;

  // ── Live progress clock ────────────────────────────────────────────────────
  // Ticks at 500 ms so elapsed/remaining and the scrub bar update smoothly.
  // We calibrate the admin browser's wall clock against the server time
  // embedded in every snapshot frame — identical technique to the TV player —
  // so the bar tracks real server position without requiring extra API calls.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const clockOffsetRef = useRef<number>(0);
  const prevServerTimeMsRef = useRef<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  // Guard: only recalibrate when serverTimeMs genuinely changes so we don't
  // re-run on every render triggered by the 500 ms clock tick itself.
  if (server?.serverTimeMs && server.serverTimeMs !== prevServerTimeMsRef.current) {
    prevServerTimeMsRef.current = server.serverTimeMs;
    clockOffsetRef.current = server.serverTimeMs - Date.now();
  }

  const isOnAir =
    snapshot.state === "PLAYING" ||
    snapshot.state === "HANDOFF" ||
    snapshot.state === "PREPARING_NEXT" ||
    snapshot.state === "LIVE_OVERRIDE_ACTIVE";

  const progressPct = useMemo(() => {
    const item = server?.current;
    // No progress bar during live overrides — override items have no
    // tracked durationSecs so the bar would show NaN/0 incorrectly.
    if (!item || !isOnAir || server?.override) return null;
    const durationMs = item.durationSecs * 1000;
    if (durationMs <= 0) return null;
    const serverNowMs = nowMs + clockOffsetRef.current;
    const elapsed = Math.max(0, serverNowMs - item.startsAtMs);
    return Math.min(elapsed / durationMs, 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, isOnAir, nowMs]);

  const elapsedSecs = progressPct !== null && server?.current
    ? progressPct * server.current.durationSecs
    : null;
  const remainingSecs = elapsedSecs !== null && server?.current
    ? Math.max(0, server.current.durationSecs - elapsedSecs)
    : null;

  // Resolve the YouTube video ID for the current/override source, if any.
  //
  // YouTube iframe embedding has been REMOVED from this preview entirely
  // (replaced by a static placeholder card). Rationale:
  //   • YouTube Error 153 ("Video player configuration error") is a pre-init
  //     embed failure that doesn't propagate through the IFrame API, requiring
  //     a brittle onReady-timeout detection scheme that flashed the raw error
  //     screen on every SSE reconnect.
  //   • TV (LiveBroadcastV2) and mobile (V2PlayerContainer) cannot play YouTube
  //     URLs through their native players, so the iframe preview was misleading
  //     operators about what real viewers actually see.
  //   • The broadcast_queue table has a CHECK constraint (no_youtube_in_queue)
  //     that prevents YouTube sources from ever entering the queue. YouTube
  //     can only appear via live-override, which is rare.
  //
  // The video ID is still extracted so the placeholder can show a thumbnail
  // and a "Watch on YouTube" link.
  const youtubeVideoId = useMemo<string | null>(() => {
    const overrideKind = server?.override?.kind;
    const overrideUrl  = server?.override?.url;
    if (overrideKind === "youtube" && overrideUrl) return extractYouTubeVideoId(overrideUrl);
    const currentKind = server?.current?.source?.kind;
    const currentUrl  = server?.current?.source?.url;
    if (currentKind === "youtube" && currentUrl) return extractYouTubeVideoId(currentUrl);
    return null;
  }, [server]);

  const overlay = useMemo(() => {
    if (snapshot.state === "OFFLINE_HOLD") {
      return { kind: "reconnect" as const, label: "Reconnecting…" };
    }
    if (snapshot.state === "FATAL") {
      return { kind: "fatal" as const, label: "Stream unavailable — auto-retry in 30 s" };
    }
    if (server?.failover.active) {
      return { kind: "standby" as const, label: server.failover.reason ?? "On standby" };
    }
    if (snapshot.state === "BOOTSTRAP") {
      return { kind: "tuning" as const, label: "Tuning in…" };
    }
    if (snapshot.state === "SYNCING") {
      if (server && !server.current && !server.override) {
        return { kind: "offair" as const, label: "Off air" };
      }
      return { kind: "tuning" as const, label: "Tuning in…" };
    }
    if (
      snapshot.state === "RECOVERING_PRIMARY" ||
      snapshot.state === "RECOVERING_FAILOVER"
    ) {
      return { kind: "tuning" as const, label: "Retrying source…" };
    }
    if (snapshot.state === "SKIP_PENDING") {
      // YouTube sources cannot be played through the <video> element, so
      // SKIP_PENDING is expected here — but we still want operators to see
      // the state rather than silently suppressing it. Render a distinct
      // yellow warning instead of the full "Skipping…" banner so it is
      // visible alongside the YouTube placeholder card without being alarming.
      if (youtubeVideoId) return { kind: "skipping" as const, label: "YouTube source · skip pending" };
      return { kind: "skipping" as const, label: "Skipping to next item…" };
    }
    if (server && !server.current && !server.override) {
      return { kind: "offair" as const, label: "Off air" };
    }
    return null;
  }, [snapshot.state, server, youtubeVideoId]);

  // Compute source diagnosis during RECOVERING_* states for known preview-only
  // failures. This lets operators see "Preview-only failure — real viewers
  // unaffected" below the spinner before retries are exhausted, rather than
  // waiting for SKIP_PENDING. Only shown for sources classified as preview-only
  // (onrender.com, YouTube) — "likely-all-surfaces" failures are legitimately
  // ambiguous during recovery and should not show an early green indicator.
  const recoverySourceDiagnosis = useMemo<SourceDiagnosis | null>(() => {
    if (
      snapshot.state !== "RECOVERING_PRIMARY" &&
      snapshot.state !== "RECOVERING_FAILOVER"
    ) return null;

    const activeItem =
      snapshot.activeBufferId === "A" ? snapshot.bufferA : snapshot.bufferB;
    let source: V2Source | null = null;
    if (activeItem && "source" in activeItem) {
      source = (activeItem as { source: V2Source }).source;
    } else if (server?.current?.source) {
      source = server.current.source;
    }

    const diagnosis = classifySourceFailure(source);
    return diagnosis.scope === "preview-only" ? diagnosis : null;
  }, [snapshot.state, snapshot.activeBufferId, snapshot.bufferA, snapshot.bufferB, server]);

  // Compute the source diagnosis only when SKIP_PENDING. The active buffer
  // holds whichever item the FSM was trying to play when retries were
  // exhausted — prefer that over lastServerSnapshot so overrides are handled.
  const skipDiagnosis = useMemo<SourceDiagnosis | null>(() => {
    if (snapshot.state !== "SKIP_PENDING") return null;

    // Resolve the source from the active buffer first, fall back to server snapshot.
    const activeItem =
      snapshot.activeBufferId === "A" ? snapshot.bufferA : snapshot.bufferB;

    let source: V2Source | null = null;

    if (activeItem && "source" in activeItem) {
      // V2Item
      source = (activeItem as { source: V2Source }).source;
    } else if (activeItem && "url" in activeItem && "kind" in activeItem) {
      // V2Override — shape it into V2Source
      const ov = activeItem as { kind: string; url: string };
      source = {
        kind: ov.kind as V2SourceKind,
        url: ov.url,
        expiresAtMs: null,
      };
    } else if (server?.current?.source) {
      source = server.current.source;
    } else if (server?.override) {
      source = {
        kind: server.override.kind as V2SourceKind,
        url: server.override.url,
        expiresAtMs: null,
      };
    }

    const diagnosis = classifySourceFailure(source);

    // If the server is actively broadcasting an item, the admin-browser
    // failure is almost certainly a preview-only issue — the browser can't
    // load a large non-faststart MP4 (moov atom at EOF) or is being blocked
    // by a missing crossOrigin header when fetching across domains. Real
    // viewers on TV and mobile are unaffected: they load via the platform
    // HLS/native video path, which handles moov-at-EOF transparently.
    //
    // Downgrade scope from "likely-all-surfaces" to "preview-only" so
    // operators see an accurate (green) indicator instead of a red alarm
    // when the broadcast is confirmed running server-side.
    const isServerPlaying = !!(server?.current);
    const isApiUploadMp4 =
      source?.kind === "mp4" &&
      (source.url.includes("/api/v1/uploads/") || source.url.includes("/api/uploads/"));

    if (isServerPlaying && isApiUploadMp4 && diagnosis.scope === "likely-all-surfaces") {
      return {
        ...diagnosis,
        scope: "preview-only" as const,
        headline: "Preview-only failure",
        reason:
          "This admin browser could not load the MP4. The most common cause is a large file whose moov metadata block is at the end rather than the beginning — the browser times out waiting for it. The broadcast server is actively playing this item.",
        viewerNote:
          "The server confirms this item is currently on air. Viewers on TV and mobile use the server's streaming path and are typically unaffected by this admin browser failure. No action needed unless viewers report stalling.",
      };
    }

    return diagnosis;
  }, [snapshot.state, snapshot.activeBufferId, snapshot.bufferA, snapshot.bufferB, server]);

  // Extract the managed_videos ID for the currently-failing item so the operator
  // can re-trigger faststart directly from this panel. Prefer the active buffer
  // (which is the item the FSM was trying to play) then fall back to the server
  // snapshot's current item. `videoId` was added to V2Item in player-core v2.1.
  const faststartVideoId = useMemo<string | null>(() => {
    if (snapshot.state !== "SKIP_PENDING") return null;
    const activeItem =
      snapshot.activeBufferId === "A" ? snapshot.bufferA : snapshot.bufferB;
    const vid =
      (activeItem && "videoId" in activeItem
        ? (activeItem as { videoId?: string | null }).videoId
        : null) ?? server?.current?.videoId ?? null;
    return vid ?? null;
  }, [snapshot.state, snapshot.activeBufferId, snapshot.bufferA, snapshot.bufferB, server]);

  const faststartMutation = useMutation({
    mutationFn: (videoId: string) =>
      api.post<{ ok: boolean; videoId: string }>(`/admin/videos/${videoId}/faststart`),
    onSuccess: () => toast.success("Faststart applied — stream will load faster"),
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to apply faststart"),
  });

  const title = server?.override?.title ?? server?.current?.title ?? null;
  // Thumbnail used for the cinematic ambient blur fill behind the video frame.
  // Falls back through: current item → next item → nothing (plain black).
  const ambientThumb =
    server?.current?.thumbnailUrl ??
    server?.next?.thumbnailUrl ??
    null;

  return (
    <div
      className={`relative bg-black rounded-lg overflow-hidden select-none ${className ?? ""}`}
      style={{
        // Paint isolation — overlay animations (spinner, badge pulse) invalidate
        // only this subtree, not the surrounding admin page layout.
        contain: "layout style paint",
        isolation: "isolate",
      }}
    >
      {/* ── Cinematic ambient fill ─────────────────────────────────────────────
          Fills any letterbox / pillarbox areas produced by object-contain with a
          blurred, darkened version of the thumbnail rather than raw black. Matches
          the TV player ambient layer exactly (same filter values, same scale trick
          to hide soft blur edges). Invisible until a thumbnail is available.    */}
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
            filter: "blur(40px) brightness(0.18) saturate(1.4)",
            transform: "scale(1.12)",
            pointerEvents: "none",
          }}
        />
      )}

      {/* Two persistent video buffers — FSM/adapter owns opacity + zIndex.
          GPU compositing hints (willChange + translateZ) promote each buffer to
          its own compositor layer — hardware-accelerated decode path on Chromium
          and prevents UI overlay repaints from invalidating the video pipeline. */}
      <video
        ref={refCallbackA}
        className="absolute inset-0 w-full h-full object-contain"
        playsInline
        autoPlay
        muted={muted}
        style={{ zIndex: 2, display: "block", willChange: "transform", transform: "translateZ(0)" }}
      />
      <video
        ref={refCallbackB}
        className="absolute inset-0 w-full h-full object-contain"
        playsInline
        autoPlay
        muted={muted}
        style={{ zIndex: 1, opacity: 0, display: "block", willChange: "transform", transform: "translateZ(0)" }}
      />

      {/* YouTube override placeholder.
          YouTube iframe embedding was removed (see useMemo comment above).
          When a live-override points at a YouTube URL, the native HLS buffers
          above cannot play it, so we show a static thumbnail + open-in-YouTube
          link instead. No detection window, no Error 153, no postMessage races. */}
      {youtubeVideoId && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center"
          style={{ zIndex: 5 }}
        >
          <div
            className="absolute inset-0 bg-cover bg-center opacity-15"
            style={{
              backgroundImage: `url(https://img.youtube.com/vi/${youtubeVideoId}/hqdefault.jpg)`,
              filter: "blur(4px)",
            }}
          />
          <img
            src={`https://img.youtube.com/vi/${youtubeVideoId}/mqdefault.jpg`}
            alt="Video thumbnail"
            className="relative z-10 w-28 rounded shadow-lg object-cover"
            draggable={false}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <div className="relative z-10 space-y-1.5 max-w-[260px]">
            <p className="text-white text-[11px] font-semibold leading-snug">
              YouTube override active
            </p>
            <p className="text-white/60 text-[10px] leading-relaxed">
              This live-override points at a YouTube URL. The native HLS preview
              below cannot render YouTube content. TV and mobile viewers see this
              same item; verify playback directly on YouTube.
            </p>
          </div>
          <div className="relative z-10 flex items-center gap-2 flex-wrap justify-center">
            <a
              href={`https://www.youtube.com/watch?v=${youtubeVideoId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-[11px] font-medium text-white bg-red-600 hover:bg-red-500 transition-colors px-2.5 py-1 rounded"
            >
              <ExternalLink size={10} />
              Watch on YouTube
            </a>
          </div>
        </div>
      )}

      {/* State overlays — fade in/out instead of hard snap */}
      <div
        className={`absolute inset-0 flex flex-col items-center justify-center gap-2 z-10 transition-opacity duration-300 ${
          overlay
            ? overlay.kind === "fatal"
              ? "bg-black/85 opacity-100"
              : overlay.kind === "skipping"
                ? "bg-amber-950/70 opacity-100"
                : "bg-black/60 opacity-100"
            : "opacity-0 pointer-events-none"
        }`}
      >
        {overlay?.kind === "tuning" || overlay?.kind === "reconnect" ? (
          <>
            <Loader2 size={20} className="animate-spin text-white/60" />
            <p className="text-xs font-medium text-white/70">{overlay.label}</p>
            {overlay.kind === "tuning" && recoverySourceDiagnosis && (
              <TooltipProvider delayDuration={120}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-1 mt-0.5 cursor-default">
                      <CheckCircle2 size={10} className="text-emerald-400 shrink-0" />
                      <p className="text-[10px] text-emerald-300/80 leading-tight">
                        {recoverySourceDiagnosis.headline} — real viewers unaffected
                      </p>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
                    <p className="font-medium mb-1">{recoverySourceDiagnosis.headline}</p>
                    <p className="text-muted-foreground leading-relaxed">{recoverySourceDiagnosis.viewerNote}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </>
        ) : overlay?.kind === "offair" ? (
          <>
            <WifiOff size={20} className="text-white/40" />
            <p className="text-xs font-medium text-white/70">{overlay.label}</p>
          </>
        ) : overlay?.kind === "skipping" && skipDiagnosis ? (
          <>
            <SkipForward size={20} className="text-amber-300/80 animate-pulse" />
            {/* Label + info tooltip */}
            <TooltipProvider delayDuration={120}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-white/10 transition-colors cursor-default"
                    aria-label="Source failure details"
                  >
                    <p className="text-xs font-medium text-amber-200">
                      {overlay.label}
                    </p>
                    <Info
                      size={11}
                      className={
                        skipDiagnosis.scope === "preview-only"
                          ? "text-emerald-400/80"
                          : skipDiagnosis.scope === "likely-all-surfaces"
                            ? "text-red-400/80"
                            : "text-amber-400/60"
                      }
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  align="center"
                  className="max-w-[300px] p-0 overflow-hidden"
                >
                  {/* Header band */}
                  <div
                    className={`flex items-center gap-2 px-3 py-2 ${
                      skipDiagnosis.scope === "preview-only"
                        ? "bg-emerald-950/80 border-b border-emerald-800/50"
                        : skipDiagnosis.scope === "likely-all-surfaces"
                          ? "bg-red-950/80 border-b border-red-800/50"
                          : "bg-amber-950/80 border-b border-amber-800/50"
                    }`}
                  >
                    {skipDiagnosis.scope === "preview-only" ? (
                      <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
                    ) : (
                      <AlertTriangle size={13} className={skipDiagnosis.scope === "likely-all-surfaces" ? "text-red-400 shrink-0" : "text-amber-400 shrink-0"} />
                    )}
                    <span className="text-xs font-semibold leading-tight">
                      {skipDiagnosis.headline}
                    </span>
                    <span className="ml-auto text-[10px] text-muted-foreground font-mono shrink-0">
                      {skipDiagnosis.typeLabel}
                    </span>
                  </div>

                  {/* Body */}
                  <div className="px-3 py-2.5 space-y-2">
                    {/* Why it failed locally */}
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {skipDiagnosis.reason}
                    </p>

                    {/* Real-viewer impact */}
                    <div className="border-t border-border/50 pt-2">
                      <p className="text-[11px] leading-relaxed">
                        <span className="font-medium text-foreground">Viewers: </span>
                        <span className="text-muted-foreground">{skipDiagnosis.viewerNote}</span>
                      </p>
                    </div>

                    {/* URL hint */}
                    {skipDiagnosis.urlHint && (
                      <p className="text-[10px] text-muted-foreground/60 font-mono break-all leading-tight border-t border-border/50 pt-2">
                        {truncateUrl(skipDiagnosis.urlHint)}
                      </p>
                    )}

                    {/* One-click faststart action — shown when we know the videoId and the
                        failure is an API-upload MP4 (moov atom likely at EOF). */}
                    {faststartVideoId && skipDiagnosis.scope === "preview-only" && (
                      <div className="border-t border-border/50 pt-2">
                        {faststartMutation.isSuccess ? (
                          <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
                            <CheckCircle2 size={12} className="shrink-0" />
                            <span>Faststart queued — queue will reload automatically.</span>
                          </div>
                        ) : faststartMutation.isError ? (
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-1.5 text-[11px] text-red-400">
                              <AlertTriangle size={12} className="shrink-0" />
                              <span>Faststart request failed. Try again from the Videos page.</span>
                            </div>
                            <button
                              className="flex items-center gap-1.5 text-[11px] font-medium text-amber-300 hover:text-amber-200 transition-colors"
                              onClick={() => faststartMutation.mutate(faststartVideoId)}
                            >
                              <RefreshCw size={11} className="shrink-0" />
                              Retry
                            </button>
                          </div>
                        ) : (
                          <button
                            className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-300 hover:text-emerald-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            onClick={() => faststartMutation.mutate(faststartVideoId)}
                            disabled={faststartMutation.isPending}
                            title="Re-run MP4 faststart to relocate the moov atom to the beginning of the file"
                          >
                            {faststartMutation.isPending ? (
                              <Loader2 size={11} className="animate-spin shrink-0" />
                            ) : (
                              <RefreshCw size={11} className="shrink-0" />
                            )}
                            {faststartMutation.isPending ? "Applying faststart…" : "Re-apply faststart"}
                          </button>
                        )}
                      </div>
                    )}

                    {/* Read-only guarantee footnote */}
                    <p className="text-[10px] text-muted-foreground/50 italic leading-tight border-t border-border/50 pt-1.5">
                      This preview never sends stall reports — it cannot block sources for real viewers.
                    </p>
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </>
        ) : (
          <p className="text-xs font-medium text-white/70">{overlay?.label ?? ""}</p>
        )}
      </div>

      {/* Reconnecting strip — non-blocking, mirrors the TV behaviour */}
      <div
        className={`absolute top-0 inset-x-0 bg-amber-500/90 text-white text-[10px] font-semibold py-1 text-center z-20 transition-opacity duration-300 ${
          snapshot.state === "OFFLINE_HOLD" ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        Reconnecting to broadcast…
      </div>

      {/* Bottom title + controls */}
      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent px-2.5 py-2 z-20 flex items-end gap-2">
        <div className="flex-1 min-w-0">
          {title && (
            <p className="text-white text-[11px] font-medium truncate leading-tight">{title}</p>
          )}
          {/* Elapsed / remaining timer row — visible only when a trackable
              queue item is playing. Shown as "0:42 · −3:18" so operators
              know exactly how much of the current item has aired and how
              long is left before the automatic advance. */}
          {elapsedSecs !== null && remainingSecs !== null && (
            <p className="text-white/40 text-[9px] font-mono tabular-nums mt-0.5 leading-none">
              {formatDuration(elapsedSecs)}
              <span className="mx-1 opacity-50">·</span>
              <span className="text-white/30">−{formatDuration(remainingSecs)}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {connected && server?.current ? (
            <span className="flex items-center gap-1 text-[9px] font-semibold text-emerald-400">
              <Wifi size={8} /> LIVE
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-white/60 hover:text-white hover:bg-white/10 rounded"
            onClick={() => setMuted((m) => !m)}
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
          </Button>

          {/* Picture-in-Picture — float the preview so admin can navigate
              other panels while monitoring the live broadcast. Only shown
              on browsers that support the native PiP API (Chrome / Edge /
              Safari 13.1+ — covers the admin's desktop browser). */}
          {typeof document !== "undefined" && !!document.pictureInPictureEnabled && (
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-white/60 hover:text-white hover:bg-white/10 rounded"
              onClick={() => {
                const a = aRef.current;
                const b = bRef.current;
                const candidates = [a, b].filter(Boolean) as HTMLVideoElement[];
                const target =
                  candidates.find((v) => !v.muted && !v.paused && v.readyState >= 2) ??
                  candidates.find((v) => !v.paused && v.readyState >= 2);
                if (!target || !("requestPictureInPicture" in target)) return;
                if (document.pictureInPictureElement) {
                  document.exitPictureInPicture().catch(() => {});
                } else {
                  target.requestPictureInPicture().catch(() => {});
                }
              }}
              title="Picture-in-Picture — monitor while navigating other panels"
            >
              {/* PiP icon */}
              <svg viewBox="0 0 16 16" fill="currentColor" style={{ width: 11, height: 11 }}>
                <rect x="0.75" y="2" width="14.5" height="10" rx="1.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
                <rect x="8" y="6.5" width="6.5" height="4.5" rx="0.75" fill="currentColor" />
              </svg>
            </Button>
          )}
        </div>
      </div>

      {/* Progress scrub line — lives at the absolute bottom of the preview
          card (z-index 25, above the gradient footer). Visible only when
          a trackable queue item is playing; hidden during overrides (no
          durationSecs) and all non-PLAYING states (no startsAtMs context).
          Width animates via CSS transition so the bar moves smoothly at
          500 ms tick intervals rather than jumping every half-second.     */}
      {progressPct !== null && (
        <div
          aria-hidden
          className="absolute bottom-0 inset-x-0"
          style={{ zIndex: 25, height: 2, background: "rgba(255,255,255,0.08)", pointerEvents: "none" }}
        >
          <div
            style={{
              height: "100%",
              width: `${progressPct * 100}%`,
              background: "linear-gradient(90deg, rgba(109,40,217,0.9) 0%, rgba(167,139,250,0.85) 100%)",
              transition: "width 500ms linear",
              boxShadow: "0 0 6px rgba(167,139,250,0.45)",
            }}
          />
        </div>
      )}
    </div>
  );
}
