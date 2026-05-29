import { useV2Broadcast } from "@workspace/player-core/react";
import { BroadcastPreviewV2 } from "@/playback/BroadcastPreviewV2";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  SkipForward,
  RefreshCw,
  AlertTriangle,
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
  Upload,
  Video,
  ListPlus,
  GripVertical,
  Timer,
  ClipboardCheck,
  CircleCheck,
  CircleX,
  CircleAlert,
  Zap,
  CalendarDays,
  CalendarClock,
  Pin,
  PinOff,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { BroadcastUploadPanel } from "@/components/broadcast/BroadcastUploadPanel";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Link } from "wouter";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { apiBase } from "@/lib/api-base";
import { api, HttpError } from "@/lib/api";
import { useSSE, useSSEEvent } from "@/contexts/sse-context";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

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
  /** Error message from the last failed transcoding job, or null when not failed. */
  transcodingError: string | null;
  /** Absolute URL of the locally-uploaded video (prod-sync items only). */
  localVideoUrl: string | null;
  /** ISO string of the locked air time for this item, or null for floating. */
  scheduledAt: string | null;
  /** Human-readable programming block label. */
  scheduleLabel: string | null;
}

interface SourceHealthEntry {
  status: "ok" | "bad";
  badUntilMs: number | null;
}

interface ScheduleUpdate {
  id: string;
  scheduledAt: string | null;
  scheduleLabel: string | null;
}

interface QueueSyncStatus {
  // Capped at 100 — kept for back-compat with badge tooltip & sample list.
  missingCount: number;
  missingReadyCount: number;
  sample: Array<{ id: string; title: string; videoSource: string; reason: string }>;
  // Uncapped totals — use these when displaying counts to the operator.
  libraryTotal?: number;
  libraryPlayable?: number;
  missingPlayable?: number;
}

interface EngineHealth {
  ok: boolean;
  stuck?: boolean;
  channelId: string;
  sequence: number;
  mode: string;
  hasCurrent: boolean;
  hasOverride: boolean;
  failoverActive: boolean;
  /** Current item title — null when off air or override mode. */
  currentTitle?: string | null;
  /** Next item title — null when queue has ≤1 active item. */
  nextTitle?: string | null;
  /** Current item duration in seconds. */
  currentDurationSecs?: number | null;
  /** Seconds elapsed on the current item (server wall-clock estimate). */
  currentElapsedSecs?: number | null;
  /** Why broadcast is off air when not in override mode. */
  offAirReason?: "empty" | "all_blocked" | null;
  /**
   * True when the queue has items but nothing is on air and sources are
   * not all blocked — signals a dead-air condition requiring operator attention.
   */
  deadAir?: boolean;
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
  skipInfo?: {
    consecutiveSkips: number;
    lastDeadAirAt: number | null;
  };
  airingHistory?: AiringEntry[];
}

