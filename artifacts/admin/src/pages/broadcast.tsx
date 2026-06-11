import React, { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BroadcastPreviewV2 } from "@/playback/BroadcastPreviewV2";
import { BroadcastUploadPanel } from "@/components/broadcast/BroadcastUploadPanel";
import type { BroadcastQueueRow, BroadcastServerSnapshot } from "@/components/broadcast/BroadcastUploadPanel";
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
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api, HttpError } from "@/lib/api";
import {
  uploadQueue,
  useUploadQueue,
} from "@/lib/upload-queue";
import { Checkbox } from "@/components/ui/checkbox";
import { useSSEEvent } from "@/contexts/sse-context";
import { useSseGatedInterval } from "@/hooks/useSseGatedInterval";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  Radio,
  Play,
  Pause,
  SkipForward,
  Plus,
  Trash2,
  RefreshCw,
  GripVertical,
  Clock,
  Video,
  AlertTriangle,
  Wifi,
  HardDrive,
  Youtube,
  Zap,
  FlaskConical,
  CheckCircle2,
  Loader2,
  ChevronsUp,
  RotateCcw,
  ShieldAlert,
  Activity,
  Server,
  XCircle,
  CheckCircle,
  List,
  Signal,
  AlertCircle,
  Siren,
  Square,
  UploadCloud,
  Tv2,
  Link,
  TriangleAlert,
  Cast,
  CalendarClock,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

// ── API types ──────────────────────────────────────────────────────────────────

interface BroadcastQueueItem {
  id: string;
  videoId: string | null;
  youtubeId: string | null;
  title: string;
  thumbnailUrl: string;
  durationSecs: number;
  localVideoUrl: string | null;
  videoSource: string;
  isActive: boolean;
  sortOrder: number;
  addedAt: string;
  /** Transcoding pipeline status from managed_videos ('queued' | 'encoding' | 'hls_ready' | 'failed' | null). */
  transcodingStatus: string | null;
  /** True when the video has a complete HLS master playlist ready to stream. */
  hasHls: boolean;
  /** Last transcoding error message, or null if never failed. */
  transcodingError: string | null;
  /** Locked air time for this item (ISO string), or null for floating position. */
  scheduledAt: string | null;
  /** Human-readable programming block label e.g. "Sunday Morning Service". */
  scheduleLabel: string | null;
}

interface V2StateResponse {
  state: {
    channelId: string;
    sequence: number;
    serverTimeMs: number;
    mode: "queue" | "override" | "failover" | "offline_hold";
    current: {
      id: string;
      title: string;
      thumbnailUrl: string | null;
      durationSecs: number;
      source: { kind: string; url: string; expiresAtMs: number | null };
      startsAtMs: number;
      endsAtMs: number;
    } | null;
    next: { id: string; title: string; thumbnailUrl: string | null } | null;
    override: { id: string; title: string; kind: string; url: string } | null;
    failover: { active: boolean; reason: string | null };
  };
}

interface V2HealthResponse {
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
  };
  reload: {
    lastReloadAtMs: number | null;
    lastReloadOk: boolean | null;
    lastReloadError: string | null;
    attempts: number;
    successes: number;
  };
  prodSync: {
    enabled: boolean;
    upstreamUrl: string | null;
    intervalMs: number;
    lastPollAtMs: number | null;
    lastPollOk: boolean | null;
    lastPollError: string | null;
    lastUpsertCount: number;
    totalPolls: number;
    totalUpserts: number;
  };
}

interface V2SourceHealthResponse {
  healthByItemId: Record<string, { status: "ok" | "bad"; badUntilMs: number | null }>;
}

type HealthStatus = "ok" | "broken" | "skipped";
type HealthReason = "hls" | "local" | "youtube" | string | null;

interface HealthItem {
  id: string;
  status: HealthStatus;
  reason: HealthReason;
}

interface HealthResponse {
  summary: { ok: number; broken: number; skipped: number; total: number; checkedAt: string };
  items: HealthItem[];
}

interface LocalVideo {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  duration: number | null;
  transcodingStatus: string;
  localVideoUrl: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// ── Module-level auto-queue tracking ─────────────────────────────────────────
// These live OUTSIDE the React component so they survive navigation. The
// uploadQueue singleton keeps uploading bytes after the user leaves /broadcast,
// and we still want completed items to auto-append to the broadcast queue.
//
// autoQueuePending is also mirrored to sessionStorage so it survives a hard
// page refresh while an upload is still in progress. Without this, a user who
// starts an upload, marks it for auto-queue, and then hits F5 would see the
// upload complete successfully but never land in the broadcast queue.
const _AQPENDING_KEY = "broadcast:autoQueuePending";

function _loadAutoQueuePending(): Set<string> {
  try {
    const raw = sessionStorage.getItem(_AQPENDING_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* sessionStorage may be unavailable in some privacy modes */ }
  return new Set<string>();
}

function _saveAutoQueuePending(set: Set<string>): void {
  try {
    sessionStorage.setItem(_AQPENDING_KEY, JSON.stringify([...set]));
  } catch { /* non-fatal */ }
}

const autoQueuePending: Set<string> = _loadAutoQueuePending();
const autoQueueHandled = new Set<string>();
const autoQueueInFlight = new Set<string>();
let autoQueueSubscribed = false;

/**
 * Install a single uploadQueue subscriber that watches for tagged uploads to
 * reach status=completed with a videoId, then POSTs them to /admin/broadcast.
 * On failure the id stays in `autoQueuePending` so the next notify retries it.
 * `autoQueueInFlight` prevents duplicate POSTs while a request is pending.
 */
function ensureAutoQueueSubscriber(
  qc: ReturnType<typeof useQueryClient>,
): void {
  if (autoQueueSubscribed) return;
  autoQueueSubscribed = true;
  uploadQueue.subscribe(() => {
    for (const it of uploadQueue.getItems()) {
      if (!autoQueuePending.has(it.id)) continue;
      if (autoQueueHandled.has(it.id)) continue;
      if (autoQueueInFlight.has(it.id)) continue;
      if (it.status !== "completed" || !it.videoId) continue;

      autoQueueInFlight.add(it.id);
      const uploadId = it.id;
      const videoId = it.videoId;
      const title = it.title;

      void (async () => {
        try {
          // `allowPending: true` lets the row land in the queue even though
          // the just-uploaded video is still transcoding. The v2 orchestrator
          // skips non-HLS items, then auto-picks-up the row when the
          // transcoder fires `broadcast-queue-updated` on HLS completion.
          await api.post("/admin/broadcast", { videoId, allowPending: true });
          await api
            .post("/broadcast-v2/reload", { idempotencyKey: crypto.randomUUID() })
            .catch(() => {});
          autoQueueHandled.add(uploadId);
          autoQueuePending.delete(uploadId);
          _saveAutoQueuePending(autoQueuePending);
          toast.success(
            `"${title}" added to broadcast queue — will start airing as soon as transcoding finishes`,
          );
          void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
          void qc.invalidateQueries({ queryKey: ["broadcast-v2-state"] });
          void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
        } catch (e) {
          const msg = e instanceof HttpError ? e.message : String(e);
          toast.error(
            `"${title}" uploaded but auto-queue failed: ${msg} — will retry on next upload activity, or use "Add to Queue" to add it manually`,
          );
        } finally {
          autoQueueInFlight.delete(uploadId);
        }
      })();
    }
  });
}

function formatDuration(secs: number): string {
  if (!secs || secs <= 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const MODE_LABELS: Record<string, string> = {
  queue: "Queue",
  override: "Override",
  failover: "Failover",
  offline_hold: "Offline",
};

const MODE_COLORS: Record<string, string> = {
  queue:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800",
  override:
    "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-400 dark:border-violet-800",
  failover:
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800",
  offline_hold:
    "bg-muted text-muted-foreground border-border",
};

// ── HealthPill ─────────────────────────────────────────────────────────────────

interface HealthPillProps {
  health: HealthItem | undefined;
  loading: boolean;
  blockedUntilMs?: number | null;
}

function HealthPill({ health, loading, blockedUntilMs }: HealthPillProps) {
  if (loading) return <Skeleton className="h-5 w-14 rounded-full" />;

  if (blockedUntilMs && blockedUntilMs > Date.now()) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800 flex-shrink-0 cursor-help"
        title={`URL blocked until ${new Date(blockedUntilMs).toLocaleTimeString()} — click "Clear Blocks" to retry now`}
      >
        <ShieldAlert size={9} />
        Blocked
      </span>
    );
  }

  if (!health) return null;

  if (health.status === "skipped") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground border border-border/50 flex-shrink-0">
        Inactive
      </span>
    );
  }

