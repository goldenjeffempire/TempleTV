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

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import Hls from "hls.js";
import { useV2Broadcast } from "@workspace/player-core/react";
import type { V2Source, V2SourceKind } from "@workspace/player-core";
import { apiBase } from "@/lib/api-base";
import { api } from "@/lib/api";
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
// Mirrors the production attachHls in LiveBroadcastV2.tsx so the admin preview
// uses the same ABR, buffer, and error-recovery settings as real viewers.

function attachHls(video: HTMLVideoElement, url: string): () => void {
  // Native HLS (Safari / WebKit-based browsers)
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    let nativeRetried = false;
    const handleNativeError = () => {
      if (!nativeRetried && video.error?.code === MediaError.MEDIA_ERR_NETWORK) {
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

  const hls = new Hls({
    lowLatencyMode: false,
    backBufferLength: 60,
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    startLevel: -1,
    capLevelToPlayerSize: true,
    abrBandWidthFactor: 0.95,
    abrBandWidthUpFactor: 0.70,
    enableWorker: true,
    autoStartLoad: true,
    startFragPrefetch: true,
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

  // Recalibrate HLS ABR after fullscreen transitions so capLevelToPlayerSize
  // reads the correct viewport dimensions rather than pre-transition values.
  // Without this, a stale quality cap can trigger a level-switch pipeline
  // flush that freezes video while audio continues for 1-3 s.
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
  const { snapshot, connected, attach } = useV2Broadcast({ baseUrl, attachHls, enableStallReport: false });
  const [muted, setMuted] = useState(true);
  const aRef = useRef<HTMLVideoElement>(null);
  const bRef = useRef<HTMLVideoElement>(null);

  // Keep DOM `muted` in sync — the FSM owns play/pause but volume is admin-local.
  useEffect(() => {
    if (aRef.current) aRef.current.muted = muted;
    if (bRef.current) bRef.current.muted = muted;
  }, [muted]);

  const server = snapshot.lastServerSnapshot;

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
      return { kind: "fatal" as const, label: "Broadcast unavailable" };
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
      // When the active source is YouTube the SKIP_PENDING state is expected —
      // the <video> element can't load YouTube URLs and the iframe path has been
      // removed. The static YouTube placeholder card is rendered separately
      // (z-index 5) and is the only meaningful UI for that case; suppress the
      // "skipping" overlay so it doesn't cover the placeholder.
      if (youtubeVideoId) return null;
      return { kind: "skipping" as const, label: "Skipping to next item…" };
    }
    if (server && !server.current && !server.override) {
      return { kind: "offair" as const, label: "Off air" };
    }
    return null;
  }, [snapshot.state, server, youtubeVideoId]);

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
  });

  const title = server?.override?.title ?? server?.current?.title ?? null;

  return (
    <div className={`relative bg-black rounded-lg overflow-hidden select-none ${className ?? ""}`}>
      {/* Two persistent video buffers — FSM/adapter owns opacity + zIndex */}
      <video
        ref={(el) => {
          aRef.current = el;
          attach.A(el);
        }}
        className="absolute inset-0 w-full h-full object-contain"
        playsInline
        autoPlay
        muted={muted}
        style={{ zIndex: 2 }}
      />
      <video
        ref={(el) => {
          bRef.current = el;
          attach.B(el);
        }}
        className="absolute inset-0 w-full h-full object-contain"
        playsInline
        autoPlay
        muted={muted}
        style={{ zIndex: 1 }}
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
        </div>
      </div>
    </div>
  );
}
