/**
 * Persistent floating upload queue panel.
 *
 * Mounted once inside the authenticated shell (App.tsx) so it stays visible
 * across all page navigations. When there are no uploads, the panel is hidden.
 * When uploads are active or recently finished it appears as a fixed
 * bottom-right drawer with per-file progress rows.
 *
 * Progress bar: size-weighted across all in-flight items (uses totalBytes /
 * uploadedBytes from summary) so large files correctly dominate the bar.
 * Header: shows live speed + ETA computed from the aggregate speed and remaining
 * bytes across all uploading items.
 * Offline: shows a banner when navigator.onLine is false (items are auto-paused).
 */

import { useState, useEffect, useCallback } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  uploadQueue,
  useUploadQueue,
  formatBytes,
  formatSpeed,
  formatEta,
  type UploadStatus,
} from "@/lib/upload-queue";
import { api, HttpError } from "@/lib/api";
import { toast } from "sonner";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  UploadCloud,
  ChevronDown,
  ChevronUp,
  X,
  Pause,
  Play,
  RefreshCw,
  ArrowUp,
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
  Ban,
  WifiOff,
  ListPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Status helpers ────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: UploadStatus }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />;
    case "failed":
      return <AlertCircle size={14} className="text-red-500 flex-shrink-0" />;
    case "cancelled":
      return <Ban size={14} className="text-muted-foreground flex-shrink-0" />;
    case "paused":
      return <Pause size={14} className="text-amber-500 flex-shrink-0" />;
    case "pending":
      return <Clock size={14} className="text-muted-foreground flex-shrink-0" />;
    case "uploading":
    case "finalizing":
      return <Loader2 size={14} className="text-primary animate-spin flex-shrink-0" />;
  }
}

function StatusBadge({ status }: { status: UploadStatus }) {
  const map: Record<UploadStatus, { label: string; variant: string }> = {
    pending:    { label: "Pending",     variant: "outline" },
    uploading:  { label: "Uploading",   variant: "secondary" },
    finalizing: { label: "Finalizing",  variant: "secondary" },
    completed:  { label: "Complete",    variant: "default" },
    failed:     { label: "Failed",      variant: "destructive" },
    paused:     { label: "Paused",      variant: "outline" },
    cancelled:  { label: "Cancelled",   variant: "outline" },
  };
  const { label, variant } = map[status];
  return (
    <Badge
      variant={variant as "default" | "secondary" | "outline" | "destructive"}
      className="text-[10px] h-4 px-1.5 flex-shrink-0"
    >
      {label}
    </Badge>
  );
}

// ── Per-file row ──────────────────────────────────────────────────────────────

type QueueActionState = "idle" | "loading" | "queued" | "conflict";

