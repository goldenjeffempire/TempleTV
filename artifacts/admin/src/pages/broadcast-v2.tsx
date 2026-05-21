import { useV2Broadcast } from "@workspace/player-core/react";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  SkipForward,
  RefreshCw,
  AlertTriangle,
  Pencil,
  Wifi,
  WifiOff,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Activity,
  CheckCircle2,
  XCircle,
  X,
  Clock,
  Loader2,
  Stethoscope,
  Server,
  Radio,
  Users,
  Cpu,
  Shuffle,
} from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { apiBase } from "@/lib/api-base";
import { api, HttpError } from "@/lib/api";
import { useSSE, useSSEEvent } from "@/contexts/sse-context";
import { useEffect, useRef, useState } from "react";

interface BroadcastQueueRow {
  id: string;
  videoId: string | null;
  youtubeId: string | null;
  title: string;
  thumbnailUrl: string;
  durationSecs: number;
  videoSource: string;
  isActive: boolean;
  sortOrder: number;
  /** 'queued' | 'encoding' | 'hls_ready' | 'failed' | 'ready' | null */
  transcodingStatus: string | null;
  /** True when a complete HLS master playlist exists for this item. */
  hasHls: boolean;
}

interface SourceHealthEntry {
  status: "ok" | "bad";
  badUntilMs: number | null;
}

interface EngineHealth {
  ok: boolean;
  channelId: string;
  sequence: number;
  mode: string;
  hasCurrent: boolean;
  hasOverride: boolean;
  failoverActive: boolean;
  itemCount: number;
  uptimeMs: number;
  serverTimeMs: number;
  boot: {
    started: boolean;
    busBridgeInstalled: boolean;
    startAttempts: number;
    lastStartError: string | null;
    lastStartAttemptAtMs: number | null;
  };
  reload: {
    lastReloadAtMs: number | null;
    lastReloadOk: boolean;
    lastReloadError: string | null;
    attempts: number;
    successes: number;
  };
  prodSync: {
    enabled: boolean;
    upstreamUrl: string | null;
    intervalMs: number;
    lastPollAtMs: number | null;
    lastPollOk: boolean;
    lastPollError: string | null;
    lastUpsertCount: number;
    totalPolls: number;
    totalUpserts: number;
  };
  drift: {
    cycleStartedAtMs: number;
    cycleDurationMs: number;
    currentItemId: string | null;
    currentItemPositionMs: number | null;
    lastCpItemId: string | null;
    lastCpPositionMs: number | null;
    lastCpWallMs: number | null;
    driftMs: number | null;
    driftAlerted: boolean;
    driftThresholdMs: number;
  };
  allBlocked?: {
    allSourcesBlocked: boolean;
    allBlockedSinceMs: number | null;
    allBlockedDurationMs: number | null;
  };
  youtubeFallback?: {
    active: boolean;
    cachedItemCount: number;
  };
}

interface WorkerHealth {
  name: string;
  running: boolean;
  circuitOpen: boolean;
  consecutiveFailures: number;
  totalRuns: number;
  totalErrors: number;
  lastRunAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastErrorAtMs: number | null;
  lastError: string | null;
  nextRunAtMs: number | null;
}

interface ValidationIssue {
  severity: "error" | "warn" | "info";
  itemId: string | null;
  itemTitle: string | null;
  code: string;
  message: string;
}

interface DiagnosticsReport {
  generatedAtMs: number;
  uptimeMs: number;
  workers: WorkerHealth[];
  queueValidation: {
    validatedAtMs: number;
    totalItems: number;
    healthyItems: number;
    issues: ValidationIssue[];
    summary: { errors: number; warnings: number; infos: number };
  } | null;
  mediaScan: {
    lastScanAtMs: number | null;
    scanDurationMs: number | null;
    totalItems: number;
    reachable: number;
    unreachable: number;
    scanning: boolean;
  } | null;
  autoSuspended: ReadonlyArray<{
    itemId: string;
    title: string | null;
    failCount: number;
    suspendedAtMs: number;
  }>;
  cleanup: {
    lastRunAtMs: number | null;
    lastOrphanedRefCount: number;
    orphanedRefCandidates: Array<{ id: string; title: string; videoId: string }>;
    lastError: string | null;
  } | null;
  analytics: {
    activeSessions: number;
    peakSessionsLast5Min: number;
    totalSessions: number;
    eventCounts: Record<string, number>;
    lastEventAtMs: number | null;
  } | null;
}

interface TranscodingPanelJob {
  id: string;
  videoId: string;
  videoTitle: string | null;
  status: "queued" | "encoding" | "processing" | "done" | "hls_ready" | "failed" | "cancelled";
  progress: number | null;
  createdAt: string;
  startedAt: string | null;
  errorMessage: string | null;
}

/**
 * Compact real-time transcoding progress panel.
 * Renders only when there are active (queued / encoding) jobs.
 * Driven by `transcoding-update` SSE events for sub-second refresh.
 */