  if (health.status === "broken") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-50 text-red-600 border border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800 flex-shrink-0">
        <AlertTriangle size={9} />
        Broken
      </span>
    );
  }

  if (health.reason === "hls") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800 flex-shrink-0">
        <Wifi size={9} />
        HLS
      </span>
    );
  }

  if (health.reason === "local") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-50 text-sky-700 border border-sky-200 dark:bg-sky-950/30 dark:text-sky-400 dark:border-sky-800 flex-shrink-0">
        <HardDrive size={9} />
        Local
      </span>
    );
  }

  if (health.reason === "youtube") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-50 text-rose-700 border border-rose-200 dark:bg-rose-950/30 dark:text-rose-400 dark:border-rose-800 flex-shrink-0">
        <Youtube size={9} />
        YouTube
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800 flex-shrink-0">
      <Zap size={9} />
      Ready
    </span>
  );
}

// ── TranscodingPill ────────────────────────────────────────────────────────────

function TranscodingPill({
  status,
  error,
}: {
  status: string | null;
  error?: string | null;
}) {
  if (!status || status === "hls_ready" || status === "ready" || status === "done") return null;

  if (status === "failed") {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-50 text-red-600 border border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800 flex-shrink-0 cursor-help"
        title={error ?? "Transcoding failed"}
      >
        <XCircle size={9} />
        Failed
      </span>
    );
  }

  if (status === "encoding") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800 flex-shrink-0">
        <Loader2 size={9} className="animate-spin" />
        Encoding
      </span>
    );
  }

  if (status === "processing") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800 flex-shrink-0">
        <Loader2 size={9} className="animate-spin" />
        Faststart
      </span>
    );
  }

  if (status === "queued") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800 flex-shrink-0">
        <Clock size={9} />
        Queued
      </span>
    );
  }

  return null;
}

// ── SortableRow ────────────────────────────────────────────────────────────────

interface SortableRowProps {
  item: BroadcastQueueItem;
  idx: number;
  health: HealthItem | undefined;
  healthLoading: boolean;
  blockedUntilMs?: number | null;
  estimatedAirMs?: number | null;
  onRemove: () => void;
  onMoveToFront: () => void;
  onPlayNow: () => void;
  isRemoving: boolean;
  isPlayingNow: boolean;
  isDragDisabled?: boolean;
  bulkMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}