function UploadRow({
  item,
  qc,
}: {
  item: ReturnType<typeof useUploadQueue>["items"][number];
  qc: QueryClient;
}) {
  const isActive    = item.status === "uploading" || item.status === "finalizing";
  const isPaused    = item.status === "paused";
  const isFailed    = item.status === "failed";
  const isCancelled = item.status === "cancelled";
  const isCompleted = item.status === "completed";
  const isPending   = item.status === "pending";

  const [queueAction, setQueueAction] = useState<QueueActionState>("idle");

  const handleAddToQueue = useCallback(async () => {
    if (!item.videoId || queueAction !== "idle") return;
    setQueueAction("loading");
    try {
      await api.post("/admin/broadcast", { videoId: item.videoId, allowPending: true });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue-sync-status"] });
      setQueueAction("queued");
      toast.success(`"${item.title || item.file.name}" added to broadcast queue.`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        setQueueAction("conflict");
      } else {
        setQueueAction("idle");
        const msg = err instanceof HttpError ? err.message : "Failed to add to broadcast queue.";
        toast.error(msg);
      }
    }
  }, [item.videoId, item.title, item.file.name, queueAction, qc]);

  return (
    <div className="px-3 py-2.5 border-b border-border/50 last:border-0">
      <div className="flex items-start gap-2">
        <StatusIcon status={item.status} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-xs font-medium truncate max-w-[160px]" title={item.file.name}>
              {item.title || item.file.name}
            </p>
            <span className="text-[10px] text-muted-foreground flex-shrink-0">
              {formatBytes(item.file.size)}
            </span>
          </div>

          {/* Progress bar — shown while uploading or paused */}
          {(isActive || isPaused) && (
            <div className="mt-1.5 space-y-1">
              <Progress
                value={item.progress}
                className={cn("h-1.5", isPaused && "opacity-60")}
              />
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">
                  {item.status === "finalizing"
                    ? item.assemblyPercent != null
                      ? `Assembling (${item.assemblyPercent}%)…`
                      : "Finalizing…"
                    : item.speed > 0
                      ? `${formatSpeed(item.speed)} · ${formatEta(item.eta)}`
                      : item.speedLabel || "Starting…"}
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {item.status === "finalizing"
                    ? `${item.progress}%`
                    : item.uploadedBytes > 0
                      ? `${formatBytes(item.uploadedBytes)} / ${formatBytes(item.file.size)}`
                      : `${item.progress}%`}
                </span>
              </div>
            </div>
          )}

          {/* Status line for terminal states */}
          {!isActive && !isPaused && (
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <StatusBadge status={item.status} />
              {isFailed && item.error && (
                <p
                  className="text-[10px] text-red-500 line-clamp-2 max-w-[200px] cursor-help"
                  title={item.error}
                >
                  {item.error}
                </p>
              )}
              {isCompleted && item.completedAt && item.startedAt && (
                <span className="text-[10px] text-muted-foreground">
                  in {formatEta((item.completedAt - item.startedAt) / 1000)}
                </span>
              )}
              {isCompleted && (
                <span className="text-[10px] text-muted-foreground">
                  · {formatBytes(item.file.size)}
                </span>
              )}
              {/* Inline confirmation states */}
              {isCompleted && queueAction === "queued" && (
                <span className="text-[10px] text-green-600 dark:text-green-400 font-medium flex-shrink-0">
                  · Added to queue
                </span>
              )}
              {isCompleted && queueAction === "conflict" && (
                <span className="text-[10px] text-muted-foreground flex-shrink-0">
                  · Already in queue
                </span>
              )}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {isPending && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => uploadQueue.prioritize(item.id)}
              title="Move to front"
            >
              <ArrowUp size={11} />
            </Button>
          )}
          {isActive && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => uploadQueue.pause(item.id)}
              title="Pause"
            >
              <Pause size={11} />
            </Button>
          )}
          {isPaused && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-primary"
              onClick={() => uploadQueue.resume(item.id)}
              title="Resume"
            >
              <Play size={11} />
            </Button>
          )}
          {(isFailed || isCancelled) && (
            <Button
              variant={isFailed ? "destructive" : "ghost"}
              size="sm"
              className={cn(
                "h-6 text-[10px] px-2 gap-1",
                isFailed
                  ? "bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800"
                  : "text-muted-foreground",
              )}
              onClick={() => uploadQueue.retry(item.id)}
              title={isFailed ? "Retry this upload" : "Re-upload"}
            >
              <RefreshCw size={10} />
              {isFailed ? "Retry" : "Re-upload"}
            </Button>
          )}

          {/* Add to broadcast queue — only for completed items with a server-side videoId */}
          {isCompleted && item.videoId && queueAction === "idle" && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-primary"
              onClick={() => { void handleAddToQueue(); }}
              title="Add to broadcast queue"
            >
              <ListPlus size={11} />
            </Button>
          )}
          {isCompleted && item.videoId && queueAction === "loading" && (
            <Button variant="ghost" size="icon" className="h-6 w-6" disabled>
              <Loader2 size={11} className="animate-spin" />
            </Button>
          )}
          {isCompleted && item.videoId && queueAction === "queued" && (
            <Button variant="ghost" size="icon" className="h-6 w-6 text-green-500 cursor-default" disabled>
              <CheckCircle2 size={11} />
            </Button>
          )}

          {(isCompleted || isFailed || isCancelled || isPending || isPaused) && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              onClick={() => uploadQueue.dismiss(item.id)}
              title="Dismiss"
            >
              <X size={11} />
            </Button>
          )}
          {isActive && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-red-500"
              onClick={() => uploadQueue.cancel(item.id)}
              title="Cancel upload"
            >
              <X size={11} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function UploadQueuePanel() {
  const { items, summary } = useUploadQueue();
  const [collapsed, setCollapsed] = useState(false);
  const qc = useQueryClient();

  // Invalidate video library queries whenever a file completes
  // (register once; the callback is stable because uploadQueue is a module singleton)
  useEffect(() => {
    return uploadQueue.onComplete(() => {
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
    });
  }, [qc]);

  if (summary.total === 0) return null;

  const { active, pending, completed, failed, cancelled, paused, totalSpeed, networkOffline } = summary;
  const inFlight = active + pending + paused;
  const done = completed + failed + cancelled;

  // ── Header text ──────────────────────────────────────────────────────────
  let headerText: string;
  if (networkOffline && (active > 0 || paused > 0)) {
    headerText = "Network offline — uploads paused";
  } else if (active > 0) {
    headerText = `Uploading ${active} file${active > 1 ? "s" : ""}`;
    if (totalSpeed > 0) {
      headerText += ` · ${formatSpeed(totalSpeed)}`;
      // Aggregate ETA from size-weighted remaining bytes
      if (summary.totalBytes > summary.uploadedBytes) {
        const totalRemaining = summary.totalBytes - summary.uploadedBytes;
        const totalEta = totalRemaining / totalSpeed;
        const etaStr = formatEta(totalEta);
        if (etaStr) headerText += ` · ${etaStr}`;
      }
    }
  } else if (pending > 0) {
    headerText = `${pending} file${pending > 1 ? "s" : ""} queued`;
  } else if (paused > 0) {
    headerText = `${paused} paused`;
  } else if (failed > 0) {
    headerText = `${failed} failed`;
  } else {
    headerText = `${completed} upload${completed !== 1 ? "s" : ""} complete`;
  }

  // Size-weighted overall progress (0–100)
  const overallPct =
    summary.totalBytes > 0
      ? Math.min(100, (summary.uploadedBytes / summary.totalBytes) * 100)
      : 0;

  return (
    <div
      className={cn(
        "fixed bottom-4 right-4 z-50 w-80 rounded-xl border border-border bg-background/95 shadow-2xl backdrop-blur-sm",
        "transition-all duration-200",
      )}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none hover:bg-muted/40 rounded-t-xl transition-colors"
        onClick={() => setCollapsed((c) => !c)}
      >
        {networkOffline ? (
          <WifiOff size={14} className="flex-shrink-0 text-amber-500" />
        ) : (
          <UploadCloud
            size={14}
            className={cn("flex-shrink-0", active > 0 ? "text-primary" : "text-muted-foreground")}
          />
        )}
        <p
          className={cn(
            "text-xs font-semibold flex-1 truncate",
            networkOffline && "text-amber-600 dark:text-amber-400",
          )}
        >
          {headerText}
        </p>

        <div className="flex items-center gap-1">
          {active > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-1.5 text-muted-foreground"
              onClick={(e) => { e.stopPropagation(); uploadQueue.pauseAll(); }}
              title="Pause all uploads"
            >
              <Pause size={10} className="mr-0.5" />
              Pause
            </Button>
          )}
          {paused > 0 && active === 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-1.5 text-muted-foreground"
              onClick={(e) => { e.stopPropagation(); uploadQueue.resumeAll(); }}
              title="Resume all paused uploads"
            >
              <Play size={10} className="mr-0.5" />
              Resume
            </Button>
          )}
          {failed > 0 && active === 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-1.5 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
              onClick={(e) => { e.stopPropagation(); uploadQueue.retryAll(); }}
              title="Retry all failed uploads"
            >
              <RefreshCw size={10} className="mr-0.5" />
              Retry {failed > 1 ? `${failed} failed` : "failed"}
            </Button>
          )}
          {inFlight === 0 && done > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-1.5 text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation();
                uploadQueue.clearCompleted();
              }}
            >
              Clear
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c); }}
          >
            {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </Button>
        </div>
      </div>

      {/* Overall progress bar — size-weighted, shown while uploads are active */}
      {!collapsed && active > 0 && summary.totalBytes > 0 && (
        <div className="px-3 pb-1.5">
          <Progress value={overallPct} className="h-1" />
          <div className="flex justify-between mt-0.5">
            <span className="text-[9px] text-muted-foreground tabular-nums">
              {formatBytes(summary.uploadedBytes)} / {formatBytes(summary.totalBytes)}
            </span>
            <span className="text-[9px] text-muted-foreground tabular-nums">
              {Math.round(overallPct)}%
            </span>
          </div>
        </div>
      )}

      {/* Network-offline banner */}
      {!collapsed && networkOffline && (
        <div className="mx-3 mb-2 px-2.5 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 flex items-center gap-1.5">
          <WifiOff size={11} className="text-amber-500 flex-shrink-0" />
          <p className="text-[10px] text-amber-700 dark:text-amber-300">
            Uploads will resume automatically when connectivity is restored.
          </p>
        </div>
      )}

      {/* File list */}
      {!collapsed && (
        <div className="max-h-80 overflow-y-auto border-t border-border/50">
          {items.map((item) => (
            <UploadRow key={item.id} item={item} qc={qc} />
          ))}
        </div>
      )}

      {/* Footer actions (when all items are done) */}
      {!collapsed && inFlight === 0 && summary.total > 0 && (
        <div className="flex justify-between items-center px-3 py-2 border-t border-border/50">
          <span className="text-[10px] text-muted-foreground">
            {completed} completed{failed > 0 ? ` · ${failed} failed` : ""}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px] px-2 text-muted-foreground"
            onClick={() => uploadQueue.clearAll()}
          >
            Dismiss all
          </Button>
        </div>
      )}
    </div>
  );
}