interface AiringEntry {
  itemId: string;
  title: string | null;
  sourceUrl: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
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
  circuitAutoResetAtMs: number | null;
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
    bufferUtilizationPct?: number;
    windowMs?: number;
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
      active: d.jobs.filter((j) => ["queued", "encoding", "processing"].includes(j.status)),
      recentFailed: d.jobs.filter((j) => j.status === "failed").slice(0, 3),
    }),
  });

  useSSEEvent("transcoding-update", () => {
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-transcoding-panel"] });
  });

  const activeJobs = data?.active ?? [];
  const recentFailed = data?.recentFailed ?? [];
  if (activeJobs.length === 0 && recentFailed.length === 0) return null;

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
        {recentFailed.length > 0 && (
          <div className="space-y-1 border-t pt-2 mt-1">
            <p className="text-[10px] font-medium uppercase tracking-wide text-red-500 dark:text-red-400 px-1">
              Recent Failures
            </p>
            {recentFailed.map((job) => (
              <div key={job.id} className="flex items-start gap-2 rounded-md border border-red-200/60 dark:border-red-800/40 bg-red-50/40 dark:bg-red-950/15 px-3 py-2">
                <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate text-foreground">
                    {job.videoTitle ?? job.videoId}
                  </p>
                  {job.errorMessage && (
                    <p className="text-[10px] text-red-600 dark:text-red-400 truncate mt-0.5" title={job.errorMessage}>
                      {job.errorMessage}
                    </p>
                  )}
                </div>
                <Badge variant="destructive" className="shrink-0 text-[10px] px-1.5">
                  Failed
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Sortable queue row ───────────────────────────────────────────────────────
// Extracted so useSortable() is called at the top level of a real component
// (not inside a .map() callback — that would violate Rules of Hooks).

interface SortableItemProps {
  item: BroadcastQueueRow;
  index: number;
  isCurrent: boolean;
  isNext: boolean;
  health: SourceHealthEntry | undefined;
  autoSuspendedIds: Set<string>;
  isDeactivating: boolean;
  isReactivating: boolean;
  onDeactivate: (id: string) => void;
  onReactivate: (id: string) => void;
  onRetryHls: (videoId: string) => void;
  isRetryingHls: boolean;
  onTranscodeLocally: (itemId: string) => void;
  isTranscodingLocally: boolean;
}

function SortableQueueItem({
  item,
  index,
  isCurrent,
  isNext,
  health,
  autoSuspendedIds,
  isDeactivating,
  isReactivating,
  onDeactivate,
  onReactivate,
  onRetryHls,
  isRetryingHls,
  onTranscodeLocally,
  isTranscodingLocally,
}: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

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
      ref={setNodeRef}
      style={style}
      className={[
        "flex items-center gap-2 px-3 py-2",
        isCurrent ? "bg-primary/5" : "",
        !item.isActive ? "opacity-50" : "",
        isDragging ? "bg-background shadow-lg rounded z-50" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Drag handle */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground/70 shrink-0 touch-none p-0.5 -ml-1"
        aria-label="Drag to reorder"
        title="Drag to reorder"
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <span className="w-5 text-center text-xs tabular-nums text-muted-foreground shrink-0">
        {index + 1}
      </span>

      <div className="h-10 w-16 flex-shrink-0 overflow-hidden rounded bg-muted flex items-center justify-center relative">
        {item.thumbnailUrl && (
          <img
            src={item.thumbnailUrl}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-contain bg-black"
            onError={(e) => { (e.target as HTMLImageElement).style.opacity = "0"; }}
          />
        )}
        <Radio className="h-4 w-4 opacity-25 text-muted-foreground" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{item.title}</div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{Math.round(item.durationSecs)}s</span>
          <span className="opacity-50">·</span>
          <span className="uppercase">{item.videoSource}</span>
          {!item.isActive &&
            (autoSuspendedIds.has(item.id) ? (
              <>
                <Badge
                  variant="destructive"
                  className="h-4 text-[10px] gap-1"
                  title="Auto-suspended after repeated URL failures. Fix the source URL then click Re-enable."
                >
                  <ShieldAlert className="h-2 w-2" />
                  auto-suspended
                </Badge>
                <button
                  onClick={() => onReactivate(item.id)}
                  disabled={isReactivating}
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
            ))}
        </div>
      </div>

      {/* Source health badge */}
      {isBlocked ? (
        <Badge
          variant="destructive"
          className="gap-1 shrink-0 text-[10px]"
          title="Source URL failed to load. Blocked until TTL expires. Use 'Clear source blocks' to retry immediately."
        >
          <ShieldAlert className="h-2.5 w-2.5" />
          {blockLabel}
        </Badge>
      ) : item.isActive && health?.status === "ok" ? (
        <Badge
          variant="outline"
          className="gap-1 shrink-0 text-[10px] border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400"
          title="Source URL confirmed reachable."
        >
          <CheckCircle2 className="h-2.5 w-2.5" />
          OK
        </Badge>
      ) : null}

      {/* HLS readiness badge */}
      {item.videoId &&
        (() => {
          if (item.hasHls)
            return (
              <Badge
                variant="outline"
                className="gap-1 shrink-0 text-[10px] border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400"
                title="HLS master playlist ready — adaptive-bitrate streaming available."
              >
                <CheckCircle2 className="h-2.5 w-2.5" />
                HLS
              </Badge>
            );
          if (item.transcodingStatus === "processing")
            return (
              <Badge
                variant="secondary"
                className="gap-1 shrink-0 text-[10px] text-amber-600 border-amber-200 dark:border-amber-800"
                title="Faststart optimisation running — item held out of queue until ready."
              >
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                Preparing…
              </Badge>
            );
          if (item.transcodingStatus === "encoding")
            return (
              <Badge
                variant="secondary"
                className="gap-1 shrink-0 text-[10px]"
                title="HLS transcoding active — will broadcast as MP4 until encoding finishes."
              >
                <RotateCw className="h-2.5 w-2.5 animate-spin" />
                Encoding…
              </Badge>
            );
          if (item.transcodingStatus === "queued")
            return (
              <Badge
                variant="secondary"
                className="gap-1 shrink-0 text-[10px]"
                title="HLS transcoding queued — will broadcast as MP4 until processed."
              >
                <RotateCw className="h-2.5 w-2.5" />
                HLS queued
              </Badge>
            );
          if (item.transcodingStatus === "failed")
            return (
              <div className="flex items-center gap-1 shrink-0">
                <Badge
                  variant="destructive"
                  className="gap-1 text-[10px]"
                  title={
                    item.transcodingError
                      ? `HLS transcoding failed — broadcasting as raw MP4.\n\nError: ${item.transcodingError}`
                      : "HLS transcoding failed — broadcasting as raw MP4."
                  }
                >
                  <XCircle className="h-2.5 w-2.5" />
                  HLS failed
                </Badge>
                {item.videoId && (
                  <button
                    onClick={() => onRetryHls(item.videoId!)}
                    disabled={isRetryingHls}
                    className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-300 hover:bg-amber-50 disabled:opacity-50 dark:text-amber-400 dark:ring-amber-700 dark:hover:bg-amber-950/30"
                    title="Retry HLS transcoding for this video."
                  >
                    <RotateCw className={`h-2.5 w-2.5 ${isRetryingHls ? "animate-spin" : ""}`} />
                    Retry
                  </button>
                )}
              </div>
            );
          if (item.transcodingStatus === "ready")
            return (
              <Badge
                variant="outline"
                className="gap-1 shrink-0 text-[10px] text-amber-600 border-amber-300 dark:border-amber-700"
                title="MP4 only — no HLS. Use 'Prepare HLS' for adaptive-bitrate streaming."
              >
                MP4 only
              </Badge>
            );
          return null;
        })()}

      {/* Transcode-locally badge — prod-sync items that have no local managed video */}
      {!item.videoId && !item.hasHls && item.localVideoUrl && (
        <div className="flex items-center gap-1 shrink-0">
          <Badge
            variant="outline"
            className="gap-1 text-[10px] text-slate-500 border-slate-300 dark:border-slate-600"
            title="No HLS — source lives on the production server. Click 'Transcode' to download and encode locally."
          >
            No HLS
          </Badge>
          <button
            onClick={() => onTranscodeLocally(item.id)}
            disabled={isTranscodingLocally}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-blue-700 ring-1 ring-blue-300 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:ring-blue-700 dark:hover:bg-blue-950/30"
            title="Download source from production and queue for local HLS transcoding."
          >
            <RotateCw className={`h-2.5 w-2.5 ${isTranscodingLocally ? "animate-spin" : ""}`} />
            Transcode
          </button>
        </div>
      )}

      {isCurrent && (
        <Badge variant="default" className="shrink-0">
          On air
        </Badge>
      )}
      {isNext && !isCurrent && (
        <Badge variant="secondary" className="shrink-0">
          Next
        </Badge>
      )}

      {/* Remove item — warns when on air */}
      {item.isActive && (
        <button
          onClick={() => {
            if (isCurrent) {
              toast.warning(
                "This item is currently on air. Use Skip to move to the next item first, then remove it.",
              );
              return;
            }
            onDeactivate(item.id);
          }}
          disabled={isDeactivating}
          className="ml-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
          title={
            isCurrent
              ? "On air — use Skip first, then remove"
              : "Remove from broadcast queue"
          }
          aria-label={`Remove "${item.title}" from broadcast queue`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </li>
  );
}

/**
 * Admin Live Broadcast (v2 control plane).
 *
 * Server-authoritative live console:
 *  - persistent A/B player buffers driven by the universal player core
 *  - real-time queue snapshot from the v2 transport
 *  - real-time queue list with per-item drag-to-reorder and remove actions
 *  - operator controls (skip / reload / failover) with idempotency keys
 *  - source health badges showing which queue items have blocked URLs
 *  - engine health panel (boot status, reload stats, prod-sync diagnostics)
 *  - combined connection indicator (global SSE + v2 transport)
 *  - listens for `broadcast-queue-updated` to auto-reload the v2 orchestrator
 *    so the queue snapshot always reflects DB mutations within ~1 frame.
 */
function BroadcastV2PageInner() {
  const apiOrigin = apiBase().replace(/\/$/, "");
  const baseUrl = `${apiOrigin}/broadcast-v2`;
  // enableStallReport: false — operator console must never affect the broadcast
  // stream. Admin preview failures are environment-local and must not block
  // sources for real viewers (TV, mobile, web).
  const { snapshot, connected: transportConnected } = useV2Broadcast({ baseUrl, enableStallReport: false });
  const sse = useSSE();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  // Dismissible stuck-engine banner. Reset whenever the stuck condition
  // resolves (sequence > 0) so the banner reappears if the engine gets
  // stuck again in the same session.
  const [stuckAlertDismissed, setStuckAlertDismissed] = useState(false);
  // Dismissible all-sources-blocked banner. Same auto-reset pattern.
  const [allBlockedDismissed, setAllBlockedDismissed] = useState(false);
  // Dismissible faststart-in-progress banner. Auto-reset when no items remain
  // in 'processing' state so the banner reappears if a new faststart starts.
  const [processingAlertDismissed, setProcessingAlertDismissed] = useState(false);
  // Dismissible circuit-open banner. Auto-reset when all workers are healthy.
  const [circuitOpenDismissed, setCircuitOpenDismissed] = useState(false);
  // Dismissible dead-air banner. Auto-reset when a current item is found so
  // the banner reappears if the broadcast drops to dead air again.
  const [deadAirDismissed, setDeadAirDismissed] = useState(false);
  // Dismissible consecutive-skips banner. Auto-reset when consecutiveSkips
  // drops back to 0 (a successful item play).
  const [consecutiveSkipsDismissed, setConsecutiveSkipsDismissed] = useState(false);
  // Emergency filler alert — appears when the orchestrator exhausts all queue
  // items and falls back to EMERGENCY_FILLER_URL. Dismissed manually.
  const [fillerActiveDismissed, setFillerActiveDismissed] = useState(false);
  const [fillerActiveAt, setFillerActiveAt] = useState<number | null>(null);
  // Launch Checklist modal.
  const [showChecklist, setShowChecklist] = useState(false);

  // Ticks every second so the on-air progress bar stays live between SSE frames.
  const [liveNow, setLiveNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setLiveNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

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
      // Functional update: only clear busy if WE are still the active
      // operation — a concurrent clearBlocks / prepareHls may have
      // started and set a different key while adminPost was in-flight.
      setBusy((prev) => (prev === path ? null : prev));
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
  const { data: engineHealth, isError: engineHealthError } = useQuery({
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

  // Deactivate (remove) a queue item without navigating away.
  const deactivateMutation = useMutation({
    mutationFn: (itemId: string) =>
      api.patch(`/admin/broadcast/${itemId}`, { isActive: false }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue-sync-status"] });
      toast.success("Item removed from broadcast queue.");
    },
    onError: (err) => {
      toast.error(err instanceof HttpError ? err.message : "Failed to remove item.");
    },
  });

  // Retry HLS transcoding for a queue item whose transcodingStatus === 'failed'.
  // Calls the same endpoint as the manual "Queue HLS" button in the Videos page,
  // which re-arms the failed job (resets attempts + errorMessage) and nudges the
  // dispatcher to start immediately rather than waiting for the next poll tick.
  const retryHlsMutation = useMutation({
    mutationFn: (videoId: string) =>
      api.post<{ jobId: string; reused: boolean }>(
        `/admin/videos/${videoId}/transcode`,
        {},
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-transcoding-panel"] });
      toast.success("HLS transcoding re-queued — encoding will start shortly.");
      void api.post("/broadcast-v2/reload", { idempotencyKey: crypto.randomUUID() }).catch(() => {});
    },
    onError: (err) => {
      toast.error(err instanceof HttpError ? err.message : "Failed to retry HLS transcoding.");
    },
  });

  // Download a prod-sync queue item's remote source and queue it for local HLS transcoding.
  const transcodeLocallyMutation = useMutation({
    mutationFn: (itemId: string) =>
      api.post<{ ok: true; videoId: string; message: string }>(
        `/broadcast-v2/queue/${itemId}/transcode-remote`,
        {},
      ),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-transcoding-panel"] });
      toast.success(`Download started — HLS transcoding queued (id: ${data.videoId.slice(0, 8)}…)`);
    },
    onError: (err) => {
      toast.error(err instanceof HttpError ? err.message : "Failed to start remote transcode.");
    },
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

  // Sync library → queue: scans managed_videos for playable rows not yet in
  // broadcast_queue and inserts them. Idempotent — safe to call repeatedly.
  const syncLibraryMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; scanned: number; enqueued: number; skipped: number }>(
        "/broadcast-v2/sync-library",
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue-sync-status"] });
      if (result.enqueued > 0) {
        toast.success(
          `Synced ${result.enqueued} video${result.enqueued !== 1 ? "s" : ""} into the broadcast queue (scanned ${result.scanned}).`,
        );
      } else {
        toast.success(`Library scan complete — all ${result.scanned} playable video${result.scanned !== 1 ? "s" : ""} already in queue.`);
      }
    },
    onError: (err) => {
      toast.error(err instanceof HttpError ? err.message : "Library sync failed — check server logs.");
    },
  });

  // ── Drag-to-reorder state ────────────────────────────────────────────────
  // Optimistic local order: updated immediately on drag-end then synced to
  // the server via a 250 ms debounced PUT. Reset from the server state on
  // every fresh queueData fetch, but not while a drag is in flight.
  const [localOrder, setLocalOrder] = useState<string[]>(() =>
    (queueData?.items ?? []).map((i) => i.id),
  );
  const isDraggingRef = useRef(false);
  useEffect(() => {
    if (!isDraggingRef.current) {
      // Dedup IDs: DB-sync races can produce duplicate rows; duplicate IDs
      // crash DnD-kit's sortable hook before orderedQueueItems can filter them.
      const seen = new Set<string>();
      setLocalOrder(
        (queueData?.items ?? [])
          .map((i) => i.id)
          .filter((id) => !seen.has(id) && (seen.add(id), true)),
      );
    }
  }, [queueData]);

  const [showScheduleEditor, setShowScheduleEditor] = useState(false);

  const reorderDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(reorderDebounceRef.current), []);

  const reorderMutation = useMutation({
    mutationFn: (itemIds: string[]) =>
      api.put<{ ok: boolean; count: number }>("/admin/broadcast/reorder", { itemIds }),
    onError: (err) => {
      toast.error(
        err instanceof HttpError ? err.message : "Reorder failed — restoring queue from server.",
      );
      setLocalOrder((queueData?.items ?? []).map((i) => i.id));
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
    },
  });

  const saveScheduleMutation = useMutation({
    mutationFn: (updates: ScheduleUpdate[]) =>
      api.post<{ ok: boolean; applied: number }>("/admin/broadcast/schedule/batch", { updates }),
    onSuccess: (result) => {
      toast.success(`Schedule saved — ${result.applied} item${result.applied !== 1 ? "s" : ""} updated.`);
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
    },
    onError: (err) => {
      toast.error(err instanceof HttpError ? err.message : "Schedule save failed.");
    },
  });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      isDraggingRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      setLocalOrder((prev) => {
        const oldIdx = prev.indexOf(active.id as string);
        const newIdx = prev.indexOf(over.id as string);
        if (oldIdx === -1 || newIdx === -1) return prev;
        const next = arrayMove(prev, oldIdx, newIdx);
        clearTimeout(reorderDebounceRef.current);
        reorderDebounceRef.current = setTimeout(() => {
          reorderMutation.mutate(next);
        }, 250);
        return next;
      });
    },
    [reorderMutation],
  );

  // How many library videos are missing from the queue — refreshed every 60 s
  // so the banner stays accurate without hammering the server.
  const { data: queueSyncStatus } = useQuery({
    queryKey: ["broadcast-v2-queue-sync-status"],
    queryFn: () => api.get<QueueSyncStatus>("/broadcast-v2/queue-sync-status"),
    refetchInterval: 60_000,
    staleTime: 45_000,
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

  // Show emergency-filler banner whenever the orchestrator inserts a filler item
  // (all regular queue items exhausted / unresolvable). Resets dismiss state so
  // the operator always sees it even if they dismissed a previous occurrence.
  useSSEEvent("emergency-filler-activated", () => {
    setFillerActiveDismissed(false);
    setFillerActiveAt(Date.now());
  });

  const server = snapshot.lastServerSnapshot;
  const queueItems = queueData?.items ?? [];
  const activeQueueCount = queueItems.filter((i) => i.isActive).length;

  // Items in drag-reorder local order — instantly reflects drag operations
  // before the server round-trip completes.
  // Dedup by ID before passing to DnD-kit: duplicate IDs in queueData
  // (possible during partial DB-sync or prod-sync races) crash the sortable
  // hook with a "Found duplicate draggable id" invariant violation.
  const orderedQueueItems = useMemo(() => {
    const idToItem = new Map(queueItems.map((i) => [i.id, i]));
    const seen = new Set<string>();
    return localOrder
      .map((id) => idToItem.get(id))
      .filter((i): i is BroadcastQueueRow =>
        i !== undefined && !seen.has(i.id) && (seen.add(i.id), true),
      );
  }, [localOrder, queueItems]);
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
  // These items ARE in the broadcast queue and will air normally — the raw
  // upload blob remains readable throughout the multipart atomic swap.
  // Once faststart completes the optimised file replaces the original in-place.
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

  // Dead air: queue has items but nothing is broadcasting and sources aren't
  // all blocked — a subtle condition that the other banners don't cover.
  // Only surface after a brief warmup window so we don't flash on cold boot.
  const isDeadAir = engineHealth?.deadAir === true && !isStuck;
  useEffect(() => {
    if (!isDeadAir) setDeadAirDismissed(false);
  }, [isDeadAir]);

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

  // Consecutive-skips warning: ≥2 items have been skipped back-to-back
  // without a successful play. This is an early signal of an emerging
  // all-blocked or total-exhaustion condition — surface it before dead air
  // actually occurs so operators can act proactively.
  const consecutiveSkips = engineHealth?.skipInfo?.consecutiveSkips ?? 0;
  const isConsecutiveSkipsWarning = consecutiveSkips >= 2 && !isAllBlocked && !isStuck;
  useEffect(() => {
    if (!isConsecutiveSkipsWarning) setConsecutiveSkipsDismissed(false);
  }, [isConsecutiveSkipsWarning]);

  // Circuit-open workers: any background worker whose circuit breaker has
  // tripped. Workers auto-reset after 10 minutes but the banner surfaces the
  // condition early so operators can act if needed.
  const circuitOpenWorkers = diagnostics?.workers.filter((w) => w.circuitOpen) ?? [];
  useEffect(() => {
    if (circuitOpenWorkers.length === 0) setCircuitOpenDismissed(false);
  }, [circuitOpenWorkers.length]);

  // Auto-reset the processing banner when no more items are in 'processing'.
  useEffect(() => {
    if (processingCount === 0) setProcessingAlertDismissed(false);
  }, [processingCount]);

  // ── On-air progress ──────────────────────────────────────────────────────────
  // Current item elapsed and total, recomputed every second by the liveNow tick.
  const currentItem = server?.current ?? null;
  const onAirElapsedMs = currentItem
    ? Math.max(0, liveNow - currentItem.startsAtMs)
    : 0;
  const onAirTotalMs = currentItem
    ? Math.max(1, currentItem.endsAtMs - currentItem.startsAtMs)
    : 1;
  const onAirProgressPct = Math.min(100, Math.round((onAirElapsedMs / onAirTotalMs) * 100));
  const onAirElapsedSecs = Math.floor(onAirElapsedMs / 1000);
  const onAirTotalSecs   = Math.floor(onAirTotalMs  / 1000);
  const fmtSecs = (s: number) =>
    s >= 3600
      ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
      : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const onAirRemainingSecs = currentItem
    ? Math.max(0, Math.ceil((currentItem.endsAtMs - liveNow) / 1000))
    : 0;
  const viewerCount = diagnostics?.analytics?.activeSessions ?? null;

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
      setBusy((prev) => (prev === "clear-blocks" ? null : prev));
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
      // Also invalidate admin-videos so the HLS-status badge in the video
      // library reflects the newly-queued transcoding jobs without a manual
      // page refresh. prepareHls touches the same transcodingStatus column
      // that the video list reads for its "HLS ready" indicator.
      await qc.invalidateQueries({ queryKey: ["admin-videos"] });
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
      setBusy((prev) => (prev === "prepare-hls" ? null : prev));
    }
  }

  // ── Launch Checklist computation (derived from already-fetched state) ───────
  const checklistItems = engineHealth != null ? [
    {
      label: "Queue populated",
      pass: activeQueueCount > 0,
      warn: false,
      detail: activeQueueCount > 0
        ? `${activeQueueCount} active item${activeQueueCount !== 1 ? "s" : ""}`
        : "No active items — add videos to the queue before going live",
    },
    {
      label: "Engine running",
      pass: engineHealth.boot.started && (engineHealth.sequence > 0 || engineHealth.uptimeMs < 30_000),
      warn: false,
      detail: engineHealth.boot.started
        ? `Sequence #${engineHealth.sequence} · uptime ${Math.floor(engineHealth.uptimeMs / 60_000)}m`
        : `Boot failed after ${engineHealth.boot.startAttempts} attempt${engineHealth.boot.startAttempts !== 1 ? "s" : ""}`,
    },
    {
      label: "No dead air detected",
      pass: !isDeadAir && !isStuck,
      warn: false,
      detail: isStuck
        ? "Orchestrator appears stuck — try Reload"
        : isDeadAir
        ? "Queue has items but nothing is on air"
        : "Broadcast is on air or off air normally",
    },
    {
      label: "Transport connected",
      pass: fullyConnected,
      warn: partiallyConnected && !fullyConnected,
      detail: linkLabel === "Live" ? "WS + SSE both connected" : linkLabel,
    },
    {
      label: "Source URLs healthy",
      pass: blockedCount === 0,
      warn: false,
      detail: blockedCount === 0
        ? "All source URLs reachable"
        : `${blockedCount} source${blockedCount !== 1 ? "s" : ""} temporarily blocked — clear blocks to retry`,
    },
    {
      label: "HLS transcoding ready",
      pass: allHlsReady || localQueueItems.length === 0,
      warn: pendingHlsCount > 0,
      detail: localQueueItems.length === 0
        ? "No local videos in queue"
        : allHlsReady
        ? "All local items have HLS playlist ready"
        : `${pendingHlsCount} item${pendingHlsCount !== 1 ? "s" : ""} missing HLS — will fall back to raw MP4`,
    },
  ] : [];
  const checklistBlockerCount = checklistItems.filter(c => !c.pass && !c.warn).length;
  const checklistWarnCount = checklistItems.filter(c => !c.pass && c.warn).length;
  const checklistAllClear = checklistBlockerCount === 0;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader
        title="Master Control"
        description="Server-authoritative continuous broadcast — live preview, queue, and operator controls."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={!!busy}
              onClick={() => adminPost("/broadcast-v2/reload")}
              title="Re-enables all suspended items, clears blocked sources, and reloads the queue from the database."
            >
              {busy === "/broadcast-v2/reload" ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RotateCw size={13} />
              )}
              Restart Engine
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setShowChecklist(true)}
            >
              <ClipboardCheck size={13} /> Launch Checklist
            </Button>
          </div>
        }
      />

      {/* Launch Checklist dialog */}
      <Dialog open={showChecklist} onOpenChange={setShowChecklist}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5" />
              Pre-Broadcast Launch Checklist
            </DialogTitle>
            <DialogDescription>
              Verify these conditions before going live to ensure uninterrupted broadcasting.
            </DialogDescription>
          </DialogHeader>

          {engineHealth == null ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {engineHealthError ? (
                <span className="text-destructive">
                  Failed to load engine status — check API connectivity and try again.
                </span>
              ) : (
                "Loading engine status…"
              )}
            </div>
          ) : (
            <div className="space-y-1 py-2">
              {checklistItems.map((item) => (
                <div
                  key={item.label}
                  className={`flex items-start gap-3 rounded-lg px-3 py-2.5 ${
                    item.pass
                      ? "bg-green-50 dark:bg-green-950/20"
                      : item.warn
                      ? "bg-amber-50 dark:bg-amber-950/20"
                      : "bg-red-50 dark:bg-red-950/20"
                  }`}
                >
                  {item.pass ? (
                    <CircleCheck className="h-4 w-4 text-green-600 dark:text-green-400 mt-0.5 flex-shrink-0" />
                  ) : item.warn ? (
                    <CircleAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                  ) : (
                    <CircleX className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className={`text-sm font-medium ${item.pass ? "text-green-800 dark:text-green-200" : item.warn ? "text-amber-800 dark:text-amber-200" : "text-red-800 dark:text-red-200"}`}>
                      {item.label}
                    </p>
                    <p className={`text-xs mt-0.5 ${item.pass ? "text-green-700/70 dark:text-green-300/70" : item.warn ? "text-amber-700/70 dark:text-amber-300/70" : "text-red-700/70 dark:text-red-300/70"}`}>
                      {item.detail}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Summary */}
          {engineHealth != null && (
            <div className={`rounded-lg border px-4 py-3 text-sm font-medium flex items-center gap-2 ${
              checklistAllClear
                ? "border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-300"
                : "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300"
            }`}>
              {checklistAllClear
                ? <CircleCheck className="h-4 w-4 flex-shrink-0" />
                : <CircleX className="h-4 w-4 flex-shrink-0" />}
              {checklistAllClear && checklistWarnCount === 0
                ? "All checks passed — ready to go live."
                : checklistAllClear
                ? `Ready with ${checklistWarnCount} warning${checklistWarnCount !== 1 ? "s" : ""} — review before going live.`
                : `${checklistBlockerCount} blocker${checklistBlockerCount !== 1 ? "s" : ""} found — resolve before going live.`}
            </div>
          )}

          <DialogFooter className="flex-wrap gap-2 sm:flex-row">
            {blockedCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { void clearBlocks(); setShowChecklist(false); }}
                disabled={busy === "clear-blocks"}
                className="gap-1.5"
              >
                <ShieldAlert className="h-3.5 w-3.5" />
                Clear Blocks
              </Button>
            )}
            {pendingHlsCount > 0 && localQueueItems.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { void prepareHls(); setShowChecklist(false); }}
                disabled={busy === "prepare-hls"}
                className="gap-1.5"
              >
                <Zap className="h-3.5 w-3.5" />
                Prepare HLS
              </Button>
            )}
            <Button variant="default" size="sm" onClick={() => setShowChecklist(false)} className="ml-auto">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
            className="gap-1 border-blue-400/70 bg-blue-50 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200"
            title={`${processingCount} item${processingCount !== 1 ? "s" : ""} being optimised for streaming (moov atom relocation). ${processingCount !== 1 ? "They are" : "It is"} airing normally on the raw upload while faststart runs in the background.`}
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            {processingCount} optimising
          </Badge>
        )}
        {/* Dead-air badge — queue has items but nothing is on air */}
        {isDeadAir && (
          <Badge
            variant="outline"
            className="gap-1 animate-pulse border-orange-400/70 bg-orange-50 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200"
          >
            <Radio className="h-3 w-3" />
            Dead air — {engineHealth?.itemCount} item{engineHealth?.itemCount !== 1 ? "s" : ""} queued
          </Badge>
        )}
        {/* Stuck orchestrator alert badge */}
        {isStuck && (
          <Badge variant="destructive" className="gap-1 animate-pulse">
            <AlertTriangle className="h-3 w-3" />
            Engine stuck — see health panel
          </Badge>
        )}
        {/* Circuit-open workers badge */}
        {circuitOpenWorkers.length > 0 && (
          <Badge variant="destructive" className="gap-1 animate-pulse">
            <ShieldAlert className="h-3 w-3" />
            {circuitOpenWorkers.length} worker{circuitOpenWorkers.length > 1 ? "s" : ""} tripped
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

      {/* ── On-Air Status Bar ──────────────────────────────────────────── */}
      {/* Always visible when the broadcast has a current item. Shows: live
          pulse, item title, per-second progress bar, elapsed / total time,
          viewer count, and sequence — giving operators a single glance
          at the full broadcast state without scrolling to the queue. */}
      <div
        role="status"
        aria-label="On-air status"
        className={[
          "rounded-lg border px-4 py-3",
          currentItem
            ? "border-red-300/70 bg-red-50 dark:border-red-800/60 dark:bg-red-950/20"
            : "border-border bg-muted/30",
        ].join(" ")}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* Live / Off-air label */}
          <div className="flex items-center gap-1.5 shrink-0">
            {currentItem ? (
              <>
                <span
                  className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse"
                  aria-hidden="true"
                />
                <span className="text-xs font-bold uppercase tracking-widest text-red-700 dark:text-red-400">
                  On Air
                </span>
              </>
            ) : (
              <>
                <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/40" aria-hidden="true" />
                <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Off Air
                </span>
              </>
            )}
          </div>

          {/* Current item title */}
          <p className="flex-1 min-w-0 truncate text-sm font-medium">
            {currentItem?.title ?? (activeQueueCount === 0 ? "Queue is empty" : "No item on air")}
          </p>

          {/* Elapsed / total time */}
          {currentItem && (
            <span className="text-xs tabular-nums text-muted-foreground shrink-0">
              {fmtSecs(onAirElapsedSecs)} / {fmtSecs(onAirTotalSecs)}
            </span>
          )}

          {/* Countdown — how much time remains on the current item */}
          {currentItem && (
            <span
              className={[
                "flex items-center gap-1 text-xs tabular-nums shrink-0",
                onAirRemainingSecs <= 30
                  ? "text-amber-500 dark:text-amber-400"
                  : "text-muted-foreground",
              ].join(" ")}
              title="Time remaining on current item"
            >
              <Timer className="h-3 w-3" />
              -{fmtSecs(onAirRemainingSecs)}
            </span>
          )}

          {/* Viewer count */}
          {viewerCount !== null && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0" title="Active sessions in the last hour">
              <Users className="h-3.5 w-3.5" />
              <span>{viewerCount}</span>
            </div>
          )}

          {/* Sequence */}
          {server && (
            <span className="text-xs tabular-nums text-muted-foreground shrink-0" title="Broadcast sequence number">
              seq {server.sequence}
            </span>
          )}
        </div>

        {/* Progress bar — fills across the full card width */}
        {currentItem && (
          <Progress
            value={onAirProgressPct}
            className="mt-2.5 h-1.5"
            aria-label={`${onAirProgressPct}% through current item`}
          />
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
            installed. Auto-recovery is running — the engine will clear source blocks, re-enable
            suspended items, and reload every 5 minutes until broadcast resumes. Check the{" "}
            <a
              href={`${apiOrigin}/broadcast-v2/health`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:opacity-80"
            >
              health endpoint
            </a>{" "}
            for the last error, or use <strong>Reload from queue</strong> to force an immediate retry.
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
              disabled={!!busy}
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

      {/* Circuit-open workers banner — dismissible amber strip */}
      {circuitOpenWorkers.length > 0 && !circuitOpenDismissed && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">
            <strong>{circuitOpenWorkers.length} background worker{circuitOpenWorkers.length > 1 ? "s have" : " has"} stopped</strong>{" "}
            after repeated failures:{" "}
            <span className="font-mono">{circuitOpenWorkers.map((w) => w.name).join(", ")}</span>.{" "}
            {circuitOpenWorkers[0]?.circuitAutoResetAtMs != null ? (
              <>
                Auto-reset in ~{Math.max(0, Math.round((circuitOpenWorkers[0].circuitAutoResetAtMs - Date.now()) / 60_000))} min.{" "}
              </>
            ) : null}
            See the Diagnostics panel below for the last error, or reload the broadcast engine to force an immediate retry.
          </div>
          <button
            type="button"
            aria-label="Dismiss worker circuit alert"
            onClick={() => setCircuitOpenDismissed(true)}
            className="shrink-0 rounded p-0.5 hover:bg-amber-200/60 dark:hover:bg-amber-800/40"
          >
            <X className="h-4 w-4" />
          </button>
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
              {processingCount} queue item{processingCount !== 1 ? "s are" : " is"} being optimised for streaming.
            </strong>{" "}
            The moov atom is being relocated to byte 0 (faststart) so the video can stream
            instantly without an HTTP Range pre-flight.{" "}
            {processingCount !== 1 ? "These items will air" : "This item will air"} automatically
            once optimisation completes — no operator action needed.
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

      {/* Dead-air alert strip — queue has content but nothing is broadcasting.
          This condition is distinct from "stuck" (seq=0) and "all-blocked"
          (every URL banned). It fires when the engine is healthy but no item
          is selected as current — typically after all items were skipped or
          the cycle position landed past the last item in an undersized queue. */}
      {isDeadAir && !deadAirDismissed && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-orange-300/60 bg-orange-50 px-4 py-3 text-sm text-orange-900 dark:border-orange-700/60 dark:bg-orange-950/30 dark:text-orange-200"
        >
          <Radio className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
          <div className="flex-1">
            <strong>Broadcast is dead air.</strong>{" "}
            The queue has{" "}
            {engineHealth?.itemCount === 1
              ? "1 active item"
              : `${engineHealth?.itemCount ?? 0} active items`}
            {" "}but no item is currently on air — sources are reachable, the engine
            is not stuck, and no failover is active. Use{" "}
            <strong>Reload from queue</strong> to restart the broadcast cycle, or{" "}
            <strong>Skip</strong> to advance to the next item.
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy}
              onClick={() => void adminPost("/broadcast-v2/reload")}
              className="h-7 px-2 text-xs border-orange-400/70 text-orange-800 hover:bg-orange-100 dark:text-orange-200 dark:border-orange-600/70 dark:hover:bg-orange-900/30"
            >
              {busy === "/broadcast-v2/reload" ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <RotateCw className="mr-1 h-3 w-3" />
              )}
              Reload
            </Button>
            <button
              type="button"
              aria-label="Dismiss dead-air alert"
              onClick={() => setDeadAirDismissed(true)}
              className="shrink-0 rounded p-0.5 hover:bg-orange-200/60 dark:hover:bg-orange-800/40"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Emergency filler alert — shown when the orchestrator exhausts all
          queue items and inserts the fallback EMERGENCY_FILLER_URL stream.
          Triggered via the "emergency-filler-activated" SSE event so it
          appears in real-time without a page refresh. */}
      {fillerActiveAt !== null && !fillerActiveDismissed && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-red-300/60 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-700/60 dark:bg-red-950/30 dark:text-red-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
          <div className="flex-1">
            <strong>Emergency filler activated</strong>{" "}at{" "}
            {new Date(fillerActiveAt).toLocaleTimeString()}.{" "}
            All queue items are unresolvable — the broadcast is running on the
            emergency fallback stream. Add playable content to the queue or
            configure <code className="font-mono text-xs">EMERGENCY_FILLER_URL</code> on the server.
          </div>
          <button
            type="button"
            aria-label="Dismiss emergency filler alert"
            onClick={() => setFillerActiveDismissed(true)}
            className="shrink-0 rounded p-0.5 hover:bg-red-200/60 dark:hover:bg-red-800/40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Consecutive-skips early warning — dismissible amber banner.
          Fires when ≥2 items have been skipped back-to-back without a
          successful play, before the broadcast reaches full dead air. */}
      {isConsecutiveSkipsWarning && !consecutiveSkipsDismissed && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="flex-1">
            <strong>{consecutiveSkips} consecutive item{consecutiveSkips !== 1 ? "s" : ""} skipped.</strong>{" "}
            The broadcast engine is having trouble playing items back-to-back — this may
            indicate broken source URLs or a stuck cycle. Check the Source Health panel
            for blocked items, or reload the queue to resync the cycle position.
            {engineHealth?.skipInfo?.lastDeadAirAt != null && (
              <span className="ml-1 opacity-75">
                (Last exhaustion: {new Date(engineHealth.skipInfo.lastDeadAirAt).toLocaleTimeString()})
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy}
              onClick={() => void adminPost("/broadcast-v2/reload")}
              className="h-7 px-2 text-xs border-amber-400/70 text-amber-800 hover:bg-amber-100 dark:text-amber-200 dark:border-amber-600/70 dark:hover:bg-amber-900/30"
            >
              {busy === "/broadcast-v2/reload" ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <RotateCw className="mr-1 h-3 w-3" />
              )}
              Reload
            </Button>
            <button
              type="button"
              aria-label="Dismiss consecutive-skips warning"
              onClick={() => setConsecutiveSkipsDismissed(true)}
              className="shrink-0 rounded p-0.5 hover:bg-amber-200/60 dark:hover:bg-amber-800/40"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
        <Card className="overflow-hidden">
          <CardHeader className="pb-2 pt-4">
            <CardTitle className="text-sm flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" aria-hidden="true" />
              Live Preview
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-4">
            <BroadcastPreviewV2 className="w-full aspect-video" />
            <p className="mt-2 text-[11px] text-muted-foreground">
              Mirrors exactly what viewers see on TV, web, and mobile. Audio is muted by default — unmute with the volume button to monitor.
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

      {/* ── Broadcast Upload Panel ────────────────────────────────────────── */}
      <BroadcastUploadPanel
        server={server}
        queueItems={queueItems}
      />

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

      <AirHistoryCard history={engineHealth?.airingHistory} />

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
                              <Badge variant="destructive" className="text-[10px] h-4 px-1">
                                circuit open
                                {w.circuitAutoResetAtMs != null && (
                                  <> · auto-reset {Math.max(0, Math.round((w.circuitAutoResetAtMs - Date.now()) / 60_000))}m</>
                                )}
                              </Badge>
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
                    These items were temporarily suspended after repeated URL failures. They <strong>auto-recover after 5 minutes</strong> — or click Re-enable in the queue above to unblock immediately.
                  </p>
                  <div className="flex flex-col gap-1">
                    {diagnostics.autoSuspended.map((item) => {
                      const SUSPENSION_TTL_MS = 5 * 60_000;
                      const recoverAtMs = item.suspendedAtMs + SUSPENSION_TTL_MS;
                      const secsLeft = Math.max(0, Math.ceil((recoverAtMs - liveNow) / 1000));
                      const recovered = secsLeft === 0;
                      const recoveryLabel = recovered
                        ? "Auto-recovered"
                        : secsLeft >= 60
                          ? `Auto-recovers in ${Math.ceil(secsLeft / 60)}m`
                          : `Auto-recovers in ${secsLeft}s`;
                      return (
                        <div key={item.itemId} className="flex items-center justify-between rounded-md bg-red-50 dark:bg-red-950/30 px-2 py-1.5 text-xs">
                          <span className="truncate font-medium text-red-800 dark:text-red-300 max-w-[180px]" title={item.title ?? item.itemId}>
                            {item.title ?? item.itemId}
                          </span>
                          <div className="flex items-center gap-2 shrink-0 ml-2">
                            <span className="text-red-600 dark:text-red-400">{item.failCount} failures</span>
                            <span className={recovered ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
                              {recoveryLabel}
                            </span>
                          </div>
                        </div>
                      );
                    })}
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
                    {diagnostics.analytics.bufferUtilizationPct !== undefined && (
                      <span className="flex items-center gap-1" title="Ring-buffer utilization — percentage of event-buffer capacity currently occupied">
                        <span className={`font-semibold tabular-nums ${diagnostics.analytics.bufferUtilizationPct > 80 ? "text-amber-600 dark:text-amber-400" : ""}`}>
                          {diagnostics.analytics.bufferUtilizationPct}%
                        </span>
                        <span className="text-muted-foreground">buf</span>
                      </span>
                    )}
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

      {/* ── SUSPENDED / UNPLAYABLE recovery card ────────────────────────────── */}
      {/* Shown when the queue has items but the orchestrator loaded 0 of them. */}
      {/* This happens when old server code wrote is_active=false to the DB     */}
      {/* (auto-suspension bug) or when all items fail the playability check    */}
      {/* (faststart not applied, bad URL, etc.). "Recover broadcast" calls     */}
      {/* POST /reload which now re-enables all suspended items + clears the    */}
      {/* bad-URL cache before reloading, giving every item a fresh attempt.    */}
      {!queueLoading &&
        queueItems.length > 0 &&
        engineHealth &&
        engineHealth.itemCount === 0 &&
        !engineHealth.hasCurrent && (
          <Card className="border-amber-400/50 bg-amber-50/60 dark:bg-amber-950/20">
            <CardContent className="flex flex-col items-center gap-5 py-8 text-center sm:flex-row sm:text-left sm:gap-8 sm:px-8">
              <div className="flex-shrink-0 flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 ring-1 ring-amber-300 dark:bg-amber-900/40 dark:ring-amber-700">
                <AlertTriangle className="h-7 w-7 text-amber-600 dark:text-amber-400" />
              </div>
              <div className="flex-1 space-y-1">
                <p className="font-semibold text-foreground">
                  Orchestrator loaded 0 items — broadcast is Off Air
                </p>
                <p className="text-sm text-muted-foreground max-w-xl">
                  The queue has {queueItems.length} item{queueItems.length !== 1 ? "s" : ""} but none
                  were accepted by the orchestrator. Items may have been auto-suspended after repeated
                  playback failures, or their video files may not yet have a playable source (MP4
                  faststart / HLS). Click <strong>Recover broadcast</strong> to re-enable all suspended
                  items, clear blocked sources, and reload the queue.
                </p>
              </div>
              <Button
                className="flex-shrink-0 gap-2"
                onClick={() => adminPost("/broadcast-v2/reload")}
                disabled={busy !== null}
              >
                {busy === "/broadcast-v2/reload" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Recover broadcast
              </Button>
            </CardContent>
          </Card>
        )}

      {/* ── OFF_AIR status card — visible only when queue is empty ─────────── */}
      {/*                                                                       */}
      {/* Three distinct off-air situations, each with different operator       */}
      {/* guidance. The right message matters: telling someone "upload videos"  */}
      {/* when they have 400+ uploaded but unplayable rows is misleading and    */}
      {/* triggers "rebuild everything" panic. We use queueSyncStatus to        */}
      {/* distinguish:                                                          */}
      {/*   A. missingCount === 0   → library is empty. Upload videos.          */}
      {/*   B. missingReadyCount > 0 → library has playable content not yet     */}
      {/*       in the queue. Click "Sync library" (right-side button above).   */}
      {/*   C. missingCount > 0 && missingReadyCount === 0 → library has        */}
      {/*       content but none of it is broadcastable. Almost always means    */}
      {/*       the entire library is YouTube-synced metadata (which by design  */}
      {/*       cannot air — no native player on TV/mobile) and there are no    */}
      {/*       uploaded MP4/HLS sources behind it.                             */}
      {!queueLoading && queueItems.length === 0 && (() => {
        // Prefer the uncapped server-side totals (libraryTotal / missingPlayable)
        // over the legacy capped fields. Until queueSyncStatus has loaded we
        // show a neutral "checking…" state instead of asserting upload guidance
        // that may be wrong when the library actually has unplayable content.
        const statusReady = queueSyncStatus !== undefined;
        const libTotal = queueSyncStatus?.libraryTotal ?? null;
        const libPlayable = queueSyncStatus?.libraryPlayable ?? null;
        const missingPlayable = queueSyncStatus?.missingPlayable ?? null;
        const onlyUnplayable =
          libTotal !== null && libPlayable !== null && libTotal > 0 && libPlayable === 0;
        const hasPlayableNotQueued =
          missingPlayable !== null && missingPlayable > 0;

        let headline = "Broadcast queue is empty";
        let body =
          "Nothing is scheduled to air. Upload your sermon videos, then add them to the broadcast queue to go live.";
        if (!statusReady) {
          headline = "Checking library…";
          body = "Determining what's available to broadcast.";
        } else if (onlyUnplayable) {
          headline = "No playable content in library";
          body =
            `Library has ${libTotal} video${libTotal === 1 ? "" : "s"}, but none can be broadcast — they all lack a playable video file (likely YouTube-only metadata, which by design never airs on TV or mobile). Upload local video files (MP4/MOV) or activate an HLS live source override to go on air.`;
        } else if (hasPlayableNotQueued) {
          headline = `${missingPlayable} playable video${missingPlayable === 1 ? "" : "s"} ready to broadcast`;
          body =
            `Your library has ${missingPlayable} broadcastable video${missingPlayable === 1 ? "" : "s"} that ${missingPlayable === 1 ? "is" : "are"} not in the queue. Click "Sync library now" below to add ${missingPlayable === 1 ? "it" : "them"} and go live.`;
        }

        return (
          <Card className="border-destructive/40 bg-destructive/5">
            <CardContent className="flex flex-col items-center gap-5 py-10 text-center sm:flex-row sm:text-left sm:gap-8 sm:py-8 sm:px-8">
              <div className="flex-shrink-0 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10 ring-1 ring-destructive/30">
                <Radio className="h-8 w-8 text-destructive" />
              </div>

              <div className="flex-1 space-y-1.5">
                <div className="flex items-center justify-center gap-2 sm:justify-start">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive px-2.5 py-0.5 text-xs font-bold uppercase tracking-widest text-destructive-foreground">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive-foreground opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-destructive-foreground" />
                    </span>
                    Off Air
                  </span>
                  <span className="text-sm font-medium text-foreground">{headline}</span>
                </div>
                <p className="text-sm text-muted-foreground max-w-xl">{body}</p>
              </div>

              <div className="flex flex-shrink-0 flex-col gap-2 sm:flex-row">
                {hasPlayableNotQueued ? (
                  <Button
                    className="gap-2 w-full sm:w-auto"
                    onClick={() => syncLibraryMutation.mutate()}
                    disabled={syncLibraryMutation.isPending}
                  >
                    {syncLibraryMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ListPlus className="h-4 w-4" />
                    )}
                    Sync library now
                  </Button>
                ) : (
                  <Link href="/videos">
                    <Button className="gap-2 w-full sm:w-auto">
                      <Upload className="h-4 w-4" />
                      Upload Videos
                    </Button>
                  </Link>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })()}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <CardTitle className="shrink-0">Broadcast queue</CardTitle>
            {queueSyncStatus && queueSyncStatus.missingReadyCount > 0 && (
              <Badge
                variant="outline"
                className="gap-1 shrink-0 text-amber-600 border-amber-300 dark:border-amber-700"
                title={`${queueSyncStatus.missingReadyCount} playable video${queueSyncStatus.missingReadyCount !== 1 ? "s" : ""} in the library are not in the broadcast queue. Click "Sync library" to add them.`}
              >
                <AlertTriangle className="h-3 w-3" />
                {queueSyncStatus.missingReadyCount} not queued
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="gap-1"
              onClick={() => syncLibraryMutation.mutate()}
              disabled={syncLibraryMutation.isPending}
              title="Scan the video library and add any playable videos that are missing from the broadcast queue. Safe to run at any time — already-queued videos are skipped."
            >
              {syncLibraryMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Sync library
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {queueLoading ? (
            <p className="text-sm text-muted-foreground">Loading queue…</p>
          ) : queueItems.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Video className="h-4 w-4 flex-shrink-0 opacity-50" />
              Queue is empty — see the card above for the next step.
            </p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={() => {
                isDraggingRef.current = true;
              }}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={orderedQueueItems.map((i) => i.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="divide-y rounded-md border">
                  {orderedQueueItems.map((item, idx) => {
                    const isCurrent = server?.current?.id === item.id;
                    const isNext = server?.next?.id === item.id;
                    return (
                      <SortableQueueItem
                        key={item.id}
                        item={item}
                        index={idx}
                        isCurrent={isCurrent}
                        isNext={isNext}
                        health={healthByItemId[item.id]}
                        autoSuspendedIds={autoSuspendedIds}
                        isDeactivating={deactivateMutation.isPending}
                        isReactivating={reactivateMutation.isPending}
                        onDeactivate={(id) => deactivateMutation.mutate(id)}
                        onReactivate={(id) => reactivateMutation.mutate(id)}
                        onRetryHls={(videoId) => retryHlsMutation.mutate(videoId)}
                        isRetryingHls={retryHlsMutation.isPending}
                        onTranscodeLocally={(itemId) => transcodeLocallyMutation.mutate(itemId)}
                        isTranscodingLocally={transcodeLocallyMutation.isPending}
                      />
                    );
                  })}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </CardContent>
      </Card>

      {/* ── Schedule editor ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          className="flex flex-row items-center justify-between gap-2 cursor-pointer select-none py-3"
          onClick={() => setShowScheduleEditor((v) => !v)}
          role="button"
          aria-expanded={showScheduleEditor}
        >
          <div className="flex items-center gap-2 min-w-0">
            <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
            <CardTitle className="text-base">Schedule editor</CardTitle>
            {queueItems.filter((i) => i.scheduledAt).length > 0 && (
              <Badge variant="secondary" className="text-[10px] h-4 gap-1">
                <Pin className="h-2.5 w-2.5" />
                {queueItems.filter((i) => i.scheduledAt).length} pinned
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 text-muted-foreground">
            <span className="text-xs hidden sm:inline">Set air times for programming blocks</span>
            {showScheduleEditor
              ? <ChevronUp className="h-4 w-4" />
              : <ChevronDown className="h-4 w-4" />}
          </div>
        </CardHeader>
        {showScheduleEditor && (
          <CardContent className="pt-0">
            <ScheduleEditorPanel
              items={orderedQueueItems}
              onSave={(updates) => saveScheduleMutation.mutate(updates)}
              isSaving={saveScheduleMutation.isPending}
            />
          </CardContent>
        )}
      </Card>
    </div>
  );
}

// ── ScheduleEditorPanel ──────────────────────────────────────────────────────

function toDateTimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatProjectedTime(d: Date): string {
  return d.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function fmtDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m > 0 ? `${m}m` : ""}`.trim();
  if (m > 0) return `${m}m${s > 0 ? ` ${s}s` : ""}`;
  return `${s}s`;
}

interface ProjectedQueueItem {
  item: BroadcastQueueRow;
  projectedStart: Date;
  isAnchor: boolean;
  hasGapBefore: boolean;
  gapMinutes: number;
}

function projectSchedule(
  items: BroadcastQueueRow[],
  localSchedule: Map<string, { scheduledAt: string; scheduleLabel: string }>,
): ProjectedQueueItem[] {
  let cursor = Date.now();
  return items
    .filter((i) => i.isActive)
    .map((item) => {
      const editedAt = localSchedule.get(item.id)?.scheduledAt ?? item.scheduledAt ?? "";
      const lockedMs = editedAt.trim() ? (() => { try { const t = new Date(editedAt).getTime(); return isNaN(t) ? null : t; } catch { return null; } })() : null;
      const isAnchor = lockedMs !== null;
      const hasGapBefore = isAnchor && lockedMs > cursor;
      const gapMinutes = hasGapBefore ? Math.max(0, Math.round((lockedMs - cursor) / 60_000)) : 0;
      if (isAnchor && lockedMs > cursor) cursor = lockedMs;
      const projectedStart = new Date(cursor);
      cursor += Math.max(1, item.durationSecs) * 1_000;
      return { item, projectedStart, isAnchor, hasGapBefore, gapMinutes };
    });
}

interface ScheduleEditorPanelProps {
  items: BroadcastQueueRow[];
  onSave: (updates: ScheduleUpdate[]) => void;
  isSaving: boolean;
}

function ScheduleEditorPanel({ items, onSave, isSaving }: ScheduleEditorPanelProps) {
  const [localSchedule, setLocalSchedule] = useState<Map<string, { scheduledAt: string; scheduleLabel: string }>>(() => {
    const m = new Map<string, { scheduledAt: string; scheduleLabel: string }>();
    for (const item of items) {
      m.set(item.id, { scheduledAt: item.scheduledAt ?? "", scheduleLabel: item.scheduleLabel ?? "" });
    }
    return m;
  });

  // Sync with incoming items without blowing away local edits for existing items
  useEffect(() => {
    setLocalSchedule((prev) => {
      const next = new Map(prev);
      const incomingIds = new Set(items.map((i) => i.id));
      for (const id of next.keys()) {
        if (!incomingIds.has(id)) next.delete(id);
      }
      for (const item of items) {
        if (!next.has(item.id)) {
          next.set(item.id, { scheduledAt: item.scheduledAt ?? "", scheduleLabel: item.scheduleLabel ?? "" });
        }
      }
      return next;
    });
  }, [items]);

  const projected = useMemo(() => projectSchedule(items, localSchedule), [items, localSchedule]);

  const setItemField = useCallback(
    (id: string, field: "scheduledAt" | "scheduleLabel", value: string) => {
      setLocalSchedule((prev) => {
        const next = new Map(prev);
        const cur = next.get(id) ?? { scheduledAt: "", scheduleLabel: "" };
        next.set(id, { ...cur, [field]: value });
        return next;
      });
    },
    [],
  );

  const unpinItem = useCallback((id: string) => {
    setLocalSchedule((prev) => {
      const next = new Map(prev);
      const cur = next.get(id) ?? { scheduledAt: "", scheduleLabel: "" };
      next.set(id, { ...cur, scheduledAt: "" });
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setLocalSchedule((prev) => {
      const next = new Map(prev);
      for (const [id, val] of next) next.set(id, { ...val, scheduledAt: "" });
      return next;
    });
  }, []);

  const dirtyCount = useMemo(
    () =>
      items.filter((item) => {
        const local = localSchedule.get(item.id);
        return (
          (local?.scheduledAt ?? "") !== (item.scheduledAt ?? "") ||
          (local?.scheduleLabel ?? "") !== (item.scheduleLabel ?? "")
        );
      }).length,
    [items, localSchedule],
  );

  const pinnedCount = projected.filter((p) => p.isAnchor).length;

  const handleSave = useCallback(() => {
    const updates: ScheduleUpdate[] = items.map((item) => {
      const local = localSchedule.get(item.id);
      return {
        id: item.id,
        scheduledAt: local?.scheduledAt?.trim() || null,
        scheduleLabel: local?.scheduleLabel?.trim() || null,
      };
    });
    onSave(updates);
  }, [items, localSchedule, onSave]);

  const activeItems = items.filter((i) => i.isActive);
  if (activeItems.length === 0) {
    return <p className="text-sm text-muted-foreground py-3">No active queue items to schedule.</p>;
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
        <p className="text-xs text-muted-foreground">
          {pinnedCount > 0 ? (
            <>
              <span className="font-medium text-foreground">{pinnedCount}</span> anchor
              {pinnedCount !== 1 ? "s" : ""} pinned — other items float in queue order.
            </>
          ) : (
            "No anchors set. Pin items to lock them to specific air times."
          )}
        </p>
        <div className="flex items-center gap-2">
          {pinnedCount > 0 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-xs text-muted-foreground"
              onClick={clearAll}
              disabled={isSaving}
            >
              <PinOff className="h-3 w-3" />
              Clear all times
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={handleSave}
            disabled={isSaving || dirtyCount === 0}
            title={dirtyCount === 0 ? "No unsaved changes" : `Save ${dirtyCount} change${dirtyCount !== 1 ? "s" : ""}`}
          >
            {isSaving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <CalendarClock className="h-3 w-3" />
            )}
            {isSaving ? "Saving…" : dirtyCount > 0 ? `Save (${dirtyCount})` : "Up to date"}
          </Button>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground/60 -mt-1">
        Pinned items air at their exact time. Floating items play in queue order after the last anchor. Use the drag handles above to reorder.
      </p>

      {/* Timeline list */}
      <div className="rounded-md border divide-y">
        {projected.map(({ item, projectedStart, isAnchor, hasGapBefore, gapMinutes }, idx) => {
          const local = localSchedule.get(item.id) ?? { scheduledAt: "", scheduleLabel: "" };
          const dtValue = local.scheduledAt?.trim()
            ? (() => {
                try {
                  return toDateTimeLocalValue(new Date(local.scheduledAt));
                } catch {
                  return "";
                }
              })()
            : "";

          return (
            <div key={item.id}>
              {hasGapBefore && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-950/20 text-[11px] text-amber-600 dark:text-amber-400">
                  <Clock className="h-3 w-3 shrink-0" />
                  {gapMinutes >= 60
                    ? `${Math.floor(gapMinutes / 60)}h ${gapMinutes % 60}m gap / filler block before this item`
                    : `${gapMinutes}m gap before this item`}
                </div>
              )}
              <div
                className={[
                  "flex items-start gap-3 px-3 py-3",
                  isAnchor ? "bg-blue-50/40 dark:bg-blue-950/10" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {/* Index + anchor indicator */}
                <div className="flex flex-col items-center gap-0.5 pt-1 w-5 shrink-0">
                  <span className="text-[11px] tabular-nums text-muted-foreground leading-none">{idx + 1}</span>
                  {isAnchor && <Pin className="h-2.5 w-2.5 text-blue-500" />}
                </div>

                <div className="flex-1 min-w-0 space-y-2">
                  {/* Title + duration + projected time */}
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    <span className="truncate text-sm font-medium max-w-[240px]">{item.title}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{fmtDuration(item.durationSecs)}</span>
                    <span
                      className={[
                        "text-xs shrink-0 flex items-center gap-1",
                        isAnchor
                          ? "text-blue-600 dark:text-blue-400 font-medium"
                          : "text-muted-foreground",
                      ].join(" ")}
                    >
                      {isAnchor ? <Pin className="h-2.5 w-2.5" /> : <Clock className="h-2.5 w-2.5" />}
                      {isAnchor
                        ? formatProjectedTime(projectedStart)
                        : `~${formatProjectedTime(projectedStart)}`}
                    </span>
                  </div>

                  {/* Controls */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-muted-foreground shrink-0">Air time:</span>
                      <input
                        type="datetime-local"
                        value={dtValue}
                        onChange={(e) => {
                          const raw = e.target.value;
                          setItemField(
                            item.id,
                            "scheduledAt",
                            raw ? new Date(raw).toISOString() : "",
                          );
                        }}
                        className="h-7 rounded border border-input bg-background px-2 py-0 text-xs tabular-nums text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        title="Pin this item to a specific air time"
                      />
                      {isAnchor && (
                        <button
                          type="button"
                          onClick={() => unpinItem(item.id)}
                          title="Remove time pin — item becomes floating"
                          className="h-7 w-7 rounded border border-input flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                        >
                          <PinOff className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-muted-foreground shrink-0">Block label:</span>
                      <Input
                        value={local.scheduleLabel}
                        onChange={(e) => setItemField(item.id, "scheduleLabel", e.target.value)}
                        placeholder="e.g. Sunday Morning Service"
                        className="h-7 text-xs w-48 py-0"
                        maxLength={200}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
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
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
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

// ── Air History Card ─────────────────────────────────────────────────────────

function AirHistoryCard({ history }: { history?: AiringEntry[] }) {
  if (!history || history.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Air History
          <Badge variant="secondary" className="ml-auto text-[10px]">
            {history.length} item{history.length !== 1 ? "s" : ""}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y text-xs">
          {history.slice(0, 20).map((entry, i) => {
            const durationMs =
              entry.endedAtMs != null
                ? entry.endedAtMs - entry.startedAtMs
                : Date.now() - entry.startedAtMs;
            return (
              <div
                key={`${entry.itemId}-${entry.startedAtMs}`}
                className="flex items-start gap-3 px-4 py-2.5"
              >
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    {entry.endedAtMs === null ? (
                      <Badge variant="default" className="h-4 px-1.5 text-[9px] font-bold shrink-0">
                        ON AIR
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground tabular-nums shrink-0">#{i}</span>
                    )}
                    <span className="font-medium truncate">{entry.title ?? entry.itemId}</span>
                  </div>
                  {entry.sourceUrl && (
                    <div className="truncate text-muted-foreground font-mono text-[10px]">
                      {entry.sourceUrl}
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-right text-muted-foreground space-y-0.5 tabular-nums pl-2">
                  <div className="font-medium">{formatDuration(durationMs)}</div>
                  <div className="text-[10px]">{formatAgo(entry.startedAtMs)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
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

export default function BroadcastV2Page() {
  return (
    <ErrorBoundary>
      <BroadcastV2PageInner />
    </ErrorBoundary>
  );
}