// Wrapped in React.memo so only the row whose props actually changed
// re-renders when parent state updates (e.g. dragging, syncing, now-playing).
// Without memo, every state change in the parent (isSyncing toggle, playNow
// pending) triggers re-renders for all 100+ queue rows simultaneously.
const SortableRow = React.memo(function SortableRow({
  item,
  idx,
  health,
  healthLoading,
  blockedUntilMs,
  estimatedAirMs,
  onRemove,
  onMoveToFront,
  onPlayNow,
  isRemoving,
  isPlayingNow,
  isDragDisabled,
  bulkMode,
  isSelected,
  onToggleSelect,
}: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: isDragDisabled || bulkMode,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
    position: isDragging ? "relative" : undefined,
  };

  const isBroken = health?.status === "broken";
  const isBlocked = blockedUntilMs && blockedUntilMs > Date.now();
  const isTranscoding =
    item.transcodingStatus === "encoding" ||
    item.transcodingStatus === "processing" ||
    item.transcodingStatus === "queued";

  const airLabel = isPlayingNow
    ? null
    : estimatedAirMs
    ? formatDistanceToNow(new Date(estimatedAirMs), { addSuffix: true })
    : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 px-4 py-3 group border-b last:border-0 bg-background transition-shadow ${
        isDragging ? "shadow-xl ring-1 ring-primary/30 rounded-lg" : ""
      } ${isSelected ? "bg-primary/8" : isPlayingNow ? "bg-primary/5" : isBroken || isBlocked ? "bg-red-50/40 dark:bg-red-950/10" : ""}`}
    >
      {bulkMode ? (
        <Checkbox
          checked={isSelected}
          onCheckedChange={onToggleSelect}
          aria-label={`Select ${item.title}`}
          className="flex-shrink-0"
        />
      ) : (
        <button
          {...attributes}
          {...listeners}
          className="text-muted-foreground/25 hover:text-muted-foreground/70 cursor-grab active:cursor-grabbing flex-shrink-0 touch-none transition-colors disabled:opacity-30 disabled:cursor-default"
          disabled={isDragDisabled}
          aria-label="Drag to reorder"
          tabIndex={0}
        >
          <GripVertical size={16} />
        </button>
      )}

      <span className="text-xs text-muted-foreground w-5 text-center flex-shrink-0 tabular-nums">
        {idx + 1}
      </span>

      <div className="flex-shrink-0 w-16 h-10 rounded overflow-hidden bg-black">
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" className="w-full h-full object-contain" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Video size={14} className="text-muted-foreground/30" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {isPlayingNow && (
            <Radio size={11} className="text-primary animate-pulse flex-shrink-0" />
          )}
          <p className="text-sm font-medium truncate">{item.title}</p>
          {item.scheduleLabel && (
            <span className="text-[10px] text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800 px-1.5 py-0.5 rounded-full flex-shrink-0 flex items-center gap-1">
              <CalendarClock size={8} />
              {item.scheduleLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {item.durationSecs > 0 && (
            <span className="text-xs text-muted-foreground">{formatDuration(item.durationSecs)}</span>
          )}
          {item.scheduledAt ? (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <CalendarClock size={9} />
              Scheduled {formatDistanceToNow(new Date(item.scheduledAt), { addSuffix: true })}
            </span>
          ) : airLabel && !isTranscoding ? (
            <span className="text-[10px] text-muted-foreground/70 flex items-center gap-1">
              <Clock size={9} />
              {airLabel}
            </span>
          ) : null}
          {isTranscoding && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">
              Airs when encoding completes
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0">
        <TranscodingPill status={item.transcodingStatus} error={item.transcodingError} />
        <HealthPill health={health} loading={healthLoading} blockedUntilMs={blockedUntilMs} />
      </div>

      {idx > 0 ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 flex-shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 text-violet-500 hover:text-violet-600 transition-opacity"
          onClick={onMoveToFront}
          disabled={isDragDisabled}
          aria-label="Move to front of queue"
          title="Move to front (reorder only)"
        >
          <ChevronsUp size={14} />
        </Button>
      ) : (
        <div className="h-7 w-7 flex-shrink-0" />
      )}

      <Button
        variant="ghost"
        size="icon"
        className={`h-7 w-7 flex-shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity ${
          isPlayingNow
            ? "text-emerald-500 hover:text-emerald-600"
            : "text-orange-500 hover:text-orange-600"
        }`}
        onClick={onPlayNow}
        disabled={isDragDisabled || isPlayingNow}
        aria-label="Play now"
        title={isPlayingNow ? "Currently playing" : "Play now — move to front and start immediately"}
      >
        <Zap size={13} />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 flex-shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 text-red-500 hover:text-red-600 transition-opacity"
        onClick={onRemove}
        disabled={isRemoving}
        aria-label="Remove from queue"
      >
        <Trash2 size={13} />
      </Button>
    </div>
  );
});

// ── OrchestratorStatusPanel ────────────────────────────────────────────────────

function OrchestratorStatusPanel({
  data,
  loading,
}: {
  data: V2HealthResponse | null | undefined;
  loading: boolean;
}) {
  if (loading && !data) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Server size={13} />
            Orchestrator
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Server size={13} />
            Orchestrator
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Status unavailable</p>
        </CardContent>
      </Card>
    );
  }

  const modeLabel = MODE_LABELS[data.mode] ?? data.mode;
  const modeColor = MODE_COLORS[data.mode] ?? MODE_COLORS.queue;
  const lastReloadOk = data.reload.lastReloadOk;
  const lastReloadAt = data.reload.lastReloadAtMs ? new Date(data.reload.lastReloadAtMs) : null;
  const bootHealthy = data.boot.started && data.boot.busBridgeInstalled;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Server size={13} />
          Orchestrator
          <span
            className={`ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${modeColor}`}
          >
            <Signal size={8} />
            {modeLabel}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="space-y-0.5">
            <p className="text-muted-foreground">Sequence</p>
            <p className="font-mono font-semibold tabular-nums">#{data.sequence}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-muted-foreground">Items loaded</p>
            <p className="font-semibold tabular-nums">{data.itemCount}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-muted-foreground">Uptime</p>
            <p className="font-semibold tabular-nums">{formatUptime(data.uptimeMs)}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-muted-foreground">Playing</p>
            <p className="font-semibold">{data.hasCurrent ? "Yes" : "No"}</p>
          </div>
        </div>

        <div className="border-t pt-3 space-y-1.5 text-xs">
          <div className="flex items-center gap-1.5">
            {bootHealthy ? (
              <CheckCircle size={11} className="text-emerald-500 flex-shrink-0" />
            ) : (
              <XCircle size={11} className="text-red-500 flex-shrink-0" />
            )}
            <span className="text-muted-foreground">
              Boot:{" "}
              <span className={bootHealthy ? "text-foreground" : "text-red-600 dark:text-red-400"}>
                {bootHealthy ? "Healthy" : `${data.boot.startAttempts} attempts`}
              </span>
            </span>
          </div>

          {lastReloadOk !== null && (
            <div className="flex items-center gap-1.5">
              {lastReloadOk ? (
                <CheckCircle size={11} className="text-emerald-500 flex-shrink-0" />
              ) : (
                <XCircle size={11} className="text-red-500 flex-shrink-0" />
              )}
              <span className="text-muted-foreground">
                Last reload:{" "}
                <span className={lastReloadOk ? "text-foreground" : "text-red-600 dark:text-red-400"}>
                  {lastReloadOk ? "OK" : "Failed"}
                </span>
                {lastReloadAt && (
                  <span className="ml-1 text-muted-foreground/60">
                    ({formatDistanceToNow(lastReloadAt, { addSuffix: true })})
                  </span>
                )}
              </span>
            </div>
          )}

          {data.reload.lastReloadError && (
            <p className="text-red-600 dark:text-red-400 text-[10px] line-clamp-2 ml-4">
              {data.reload.lastReloadError}
            </p>
          )}

          {data.failoverActive && (
            <div className="flex items-center gap-1.5">
              <AlertCircle size={11} className="text-amber-500 flex-shrink-0" />
              <span className="text-amber-600 dark:text-amber-400 font-medium">Failover active</span>
            </div>
          )}
        </div>

        {data.boot.lastStartError && (
          <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 dark:border-red-800 dark:bg-red-950/20">
            <p className="text-[10px] text-red-700 dark:text-red-400 line-clamp-3 font-mono">
              {data.boot.lastStartError}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── ProdSyncCard ───────────────────────────────────────────────────────────────

function ProdSyncCard({ sync }: { sync: V2HealthResponse["prodSync"] }) {
  const lastPollAt = sync.lastPollAtMs ? new Date(sync.lastPollAtMs) : null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity size={13} />
          Prod Sync
          <span
            className={`ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
              sync.lastPollOk
                ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800"
                : sync.lastPollOk === false
                ? "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800"
                : "bg-muted text-muted-foreground border-border"
            }`}
          >
            {sync.lastPollOk ? "Live" : sync.lastPollOk === false ? "Error" : "Waiting"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 text-xs">
        {sync.upstreamUrl && (
          <p className="text-muted-foreground truncate" title={sync.upstreamUrl}>
            {sync.upstreamUrl.replace("https://", "")}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-0.5">
            <p className="text-muted-foreground">Polls</p>
            <p className="font-semibold tabular-nums">{sync.totalPolls}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-muted-foreground">Upserts</p>
            <p className="font-semibold tabular-nums">{sync.totalUpserts}</p>
          </div>
        </div>
        {lastPollAt && (
          <p className="text-muted-foreground/70">
            Last poll {formatDistanceToNow(lastPollAt, { addSuffix: true })}
          </p>
        )}
        {sync.lastPollError && (
          <p className="text-red-600 dark:text-red-400 text-[10px] line-clamp-2">{sync.lastPollError}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ── EmergencyOverridePanel ─────────────────────────────────────────────────────

type OverrideKind = "youtube" | "hls" | "rtmp";

const KIND_LABELS: Record<OverrideKind, string> = {
  youtube: "YouTube",
  hls: "HLS Stream",
  rtmp: "RTMP",
};

const KIND_ICONS: Record<OverrideKind, React.ReactNode> = {
  youtube: <Youtube size={12} />,
  hls: <Tv2 size={12} />,
  rtmp: <Cast size={12} />,
};

const KIND_PLACEHOLDERS: Record<OverrideKind, string> = {
  youtube: "https://youtube.com/watch?v=… or youtu.be/…",
  hls: "https://stream.example.com/live/master.m3u8",
  rtmp: "rtmp://stream.example.com/live/streamkey",
};

function EmergencyOverridePanel({
  snapshot,
  healthMode,
}: {
  snapshot: V2StateResponse["state"] | null;
  healthMode: string | undefined;
}) {
  const qc = useQueryClient();

  // ── Local form state ──────────────────────────────────────────────────────
  const [kind, setKind] = useState<OverrideKind>("youtube");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [timed, setTimed] = useState(false);
  const [durationMin, setDurationMin] = useState("30");
  const [resumeQueue, setResumeQueue] = useState(true);
  const [failoverReason, setFailoverReason] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmFailover, setConfirmFailover] = useState(false);

  // ── Derived from snapshot ─────────────────────────────────────────────────
  const activeOverride = snapshot?.override ?? null;
  const activeFailover = snapshot?.failover ?? null;
  const isOverrideActive = !!activeOverride || healthMode === "override";
  const isFailoverActive = (activeFailover?.active) || healthMode === "failover";

  function invalidateAll() {
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-state"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
  }

  // ── Start override ────────────────────────────────────────────────────────
  const startOverride = useMutation({
    mutationFn: () => {
      const endsAtMs =
        timed && durationMin
          ? Date.now() + Number(durationMin) * 60 * 1000
          : null;
      return api.post("/broadcast-v2/override/start", {
        kind,
        url: url.trim(),
        title: title.trim(),
        endsAtMs,
        resumeQueueOnEnd: resumeQueue,
        idempotencyKey: `override-${Date.now()}`,
      });
    },
    onSuccess: () => {
      toast.success("Override started — broadcast is now live");
      setUrl("");
      setTitle("");
      invalidateAll();
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to start override");
    },
  });

  // ── Stop override ─────────────────────────────────────────────────────────
  const stopOverride = useMutation({
    mutationFn: () =>
      api.post("/broadcast-v2/override/stop", {
        idempotencyKey: `stop-override-${Date.now()}`,
      }),
    onSuccess: () => {
      toast.success("Override stopped — returning to queue");
      setConfirmStop(false);
      invalidateAll();
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to stop override");
      setConfirmStop(false);
    },
  });

  // ── Force failover ────────────────────────────────────────────────────────
  const forceFailover = useMutation({
    mutationFn: () =>
      api.post("/broadcast-v2/force-failover", {
        reason: failoverReason.trim() || "Manual failover",
        idempotencyKey: `failover-${Date.now()}`,
      }),
    onSuccess: () => {
      toast.success("Failover mode activated");
      setConfirmFailover(false);
      setFailoverReason("");
      invalidateAll();
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to activate failover");
      setConfirmFailover(false);
    },
  });

  // ── Clear failover ────────────────────────────────────────────────────────
  const clearFailover = useMutation({
    mutationFn: () =>
      api.post("/broadcast-v2/clear-failover", {
        idempotencyKey: `clear-failover-${Date.now()}`,
      }),
    onSuccess: () => {
      toast.success("Failover cleared — returning to queue");
      invalidateAll();
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Failed to clear failover");
    },
  });

  const canStart =
    url.trim().length > 0 && title.trim().length > 0 && !startOverride.isPending;

  /**
   * Validate the override URL format per kind before firing the mutation.
   * The server performs SSRF checks too, but catching bad input here gives
   * operators an immediate, readable error instead of a cryptic API response.
   */
  const handleStartOverride = () => {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      toast.error("Stream URL is required");
      return;
    }
    if (kind === "rtmp") {
      if (!trimmedUrl.startsWith("rtmp://") && !trimmedUrl.startsWith("rtmps://")) {
        toast.error("RTMP URL must start with rtmp:// or rtmps://");
        return;
      }
    } else {
      try {
        const parsed = new URL(trimmedUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          toast.error("URL must start with http:// or https://");
          return;
        }
      } catch {
        toast.error("URL is not a valid web address — check for typos");
        return;
      }
    }
    startOverride.mutate();
  };

  return (
    <>
      <Card
        className={
          isOverrideActive || isFailoverActive
            ? "border-violet-300 dark:border-violet-700"
            : undefined
        }
      >
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Siren size={13} />
            Emergency Override
            {(isOverrideActive || isFailoverActive) && (
              <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-400 dark:border-violet-700">
                <Signal size={8} />
                {isFailoverActive ? "Failover" : "Override"} Active
              </span>
            )}
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* ── Active override banner ── */}
          {isOverrideActive && activeOverride && (
            <div className="rounded-lg border border-violet-200 bg-violet-50 dark:border-violet-800 dark:bg-violet-950/20 p-3 space-y-2">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-violet-800 dark:text-violet-300 truncate">
                    {activeOverride.title}
                  </p>
                  <p className="text-[10px] text-violet-600 dark:text-violet-400 font-mono truncate mt-0.5">
                    {activeOverride.kind.toUpperCase()} · {activeOverride.url}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs border-violet-300 text-violet-700 hover:bg-violet-100 dark:border-violet-700 dark:text-violet-400 gap-2"
                onClick={() => setConfirmStop(true)}
                disabled={stopOverride.isPending}
              >
                {stopOverride.isPending ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Square size={11} />
                )}
                Stop Override
              </Button>
            </div>
          )}

          {/* ── Active failover banner ── */}
          {isFailoverActive && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <TriangleAlert size={13} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                    Failover Mode Active
                  </p>
                  {activeFailover?.reason && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 truncate">
                      {activeFailover.reason}
                    </p>
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-400 gap-2"
                onClick={() => clearFailover.mutate()}
                disabled={clearFailover.isPending}
              >
                {clearFailover.isPending ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <RotateCcw size={11} />
                )}
                Clear Failover
              </Button>
            </div>
          )}

          {/* ── Override form ── */}
          <div className="space-y-3">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              Inject Live Source
            </p>

            {/* Kind selector */}
            <div className="flex rounded-md border overflow-hidden text-xs">
              {(["youtube", "hls", "rtmp"] as OverrideKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setKind(k);
                    setUrl("");
                  }}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 transition-colors ${
                    kind === k
                      ? "bg-primary text-primary-foreground font-medium"
                      : "hover:bg-muted text-muted-foreground"
                  }`}
                >
                  {KIND_ICONS[k]}
                  {KIND_LABELS[k]}
                </button>
              ))}
            </div>

            {/* URL */}
            <div className="space-y-1">
              <Label htmlFor="override-url" className="text-xs">
                URL
              </Label>
              <div className="relative">
                <Link size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="override-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={KIND_PLACEHOLDERS[kind]}
                  className="text-xs pl-7 h-8 font-mono"
                />
              </div>
            </div>

            {/* Title */}
            <div className="space-y-1">
              <Label htmlFor="override-title" className="text-xs">
                On-screen title
              </Label>
              <Input
                id="override-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Live Sunday Service"
                className="text-xs h-8"
              />
            </div>

            {/* Optional duration */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Switch
                  id="timed-switch"
                  checked={timed}
                  onCheckedChange={setTimed}
                  className="scale-75 origin-left"
                />
                <Label htmlFor="timed-switch" className="text-xs cursor-pointer">
                  Auto-stop after
                </Label>
                {timed && (
                  <div className="flex items-center gap-1 ml-auto">
                    <Input
                      type="number"
                      min={1}
                      max={480}
                      value={durationMin}
                      onChange={(e) => setDurationMin(e.target.value)}
                      className="text-xs h-6 w-14 text-center p-1"
                    />
                    <span className="text-xs text-muted-foreground">min</span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  id="resume-switch"
                  checked={resumeQueue}
                  onCheckedChange={setResumeQueue}
                  className="scale-75 origin-left"
                />
                <Label htmlFor="resume-switch" className="text-xs cursor-pointer">
                  Resume queue when done
                </Label>
              </div>
            </div>

            {/* Go Live button */}
            <Button
              className="w-full gap-2 bg-red-600 hover:bg-red-700 text-white text-xs"
              size="sm"
              onClick={handleStartOverride}
              disabled={!canStart}
            >
              {startOverride.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Radio size={12} />
              )}
              {isOverrideActive ? "Replace Override" : "Go Live Now"}
            </Button>
          </div>

          {/* ── Force failover ── */}
          <div className="border-t pt-3 space-y-2">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              Force Failover
            </p>
            <Input
              value={failoverReason}
              onChange={(e) => setFailoverReason(e.target.value)}
              placeholder="Reason (e.g. stream went down)"
              className="text-xs h-8"
            />
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-2 text-xs border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-400"
              onClick={() => setConfirmFailover(true)}
              disabled={forceFailover.isPending || isFailoverActive}
            >
              {forceFailover.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <TriangleAlert size={12} />
              )}
              {isFailoverActive ? "Failover Already Active" : "Force Failover Mode"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Confirm stop override ── */}
      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop Override?</AlertDialogTitle>
            <AlertDialogDescription>
              The current override will stop immediately.{" "}
              {resumeQueue
                ? "The broadcast queue will resume from where it left off."
                : "The channel will go offline."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => stopOverride.mutate()}
              className="bg-violet-600 hover:bg-violet-700"
            >
              Stop Override
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Confirm force failover ── */}
      <AlertDialog open={confirmFailover} onOpenChange={setConfirmFailover}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert size={16} className="text-amber-500" />
              Force Failover Mode?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This immediately halts normal playback and puts the broadcast into
              failover mode. All viewers will see the failover screen. Clear
              failover to return to the queue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => forceFailover.mutate()}
              className="bg-amber-600 hover:bg-amber-700"
            >
              Force Failover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── TestBroadcastDialog ────────────────────────────────────────────────────────

