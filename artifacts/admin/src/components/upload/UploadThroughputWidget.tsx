/**
 * UploadThroughputWidget
 *
 * Real-time dashboard card showing:
 *   • Current aggregate throughput (MB/s) with a 60-second SVG sparkline
 *   • Per-file speed bars for every active upload
 *   • Slot utilization dots (active / MAX_CONCURRENT_FILES)
 *   • Size-weighted overall progress bar + ETA
 *   • Offline / paused / idle states
 *
 * Mounts on the Dashboard page. Hides completely when no uploads are
 * active or pending so it doesn't clutter the idle dashboard.
 */

import { useRef, useEffect, useMemo, useCallback } from "react";
import { Link } from "wouter";
import {
  useUploadQueue,
  formatBytes,
  formatSpeed,
  formatEta,
  UPLOAD_MAX_CONCURRENT_FILES,
  type UploadItem,
} from "@/lib/upload-queue";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  UploadCloud,
  WifiOff,
  Pause,
  Clock,
  Loader2,
  CheckCircle2,
  ArrowRight,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Sparkline ────────────────────────────────────────────────────────────────

const SPARK_SAMPLES = 60; // 60 × 1 s = 60-second window

function Sparkline({ samples }: { samples: number[] }) {
  if (samples.length < 2) return null;
  const w = 120;
  const h = 32;
  const pad = 2;
  const max = Math.max(...samples, 1);
  const pts = samples.map((v, i) => {
    const x = pad + (i / (samples.length - 1)) * (w - pad * 2);
    const y = h - pad - (v / max) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const d = `M ${pts.join(" L ")}`;
  // Area fill
  const areaD = `M ${pts[0]} L ${pts.join(" L ")} L ${(w - pad).toFixed(1)},${h - pad} L ${pad},${h - pad} Z`;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="overflow-visible"
      aria-hidden
    >
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.25" />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#spark-fill)" />
      <path d={d} fill="none" stroke="hsl(var(--primary))" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ── Slot utilization dots ────────────────────────────────────────────────────

function SlotDots({ active, pending, total }: { active: number; pending: number; total: number }) {
  return (
    <div className="flex items-center gap-[3px] flex-wrap" aria-label={`${active} of ${total} upload slots active`}>
      {Array.from({ length: total }).map((_, i) => {
        const isActive = i < active;
        const isPending = !isActive && i < active + pending;
        return (
          <div
            key={i}
            className={cn(
              "w-2 h-2 rounded-full transition-colors duration-300",
              isActive
                ? "bg-primary"
                : isPending
                ? "bg-primary/30"
                : "bg-muted-foreground/15",
            )}
          />
        );
      })}
    </div>
  );
}

// ── Per-file row ─────────────────────────────────────────────────────────────

function FileRow({ item }: { item: UploadItem }) {
  const isAssembling = item.status === "finalizing" && (item.assemblyPercent ?? 0) > 0;
  const pct = isAssembling
    ? 90 + Math.round(((item.assemblyPercent ?? 0) / 99) * 9)
    : item.progress;

  const statusColor =
    item.status === "uploading" ? "text-primary" :
    item.status === "finalizing" ? "text-amber-500" :
    item.status === "paused" ? "text-muted-foreground" :
    item.status === "failed" ? "text-destructive" :
    "text-muted-foreground";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {item.status === "uploading" || item.status === "finalizing" ? (
            <Loader2 size={11} className={cn("shrink-0 animate-spin", statusColor)} />
          ) : item.status === "paused" ? (
            <Pause size={11} className="shrink-0 text-muted-foreground" />
          ) : item.status === "pending" ? (
            <Clock size={11} className="shrink-0 text-muted-foreground" />
          ) : (
            <CheckCircle2 size={11} className="shrink-0 text-green-500" />
          )}
          <span className="text-xs truncate min-w-0 text-foreground/80" title={item.title}>
            {item.title}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {item.status === "uploading" && item.speed > 0 && (
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {formatSpeed(item.speed)}
            </span>
          )}
          {item.status === "finalizing" && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">
              {isAssembling ? `Assembling ${item.assemblyPercent}%` : "Finalizing…"}
            </span>
          )}
          {item.status === "paused" && (
            <span className="text-[10px] text-muted-foreground">Paused</span>
          )}
          {item.status === "pending" && (
            <span className="text-[10px] text-muted-foreground">Queued</span>
          )}
          <span className="text-[10px] tabular-nums text-muted-foreground/60">
            {pct}%
          </span>
        </div>
      </div>
      <Progress
        value={pct}
        className={cn(
          "h-1",
          item.status === "finalizing" ? "[&>div]:bg-amber-500" :
          item.status === "paused" ? "[&>div]:bg-muted-foreground/40" :
          item.status === "pending" ? "[&>div]:bg-muted-foreground/20" : "",
        )}
      />
    </div>
  );
}

// ── Main widget ──────────────────────────────────────────────────────────────

export function UploadThroughputWidget() {
  const { items, summary } = useUploadQueue();

  // ── Throughput history (1 sample/second, rolling 60 s window) ─────────────
  const speedHistory = useRef<number[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sampleSpeed = useCallback(() => {
    const history = speedHistory.current;
    history.push(summary.totalSpeed);
    if (history.length > SPARK_SAMPLES) history.shift();
  }, [summary.totalSpeed]);

  useEffect(() => {
    if (summary.hasActive) {
      if (!tickRef.current) {
        tickRef.current = setInterval(() => sampleSpeed(), 1_000);
        sampleSpeed();
      }
    } else {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      speedHistory.current = [];
    }
    return () => {};
  }, [summary.hasActive, sampleSpeed]);

  // Also update the last sample immediately on speed changes
  useEffect(() => {
    if (summary.hasActive && speedHistory.current.length > 0) {
      speedHistory.current[speedHistory.current.length - 1] = summary.totalSpeed;
    }
  }, [summary.totalSpeed, summary.hasActive]);

  // ── Derived values ────────────────────────────────────────────────────────
  const activeItems = useMemo(
    () => items.filter((i) => i.status === "uploading" || i.status === "finalizing"),
    [items],
  );
  const pendingItems = useMemo(
    () => items.filter((i) => i.status === "pending"),
    [items],
  );
  const pausedItems = useMemo(
    () => items.filter((i) => i.status === "paused"),
    [items],
  );

  // All items visible in the widget (active first, then pending up to 3 total)
  const visibleItems = useMemo(() => {
    const active = items.filter(
      (i) => i.status === "uploading" || i.status === "finalizing",
    );
    const pending = items.filter((i) => i.status === "pending").slice(0, Math.max(0, 5 - active.length));
    return [...active, ...pending];
  }, [items]);

  const overallPct =
    summary.totalBytes > 0
      ? Math.min(99, Math.round((summary.uploadedBytes / summary.totalBytes) * 100))
      : 0;

  // Aggregate ETA: remaining bytes at current total speed
  const remainingBytes = summary.totalBytes - summary.uploadedBytes;
  const etaSecs =
    summary.totalSpeed > 0 && remainingBytes > 0
      ? Math.round(remainingBytes / summary.totalSpeed)
      : 0;

  // Hide entirely when nothing is happening
  if (!summary.hasActive && summary.paused === 0 && summary.pending === 0) {
    return null;
  }

  const hasUploading = activeItems.length > 0;
  const allPaused = !hasUploading && pausedItems.length > 0;

  return (
    <Card className={cn(
      "transition-colors",
      summary.networkOffline && "border-amber-500/40 bg-amber-500/5",
      allPaused && "border-muted-foreground/20",
    )}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            {summary.networkOffline ? (
              <WifiOff size={15} className="text-amber-500" />
            ) : hasUploading ? (
              <UploadCloud size={15} className="text-primary" />
            ) : (
              <UploadCloud size={15} className="text-muted-foreground" />
            )}
            Upload Activity
            {summary.networkOffline && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-amber-500/50 text-amber-600 dark:text-amber-400">
                Offline
              </Badge>
            )}
            {allPaused && !summary.networkOffline && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground">
                Paused
              </Badge>
            )}
          </span>
          <Link href="/videos">
            <Button variant="ghost" size="sm" className="h-6 text-xs">
              Library <ArrowRight size={12} className="ml-1" />
            </Button>
          </Link>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* ── Top row: throughput number + sparkline + slot dots ─────────── */}
        <div className="flex items-start justify-between gap-4">
          {/* Left: big throughput number */}
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className={cn(
                "text-2xl font-bold tabular-nums",
                hasUploading && summary.totalSpeed > 0 ? "text-foreground" : "text-muted-foreground/50",
              )}>
                {hasUploading && summary.totalSpeed > 0
                  ? (summary.totalSpeed / (1024 * 1024)).toFixed(1)
                  : "—"}
              </span>
              {hasUploading && summary.totalSpeed > 0 && (
                <span className="text-xs text-muted-foreground font-medium">MB/s</span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {hasUploading && summary.totalSpeed > 0
                ? `${formatSpeed(summary.totalSpeed)} total`
                : allPaused
                ? "All uploads paused"
                : "Awaiting upload"}
            </p>

            {/* Slot utilization */}
            <div className="mt-2 space-y-1">
              <SlotDots
                active={activeItems.length}
                pending={pendingItems.length}
                total={UPLOAD_MAX_CONCURRENT_FILES}
              />
              <p className="text-[10px] text-muted-foreground">
                {activeItems.length}/{UPLOAD_MAX_CONCURRENT_FILES} slots
                {pendingItems.length > 0 && ` · ${pendingItems.length} pending`}
              </p>
            </div>
          </div>

          {/* Right: sparkline */}
          <div className="shrink-0 flex flex-col items-end gap-1">
            <Sparkline samples={speedHistory.current.slice()} />
            <p className="text-[10px] text-muted-foreground/50">60s history</p>
          </div>
        </div>

        {/* ── Overall progress ────────────────────────────────────────────── */}
        {summary.totalBytes > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {formatBytes(summary.uploadedBytes)} / {formatBytes(summary.totalBytes)}
              </span>
              <div className="flex items-center gap-2">
                {etaSecs > 0 && hasUploading && (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Clock size={10} />
                    {formatEta(etaSecs)} remaining
                  </span>
                )}
                <span className="font-medium tabular-nums">{overallPct}%</span>
              </div>
            </div>
            <Progress value={overallPct} className="h-1.5" />
          </div>
        )}

        {/* ── Per-file rows ───────────────────────────────────────────────── */}
        {visibleItems.length > 0 && (
          <div className="space-y-2.5 pt-0.5">
            {visibleItems.map((item) => (
              <FileRow key={item.id} item={item} />
            ))}
            {/* Overflow indicator */}
            {items.filter(
              (i) =>
                i.status === "uploading" ||
                i.status === "finalizing" ||
                i.status === "pending",
            ).length > visibleItems.length && (
              <p className="text-[11px] text-muted-foreground/60 text-center pt-0.5">
                +{
                  items.filter(
                    (i) =>
                      i.status === "uploading" ||
                      i.status === "finalizing" ||
                      i.status === "pending",
                  ).length - visibleItems.length
                } more in queue — see upload panel
              </p>
            )}
          </div>
        )}

        {/* ── Status row ─────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground border-t border-border/50 pt-2.5">
          {summary.completed > 0 && (
            <span className="flex items-center gap-1">
              <CheckCircle2 size={10} className="text-green-500" />
              {summary.completed} done
            </span>
          )}
          {summary.failed > 0 && (
            <span className="flex items-center gap-1 text-destructive">
              {summary.failed} failed
            </span>
          )}
          {summary.paused > 0 && (
            <span className="flex items-center gap-1">
              <Pause size={10} />
              {summary.paused} paused
            </span>
          )}
          {hasUploading && summary.totalSpeed > 0 && (
            <span className="flex items-center gap-1 ml-auto">
              <Zap size={10} className="text-primary" />
              {activeItems.length} file{activeItems.length !== 1 ? "s" : ""} uploading
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
