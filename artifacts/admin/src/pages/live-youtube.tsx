/**
 * Live YouTube
 * ────────────
 * A focused, single-purpose admin surface for going live via a pasted
 * YouTube URL. Three concerns, in order of how the admin uses the page:
 *
 *   1. Paste & validate a YouTube live URL.
 *   2. Activate it as the global live source — every viewer surface
 *      switches over without a refresh, via the existing
 *      `broadcast-control-updated` SSE event.
 *   3. View the active live override and deactivate it. On deactivation
 *      the broadcast engine's normal precedence (schedule → queue) takes
 *      over automatically — the same path that runs when an override
 *      naturally expires — so there is no dead-air window.
 *
 * Why this lives separately from `/live-control`
 * ──────────────────────────────────────────────
 * `/live-control` exposes the full operator surface (HLS URLs, RTMP key
 * rotation, scheduled-for-later, push-notification toggles, re-broadcast
 * dropdowns). When a non-technical admin just needs to paste a Sunday-
 * service link and go live, that page is too noisy. This page is the
 * "five seconds and one click" path for the YouTube-only case the user
 * spec called out.
 *
 * Backend contract
 * ────────────────
 * No new endpoints — every call goes through the existing `liveApi`:
 *   POST /api/admin/live/override/preview-youtube  → URL validation + liveness probe
 *   POST /api/admin/live/override/start            → activate (notify=true by default)
 *   POST /api/admin/live/override/stop             → deactivate
 *   GET  /api/admin/live                           → poll fallback for status
 *   GET  /api/admin/live/events (SSE)              → push status updates
 *
 * Cross-platform sync is handled server-side: `start` / `stop` invalidate
 * the broadcast cache and emit `broadcast-control-updated` + `status` SSE
 * events that the TV, mobile, and web players already listen to. There is
 * no client-side stream-source manipulation — the new override is the
 * single source of truth.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Youtube,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Square,
  Radio,
  Clock,
  Eye,
  Info,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useSSEEvent } from "@/contexts/SSEContext";
import { liveApi, type LiveOverride, type YouTubePreviewResult } from "@/services/adminApi";
import { PageHeader } from "@/components/shared/page-header";
import { cn } from "@/lib/utils";

/** Default duration for a YouTube live override. */
const DEFAULT_DURATION_MIN = 240;