const colorMap = {
  emerald:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800",
  sky: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-400 dark:border-sky-800",
  amber:
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800",
  rose: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/30 dark:text-rose-400 dark:border-rose-800",
};

function readinessInfo(v: LocalVideo): {
  label: string;
  color: "emerald" | "sky" | "amber" | "rose";
  icon: React.ReactNode;
  canPlay: boolean;
} {
  const hlsReady = v.transcodingStatus === "hls_ready" || v.transcodingStatus === "ready";
  const hasLocal = typeof v.localVideoUrl === "string" && v.localVideoUrl.length > 0;
  if (hlsReady)
    return { label: "HLS ready", color: "emerald", icon: <Wifi size={10} />, canPlay: true };
  // Transcoding-in-flight check MUST come before hasLocal: the raw upload blob
  // is not safely streamable during 'queued' (pre-faststart), 'encoding'
  // (ffmpeg mid-rewrite), or 'processing' (moov atom relocation / 404 window).
  // The orchestrator's loadActive() WHERE clause blocks all three states — so
  // marking canPlay:true here would show a success toast but the item would
  // silently never air.
  if (
    v.transcodingStatus === "encoding" ||
    v.transcodingStatus === "processing" ||
    v.transcodingStatus === "queued"
  ) {
    return {
      label: "Transcoding…",
      color: "amber",
      icon: <Loader2 size={10} className="animate-spin" />,
      canPlay: false,
    };
  }
  if (hasLocal)
    return { label: "MP4 only", color: "sky", icon: <HardDrive size={10} />, canPlay: true };
  return { label: "Not ready", color: "rose", icon: <AlertTriangle size={10} />, canPlay: false };
}

interface TestBroadcastDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdded: () => void;
}

