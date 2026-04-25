import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { processApi, type ProcessStatus } from "@/services/adminApi";
import {
  Server,
  Cpu,
  Activity,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from "lucide-react";

const POLL_MS = 10_000;

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatAge(sec: number): string {
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function formatDurationMs(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function ProcessStatusPanel() {
  const [status, setStatus] = useState<ProcessStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await processApi.getStatus(signal);
      setStatus(data);
      setError(null);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    void refresh(ctl.signal);
    const id = setInterval(() => void refresh(ctl.signal), POLL_MS);
    return () => {
      ctl.abort();
      clearInterval(id);
    };
  }, [refresh]);

  if (error && !status) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-amber-300 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          Process status unavailable: {error}
        </CardContent>
      </Card>
    );
  }

  if (!status) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Loading process status…
        </CardContent>
      </Card>
    );
  }

  const { thisProcess, transcoder } = status;
  const sameProcess = transcoder.heartbeat?.sameProcess ?? false;

  // Worker indicator color
  const workerHealth = !transcoder.heartbeat
    ? "muted"
    : transcoder.alive
      ? "ok"
      : "warn";

  const workerBadgeClass =
    workerHealth === "ok"
      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
      : workerHealth === "warn"
        ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
        : "bg-zinc-500/20 text-zinc-300 border-zinc-500/40";

  const workerLabel =
    workerHealth === "ok"
      ? "Alive"
      : workerHealth === "warn"
        ? "Stale"
        : "Unknown";

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* ── API process card ──────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm font-medium">
            <span className="flex items-center gap-2">
              <Server className="h-4 w-4 text-primary" />
              API Process
            </span>
            <Badge
              variant="outline"
              className="bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
            >
              {thisProcess.role === "api" ? "RUN_MODE=api" : `RUN_MODE=${thisProcess.runMode}`}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-xs text-muted-foreground">
          <Row label="PID" value={String(thisProcess.pid)} />
          <Row label="Uptime" value={formatUptime(thisProcess.uptimeSec)} />
          <Row label="RSS memory" value={`${thisProcess.rssMb} MB`} />
          <Row label="Heap used" value={`${thisProcess.heapUsedMb} MB`} />
          <Row label="Node" value={thisProcess.nodeVersion} />
        </CardContent>
      </Card>

      {/* ── Transcoder worker card ────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm font-medium">
            <span className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-primary" />
              Transcoder Worker
              {sameProcess && (
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  (co-located)
                </span>
              )}
            </span>
            <Badge variant="outline" className={workerBadgeClass}>
              {workerLabel}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-xs text-muted-foreground">
          {transcoder.heartbeat ? (
            <>
              <Row label="PID" value={String(transcoder.heartbeat.pid)} />
              <Row
                label="Last heartbeat"
                value={formatAge(transcoder.heartbeat.ageSec)}
                emphasis={
                  transcoder.heartbeat.ageSec >= 90 ? "warn" : undefined
                }
              />
              <Row
                label="RSS memory"
                value={`${transcoder.heartbeat.rssMb} MB`}
              />
              <Row label="Run mode" value={transcoder.heartbeat.runMode} />
            </>
          ) : (
            <div className="text-amber-300/80 flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5" />
              No worker heartbeat yet — worker process may be down or has not
              registered.
            </div>
          )}

          {/* Last finished job — confirms the worker is *doing* work,
              not just alive. Pulled from the most recent done/failed row. */}
          {transcoder.lastJob && (
            <div className="mt-2 pt-2 border-t border-border/50">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/80 mb-1">
                {transcoder.lastJob.status === "done" ? (
                  <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                ) : (
                  <XCircle className="h-3 w-3 text-red-400" />
                )}
                Last job
              </div>
              <div
                className="truncate text-foreground"
                title={transcoder.lastJob.videoTitle ?? transcoder.lastJob.videoId}
              >
                {transcoder.lastJob.videoTitle ?? `video ${transcoder.lastJob.videoId.slice(0, 8)}…`}
              </div>
              <div className="flex items-center justify-between mt-0.5 text-[11px]">
                <span className="text-muted-foreground/80">
                  {transcoder.lastJob.endedAgoSec !== null
                    ? formatAge(transcoder.lastJob.endedAgoSec)
                    : "—"}
                  {transcoder.lastJob.durationMs !== null && (
                    <> · took {formatDurationMs(transcoder.lastJob.durationMs)}</>
                  )}
                </span>
                <span
                  className={
                    transcoder.lastJob.status === "done"
                      ? "text-emerald-300"
                      : "text-red-300"
                  }
                >
                  {transcoder.lastJob.status}
                </span>
              </div>
              {transcoder.lastJob.status === "failed" &&
                transcoder.lastJob.errorMessage && (
                  <div
                    className="mt-1 text-[11px] text-red-300/80 truncate"
                    title={transcoder.lastJob.errorMessage}
                  >
                    {transcoder.lastJob.errorMessage}
                  </div>
                )}
            </div>
          )}

          {/* Queue depth — same data on both processes */}
          <div className="mt-2 pt-2 border-t border-border/50">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/80 mb-1">
              <Activity className="h-3 w-3" />
              Queue depth
            </div>
            <div className="grid grid-cols-4 gap-2 text-center">
              <QueueStat label="Queued" value={transcoder.queue.queued} />
              <QueueStat
                label="Active"
                value={transcoder.queue.processing}
                emphasis={transcoder.queue.processing > 0 ? "active" : undefined}
              />
              <QueueStat
                label="Failed"
                value={transcoder.queue.failed}
                emphasis={transcoder.queue.failed > 0 ? "warn" : undefined}
              />
              <QueueStat label="Done" value={transcoder.queue.done} />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: "warn";
}) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span
        className={
          emphasis === "warn"
            ? "font-mono text-amber-300"
            : "font-mono text-foreground"
        }
      >
        {value}
      </span>
    </div>
  );
}

function QueueStat({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number;
  emphasis?: "active" | "warn";
}) {
  const colorCls =
    emphasis === "active"
      ? "text-emerald-300"
      : emphasis === "warn"
        ? "text-amber-300"
        : "text-foreground";
  return (
    <div className="rounded-md bg-muted/30 py-1.5 px-1">
      <div className={`text-base font-semibold ${colorCls}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
        {label}
      </div>
    </div>
  );
}