/** Format "Xh Ym Zs on air" from a startedAt ISO string. */
function elapsedStr(startedAt: string | null | undefined): string {
  if (!startedAt) return "";
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s on air`;
  if (m > 0) return `${m}m ${s}s on air`;
  return `${s}s on air`;
}

/**
 * Returns a viewer-facing watch URL for a YouTube video ID. We render this
 * for the operator as a "verify in a new tab" link, never as the actual
 * source we send to viewers — viewers receive the override payload from
 * `/api/broadcast/current` like any other source.
 */
function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export default function LiveYouTube() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // ── Live status (poll + SSE-invalidated) ─────────────────────────────
  const { data: liveStatus, isLoading: statusLoading } = useQuery({
    queryKey: ["admin-live-status"],
    queryFn: ({ signal }) => liveApi.getStatus(signal),
    // 15s poll is the safety net; the SSE handlers below invalidate
    // immediately on any state change so the UI stays current within a
    // few hundred ms of the server-side switch.
    refetchInterval: 15_000,
  });

  const activeOverride: LiveOverride | null = liveStatus?.liveOverride ?? null;
  const activeIsYouTube = !!activeOverride?.youtubeVideoId;
  const activeIsOtherSource = !!activeOverride && !activeIsYouTube;

  // Re-render once per second so the "on air" timer ticks visibly.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!activeOverride) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [activeOverride]);

  // ── SSE: invalidate status on any broadcast-control change ───────────
  const invalidateStatus = () =>
    queryClient.invalidateQueries({ queryKey: ["admin-live-status"] });
  useSSEEvent("broadcast-control-updated", invalidateStatus);
  useSSEEvent("status", invalidateStatus);

  // ── Form + preview state ─────────────────────────────────────────────
  const [url, setUrl] = useState("");
  const [previewedUrl, setPreviewedUrl] = useState<string>("");
  const [preview, setPreview] = useState<YouTubePreviewResult | null>(null);

  // The validated state we trust for activation. Only true if the most
  // recent successful preview was for the URL currently in the input
  // (so editing the URL invalidates an earlier "live" verdict).
  const previewMatches = preview && previewedUrl.trim() === url.trim();
  const canActivate =
    previewMatches && preview?.exists === true && preview?.isLive === true;

  // ── Mutations ────────────────────────────────────────────────────────
  const previewMutation = useMutation({
    mutationFn: (input: string) => liveApi.previewYoutube(input),
    onSuccess: (result, input) => {
      setPreview(result);
      setPreviewedUrl(input);
      // Don't toast on success — the inline result panel is the feedback.
      // Server may return ok:false with a parse error; surface that.
      if (result && (result as YouTubePreviewResult).ok === false) {
        toast({
          variant: "destructive",
          title: "Invalid URL",
          description:
            (result as YouTubePreviewResult).error ?? "Could not parse that URL",
        });
      }
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Validation failed";
      // The API returns 400 with `{ok:false, error}` for bad URLs; that's
      // surfaced via onSuccess above. onError only fires for true
      // network/5xx failures.
      toast({
        variant: "destructive",
        title: "Validation request failed",
        description: msg,
      });
    },
  });

  const startMutation = useMutation({
    mutationFn: (input: { title: string; youtubeUrl: string }) =>
      liveApi.startOverride({
        title: input.title,
        youtubeUrl: input.youtubeUrl,
        durationMinutes: DEFAULT_DURATION_MIN,
        notify: true,
      }),
    onSuccess: (result) => {
      const warning = result?.youtubeProbeWarning;
      toast({
        title: warning ? "Live — but with a warning" : "Now broadcasting live",
        description:
          warning ??
          "Every viewer surface is switching to the YouTube stream right now.",
        variant: warning ? "default" : "default",
      });
      setUrl("");
      setPreview(null);
      setPreviewedUrl("");
      invalidateStatus();
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Activation failed";
      toast({
        variant: "destructive",
        title: "Could not go live",
        description: msg,
      });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => liveApi.stopOverride(),
    onSuccess: () => {
      toast({
        title: "Live stream stopped",
        description: "Viewers are returning to scheduled programming.",
      });
      invalidateStatus();
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Stop failed";
      toast({
        variant: "destructive",
        title: "Could not stop the stream",
        description: msg,
      });
    },
  });

  const onPreview = () => {
    const trimmed = url.trim();
    if (!trimmed) {
      toast({
        variant: "destructive",
        title: "Paste a YouTube URL first",
      });
      return;
    }
    previewMutation.mutate(trimmed);
  };

  const onActivate = () => {
    if (!canActivate || !preview) return;
    const title = preview.title?.trim() || "Temple TV Live";
    startMutation.mutate({ title, youtubeUrl: url.trim() });
  };

  // Editing the URL clears any stale "live" verdict so the activate
  // button never lets you go live with a URL that wasn't just validated.
  const onUrlChange = (next: string) => {
    setUrl(next);
    if (previewedUrl && next.trim() !== previewedUrl.trim()) {
      // Keep the visual result for context (so the admin sees what they
      // had before), but `canActivate` derives from `previewMatches` and
      // will go false automatically.
    }
  };

  // ── Status panel content ─────────────────────────────────────────────
  const statusPanel = useMemo(() => {
    if (statusLoading) {
      return (
        <div className="space-y-2" data-testid="live-status-loading">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
      );
    }

    if (!activeOverride) {
      return (
        <div className="flex items-start gap-3" data-testid="live-status-idle">
          <div className="size-2.5 mt-2 rounded-full bg-zinc-400" aria-hidden />
          <div>
            <div className="font-semibold text-zinc-700 dark:text-zinc-200">
              Off air
            </div>
            <div className="text-sm text-muted-foreground">
              No live override is active. Viewers see the scheduled programming.
            </div>
          </div>
        </div>
      );
    }

    return (
      <div
        className="flex items-start gap-3"
        data-testid={
          activeIsYouTube ? "live-status-youtube" : "live-status-other"
        }
      >
        <div className="relative mt-2">
          <div className="size-2.5 rounded-full bg-red-500" aria-hidden />
          <div className="absolute inset-0 rounded-full bg-red-500 animate-ping opacity-75" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide text-xs">
              On Air
            </span>
            {activeIsYouTube ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 px-2 py-0.5 text-xs font-medium">
                <Youtube className="size-3" /> YouTube
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 px-2 py-0.5 text-xs font-medium">
                <Radio className="size-3" /> Other source
              </span>
            )}
          </div>
          <div className="font-medium truncate">{activeOverride.title}</div>
          <div className="text-sm text-muted-foreground flex items-center gap-3 flex-wrap mt-0.5">
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" /> {elapsedStr(activeOverride.startedAt)}
            </span>
            {typeof liveStatus?.viewerCount === "number" && (
              <span className="inline-flex items-center gap-1">
                <Eye className="size-3.5" /> {liveStatus.viewerCount} watching
              </span>
            )}
            {activeIsYouTube && activeOverride.youtubeVideoId && (
              <a
                href={youtubeWatchUrl(activeOverride.youtubeVideoId)}
                target="_blank"
                rel="noreferrer noopener"
                className="text-red-600 dark:text-red-400 hover:underline"
              >
                Open on YouTube ↗
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }, [statusLoading, activeOverride, activeIsYouTube, liveStatus]);

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div className="space-y-6" data-testid="page-live-youtube">
      <PageHeader
        title="Live YouTube"
        description="Paste a YouTube live link, validate it, and broadcast it instantly to every viewer surface."
      />

      {/* CURRENT STATUS ─────────────────────────────────────────────── */}
      <Card data-testid="card-live-status">
        <CardHeader>
          <CardTitle className="text-base">Current live status</CardTitle>
          <CardDescription>
            Reflects the global broadcast state — TV, mobile, web, and tablet.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {statusPanel}

          {activeOverride && (
            <>
              <Separator />
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-xs text-muted-foreground max-w-md">
                  Stopping the stream returns viewers to the scheduled
                  programming with no dead-air. The handoff is automatic.
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => stopMutation.mutate()}
                  disabled={stopMutation.isPending}
                  data-testid="btn-stop-live"
                >
                  {stopMutation.isPending ? (
                    <>
                      <Loader2 className="size-4 mr-2 animate-spin" />
                      Stopping…
                    </>
                  ) : (
                    <>
                      <Square className="size-4 mr-2 fill-current" />
                      Stop live stream
                    </>
                  )}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* GO LIVE FORM ─────────────────────────────────────────────────── */}
      <Card data-testid="card-go-live-form">
        <CardHeader>
          <CardTitle className="text-base">Broadcast a YouTube live stream</CardTitle>
          <CardDescription>
            Only YouTube live URLs are accepted. The link is validated against
            YouTube before activation — offline videos and non-live content are
            rejected.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {activeIsOtherSource && (
            <div
              className="flex items-start gap-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm"
              data-testid="banner-other-source-active"
            >
              <Info className="size-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <div>
                A non-YouTube live override is currently active. Activating a
                YouTube stream here will replace it.
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="yt-url">YouTube live URL</Label>
            <div className="flex gap-2">
              <Input
                id="yt-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://www.youtube.com/watch?v=…"
                value={url}
                onChange={(e) => onUrlChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onPreview();
                  }
                }}
                disabled={previewMutation.isPending || startMutation.isPending}
                data-testid="input-youtube-url"
              />
              <Button
                type="button"
                variant="outline"
                onClick={onPreview}
                disabled={
                  previewMutation.isPending ||
                  startMutation.isPending ||
                  url.trim().length === 0
                }
                data-testid="btn-validate-url"
              >
                {previewMutation.isPending ? (
                  <>
                    <Loader2 className="size-4 mr-2 animate-spin" />
                    Validating…
                  </>
                ) : (
                  "Validate"
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Accepted forms: <code>youtube.com/watch?v=…</code>,{" "}
              <code>youtu.be/…</code>, <code>youtube.com/live/…</code>.
            </p>
          </div>

          {/* PREVIEW RESULT PANEL ─────────────────────────────────────── */}
          {preview && previewMatches && (
            <PreviewResult result={preview} />
          )}

          {/* ACTIVATE BUTTON ─────────────────────────────────────────── */}
          <div className="flex items-center justify-between gap-3 flex-wrap pt-2">
            <p className="text-xs text-muted-foreground">
              Activation is logged, server-validated, and synced to every
              viewer surface within ~1&nbsp;second.
            </p>
            <Button
              type="button"
              size="lg"
              onClick={onActivate}
              disabled={!canActivate || startMutation.isPending}
              className={cn(
                "min-w-[180px]",
                canActivate &&
                  !startMutation.isPending &&
                  "bg-red-600 hover:bg-red-700",
              )}
              data-testid="btn-activate-live"
            >
              {startMutation.isPending ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Going live…
                </>
              ) : (
                <>
                  <Radio className="size-4 mr-2" />
                  Activate live stream
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── PREVIEW RESULT PANEL ──────────────────────────────────────────────

/**
 * Renders the outcome of a YouTube preview probe with the right visual
 * weight: green for "ready to go live", amber for "exists but offline",
 * red for "video not found / private / invalid". Activation is gated on
 * the green case only.
 */
function PreviewResult({ result }: { result: YouTubePreviewResult }) {
  // Server returned ok:false (e.g. URL didn't parse). Render as a red error.
  if (result.ok === false) {
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3"
        data-testid="preview-result-invalid"
      >
        <AlertTriangle className="size-4 mt-0.5 text-red-600 dark:text-red-400 shrink-0" />
        <div className="text-sm">
          <div className="font-medium text-red-700 dark:text-red-300">
            Invalid URL
          </div>
          <div className="text-red-600/80 dark:text-red-400/80">
            {result.error ?? "Could not parse that URL"}
          </div>
        </div>
      </div>
    );
  }

  // ok:true but exists:false → video missing/private/removed.
  if (!result.exists) {
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3"
        data-testid="preview-result-not-found"
      >
        <AlertTriangle className="size-4 mt-0.5 text-red-600 dark:text-red-400 shrink-0" />
        <div className="text-sm">
          <div className="font-medium text-red-700 dark:text-red-300">
            Video unavailable
          </div>
          <div className="text-red-600/80 dark:text-red-400/80">
            {result.reason ??
              "YouTube could not verify this video. Check the link is public."}
          </div>
        </div>
      </div>
    );
  }

  // exists:true but isLive:false → real video, not currently live.
  if (!result.isLive) {
    return (
      <div
        className="flex items-start gap-3 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-3"
        data-testid="preview-result-not-live"
      >
        {result.thumbnailUrl ? (
          <img
            src={result.thumbnailUrl}
            alt=""
            className="w-20 aspect-video object-cover rounded shrink-0"
            loading="lazy"
          />
        ) : (
          <AlertTriangle className="size-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
        )}
        <div className="text-sm min-w-0">
          <div className="font-medium text-amber-700 dark:text-amber-300">
            Video found but not currently live
          </div>
          {result.title && (
            <div className="text-amber-700 dark:text-amber-300 truncate">
              {result.title}
            </div>
          )}
          <div className="text-amber-700/80 dark:text-amber-400/80">
            {result.reason ??
              "Wait for the broadcast to start, then re-validate."}
          </div>
        </div>
      </div>
    );
  }

  // exists:true && isLive:true → ready to activate.
  return (
    <div
      className="flex items-start gap-3 rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 p-3"
      data-testid="preview-result-live"
    >
      {result.thumbnailUrl && (
        <img
          src={result.thumbnailUrl}
          alt=""
          className="w-20 aspect-video object-cover rounded shrink-0"
          loading="lazy"
        />
      )}
      <div className="text-sm min-w-0 flex-1">
        <div className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="size-4" /> Live now — ready to activate
        </div>
        {result.title && (
          <div className="text-emerald-800 dark:text-emerald-200 truncate font-medium mt-0.5">
            {result.title}
          </div>
        )}
        {result.videoId && (
          <a
            href={youtubeWatchUrl(result.videoId)}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-emerald-700/80 dark:text-emerald-400/80 hover:underline"
          >
            Verify on YouTube ↗
          </a>
        )}
      </div>
    </div>
  );
}