function TestBroadcastDialog({ open, onOpenChange, onAdded }: TestBroadcastDialogProps) {
  const [search, setSearch] = useState("");
  const [addingId, setAddingId] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ["test-broadcast-videos", search],
    queryFn: () => {
      const p = new URLSearchParams({ limit: "30", source: "local" });
      if (search) p.set("search", search);
      return api.get<{ videos: LocalVideo[] }>(`/admin/videos?${p}`);
    },
    enabled: open,
    staleTime: 30_000,
  });

  async function handleAdd(video: LocalVideo) {
    if (addingId) return;
    setAddingId(video.id);
    try {
      await api.post("/admin/broadcast", { videoId: video.id });
      await api
        .post("/broadcast-v2/reload", { idempotencyKey: crypto.randomUUID() })
        .catch(() => {});
      setAddedIds((prev) => new Set(prev).add(video.id));
      toast.success(`"${video.title}" added to broadcast queue`);
      onAdded();
    } catch (e) {
      toast.error(e instanceof HttpError ? e.message : "Failed to add video");
    } finally {
      setAddingId(null);
    }
  }

  function handleOpenChange(o: boolean) {
    if (!o) {
      setSearch("");
      setAddedIds(new Set());
    }
    onOpenChange(o);
  }

  const videos = data?.videos ?? [];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical size={16} className="text-violet-500" />
            Test Broadcast
          </DialogTitle>
          <DialogDescription>
            Add any locally-uploaded video to the queue to test the full player pipeline.
            HLS-ready videos play with adaptive bitrate; MP4-only videos stream as a single file.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            placeholder="Search local videos…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />

          <div className="border rounded-lg max-h-72 overflow-y-auto divide-y">
            {isLoading ? (
              <div className="py-8 flex items-center justify-center">
                <Loader2 size={20} className="animate-spin text-muted-foreground" />
              </div>
            ) : videos.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
                <HardDrive size={22} className="text-muted-foreground/30" />
                <p>No local videos found.</p>
                <p className="text-xs">Upload a video first, then test it here.</p>
              </div>
            ) : (
              videos.map((v) => {
                const info = readinessInfo(v);
                const isAdded = addedIds.has(v.id);
                const isAdding = addingId === v.id;
                return (
                  <div
                    key={v.id}
                    className={`flex items-center gap-2.5 px-3 py-2.5 ${
                      isAdded ? "bg-emerald-50/50 dark:bg-emerald-950/10" : ""
                    }`}
                  >
                    <div className="flex-shrink-0 w-14 h-9 rounded overflow-hidden bg-black">
                      {v.thumbnailUrl ? (
                        <img src={v.thumbnailUrl} alt="" className="w-full h-full object-contain" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Video size={13} className="text-muted-foreground/30" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{v.title}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span
                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${colorMap[info.color]}`}
                        >
                          {info.icon}
                          {info.label}
                        </span>
                        {v.duration && v.duration > 0 && (
                          <span className="text-[11px] text-muted-foreground">
                            {formatDuration(v.duration)}
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={isAdded ? "ghost" : "outline"}
                      className="h-7 flex-shrink-0 gap-1 text-xs"
                      disabled={isAdding || !info.canPlay}
                      title={!info.canPlay ? "Video is not yet playable" : undefined}
                      onClick={() => !isAdded && void handleAdd(v)}
                    >
                      {isAdding ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : isAdded ? (
                        <>
                          <CheckCircle2 size={11} className="text-emerald-500" /> Added
                        </>
                      ) : (
                        <>
                          <Plus size={11} /> Add
                        </>
                      )}
                    </Button>
                  </div>
                );
              })
            )}
          </div>

          <div className="flex items-start gap-2 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-[11px] text-violet-700 dark:border-violet-800/60 dark:bg-violet-950/20 dark:text-violet-300">
            <FlaskConical size={12} className="mt-0.5 flex-shrink-0" />
            <span>
              Added videos go to the end of the queue. Use the{" "}
              <strong className="font-semibold">⚡ Play Now</strong> button on any queue row to
              instantly promote it and start playing.
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function BroadcastPage() {
  const qc = useQueryClient();

  // ── SSE-gated poll intervals ───────────────────────────────────────────────
  // Suppress HTTP polling while SSE is healthy; fall back when unavailable.
  // A 15-second grace period on reconnect avoids a burst of requests on brief blips.
  const sseGated15s = useSseGatedInterval(15_000);
  const sseGated30s = useSseGatedInterval(30_000);
  const sseGated60s = useSseGatedInterval(60_000);

  const [addOpen, setAddOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [videoSearch, setVideoSearch] = useState("");
  const [selectedVideoId, setSelectedVideoId] = useState("");
  const [items, setItems] = useState<BroadcastQueueItem[]>([]);
  const [removeConfirm, setRemoveConfirm] = useState<BroadcastQueueItem | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  // Top-level drag state. dnd-kit's per-row `isDragging` is local to each
  // SortableRow, but we need a queue-wide flag so the items-sync effect
  // below doesn't yank the row out from under the user mid-drag when a
  // background poll arrives. Set true on DnDContext.onDragStart, cleared
  // by handleDragEnd (the reorder mutation owns isSyncing from drop on).
  const [isDragging, setIsDragging] = useState(false);

  // ── Bulk-remove state ─────────────────────────────────────────────────────
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkRemoveConfirm, setBulkRemoveConfirm] = useState(false);

  // ── Upload-and-auto-queue state ───────────────────────────────────────────
  // `uploadQueue` is a shared module singleton; auto-queue tracking is held at
  // module-level (see `markForAutoQueue` / `ensureAutoQueueSubscriber` above)
  // so the intent survives navigation, retries on transient POST failure, and
  // doesn't accidentally re-queue uploads started from /videos.
  const [uploadPanelOpen, setUploadPanelOpen] = useState(false);
  const { summary: uploadSummary } = useUploadQueue();

  // ── Data queries ──────────────────────────────────────────────────────────

  const {
    data: queue,
    isLoading: queueLoading,
    error: queueError,
    refetch,
  } = useQuery({
    queryKey: ["broadcast-queue"],
    queryFn: () => api.get<{ items: BroadcastQueueItem[] }>("/admin/broadcast"),
    // When actively transcoding: always poll at 5 s so encoding badges update
    // in real time (this page's SSE handler does not invalidate broadcast-queue
    // on transcoding-update, so HTTP polling is the only refresh path).
    // When idle and SSE is connected: suppress polling (push-invalidation handles
    // freshness). When SSE is unavailable: fall back to 15 s.
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasLiveTranscoding = data?.items.some(
        (i) =>
          i.transcodingStatus === "encoding" ||
          i.transcodingStatus === "processing" ||
          i.transcodingStatus === "queued",
      ) ?? false;
      if (hasLiveTranscoding) return 5_000;
      return sseGated15s;
    },
    staleTime: 4_000,
  });

  // V2 snapshot — authoritative "now playing" and mode source
  const { data: v2State } = useQuery({
    queryKey: ["broadcast-v2-state"],
    queryFn: () => api.get<V2StateResponse>("/broadcast-v2/state"),
    refetchInterval: sseGated15s,
  });

  // V2 health — orchestrator status panel (public endpoint, no auth needed)
  const { data: v2Health, isLoading: healthLoading } = useQuery({
    queryKey: ["broadcast-v2-health"],
    queryFn: () =>
      api.get<V2HealthResponse>("/broadcast-v2/health").catch(() => null),
    refetchInterval: sseGated15s,
    staleTime: 12_000,
  });

  // V2 source-health — per-item bad-URL cache status.
  // Poll aggressively (5 s) when at least one source is blocked so the
  // countdown badges stay fresh and the "Clear Blocks" UI reflects the
  // real state as soon as the TTL expires. Fall back to 30 s when healthy.
  const { data: sourceHealth } = useQuery({
    queryKey: ["broadcast-v2-source-health"],
    queryFn: () =>
      api
        .get<V2SourceHealthResponse>("/broadcast-v2/source-health")
        .catch(() => null),
    // Always poll at 5 s when sources are blocked (countdown badges must stay
    // current). When idle and SSE is connected: no polling. When SSE is down:
    // fall back to 30 s.
    refetchInterval: (query) => {
      const d = query.state.data;
      const hasBlocked = d
        ? Object.values(d.healthByItemId).some(
            (h) => h.status === "bad" && h.badUntilMs && h.badUntilMs > Date.now(),
          )
        : false;
      if (hasBlocked) return 5_000;
      return sseGated30s;
    },
  });

  // v1 health for broken-source badges (structural check, not runtime cache)
  const { data: health, isLoading: healthV1Loading } = useQuery({
    queryKey: ["broadcast-health"],
    queryFn: () =>
      api.get<HealthResponse>("/admin/broadcast/health").catch(() => null),
    refetchInterval: sseGated60s,
    enabled: (queue?.items.length ?? 0) > 0,
  });

  // Video search for Add dialog
  const { data: videoSearchResults } = useQuery({
    queryKey: ["video-search", videoSearch],
    queryFn: () => {
      const p = new URLSearchParams({ limit: "20", transcodingStatus: "hls_ready" });
      if (videoSearch) p.set("search", videoSearch);
      return api.get<{
        videos: { id: string; title: string; duration?: number; thumbnailUrl?: string }[];
      }>(`/admin/videos?${p}`);
    },
    enabled: addOpen,
  });

  // ── Sync queue items to local drag state ──────────────────────────────────

  useEffect(() => {
    // Skip sync while the user is actively dragging or a reorder is mid-flight,
    // otherwise a background poll would overwrite the in-progress arrangement
    // and cause a visible jump / lost drop.
    if (isDragging || isSyncing) return;
    if (queue?.items) setItems(queue.items);
  }, [queue?.items, isSyncing, isDragging]);

  // ── SSE real-time invalidation ────────────────────────────────────────────

  useSSEEvent("broadcast-queue-updated", () => {
    void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-state"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
  });

  // ── Derived values ────────────────────────────────────────────────────────

  const healthMap = new Map<string, HealthItem>(
    health?.items.map((h) => [h.id, h]) ?? [],
  );
  const sourceHealthMap = sourceHealth?.healthByItemId ?? {};

  const v2Snapshot = v2State?.state ?? null;
  const nowPlaying = v2Snapshot?.current ?? null;
  const nowPlayingStartedAt = nowPlaying ? new Date(nowPlaying.startsAtMs) : null;
  const nowPlayingEndsAt = nowPlaying ? new Date(nowPlaying.endsAtMs) : null;
  const nowPlayingVideoId =
    nowPlaying ? (items.find((i) => i.id === nowPlaying.id)?.videoId ?? null) : null;
  const nowPlayingIsApiUploadMp4 =
    nowPlaying?.source.kind === "mp4" &&
    (nowPlaying.source.url.includes("/api/v1/uploads/") ||
      nowPlaying.source.url.includes("/api/uploads/"));

  const brokenCount = health?.summary.broken ?? 0;
  const blockedCount = Object.values(sourceHealthMap).filter(
    (h) => h.status === "bad" && h.badUntilMs && h.badUntilMs > Date.now(),
  ).length;

  // ── Mutations ─────────────────────────────────────────────────────────────

  const skipMutation = useMutation({
    mutationFn: () =>
      api.post("/broadcast-v2/skip", { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      toast.success("Skipped to next item");
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-state"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Skip failed"),
  });

  const reloadMutation = useMutation({
    mutationFn: () =>
      api.post("/broadcast-v2/reload", { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      toast.success("Orchestrator reloaded");
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-state"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Reload failed"),
  });

  const clearBlocksMutation = useMutation({
    mutationFn: () =>
      api.post("/broadcast-v2/clear-bad-urls", { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      toast.success("Source blocks cleared — orchestrator reloaded");
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-state"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to clear blocks"),
  });

  const reorderMutation = useMutation({
    mutationFn: async (itemIds: string[]) => {
      try {
        return await api.put("/admin/broadcast/reorder", { itemIds });
      } catch (err) {
        // Transient connection failure (status 0 = no HTTP response received):
        // wait 800 ms and retry once. This covers Render.com cold-start TCP
        // resets, dev-server restarts, and brief network blips where the
        // optimistic reorder has already been applied in the UI.
        if (err instanceof HttpError && err.status === 0) {
          await new Promise((r) => setTimeout(r, 800));
          return api.put("/admin/broadcast/reorder", { itemIds });
        }
        throw err;
      }
    },
    onSuccess: () => {
      setIsSyncing(false);
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-state"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
    },
    onError: (e) => {
      setIsSyncing(false);
      const msg =
        e instanceof HttpError
          ? e.message || `Server error ${e.status}`
          : "Network error — reorder not saved. Please try again.";
      toast.error(msg);
      if (queue?.items) setItems(queue.items);
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-state"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
    },
  });

  const addMutation = useMutation({
    mutationFn: (videoId: string) => api.post("/admin/broadcast", { videoId }),
    onSuccess: async () => {
      toast.success("Added to broadcast queue");
      await api
        .post("/broadcast-v2/reload", { idempotencyKey: crypto.randomUUID() })
        .catch(() => {});
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-state"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
      setAddOpen(false);
      setSelectedVideoId("");
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to add"),
  });

  // Install the module-level auto-queue subscriber once. Safe to call on
  // every render — it self-guards via `autoQueueSubscribed`.
  useEffect(() => {
    ensureAutoQueueSubscriber(qc);
  }, [qc]);

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/broadcast/${id}`),
    onSuccess: () => {
      toast.success("Removed from queue");
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-state"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to remove"),
  });

  const bulkRemoveMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.all(ids.map((id) => api.delete(`/admin/broadcast/${id}`)));
    },
    onSuccess: (_data, ids) => {
      toast.success(`${ids.length} item${ids.length === 1 ? "" : "s"} removed from queue`);
      setSelectedIds(new Set());
      setBulkMode(false);
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-state"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Bulk remove failed"),
  });

  const faststartMutation = useMutation({
    mutationFn: (videoId: string) =>
      api.post<{ ok: boolean; videoId: string }>(`/admin/videos/${videoId}/faststart`),
    onSuccess: () => {
      toast.success("Faststart started — moov atom will be relocated in ~30–90 s. Queue will reload automatically when done.");
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Faststart request failed"),
  });

  const playNowMutation = useMutation({
    mutationFn: (queueItemId: string) =>
      api.post("/broadcast-v2/play-now", {
        queueItemId,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: (_data, queueItemId) => {
      const item = items.find((i) => i.id === queueItemId);
      toast.success(item ? `Now playing: ${item.title}` : "Switched to item");
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-state"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Play Now failed"),
  });

  // ── Drag-and-drop ─────────────────────────────────────────────────────────

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setItems((prev) => {
      const oldIndex = prev.findIndex((i) => i.id === active.id);
      const newIndex = prev.findIndex((i) => i.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      const next = arrayMove(prev, oldIndex, newIndex);
      setIsSyncing(true);
      reorderMutation.mutate(next.map((i) => i.id));
      return next;
    });
  }

  // ── Estimated air times ───────────────────────────────────────────────────
  // Compute estimated on-air timestamp for each non-playing queue item.
  // Uses the v2 snapshot's endsAtMs for the current item as the anchor,
  // then accumulates durationSecs of each subsequent item in queue order.
  const estimatedAirTimes = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    let cursor = nowPlaying ? nowPlaying.endsAtMs : Date.now();
    const activeItems = items.filter((i) => i.isActive);
    let pastCurrent = nowPlaying === null;
    for (const it of activeItems) {
      if (!pastCurrent) {
        if (it.id === nowPlaying?.id) {
          pastCurrent = true;
        }
        continue;
      }
      map.set(it.id, cursor);
      cursor += (it.durationSecs || 0) * 1000;
    }
    return map;
  }, [items, nowPlaying]);

  // ── BroadcastUploadPanel adapter types ────────────────────────────────────
  const panelQueueItems = useMemo<BroadcastQueueRow[]>(
    () =>
      items.map((i) => ({
        id: i.id,
        videoId: i.videoId,
        title: i.title,
        thumbnailUrl: i.thumbnailUrl,
        durationSecs: i.durationSecs,
        videoSource: i.videoSource,
        isActive: i.isActive,
        sortOrder: i.sortOrder,
        transcodingStatus: i.transcodingStatus,
        hasHls: i.hasHls,
      })),
    [items],
  );

  const panelServer = useMemo<BroadcastServerSnapshot>(() => {
    const next = v2Snapshot?.next ?? null;
    return {
      current: nowPlaying
        ? {
            id: nowPlaying.id,
            title: nowPlaying.title,
            startsAtMs: nowPlaying.startsAtMs,
            endsAtMs: nowPlaying.endsAtMs,
          }
        : null,
      next: next ? { id: next.id, title: next.title } : null,
    };
  }, [nowPlaying, v2Snapshot]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <PageHeader
        title="Broadcast Queue"
        description="Master control for live broadcast and the video playback queue."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refetch();
                void qc.invalidateQueries({ queryKey: ["broadcast-v2-health"] });
                void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
              }}
              className="gap-1.5"
            >
              <RefreshCw size={13} /> Refresh
            </Button>

            {blockedCount > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => clearBlocksMutation.mutate()}
                disabled={clearBlocksMutation.isPending}
                className="gap-1.5 border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-950/20"
                title="Clear blocked source URLs and retry all items"
              >
                {clearBlocksMutation.isPending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <ShieldAlert size={13} />
                )}
                Clear {blockedCount} Block{blockedCount !== 1 ? "s" : ""}
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => reloadMutation.mutate()}
              disabled={reloadMutation.isPending}
              className="gap-1.5"
              title="Reload the orchestrator from the database"
            >
              {reloadMutation.isPending ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RotateCcw size={13} />
              )}
              Reload
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={() => setTestOpen(true)}
              className="gap-1.5 border-violet-200 text-violet-700 hover:bg-violet-50 hover:text-violet-800 dark:border-violet-700 dark:text-violet-400 dark:hover:bg-violet-950/30"
            >
              <FlaskConical size={14} /> Test
            </Button>

            <Button
              size="sm"
              variant={uploadPanelOpen ? "secondary" : "outline"}
              onClick={() => setUploadPanelOpen((v) => !v)}
              className="gap-1.5"
            >
              <UploadCloud size={14} />
              {uploadPanelOpen ? "Hide Upload" : "Upload & Queue"}
              {uploadSummary.hasActive && (
                <span className="ml-1 h-2 w-2 rounded-full bg-primary animate-pulse" />
              )}
            </Button>

            <Button size="sm" onClick={() => setAddOpen(true)} className="gap-1.5">
              <Plus size={14} /> Add to Queue
            </Button>
          </div>
        }
      />

      {/* Error alert */}
      {queueError && (
        <ErrorAlert
          message={(queueError as Error).message}
          onRetry={() => void refetch()}
        />
      )}

      {/* Broken-items banner */}
      {brokenCount > 0 && !healthV1Loading && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 dark:border-red-800 dark:bg-red-950/20">
          <AlertTriangle size={15} className="mt-0.5 flex-shrink-0 text-red-500" />
          <p className="text-sm">
            <span className="font-semibold text-red-700 dark:text-red-400">
              {brokenCount} item{brokenCount !== 1 ? "s" : ""} with no playable source
            </span>
            <span className="text-red-600 dark:text-red-400/80">
              {" "}— these will be auto-skipped. Remove them or link a video source.
            </span>
          </p>
        </div>
      )}

      {/* Blocked URLs banner */}
      {blockedCount > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/20">
          <ShieldAlert size={15} className="mt-0.5 flex-shrink-0 text-amber-500" />
          <div className="flex-1 text-sm">
            <span className="font-semibold text-amber-700 dark:text-amber-400">
              {blockedCount} source{blockedCount !== 1 ? "s" : ""} temporarily blocked
            </span>
            <span className="text-amber-600 dark:text-amber-400/80">
              {" "}— a player reported these as unreachable (2-min cooldown).
            </span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs flex-shrink-0 text-amber-700 hover:bg-amber-100 dark:text-amber-400"
            onClick={() => clearBlocksMutation.mutate()}
            disabled={clearBlocksMutation.isPending}
          >
            Clear now
          </Button>
        </div>
      )}

      {/* ── Two-column layout ── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_18rem] xl:grid-cols-[1fr_20rem] gap-6 items-start">
        {/* ── Left column ── */}
        <div className="space-y-6">
          {/* Live Preview + Now Playing */}
          <Card className={nowPlaying ? "border-primary/30 bg-primary/5" : ""}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Radio
                  size={13}
                  className={
                    nowPlaying ? "text-primary animate-pulse" : "text-muted-foreground"
                  }
                />
                {nowPlaying
                  ? "On Air"
                  : v2Snapshot?.mode === "offline_hold"
                  ? "Offline Hold"
                  : "Off Air"}

                {v2Snapshot && (
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                      MODE_COLORS[v2Snapshot.mode] ?? MODE_COLORS.queue
                    }`}
                  >
                    {MODE_LABELS[v2Snapshot.mode] ?? v2Snapshot.mode}
                  </span>
                )}

                <div className="ml-auto flex items-center gap-1.5">
                  {nowPlaying && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 text-xs"
                      onClick={() => skipMutation.mutate()}
                      disabled={skipMutation.isPending}
                    >
                      {skipMutation.isPending ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <SkipForward size={11} />
                      )}
                      Skip
                    </Button>
                  )}
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Always-visible live preview — v2 player, identical feed to TV/web/mobile */}
              <BroadcastPreviewV2 className="w-full aspect-video rounded-md overflow-hidden" />

              {nowPlaying ? (
                <div className="flex items-center gap-3">
                  <div className="flex-shrink-0 w-20 h-12 rounded overflow-hidden bg-black">
                    {nowPlaying.thumbnailUrl ? (
                      <img
                        src={nowPlaying.thumbnailUrl}
                        alt=""
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Video size={18} className="text-muted-foreground/30" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate">{nowPlaying.title}</p>
                    <div className="flex gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                      {nowPlayingStartedAt && (
                        <span className="flex items-center gap-1">
                          <Play size={11} />
                          Started{" "}
                          {formatDistanceToNow(nowPlayingStartedAt, { addSuffix: true })}
                        </span>
                      )}
                      {nowPlayingEndsAt && (
                        <span className="flex items-center gap-1">
                          <Clock size={11} />
                          Ends {formatDistanceToNow(nowPlayingEndsAt, { addSuffix: true })}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Wifi size={10} className="text-emerald-500" />
                        {nowPlaying.source.kind.toUpperCase()}
                      </span>
                    </div>
                    {nowPlayingIsApiUploadMp4 && nowPlayingVideoId && (
                      <div className="flex items-center gap-2 mt-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20 px-2.5 py-1.5">
                        <TriangleAlert size={11} className="text-amber-500 flex-shrink-0" />
                        <p className="text-[11px] text-amber-700 dark:text-amber-400 flex-1 leading-snug">
                          MP4 upload — if this video fails to play, re-apply faststart to fix the moov atom.
                        </p>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[11px] flex-shrink-0 px-2 gap-1 border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-400"
                          onClick={() => faststartMutation.mutate(nowPlayingVideoId!)}
                          disabled={faststartMutation.isPending}
                          title="Re-run MP4 faststart to relocate the moov atom to the front of the file"
                        >
                          {faststartMutation.isPending ? (
                            <Loader2 size={10} className="animate-spin" />
                          ) : (
                            <RotateCcw size={10} />
                          )}
                          Retry faststart
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 py-1">
                  <Pause size={16} className="text-muted-foreground/30 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-muted-foreground">
                    {v2Snapshot?.mode === "offline_hold"
                      ? "Broadcast is in offline hold — no content will air until the queue has a playable item."
                      : items.length === 0
                      ? "Queue is empty. Add content to start broadcasting."
                      : blockedCount > 0 && blockedCount >= items.filter((i) => i.isActive).length
                      ? "All sources are temporarily blocked — broadcast paused. Sources auto-unblock after 2 min, or click \"Clear Blocks\" to resume immediately."
                      : blockedCount > 0
                      ? `${blockedCount} source${blockedCount !== 1 ? "s" : ""} blocked — broadcast cycling around unavailable items.`
                      : "No content currently playing — orchestrator is loading."}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Queue */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2 flex-wrap gap-y-1">
                <List size={13} />
                Up Next ({items.length})
                {reorderMutation.isPending && (
                  <span className="text-xs text-muted-foreground font-normal animate-pulse ml-1">
                    Saving order…
                  </span>
                )}

                <div className="ml-auto flex items-center gap-1.5 flex-wrap">
                  {health && !healthV1Loading && items.length > 0 && (
                    <span className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
                      {health.summary.ok > 0 && (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {health.summary.ok} ready
                        </span>
                      )}
                      {health.summary.broken > 0 && (
                        <span className="text-red-600 dark:text-red-400 font-medium">
                          {health.summary.broken} broken
                        </span>
                      )}
                      {health.summary.skipped > 0 && (
                        <span>{health.summary.skipped} inactive</span>
                      )}
                    </span>
                  )}

                  {items.length > 0 && (
                    <>
                      {bulkMode ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => {
                              if (selectedIds.size === items.length) {
                                setSelectedIds(new Set());
                              } else {
                                setSelectedIds(new Set(items.map((i) => i.id)));
                              }
                            }}
                          >
                            {selectedIds.size === items.length ? "Deselect all" : "Select all"}
                          </Button>
                          {selectedIds.size > 0 && (
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-7 px-2 text-xs gap-1"
                              onClick={() => setBulkRemoveConfirm(true)}
                              disabled={bulkRemoveMutation.isPending}
                            >
                              {bulkRemoveMutation.isPending ? (
                                <Loader2 size={11} className="animate-spin" />
                              ) : (
                                <Trash2 size={11} />
                              )}
                              Remove {selectedIds.size}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => {
                              setBulkMode(false);
                              setSelectedIds(new Set());
                            }}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs gap-1 text-muted-foreground"
                          onClick={() => setBulkMode(true)}
                        >
                          <Trash2 size={11} />
                          Bulk remove
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {queueLoading ? (
                <div className="divide-y">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="flex items-center gap-3 p-3">
                      <Skeleton className="h-4 w-4" />
                      <Skeleton className="h-12 w-20 rounded" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-4 w-48" />
                        <Skeleton className="h-3 w-24" />
                      </div>
                      <Skeleton className="h-5 w-14 rounded-full" />
                    </div>
                  ))}
                </div>
              ) : items.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-12 text-center">
                  <Radio size={28} className="text-muted-foreground/20" />
                  <p className="font-medium text-sm">Queue is empty</p>
                  <p className="text-xs text-muted-foreground">
                    Add videos to schedule broadcast content.
                  </p>
                  <div className="flex gap-2 mt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setUploadPanelOpen(true)}
                      className="gap-1.5"
                    >
                      <UploadCloud size={13} /> Upload video
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setAddOpen(true)}
                      className="gap-1.5"
                    >
                      <Plus size={13} /> Add content
                    </Button>
                  </div>
                </div>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={() => setIsDragging(true)}
                  onDragCancel={() => setIsDragging(false)}
                  onDragEnd={(e) => {
                    setIsDragging(false);
                    handleDragEnd(e);
                  }}
                >
                  <SortableContext
                    items={items.map((i) => i.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div>
                      {items.map((item, idx) => {
                        const sh = sourceHealthMap[item.id];
                        return (
                          <SortableRow
                            key={item.id}
                            item={item}
                            idx={idx}
                            health={healthMap.get(item.id)}
                            healthLoading={healthV1Loading}
                            blockedUntilMs={sh?.status === "bad" ? sh.badUntilMs : null}
                            estimatedAirMs={estimatedAirTimes.get(item.id) ?? null}
                            onRemove={() => setRemoveConfirm(item)}
                            onMoveToFront={() => {
                              if (idx === 0) return;
                              setItems((prev) => {
                                const next = arrayMove(prev, idx, 0);
                                setIsSyncing(true);
                                reorderMutation.mutate(next.map((i) => i.id));
                                return next;
                              });
                            }}
                            onPlayNow={() => playNowMutation.mutate(item.id)}
                            isRemoving={
                              removeMutation.isPending &&
                              removeMutation.variables === item.id
                            }
                            isPlayingNow={nowPlaying?.id === item.id}
                            isDragDisabled={isSyncing || playNowMutation.isPending || removeMutation.isPending}
                            bulkMode={bulkMode}
                            isSelected={selectedIds.has(item.id)}
                            onToggleSelect={() =>
                              setSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(item.id)) next.delete(item.id);
                                else next.add(item.id);
                                return next;
                              })
                            }
                          />
                        );
                      })}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </CardContent>
          </Card>

          {/* ── Upload Panel (inline, collapsible) ── */}
          {uploadPanelOpen && (
            <BroadcastUploadPanel
              server={panelServer}
              queueItems={panelQueueItems}
            />
          )}
        </div>

        {/* ── Right column: status panels ── */}
        <div className="space-y-4">
          <OrchestratorStatusPanel data={v2Health} loading={healthLoading} />

          {v2Health?.prodSync?.enabled && (
            <ProdSyncCard sync={v2Health.prodSync} />
          )}

          {/* Quick actions panel */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Zap size={13} />
                Quick Actions
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full gap-2 justify-start text-xs"
                onClick={() => reloadMutation.mutate()}
                disabled={reloadMutation.isPending}
              >
                {reloadMutation.isPending ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RotateCcw size={12} />
                )}
                Reload orchestrator
              </Button>

              {blockedCount > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-2 justify-start text-xs border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-400"
                  onClick={() => clearBlocksMutation.mutate()}
                  disabled={clearBlocksMutation.isPending}
                >
                  <ShieldAlert size={12} />
                  Clear {blockedCount} blocked source{blockedCount !== 1 ? "s" : ""}
                </Button>
              )}

              {nowPlaying && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-2 justify-start text-xs"
                  onClick={() => skipMutation.mutate()}
                  disabled={skipMutation.isPending}
                >
                  {skipMutation.isPending ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <SkipForward size={12} />
                  )}
                  Skip current item
                </Button>
              )}

              <Button
                variant="outline"
                size="sm"
                className="w-full gap-2 justify-start text-xs border-violet-200 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-400"
                onClick={() => setTestOpen(true)}
              >
                <FlaskConical size={12} />
                Test broadcast
              </Button>
            </CardContent>
          </Card>

          <EmergencyOverridePanel
            snapshot={v2Snapshot}
            healthMode={v2Health?.mode}
          />
        </div>
      </div>

      {/* ── Bulk Remove Confirmation ── */}
      <AlertDialog open={bulkRemoveConfirm} onOpenChange={setBulkRemoveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {selectedIds.size} item{selectedIds.size === 1 ? "" : "s"} from queue?</AlertDialogTitle>
            <AlertDialogDescription>
              {selectedIds.size} item{selectedIds.size === 1 ? "" : "s"} will be permanently removed from the broadcast queue.
              If any are currently on air, the player will skip to the next item.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkRemoveMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={bulkRemoveMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                bulkRemoveMutation.mutate([...selectedIds], {
                  onSettled: () => setBulkRemoveConfirm(false),
                });
              }}
            >
              {bulkRemoveMutation.isPending ? "Removing…" : `Remove ${selectedIds.size}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Add to Queue Dialog ── */}
      <Dialog
        open={addOpen}
        onOpenChange={(o) => {
          setAddOpen(o);
          if (!o) {
            setSelectedVideoId("");
            setVideoSearch("");
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add to Broadcast Queue</DialogTitle>
            <DialogDescription className="sr-only">
              Search and select a ready video to add to the live broadcast queue
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Search HLS-ready videos…"
              value={videoSearch}
              onChange={(e) => setVideoSearch(e.target.value)}
            />
            <div className="border rounded-lg max-h-72 overflow-y-auto divide-y">
              {(videoSearchResults?.videos ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No HLS-ready videos found
                </p>
              ) : (
                videoSearchResults?.videos.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => setSelectedVideoId(v.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors ${
                      selectedVideoId === v.id
                        ? "bg-primary/10 border-l-2 border-l-primary"
                        : ""
                    }`}
                  >
                    <div className="flex-shrink-0 w-14 h-9 rounded overflow-hidden bg-black">
                      {v.thumbnailUrl ? (
                        <img
                          src={v.thumbnailUrl}
                          alt=""
                          className="w-full h-full object-contain"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Video size={13} className="text-muted-foreground/30" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{v.title}</p>
                      {v.duration && (
                        <p className="text-xs text-muted-foreground">
                          {formatDuration(v.duration)}
                        </p>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => selectedVideoId && addMutation.mutate(selectedVideoId)}
              disabled={!selectedVideoId || addMutation.isPending}
            >
              {addMutation.isPending ? "Adding…" : "Add to Queue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Test Broadcast Dialog ── */}
      <TestBroadcastDialog
        open={testOpen}
        onOpenChange={setTestOpen}
        onAdded={() => {
          void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
          void qc.invalidateQueries({ queryKey: ["broadcast-v2-source-health"] });
        }}
      />

      {/* ── Remove Confirmation Dialog ── */}
      <AlertDialog
        open={!!removeConfirm}
        onOpenChange={(o) => !o && setRemoveConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from broadcast queue?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeConfirm ? (
                <>
                  <span className="font-medium text-foreground">{removeConfirm.title}</span>
                  {" "}will be removed from the live broadcast queue. If it is currently on air,
                  the player will skip to the next item. This cannot be undone.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
              disabled={removeMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (!removeConfirm) return;
                const id = removeConfirm.id;
                removeMutation.mutate(id, {
                  onSettled: () => setRemoveConfirm(null),
                });
              }}
            >
              {removeMutation.isPending ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