function TranscodingProgressPanel() {
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["broadcast-v2-transcoding-panel"],
    queryFn: () => api.get<{ jobs: TranscodingPanelJob[] }>("/admin/transcoding/queue"),
    refetchInterval: 15_000,
    staleTime: 10_000,
    select: (d) => ({
      jobs: d.jobs.filter((j) => j.status === "queued" || j.status === "encoding" || j.status === "processing"),
    }),
  });

  useSSEEvent("transcoding-update", () => {
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-transcoding-panel"] });
  });

  const activeJobs = data?.jobs ?? [];
  if (activeJobs.length === 0) return null;

  const encodingJob = activeJobs.find((j) => j.status === "encoding" || j.status === "processing");
  const queuedJobs = activeJobs.filter((j) => j.status === "queued");

  return (
    <Card className="border-amber-200/60 dark:border-amber-800/50">
      <CardHeader className="pb-2 pt-4">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-amber-500 shrink-0" />
          <CardTitle className="text-sm">HLS Transcoding</CardTitle>
          <Badge
            variant="secondary"
            className="ml-0.5 gap-1 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 text-[10px] px-1.5"
          >
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            {activeJobs.length} active
          </Badge>
          <Link href="/transcoding" className="ml-auto">
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] gap-1 text-muted-foreground hover:text-foreground">
              Full pipeline →
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pb-4">
        {encodingJob && (
          <div className="rounded-lg border border-amber-200/60 dark:border-amber-800/50 bg-amber-50/40 dark:bg-amber-950/20 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 text-amber-500 animate-spin shrink-0" />
              <span className="flex-1 text-sm font-medium truncate min-w-0">
                {encodingJob.videoTitle ?? encodingJob.videoId}
              </span>
              <Badge className="shrink-0 text-[10px] px-1.5 bg-amber-500 hover:bg-amber-500 text-white">
                Encoding
              </Badge>
            </div>
            <div className="space-y-1">
              <Progress value={encodingJob.progress ?? 0} className="h-1.5" />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>{encodingJob.progress ?? 0}% complete</span>
                <span>HLS ready on completion — queue switches automatically</span>
              </div>
            </div>
          </div>
        )}
        {queuedJobs.length > 0 && (
          <div className="space-y-1">
            {queuedJobs.map((job) => (
              <div key={job.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="flex-1 text-xs truncate min-w-0 text-muted-foreground">
                  {job.videoTitle ?? job.videoId}
                </span>
                <Badge variant="outline" className="shrink-0 text-[10px] px-1.5">
                  Queued
                </Badge>
              </div>
            ))}
          </div>
        )}
        {!encodingJob && queuedJobs.length > 0 && (
          <p className="text-[10px] text-muted-foreground px-1">
            Encoder will pick up the next job within 10 s.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Admin Live Broadcast (v2 control plane).
 *
 * Server-authoritative live console:
 *  - persistent A/B player buffers driven by the universal player core
 *  - real-time queue snapshot from the v2 transport
 *  - real-time queue list mirrored from /admin/broadcast (read-only here;
 *    full drag-reorder editor lives at /broadcast)
 *  - operator controls (skip / reload / failover) with idempotency keys
 *  - source health badges showing which queue items have blocked URLs
 *  - engine health panel (boot status, reload stats, prod-sync diagnostics)
 *  - combined connection indicator (global SSE + v2 transport)
 *  - listens for `broadcast-queue-updated` to auto-reload the v2 orchestrator
 *    so the queue snapshot always reflects DB mutations within ~1 frame.
 */
export default function BroadcastV2Page() {
  const apiOrigin = apiBase().replace(/\/$/, "");
  const baseUrl = `${apiOrigin}/broadcast-v2`;
  // enableStallReport: false — operator console must never affect the broadcast
  // stream. Admin preview failures are environment-local and must not block
  // sources for real viewers (TV, mobile, web).
  const { snapshot, connected: transportConnected, attach } = useV2Broadcast({ baseUrl, enableStallReport: false });
  const sse = useSSE();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  // Dismissible stuck-engine banner. Reset whenever the stuck condition
  // resolves (sequence > 0) so the banner reappears if the engine gets
  // stuck again in the same session.
  const [stuckAlertDismissed, setStuckAlertDismissed] = useState(false);
  // Dismissible all-sources-blocked banner. Same auto-reset pattern.
  const [allBlockedDismissed, setAllBlockedDismissed] = useState(false);
  // Dismissible YouTube fallback banner. Auto-reset when local content returns.
  const [ytFallbackDismissed, setYtFallbackDismissed] = useState(false);
  // Dismissible faststart-in-progress banner. Auto-reset when no items remain
  // in 'processing' state so the banner reappears if a new faststart starts.
  const [processingAlertDismissed, setProcessingAlertDismissed] = useState(false);

  async function adminPost(path: string, body: Record<string, unknown> = {}) {
    setBusy(path);
    try {
      await api.post(path, { ...body, idempotencyKey: crypto.randomUUID() });
      toast.success(`OK: ${path.split("/").pop()}`);
    } catch (e) {
      const detail =
        e instanceof HttpError
          ? `${e.status}${e.message && e.message !== String(e.status) ? ` ${e.message}` : ""}`
          : e instanceof Error
          ? e.message
          : "?";
      toast.error(`Failed: ${path.split("/").pop()} (${detail})`);
    } finally {
      setBusy(null);
    }
  }

  // Live queue mirror — same source as the /broadcast editor.
  // staleTime lowered to 15 s (was 60 s) so queue changes from other admin
  // sessions are visible within one refetch cycle on the broadcast console.
  const { data: queueData, isLoading: queueLoading } = useQuery({
    queryKey: ["broadcast-queue"],
    queryFn: () => api.get<{ items: BroadcastQueueRow[] }>("/admin/broadcast"),
    staleTime: 15_000,
  });

  // Source health — polls every 10 s so blocked-URL TTL countdowns stay fresh.
  // The in-process bad-URL cache on the server is the source of truth; this
  // endpoint normalises queue item URLs and checks them against it.
  const { data: healthData, refetch: refetchHealth } = useQuery({
    queryKey: ["broadcast-v2-source-health"],
    queryFn: () =>
      api.get<{ healthByItemId: Record<string, SourceHealthEntry> }>(
        "/broadcast-v2/source-health",
      ),
    refetchInterval: 10_000,
    staleTime: 8_000,
  });
  const healthByItemId = healthData?.healthByItemId ?? {};

  // Engine health — polls every 15 s. Unauthenticated on the server but
  // fetched here through the admin client so the request carries auth headers
  // (no harm in that — the server ignores them on this route). The 15 s cadence
  // is short enough to surface a newly-stuck orchestrator within one poll
  // cycle but long enough to stay well under the server-side 30 req/min cap.
  const { data: engineHealth } = useQuery({
    queryKey: ["broadcast-v2-engine-health"],
    queryFn: () => api.get<EngineHealth>("/broadcast-v2/health"),
    refetchInterval: 15_000,
    staleTime: 12_000,
  });

  // Diagnostics — auth-guarded deep snapshot of all engine subsystems.
  // Polls every 30 s; the queue-validator worker runs every 10 min so
  // a 30 s cadence is more than sufficient to surface new issues quickly
  // without hammering the server.
  const { data: diagnostics, refetch: refetchDiagnostics } = useQuery({
    queryKey: ["broadcast-v2-diagnostics"],
    queryFn: () => api.get<DiagnosticsReport>("/broadcast-v2/diagnostics"),
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  // Re-enable an auto-suspended queue item without leaving Master Control.
  const reactivateMutation = useMutation({
    mutationFn: (itemId: string) =>
      api.patch(`/admin/broadcast/${itemId}`, { isActive: true }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      // Refetch source-health so the re-enabled item's bad-URL badge clears
      // immediately rather than waiting for the next 10 s poll cycle.
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
      toast.success("Item re-enabled and will resume playback on the next cycle.");
    },
    onError: (err) => {
      toast.error(err instanceof HttpError ? err.message : "Failed to re-enable item.");
    },
  });

  // Clears the in-memory YouTube fallback shuffle cache and triggers a reload
  // so a fresh random order takes effect immediately without a server restart.
  const reshuffleMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; message: string }>("/broadcast-v2/youtube-fallback/reshuffle"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      toast.success("YouTube fallback reshuffled — new play order will take effect within seconds.");
    },
    onError: (err) => {
      const detail = err instanceof HttpError ? err.message : "Unknown error";
      toast.error(`Reshuffle failed (${detail})`);
    },
  });

  // Auto-reload orchestrator when queue mutates.
  // The server-side bus bridge already triggers a reload before this SSE fires,
  // so the 1 s delayed POST is belt-and-suspenders for when the bus bridge
  // misses the signal (e.g. during a cold-start retry window).
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useSSEEvent("broadcast-queue-updated", () => {
    void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
    // Refresh engine health and source-health immediately so the operator sees
    // an accurate state right after any queue mutation (add/remove/reorder).
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      api
        .post("/broadcast-v2/reload", { idempotencyKey: crypto.randomUUID() })
        .catch(() => {});
    }, 1_000);
  });
  useEffect(() => () => clearTimeout(reloadTimer.current), []);

  // Refresh HLS readiness badges and engine health whenever any transcoding
  // job changes state (queued → encoding → hls_ready).
  useSSEEvent("transcoding-update", () => {
    void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
  });

  const server = snapshot.lastServerSnapshot;
  const queueItems = queueData?.items ?? [];
  const activeQueueCount = queueItems.filter((i) => i.isActive).length;
  const blockedCount = Object.values(healthByItemId).filter((h) => h.status === "bad").length;
  // Build a set of item IDs that were auto-suspended this session so queue
  // rows can show "auto-suspended" instead of the generic "inactive" badge.
  const autoSuspendedIds = new Set(
    (diagnostics?.autoSuspended ?? []).map((s) => s.itemId),
  );
  // HLS readiness summary across locally-hosted items in the queue.
  const localQueueItems = queueItems.filter((i) => i.videoId !== null);
  const pendingHlsCount = localQueueItems.filter((i) => !i.hasHls).length;
  const allHlsReady = localQueueItems.length > 0 && pendingHlsCount === 0;

  // Items currently being faststarted (moov atom relocation in progress).
  // These are temporarily excluded from the broadcast queue by loadActive()
  // and will re-enter automatically once faststart completes.
  const processingCount = queueItems.filter(
    (i) => i.isActive && i.transcodingStatus === "processing",
  ).length;

  // Detect the "stuck-at-sequence-0" signature that indicates the orchestrator
  // booted but couldn't load the queue (missing table, cold pool, etc.).
  // Signature: sequence=0 AND uptimeMs>30s AND busBridgeInstalled=true.
  const isStuck =
    engineHealth !== undefined &&
    engineHealth.sequence === 0 &&
    engineHealth.uptimeMs > 30_000 &&
    engineHealth.boot.busBridgeInstalled;

  // Auto-reset dismissed state when stuck condition clears so the banner
  // reappears if the engine gets stuck again in the same session.
  useEffect(() => {
    if (!isStuck) setStuckAlertDismissed(false);
  }, [isStuck]);

  // Drift alert: cycle anchor is more than the threshold ahead/behind the
  // checkpoint-projected position. Means viewers are watching the wrong segment.
  const isDriftAlerted = engineHealth?.drift?.driftAlerted === true;

  // All-sources-blocked: every queue item's URL is in the bad-URL cache.
  // Nothing can air until the TTL expires (auto-recovery) or an operator
  // presses "Clear source blocks". The banner offers both paths.
  const isAllBlocked = engineHealth?.allBlocked?.allSourcesBlocked === true;
  useEffect(() => {
    if (!isAllBlocked) setAllBlockedDismissed(false);
  }, [isAllBlocked]);

  // YouTube fallback: no local content in queue — broadcasting YouTube library.
  const isYtFallback = engineHealth?.youtubeFallback?.active === true;
  useEffect(() => {
    if (!isYtFallback) setYtFallbackDismissed(false);
  }, [isYtFallback]);

  // Auto-reset the processing banner when no more items are in 'processing'.
  useEffect(() => {
    if (processingCount === 0) setProcessingAlertDismissed(false);
  }, [processingCount]);

  // ── Preview player error overlay ────────────────────────────────────────────
  // Surfaces FSM recovery / skip states directly inside the A/B buffer preview
  // so operators know immediately when a source is failing — without having to
  // watch a black screen and guess. Because enableStallReport=false, this
  // overlay never triggers a server-side skip for real viewers.
  const previewErrorState: string | null =
    snapshot.state === "RECOVERING_PRIMARY" ||
    snapshot.state === "RECOVERING_FAILOVER" ||
    snapshot.state === "SKIP_PENDING"
      ? snapshot.state
      : null;
  const previewFailingSource = previewErrorState ? (server?.current?.source ?? null) : null;
  const previewFailingUrl = previewFailingSource?.url ?? null;
  const previewSourceKind = previewFailingSource?.kind ?? null;
  // "mp4" kind covers both local uploads and proxied raw-MP4 sources.
  // HLS items always arrive as kind="hls".
  const previewIsMp4Upload = previewSourceKind === "mp4";

  // Combined "live link health" indicator.
  const fullyConnected = transportConnected && sse.state === "connected";
  const partiallyConnected = transportConnected || sse.state === "connected";
  const linkLabel = fullyConnected
    ? "Live"
    : partiallyConnected
    ? "Partial"
    : sse.state === "reconnecting" || sse.state === "connecting"
    ? "Reconnecting"
    : sse.state === "degraded"
    ? "Degraded"
    : "Offline";

  async function clearBlocks() {
    setBusy("clear-blocks");
    try {
      await api.post("/broadcast-v2/clear-bad-urls", { idempotencyKey: crypto.randomUUID() });
      await refetchHealth();
      toast.success("Source blocks cleared — all URLs will retry on next cycle.");
    } catch (e) {
      const detail =
        e instanceof HttpError
          ? `${e.status}${e.message && e.message !== String(e.status) ? ` ${e.message}` : ""}`
          : e instanceof Error
          ? e.message
          : "?";
      toast.error(`Failed to clear blocks (${detail})`);
    } finally {
      setBusy(null);
    }
  }

  async function prepareHls() {
    setBusy("prepare-hls");
    try {
      const result = await api.post<{ ok: boolean; triggered: number; reason?: string }>(
        "/broadcast-v2/prepare-hls",
        { idempotencyKey: crypto.randomUUID() },
      );
      await qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      if (!result.ok) {
        toast.error(`Prepare HLS: ${result.reason ?? "server refused"}`);
      } else if (result.triggered > 0) {
        toast.success(
          `HLS transcoding queued for ${result.triggered} item${result.triggered !== 1 ? "s" : ""}. Badges will update as jobs complete.`,
        );
      } else {
        toast.success("All active queue items already have HLS ready or are already queued for transcoding.");
      }
    } catch (e) {
      const detail =
        e instanceof HttpError
          ? `${e.status}${e.message && e.message !== String(e.status) ? ` ${e.message}` : ""}`
          : e instanceof Error
          ? e.message
          : "?";
      toast.error(`Failed to prepare HLS (${detail})`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader
        title="Master Control"
        description="Server-authoritative continuous broadcast — live preview, queue, and operator controls."
      />

      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={fullyConnected ? "default" : partiallyConnected ? "secondary" : "destructive"}
          className="gap-1"
          aria-label={`Connection: ${linkLabel}`}
        >
          {fullyConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {linkLabel}
        </Badge>
        <Badge variant="outline">FSM: {snapshot.state}</Badge>
        {server && (
          <>
            <Badge variant="secondary">Mode: {server.mode}</Badge>
            <Badge variant="outline">Seq: {server.sequence}</Badge>
            <Badge variant="outline">{activeQueueCount} active</Badge>
            {server.failover.active && (
              <Badge variant="destructive">
                <AlertTriangle className="mr-1 h-3 w-3" /> Failover: {server.failover.reason}
              </Badge>
            )}
          </>
        )}
        {/* Source health summary — only visible when at least one URL is blocked */}
        {blockedCount > 0 ? (
          <Badge
            variant="destructive"
            className="gap-1"
            title={`${blockedCount} queue item${blockedCount !== 1 ? "s" : ""} have source URLs that failed to load and are temporarily blocked from playback.`}
          >
            <ShieldAlert className="h-3 w-3" />
            {blockedCount} source{blockedCount !== 1 ? "s" : ""} blocked
          </Badge>
        ) : Object.keys(healthByItemId).length > 0 ? (
          <Badge variant="outline" className="gap-1 text-emerald-600">
            <ShieldCheck className="h-3 w-3" />
            Sources OK
          </Badge>
        ) : null}
        {/* HLS readiness summary — only shown for queues with local videos */}
        {localQueueItems.length > 0 && (
          allHlsReady ? (
            <Badge variant="outline" className="gap-1 text-emerald-600" title="All locally-hosted queue items have a complete HLS master playlist ready for adaptive-bitrate streaming.">
              <CheckCircle2 className="h-3 w-3" />
              HLS ready
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1 text-amber-600" title={`${pendingHlsCount} locally-hosted queue item${pendingHlsCount !== 1 ? "s" : ""} lack an HLS master playlist and will broadcast as raw MP4. Use "Prepare HLS" to queue transcoding.`}>
              <AlertTriangle className="h-3 w-3" />
              {pendingHlsCount} missing HLS
            </Badge>
          )
        )}
        {/* Faststart-processing badge */}
        {processingCount > 0 && (
          <Badge
            variant="outline"
            className="gap-1 animate-pulse border-blue-400/70 bg-blue-50 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200"
            title={`${processingCount} item${processingCount !== 1 ? "s" : ""} temporarily held from broadcast while the moov atom is being relocated to byte 0 (faststart). They will air automatically once complete.`}
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            {processingCount} processing
          </Badge>
        )}
        {/* Stuck orchestrator alert badge */}
        {isStuck && (
          <Badge variant="destructive" className="gap-1 animate-pulse">
            <AlertTriangle className="h-3 w-3" />
            Engine stuck — see health panel
          </Badge>
        )}
        {/* All-sources-blocked badge */}
        {isAllBlocked && (
          <Badge variant="destructive" className="gap-1 animate-pulse">
            <ShieldAlert className="h-3 w-3" />
            All sources blocked — nothing on air
          </Badge>
        )}
        {/* Drift alert badge */}
        {isDriftAlerted && (
          <Badge
            variant="outline"
            className="gap-1 animate-pulse border-amber-400/70 bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200"
          >
            <Clock className="h-3 w-3" />
            Sync drift — see health panel
          </Badge>
        )}
      </div>

      {/* Reconnecting strip */}
      {!fullyConnected && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <RotateCw className="h-4 w-4 animate-spin" />
          {transportConnected
            ? "Admin live bus reconnecting — queue updates may be delayed."
            : sse.state === "connected"
            ? "Broadcast preview reconnecting — playback continues from last known state."
            : "Reconnecting to live services…"}
        </div>
      )}

      {/* Stuck-engine alert strip — dismissible amber banner */}
      {isStuck && !stuckAlertDismissed && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">
            <strong>Orchestrator may be stuck.</strong> Sequence is 0 after{" "}
            {Math.round((engineHealth?.uptimeMs ?? 0) / 1000)}s uptime with the event bus bridge
            installed. This usually means the DB pool wasn't warm at boot or a table was missing.
            The self-heal tick retries every 10 s automatically — check the{" "}
            <a
              href={`${apiOrigin}/broadcast-v2/health`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:opacity-80"
            >
              health endpoint
            </a>{" "}
            for the last error, or use <strong>Reload from queue</strong> to force a retry now.
          </div>
          <button
            type="button"
            aria-label="Dismiss stuck-engine alert"
            onClick={() => setStuckAlertDismissed(true)}
            className="shrink-0 rounded p-0.5 hover:bg-amber-200/60 dark:hover:bg-amber-800/40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* All-sources-blocked alert strip — dismissible red banner */}
      {isAllBlocked && !allBlockedDismissed && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-red-300/60 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-700/60 dark:bg-red-950/30 dark:text-red-200"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">
            <strong>All source URLs are blocked.</strong>{" "}
            Every item in the broadcast queue has a URL that failed to load and
            is temporarily banned from playback
            {engineHealth?.allBlocked?.allBlockedDurationMs != null && (
              <> (blocked for {Math.round(engineHealth.allBlocked.allBlockedDurationMs / 1000)}s)</>
            )}
            . The server will auto-clear after the bad-URL TTL expires, or you can unblock
            immediately:
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={busy === "clear-blocks"}
              onClick={clearBlocks}
              className="h-7 px-2 text-xs"
            >
              {busy === "clear-blocks" ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3 w-3" />
              )}
              Clear blocks
            </Button>
            <button
              type="button"
              aria-label="Dismiss all-sources-blocked alert"
              onClick={() => setAllBlockedDismissed(true)}
              className="shrink-0 rounded p-0.5 hover:bg-red-200/60 dark:hover:bg-red-800/40"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* YouTube fallback banner — dismissible amber info strip */}
      {isYtFallback && !ytFallbackDismissed && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <Radio className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">
            <strong>Broadcasting YouTube library.</strong>{" "}
            No local videos are in the broadcast queue, so the system is automatically
            cycling through{engineHealth?.youtubeFallback?.cachedItemCount
              ? ` ${engineHealth.youtubeFallback.cachedItemCount}`
              : ""}{" "}
            YouTube videos in shuffled order. Upload local videos and add them to the
            queue to restore normal broadcast mode.
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-amber-400/70 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-600/60 dark:bg-transparent dark:text-amber-300 dark:hover:bg-amber-900/40"
              onClick={() => reshuffleMutation.mutate()}
              disabled={reshuffleMutation.isPending}
              title="Clear the current shuffle and apply a new random order immediately"
            >
              {reshuffleMutation.isPending
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Shuffle className="h-3.5 w-3.5" />}
              <span className="ml-1.5">Reshuffle</span>
            </Button>
            <button
              type="button"
              aria-label="Dismiss YouTube fallback alert"
              onClick={() => setYtFallbackDismissed(true)}
              className="rounded p-0.5 hover:bg-amber-200/60 dark:hover:bg-amber-800/40"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Faststart-processing banner — dismissible blue info strip */}
      {processingCount > 0 && !processingAlertDismissed && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-md border border-blue-300/60 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-700/60 dark:bg-blue-950/30 dark:text-blue-200"
        >
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
          <div className="flex-1">
            <strong>
              {processingCount} queue item{processingCount !== 1 ? "s are" : " is"} being processed.
            </strong>{" "}
            The moov atom is being relocated to byte 0 (faststart) so the video can stream
            instantly without an HTTP Range pre-flight. The item{processingCount !== 1 ? "s are" : " is"}{" "}
            temporarily held from the broadcast queue and will air automatically once complete —
            no operator action needed.
          </div>
          <button
            type="button"
            aria-label="Dismiss faststart-processing notice"
            onClick={() => setProcessingAlertDismissed(true)}
            className="shrink-0 rounded p-0.5 hover:bg-blue-200/60 dark:hover:bg-blue-800/40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Drift alert strip */}
      {isDriftAlerted && engineHealth?.drift && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <Clock className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <strong>Broadcast sync drift detected.</strong>{" "}
            The cycle anchor is{" "}
            {engineHealth.drift.driftMs !== null && engineHealth.drift.driftMs < 0
              ? `${Math.round(Math.abs(engineHealth.drift.driftMs) / 1000)}s behind`
              : engineHealth.drift.driftMs !== null
              ? `${Math.round(engineHealth.drift.driftMs / 1000)}s ahead of`
              : "out of sync with"}{" "}
            its expected real-time position (threshold: {engineHealth.drift.driftThresholdMs / 1000}s).
            Viewers may be watching a different segment than intended.
            Use <strong>Skip</strong> or <strong>Reload from queue</strong> to resync the broadcast.
          </div>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Live preview (A/B persistent buffers)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
              <video
                ref={attach.A}
                playsInline
                preload="auto"
                className="absolute inset-0 h-full w-full object-contain"
                style={{ zIndex: 2 }}
              />
              <video
                ref={attach.B}
                playsInline
                muted
                preload="auto"
                className="absolute inset-0 h-full w-full object-contain"
                style={{ zIndex: 1 }}
              />

              {/* ── Preview load-failure overlay ──────────────────────────
                  Appears when the FSM enters a recovery or skip-pending state.
                  enableStallReport=false means this overlay never sends a stall
                  report, so it cannot block sources for real viewers. */}
              {previewErrorState && previewFailingSource && (
                <div
                  className="absolute inset-0 flex flex-col justify-end p-2 sm:p-3"
                  style={{
                    zIndex: 10,
                    background:
                      "linear-gradient(to top, rgba(0,0,0,0.93) 55%, rgba(0,0,0,0.35) 100%)",
                  }}
                >
                  <div className="rounded-md border border-red-500/30 bg-red-950/90 p-2.5 space-y-1.5 text-xs backdrop-blur-sm">
                    {/* Title row */}
                    <div className="flex items-start gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0 mt-px" />
                      <div className="min-w-0 space-y-1">
                        <p className="font-semibold text-red-200 leading-tight">
                          {previewIsMp4Upload
                            ? "MP4 upload failed to load"
                            : previewSourceKind === "hls"
                            ? "HLS stream failed to load"
                            : "Broadcast source failed to load"}
                        </p>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="inline-block rounded px-1 py-px bg-red-900/60 text-red-300 text-[10px] font-mono tracking-wide uppercase">
                            {previewIsMp4Upload
                              ? "MP4 upload"
                              : previewSourceKind ?? "unknown"}
                          </span>
                          <span className="text-red-400/50 text-[10px]">
                            {previewErrorState}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Source-specific guidance */}
                    {previewIsMp4Upload && (
                      <p className="text-red-200/75 text-[11px] leading-snug pl-5">
                        This MP4 upload timed out or failed during initial load.
                        The video may still be undergoing moov-atom optimization
                        (faststart) after upload, or the server may be under load.
                      </p>
                    )}

                    {/* Failing URL */}
                    {previewFailingUrl && (
                      <p
                        className="font-mono text-[10px] text-slate-400/70 truncate pl-5"
                        title={previewFailingUrl}
                      >
                        {previewFailingUrl}
                      </p>
                    )}

                    {/* Viewer impact — MP4 uploads only */}
                    {previewIsMp4Upload && (
                      <p className="text-amber-200/70 text-[11px] leading-snug pl-5">
                        <strong className="text-amber-200/90">Viewers:</strong>{" "}
                        This failure can affect real viewers. If the video was
                        recently uploaded, wait 60–120 seconds for the
                        post-upload optimization to complete and the broadcast
                        queue to reload. Check the health panel for viewer stall
                        reports.
                      </p>
                    )}

                    {/* Stall-report disclaimer — always shown */}
                    <p className="text-slate-500 text-[10px] pl-5 border-t border-white/5 pt-1.5">
                      This preview never sends stall reports — it cannot block
                      sources for real viewers.
                    </p>
                  </div>
                </div>
              )}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Two &lt;video&gt; elements stay mounted for the lifetime of the page; the FSM swaps z-index between them on each item handoff. No remount, no blank frame.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Operator controls</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button
              className="w-full"
              variant="outline"
              disabled={!!busy}
              onClick={() => adminPost("/broadcast-v2/skip", { reason: "operator" })}
            >
              <SkipForward className="mr-2 h-4 w-4" /> Skip current item
            </Button>
            <Button
              className="w-full"
              variant="outline"
              disabled={!!busy}
              onClick={() => adminPost("/broadcast-v2/reload")}
            >
              <RefreshCw className="mr-2 h-4 w-4" /> Reload from queue
            </Button>
            <Button
              className="w-full"
              variant="destructive"
              disabled={!!busy}
              onClick={() => adminPost("/broadcast-v2/force-failover", { reason: "manual" })}
            >
              <AlertTriangle className="mr-2 h-4 w-4" /> Force failover
            </Button>
            <Button
              className="w-full"
              variant="secondary"
              disabled={!!busy}
              onClick={() => adminPost("/broadcast-v2/clear-failover")}
            >
              Clear failover
            </Button>
            {/* Clear blocks — only shown when at least one URL is blocked */}
            {blockedCount > 0 && (
              <Button
                className="w-full"
                variant="outline"
                disabled={!!busy}
                onClick={clearBlocks}
                title="Remove all blocked-URL entries so sources are retried immediately on the next playback cycle."
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Clear {blockedCount} source block{blockedCount !== 1 ? "s" : ""}
              </Button>
            )}
            {/* Prepare HLS — shown when local queue items lack HLS master playlists */}
            {pendingHlsCount > 0 && (
              <Button
                className="w-full"
                variant="outline"
                disabled={!!busy}
                onClick={prepareHls}
                title={`Queue high-priority HLS transcoding for ${pendingHlsCount} active item${pendingHlsCount !== 1 ? "s" : ""} that currently lack an HLS master playlist. Items will continue broadcasting as MP4 until transcoding completes.`}
              >
                <RotateCw className={`mr-2 h-4 w-4 ${busy === "prepare-hls" ? "animate-spin" : ""}`} />
                Prepare HLS ({pendingHlsCount} item{pendingHlsCount !== 1 ? "s" : ""})
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Engine health panel */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Engine health
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!engineHealth ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="grid gap-4 text-sm grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
              {/* Boot */}
              <div className="space-y-1.5">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Boot</div>
                <HealthRow
                  label="Started"
                  ok={engineHealth.boot.started}
                  value={engineHealth.boot.started ? "yes" : "no"}
                />
                <HealthRow
                  label="Bus bridge"
                  ok={engineHealth.boot.busBridgeInstalled}
                  value={engineHealth.boot.busBridgeInstalled ? "installed" : "missing"}
                />
                <HealthRow
                  label="Attempts"
                  ok={engineHealth.boot.startAttempts <= 1}
                  value={String(engineHealth.boot.startAttempts)}
                />
                <HealthRow
                  label="Uptime"
                  ok
                  value={formatDuration(engineHealth.uptimeMs)}
                />
                {engineHealth.boot.lastStartError && (
                  <div className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300 break-words">
                    {engineHealth.boot.lastStartError}
                  </div>
                )}
              </div>

              {/* Reload */}
              <div className="space-y-1.5">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Queue reloads</div>
                <HealthRow
                  label="Last reload"
                  ok={engineHealth.reload.lastReloadOk}
                  value={
                    engineHealth.reload.lastReloadAtMs
                      ? `${engineHealth.reload.lastReloadOk ? "OK" : "FAIL"} · ${formatAgo(engineHealth.reload.lastReloadAtMs)}`
                      : "—"
                  }
                />
                <HealthRow
                  label="Attempts"
                  ok
                  value={`${engineHealth.reload.successes} / ${engineHealth.reload.attempts}`}
                />
                <HealthRow
                  label="Items loaded"
                  ok={engineHealth.itemCount > 0}
                  value={String(engineHealth.itemCount)}
                />
                <HealthRow
                  label="Sequence"
                  ok={engineHealth.sequence > 0 || engineHealth.uptimeMs < 30_000}
                  value={String(engineHealth.sequence)}
                />
                {engineHealth.reload.lastReloadError && (
                  <div className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300 break-words">
                    {engineHealth.reload.lastReloadError}
                  </div>
                )}
              </div>

              {/* Prod sync */}
              <div className="space-y-1.5">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Prod sync
                  {!engineHealth.prodSync.enabled && (
                    <span className="ml-1 text-muted-foreground/60">(disabled)</span>
                  )}
                </div>
                {engineHealth.prodSync.enabled ? (
                  <>
                    <HealthRow
                      label="Last poll"
                      ok={engineHealth.prodSync.lastPollOk}
                      value={
                        engineHealth.prodSync.lastPollAtMs
                          ? `${engineHealth.prodSync.lastPollOk ? "OK" : "FAIL"} · ${formatAgo(engineHealth.prodSync.lastPollAtMs)}`
                          : "—"
                      }
                    />
                    <HealthRow
                      label="Total polls"
                      ok
                      value={String(engineHealth.prodSync.totalPolls)}
                    />
                    <HealthRow
                      label="Upserts"
                      ok
                      value={`${engineHealth.prodSync.lastUpsertCount} last / ${engineHealth.prodSync.totalUpserts} total`}
                    />
                    <HealthRow
                      label="Cadence"
                      ok
                      value={`${engineHealth.prodSync.intervalMs / 1000}s`}
                    />
                    {engineHealth.prodSync.lastPollError && (
                      <div className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300 break-words">
                        {engineHealth.prodSync.lastPollError}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Set <code className="rounded bg-muted px-1">PROD_SYNC_API_URL</code> to mirror the production queue into dev.
                  </p>
                )}
              </div>

              {/* Sync drift */}
              <div className="space-y-1.5">
                <div className={`text-xs font-semibold uppercase tracking-wide ${engineHealth.drift.driftAlerted ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
                  Sync drift
                  {engineHealth.drift.driftAlerted && (
                    <span className="ml-1.5 inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3 w-3" />
                    </span>
                  )}
                </div>
                <HealthRow
                  label="Drift"
                  ok={!engineHealth.drift.driftAlerted}
                  value={
                    engineHealth.drift.driftMs === null
                      ? "—"
                      : engineHealth.drift.driftMs >= 0
                      ? `+${(engineHealth.drift.driftMs / 1000).toFixed(1)}s`
                      : `${(engineHealth.drift.driftMs / 1000).toFixed(1)}s`
                  }
                />
                <HealthRow
                  label="Threshold"
                  ok
                  value={`±${engineHealth.drift.driftThresholdMs / 1000}s`}
                />
                <HealthRow
                  label="Last checkpoint"
                  ok={engineHealth.drift.lastCpWallMs !== null}
                  value={
                    engineHealth.drift.lastCpWallMs
                      ? formatAgo(engineHealth.drift.lastCpWallMs)
                      : "none yet"
                  }
                />
                <HealthRow
                  label="Cycle length"
                  ok
                  value={
                    engineHealth.drift.cycleDurationMs > 0
                      ? formatDuration(engineHealth.drift.cycleDurationMs)
                      : "—"
                  }
                />
                {engineHealth.drift.driftMs === null && (
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    {engineHealth.mode === "override"
                      ? "Override active — drift paused."
                      : "Awaiting first checkpoint (≤5s after start)."}
                  </p>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Server snapshot</CardTitle>
        </CardHeader>
        <CardContent>
          {!server ? (
            <p className="text-sm text-muted-foreground">Waiting for first snapshot…</p>
          ) : (
            <div className="grid gap-4 text-sm grid-cols-1 sm:grid-cols-2 md:grid-cols-3">
              <SnapshotSlot label="Now playing" item={server.current} highlight />
              <SnapshotSlot label="Up next" item={server.next} />
              <SnapshotSlot label="Then" item={server.nextNext} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Engine Diagnostics panel ────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Stethoscope className="h-4 w-4 text-muted-foreground" />
            Engine Diagnostics
          </CardTitle>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => { void refetchDiagnostics(); }}
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-5">
          {!diagnostics ? (
            <p className="text-sm text-muted-foreground">Loading diagnostics…</p>
          ) : (
            <>
              {/* Workers */}
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Server className="h-3 w-3" />
                  Supervised Workers
                </div>
                <div className="rounded-md border divide-y">
                  {diagnostics.workers.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">No supervised workers registered.</p>
                  ) : (
                    diagnostics.workers.map((w) => {
                      const isHealthy = w.running && !w.circuitOpen;
                      const nextIn = w.nextRunAtMs ? Math.max(0, Math.round((w.nextRunAtMs - Date.now()) / 1000)) : null;
                      return (
                        <div key={w.name} className="flex items-center gap-3 px-3 py-2">
                          {isHealthy ? (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                          ) : w.circuitOpen ? (
                            <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-red-500" />
                          ) : (
                            <XCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                          )}
                          <span className="min-w-0 flex-1 truncate text-xs font-medium">{w.name}</span>
                          <div className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
                            {w.circuitOpen && (
                              <Badge variant="destructive" className="text-[10px] h-4 px-1">circuit open</Badge>
                            )}
                            <span title={`${w.totalRuns} runs, ${w.totalErrors} errors`}>
                              {w.totalRuns}r / {w.totalErrors}e
                            </span>
                            {w.lastSuccessAtMs && (
                              <span title="Last successful run">✓ {formatAgo(w.lastSuccessAtMs)}</span>
                            )}
                            {nextIn !== null && (
                              <span title="Next scheduled run" className="opacity-70">
                                next {nextIn < 60 ? `${nextIn}s` : `${Math.round(nextIn / 60)}m`}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                {diagnostics.workers.some((w) => w.lastError) && (
                  <div className="mt-2 space-y-1">
                    {diagnostics.workers
                      .filter((w) => w.lastError)
                      .map((w) => (
                        <div
                          key={w.name}
                          className="rounded bg-red-50 px-2.5 py-1.5 text-[10px] text-red-800 dark:bg-red-950/40 dark:text-red-300"
                        >
                          <span className="font-semibold">{w.name}:</span>{" "}
                          <span className="font-mono">{w.lastError}</span>
                          {w.lastErrorAtMs && (
                            <span className="ml-2 opacity-60">{formatAgo(w.lastErrorAtMs)}</span>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </div>

              {/* Queue validation issues */}
              {diagnostics.queueValidation && (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <Activity className="h-3 w-3" />
                    Queue Validation
                    <span className="ml-auto font-normal normal-case text-[10px]">
                      {diagnostics.queueValidation.validatedAtMs
                        ? formatAgo(diagnostics.queueValidation.validatedAtMs)
                        : "—"}
                    </span>
                  </div>
                  {diagnostics.queueValidation.issues.length === 0 ? (
                    <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      All {diagnostics.queueValidation.totalItems} item
                      {diagnostics.queueValidation.totalItems !== 1 ? "s" : ""} validated — no issues.
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{diagnostics.queueValidation.totalItems} items</span>
                        {diagnostics.queueValidation.summary.errors > 0 && (
                          <Badge variant="destructive" className="h-4 px-1 text-[10px]">
                            {diagnostics.queueValidation.summary.errors} error{diagnostics.queueValidation.summary.errors !== 1 ? "s" : ""}
                          </Badge>
                        )}
                        {diagnostics.queueValidation.summary.warnings > 0 && (
                          <Badge variant="outline" className="h-4 px-1 text-[10px] border-amber-400 text-amber-700 dark:text-amber-400">
                            {diagnostics.queueValidation.summary.warnings} warning{diagnostics.queueValidation.summary.warnings !== 1 ? "s" : ""}
                          </Badge>
                        )}
                      </div>
                      <div className="rounded-md border divide-y">
                        {diagnostics.queueValidation.issues.map((issue, i) => (
                          <div key={i} className="flex items-start gap-2 px-3 py-2">
                            {issue.severity === "error" ? (
                              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                            ) : issue.severity === "warn" ? (
                              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                            ) : (
                              <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
                            )}
                            <div className="min-w-0 flex-1">
                              {issue.itemTitle && (
                                <div className="truncate text-[10px] font-semibold">{issue.itemTitle}</div>
                              )}
                              <div className="text-[10px] text-muted-foreground">{issue.message}</div>
                            </div>
                            <Badge variant="outline" className="shrink-0 text-[10px] h-4 px-1 font-mono">
                              {issue.code}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Media scan summary */}
              {diagnostics.mediaScan && (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <Radio className="h-3 w-3" />
                    Media Integrity
                    {diagnostics.mediaScan.scanning && (
                      <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
                    )}
                    {diagnostics.mediaScan.lastScanAtMs && (
                      <span className="ml-auto font-normal normal-case text-[10px]">
                        {formatAgo(diagnostics.mediaScan.lastScanAtMs)}
                        {diagnostics.mediaScan.scanDurationMs != null && (
                          <> · {(diagnostics.mediaScan.scanDurationMs / 1000).toFixed(1)}s</>
                        )}
                      </span>
                    )}
                  </div>
                  {diagnostics.mediaScan.lastScanAtMs == null ? (
                    <p className="text-xs text-muted-foreground">
                      {diagnostics.mediaScan.scanning ? "Scan in progress…" : "First scan pending (runs ~45 s after start)."}
                    </p>
                  ) : (
                    <div className="flex items-center gap-4 text-xs">
                      <span className="text-muted-foreground">{diagnostics.mediaScan.totalItems} items checked</span>
                      <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" />
                        {diagnostics.mediaScan.reachable} reachable
                      </span>
                      {diagnostics.mediaScan.unreachable > 0 && (
                        <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                          <XCircle className="h-3 w-3" />
                          {diagnostics.mediaScan.unreachable} unreachable
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Auto-suspended items */}
              {diagnostics.autoSuspended && diagnostics.autoSuspended.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
                    <XCircle className="h-3 w-3" />
                    Auto-Suspended Items
                    <Badge variant="destructive" className="ml-1 text-[10px] px-1.5 py-0">{diagnostics.autoSuspended.length}</Badge>
                  </div>
                  <p className="mb-2 text-[11px] text-muted-foreground">
                    These items were deactivated automatically after repeated URL failures. Re-enable them in the queue editor once the source is fixed.
                  </p>
                  <div className="flex flex-col gap-1">
                    {diagnostics.autoSuspended.map((item) => (
                      <div key={item.itemId} className="flex items-center justify-between rounded-md bg-red-50 dark:bg-red-950/30 px-2 py-1.5 text-xs">
                        <span className="truncate font-medium text-red-800 dark:text-red-300 max-w-[200px]" title={item.title ?? item.itemId}>
                          {item.title ?? item.itemId}
                        </span>
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          <span className="text-red-600 dark:text-red-400">{item.failCount} failures</span>
                          <span className="text-muted-foreground">{formatAgo(item.suspendedAtMs)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Analytics summary */}
              {diagnostics.analytics && (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <Users className="h-3 w-3" />
                    Session Analytics
                  </div>
                  <div className="flex flex-wrap items-center gap-4 text-xs">
                    <span className="flex items-center gap-1">
                      <span className="font-semibold tabular-nums">{diagnostics.analytics.activeSessions}</span>
                      <span className="text-muted-foreground">active</span>
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="font-semibold tabular-nums">{diagnostics.analytics.peakSessionsLast5Min}</span>
                      <span className="text-muted-foreground">peak/5min</span>
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="font-semibold tabular-nums">{diagnostics.analytics.totalSessions}</span>
                      <span className="text-muted-foreground">total sessions</span>
                    </span>
                    {diagnostics.analytics.lastEventAtMs && (
                      <span className="text-muted-foreground">
                        last event {formatAgo(diagnostics.analytics.lastEventAtMs)}
                      </span>
                    )}
                  </div>
                  {Object.keys(diagnostics.analytics.eventCounts).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {Object.entries(diagnostics.analytics.eventCounts)
                        .sort((a, b) => b[1] - a[1])
                        .map(([evt, count]) => (
                          <Badge key={evt} variant="secondary" className="text-[10px] font-mono gap-1">
                            {evt}
                            <span className="font-semibold">{count}</span>
                          </Badge>
                        ))}
                    </div>
                  )}
                </div>
              )}

              {/* Orphan cleanup */}
              {diagnostics.cleanup && diagnostics.cleanup.orphanedRefCandidates.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" />
                    Orphaned Queue References
                    {diagnostics.cleanup.lastRunAtMs && (
                      <span className="ml-auto font-normal normal-case text-[10px] text-muted-foreground">
                        checked {formatAgo(diagnostics.cleanup.lastRunAtMs)}
                      </span>
                    )}
                  </div>
                  <div className="rounded-md border divide-y border-amber-200 dark:border-amber-800">
                    {diagnostics.cleanup.orphanedRefCandidates.map((c) => (
                      <div key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-[10px]">
                        <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
                        <span className="min-w-0 flex-1 truncate font-medium">{c.title}</span>
                        <span className="shrink-0 font-mono text-muted-foreground opacity-60">{c.videoId}</span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[10px] text-muted-foreground">
                    These queue items reference video IDs that no longer exist in the library. Remove them from the queue editor to prevent broadcast errors.
                  </p>
                </div>
              )}

              <div className="text-right text-[10px] text-muted-foreground">
                Snapshot taken {formatAgo(diagnostics.generatedAtMs)} · uptime {formatDuration(diagnostics.uptimeMs)}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Blocked-source diagnostic panel — shown when any queue item's URL
          is in the bad-URL cache. Explains likely causes and gives operators
          a clear CTA. Appears above the queue so it's hard to miss. */}
      {blockedCount > 0 && (() => {
        const blockedItems = queueItems.filter((i) => healthByItemId[i.id]?.status === "bad");
        const hasUploadInProcessing = blockedItems.some(
          (i) => i.videoId !== null && (i.transcodingStatus === "processing" || i.transcodingStatus === null),
        );
        return (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="flex-1 space-y-2">
              <div>
                <strong>
                  {blockedCount} source{blockedCount !== 1 ? "s" : ""} blocked from playback.
                </strong>{" "}
                {blockedCount !== 1 ? "These queue items" : "This queue item"} failed to load and{" "}
                {blockedCount !== 1 ? "are" : "is"} temporarily skipped for up to 15 seconds.
              </div>
              {blockedItems.map((item) => {
                const h = healthByItemId[item.id];
                const secsLeft =
                  h?.badUntilMs ? Math.max(0, Math.ceil((h.badUntilMs - Date.now()) / 1000)) : null;
                return (
                  <div key={item.id} className="rounded bg-amber-100/70 px-2 py-1.5 text-xs dark:bg-amber-900/30">
                    <span className="font-medium">{item.title}</span>
                    {secsLeft !== null && (
                      <span className="ml-2 opacity-70">
                        auto-unblocks in {secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)}m` : `${secsLeft}s`}
                      </span>
                    )}
                  </div>
                );
              })}
              {hasUploadInProcessing && (
                <p className="text-xs leading-relaxed opacity-80">
                  One or more MP4 uploads may still be undergoing moov-atom optimisation
                  (faststart) — the file is being rewritten and temporarily unavailable.
                  Wait 60–120 s for processing to complete; the queue reloads automatically
                  when it finishes and clears the block immediately.
                </p>
              )}
              <p className="text-xs opacity-70">
                This preview has stall reports disabled — source blocks here do{" "}
                <strong>not</strong> affect real viewers on TV, mobile, or web.
                Use <strong>Clear {blockedCount} source block{blockedCount !== 1 ? "s" : ""}</strong> below
                to force an immediate retry on all surfaces.
              </p>
            </div>
          </div>
        );
      })()}

      <TranscodingProgressPanel />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Broadcast queue</CardTitle>
          <Link href="/broadcast">
            <Button size="sm" variant="outline" className="gap-1">
              <Pencil className="h-3 w-3" /> Edit queue
            </Button>
          </Link>
        </CardHeader>
        <CardContent>
          {queueLoading ? (
            <p className="text-sm text-muted-foreground">Loading queue…</p>
          ) : queueItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No items in the broadcast queue. Open the editor to add uploaded videos.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {queueItems.map((item, idx) => {
                const isCurrent = server?.current?.id === item.id;
                const isNext = server?.next?.id === item.id;
                const health = healthByItemId[item.id];
                const isBlocked = health?.status === "bad";
                const secsLeft =
                  isBlocked && health?.badUntilMs
                    ? Math.max(0, Math.ceil((health.badUntilMs - Date.now()) / 1000))
                    : null;
                const blockLabel =
                  secsLeft !== null
                    ? secsLeft >= 60
                      ? `Blocked ${Math.ceil(secsLeft / 60)}m`
                      : `Blocked ${secsLeft}s`
                    : "Blocked";

                return (
                  <li
                    key={item.id}
                    className={`flex items-center gap-3 px-3 py-2 ${
                      isCurrent ? "bg-primary/5" : ""
                    } ${!item.isActive ? "opacity-50" : ""}`}
                  >
                    <span className="w-6 text-center text-xs tabular-nums text-muted-foreground">
                      {idx + 1}
                    </span>
                    <div className="h-10 w-16 flex-shrink-0 overflow-hidden rounded bg-muted">
                      {item.thumbnailUrl ? (
                        <img
                          src={item.thumbnailUrl}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-contain bg-black"
                        />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{item.title}</div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{Math.round(item.durationSecs)}s</span>
                        <span className="opacity-50">·</span>
                        <span className="uppercase">{item.videoSource}</span>
                        {!item.isActive && (
                          autoSuspendedIds.has(item.id) ? (
                            <>
                              <Badge
                                variant="destructive"
                                className="h-4 text-[10px] gap-1"
                                title="Auto-suspended: this item was automatically deactivated after repeated URL failures. Fix the source URL then click Re-enable."
                              >
                                <ShieldAlert className="h-2 w-2" />
                                auto-suspended
                              </Badge>
                              <button
                                onClick={() => reactivateMutation.mutate(item.id)}
                                disabled={reactivateMutation.isPending}
                                className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-300 hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-400 dark:ring-emerald-700 dark:hover:bg-emerald-950/30"
                                title="Re-enable this item and add it back to the broadcast rotation."
                              >
                                <RefreshCw className="h-2.5 w-2.5" />
                                Re-enable
                              </button>
                            </>
                          ) : (
                            <Badge variant="outline" className="h-4 text-[10px]">
                              inactive
                            </Badge>
                          )
                        )}
                      </div>
                    </div>

                    {/* Source health badge — right-aligned */}
                    {isBlocked ? (
                      <Badge
                        variant="destructive"
                        className="gap-1 shrink-0 text-[10px]"
                        title={`Source URL failed to load. Blocked from playback queue until the TTL expires. Use "Clear source blocks" to retry immediately.`}
                      >
                        <ShieldAlert className="h-2.5 w-2.5" />
                        {blockLabel}
                      </Badge>
                    ) : item.isActive && health?.status === "ok" ? (
                      <Badge
                        variant="outline"
                        className="gap-1 shrink-0 text-[10px] border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400"
                        title="Source URL was probed recently and confirmed reachable."
                      >
                        <CheckCircle2 className="h-2.5 w-2.5" />
                        OK
                      </Badge>
                    ) : null}

                    {/* HLS readiness badge — only shown for locally-hosted videos */}
                    {item.videoId && (() => {
                      if (item.hasHls) {
                        return (
                          <Badge
                            variant="outline"
                            className="gap-1 shrink-0 text-[10px] border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400"
                            title="HLS master playlist ready — adaptive-bitrate streaming available on all surfaces."
                          >
                            <CheckCircle2 className="h-2.5 w-2.5" />
                            HLS
                          </Badge>
                        );
                      }
                      if (item.transcodingStatus === "processing") {
                        return (
                          <Badge
                            variant="secondary"
                            className="gap-1 shrink-0 text-[10px] text-amber-600 border-amber-200 dark:border-amber-800"
                            title="Faststart optimisation is running — the moov atom is being relocated to the front of the file for instant playback. This item will be held out of the broadcast queue until it is ready (usually 30–90 seconds)."
                          >
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            Preparing…
                          </Badge>
                        );
                      }
                      if (item.transcodingStatus === "encoding") {
                        return (
                          <Badge variant="secondary" className="gap-1 shrink-0 text-[10px]" title="HLS transcoding is actively encoding. This item will broadcast as MP4 until encoding finishes.">
                            <RotateCw className="h-2.5 w-2.5 animate-spin" />
                            Encoding…
                          </Badge>
                        );
                      }
                      if (item.transcodingStatus === "queued") {
                        return (
                          <Badge variant="secondary" className="gap-1 shrink-0 text-[10px]" title="HLS transcoding is queued — this item will broadcast as MP4 until it's processed.">
                            <RotateCw className="h-2.5 w-2.5" />
                            HLS queued
                          </Badge>
                        );
                      }
                      if (item.transcodingStatus === "failed") {
                        return (
                          <Badge variant="destructive" className="gap-1 shrink-0 text-[10px]" title="HLS transcoding failed. This item will broadcast as raw MP4. Check the server logs for ffmpeg errors.">
                            <XCircle className="h-2.5 w-2.5" />
                            HLS failed
                          </Badge>
                        );
                      }
                      if (item.transcodingStatus === "ready") {
                        return (
                          <Badge variant="outline" className="gap-1 shrink-0 text-[10px] text-amber-600 border-amber-300 dark:border-amber-700" title="Video is streamable as MP4 (faststart applied) but has no HLS playlist. Use 'Prepare HLS' to enable adaptive-bitrate streaming.">
                            MP4 only
                          </Badge>
                        );
                      }
                      return null;
                    })()}

                    {isCurrent && <Badge variant="default" className="shrink-0">On air</Badge>}
                    {isNext && !isCurrent && <Badge variant="secondary" className="shrink-0">Next</Badge>}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Helper components ────────────────────────────────────────────────────────

function HealthRow({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="flex items-center gap-1 text-xs font-medium truncate">
        {ok ? (
          <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
        ) : (
          <XCircle className="h-3 w-3 shrink-0 text-red-500" />
        )}
        <span className="truncate">{value}</span>
      </span>
    </div>
  );
}

function SnapshotSlot({
  label,
  item,
  highlight = false,
}: {
  label: string;
  item: { id: string; title: string; thumbnailUrl: string | null; durationSecs: number } | null;
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-lg border p-3 ${highlight ? "border-primary bg-primary/5" : ""}`}>
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      {!item ? (
        <div className="mt-1 text-sm text-muted-foreground">—</div>
      ) : (
        <div className="mt-1 flex gap-2">
          {item.thumbnailUrl && (
            <img
              src={item.thumbnailUrl}
              alt=""
              loading="lazy"
              className="h-12 w-20 rounded object-contain bg-black"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{item.title}</div>
            <div className="text-xs text-muted-foreground">{Math.round(item.durationSecs)}s</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Utility formatters ───────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

