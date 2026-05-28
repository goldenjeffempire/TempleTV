import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { MetricCard } from "@/components/shared/metric-card";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer,
} from "@/lib/recharts-shim";
import {
  ScanSearch, Cpu, MemoryStick, Clock, Radio, Clapperboard,
  Activity, Users, RefreshCw, CheckCircle2, AlertTriangle,
  TrendingDown, TrendingUp, Server, Zap, HardDrive,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

interface ProcessInfo {
  pid: number;
  nodeVersion: string;
  runMode: string;
  uptimeS: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  checkedAt: string;
}

interface TranscoderStatus {
  heartbeat: {
    lastHeartbeatAt: number | null;
    currentJobId: string | null;
    currentJobVideoId: string | null;
    lastCompletedAt: number | null;
    lastCompletedJobId: string | null;
    lastCompletedStatus: "done" | "failed" | null;
    isRunning: boolean;
    ffmpegAvailable: boolean;
  };
  queue: {
    queued: number;
    processing: number;
    done: number;
    failed: number;
  };
  viewerSlope: {
    degraded: boolean;
    degradedSince: number | null;
    consecutiveDrops: number;
    viewerDeltaPerMin: number | null;
    samples: Array<{ ts: number; count: number }>;
    checkedAt: string;
  };
  checkedAt: string;
}

interface BroadcastHealth {
  ok: boolean;
  stuck: boolean;
  channelId: string;
  sequence: number;
  mode: string;
  hasCurrent: boolean;
  currentTitle: string | null;
  nextTitle: string | null;
  currentDurationSecs: number | null;
  currentElapsedSecs: number | null;
  itemCount: number;
  uptimeMs: number;
  deadAir: boolean;
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
  skipInfo: {
    consecutiveSkips: number;
    deadAirDetected: boolean;
  } | null;
}

interface StreamHealthMetrics {
  windowMs: number;
  totalStalls: number;
  totalErrors: number;
  avgBufferedSecs: number | null;
  avgBitrateKbps: number | null;
  activeSessions: number;
  platformBreakdown: Record<string, number>;
  startupMs: {
    p50: number | null;
    p95: number | null;
    avg: number | null;
    sampleCount: number;
  };
  bufferHealthPct: number | null;
  stallsPerSession: number | null;
  checkedAt: string;
}

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function StatusPill({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <Badge
      className={cn(
        "text-[10px] font-semibold px-2 py-0.5",
        ok
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25"
          : "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/25",
      )}
    >
      {label ?? (ok ? "Healthy" : "Degraded")}
    </Badge>
  );
}

function MemoryGauge({ usedMb, totalMb, label }: { usedMb: number; totalMb: number; label: string }) {
  const pct = totalMb > 0 ? Math.min(100, Math.round((usedMb / totalMb) * 100)) : 0;
  const color = pct > 85 ? "bg-red-500" : pct > 65 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{usedMb.toFixed(1)} / {totalMb.toFixed(1)} MB ({pct}%)</span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function ViewerSparkline({ samples }: { samples: Array<{ ts: number; count: number }> }) {
  if (samples.length < 2) {
    return (
      <div className="flex items-center justify-center h-20 text-xs text-muted-foreground">
        Collecting samples… (updates every minute)
      </div>
    );
  }
  const data = samples.map((s) => ({
    time: new Date(s.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    viewers: s.count,
  }));
  const min = Math.max(0, Math.min(...data.map((d) => d.viewers)) - 2);
  const max = Math.max(...data.map((d) => d.viewers)) + 2;
  return (
    <ResponsiveContainer width="100%" height={80}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="viewerGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="time" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
        <YAxis domain={[min, max]} tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
        <RechartsTooltip
          contentStyle={{ fontSize: 11, borderRadius: 6, padding: "4px 10px" }}
          formatter={(v: number) => [v, "Viewers"]}
        />
        <Area
          type="monotone"
          dataKey="viewers"
          stroke="#6366f1"
          strokeWidth={2}
          fill="url(#viewerGrad)"
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function SectionSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

export default function DiagnosticsPage() {
  const POLL_MS = 15_000;
  const SLOW_POLL_MS = 30_000;

  const procQuery = useQuery<ProcessInfo>({
    queryKey: ["diagnostics", "process-info"],
    queryFn: () => api.get("/api/v1/admin/process-info"),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
    retry: false,
  });

  const transcoderQuery = useQuery<TranscoderStatus>({
    queryKey: ["diagnostics", "transcoder-status"],
    queryFn: () => api.get("/api/v1/admin/transcoder-status"),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
    retry: false,
  });

  const broadcastQuery = useQuery<BroadcastHealth>({
    queryKey: ["diagnostics", "broadcast-health"],
    queryFn: () => api.get("/api/broadcast-v2/health"),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
    retry: false,
  });

  const streamHealthQuery = useQuery<StreamHealthMetrics>({
    queryKey: ["diagnostics", "stream-health"],
    queryFn: () => api.get("/api/v1/admin/stream-health/metrics"),
    refetchInterval: SLOW_POLL_MS,
    staleTime: SLOW_POLL_MS,
    retry: false,
  });

  const isRefreshing =
    procQuery.isFetching ||
    transcoderQuery.isFetching ||
    broadcastQuery.isFetching ||
    streamHealthQuery.isFetching;

  function refetchAll() {
    void procQuery.refetch();
    void transcoderQuery.refetch();
    void broadcastQuery.refetch();
    void streamHealthQuery.refetch();
  }

  const proc = procQuery.data;
  const tx = transcoderQuery.data;
  const bcast = broadcastQuery.data;
  const sh = streamHealthQuery.data;

  const viewerSamples = tx?.viewerSlope.samples ?? [];

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <PageHeader
        title="Diagnostics"
        description="Real-time process health, transcoder state, broadcast engine status, and stream quality."
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={refetchAll}
            disabled={isRefreshing}
            className="gap-2"
          >
            <RefreshCw size={13} className={isRefreshing ? "animate-spin" : ""} />
            Refresh
          </Button>
        }
      />

      {(procQuery.error && !proc) && (
        <ErrorAlert
          title="Process info unavailable"
          message={procQuery.error instanceof Error ? procQuery.error.message : "Request failed"}
        />
      )}

      {/* ── Process Memory & CPU ────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground/70">
          Process · Memory &amp; CPU
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricCard
            title="RSS Memory"
            value={proc ? `${proc.rssMb.toFixed(1)} MB` : null}
            icon={<MemoryStick size={14} />}
            subtitle="Resident set size"
            loading={procQuery.isLoading}
            highlight={proc && proc.rssMb > 450 ? "danger" : proc && proc.rssMb > 300 ? "warning" : undefined}
          />
          <MetricCard
            title="Heap Used"
            value={proc ? `${proc.heapUsedMb.toFixed(1)} MB` : null}
            icon={<HardDrive size={14} />}
            subtitle={proc ? `of ${proc.heapTotalMb.toFixed(1)} MB total` : "heap"}
            loading={procQuery.isLoading}
            highlight={proc && proc.heapUsedMb / proc.heapTotalMb > 0.85 ? "danger" : undefined}
          />
          <MetricCard
            title="CPU User Time"
            value={proc ? fmtMs(proc.cpuUserMs) : null}
            icon={<Cpu size={14} />}
            subtitle={proc ? `+${fmtMs(proc.cpuSystemMs)} system` : "accumulated"}
            loading={procQuery.isLoading}
          />
          <MetricCard
            title="Process Uptime"
            value={proc ? fmtUptime(proc.uptimeS) : null}
            icon={<Clock size={14} />}
            subtitle={proc ? `PID ${proc.pid} · ${proc.nodeVersion}` : ""}
            loading={procQuery.isLoading}
          />
        </div>

        {proc && (
          <Card>
            <CardContent className="pt-4 space-y-3">
              <MemoryGauge usedMb={proc.heapUsedMb} totalMb={proc.heapTotalMb} label="V8 Heap" />
              <MemoryGauge usedMb={proc.rssMb} totalMb={512} label="RSS (vs 512 MB limit)" />
            </CardContent>
          </Card>
        )}
        {procQuery.isLoading && <SectionSkeleton />}
      </section>

      {/* ── Broadcast Engine ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground/70">
          Broadcast Engine
        </h2>
        {broadcastQuery.isLoading ? (
          <SectionSkeleton />
        ) : bcast ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Card className={cn(
              bcast.stuck || bcast.deadAir
                ? "border-red-200 bg-red-50/50 dark:bg-red-950/20 dark:border-red-900/50"
                : bcast.ok
                  ? "border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20 dark:border-emerald-900/50"
                  : "",
            )}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Radio size={14} className="text-muted-foreground" />
                    Engine Health
                  </CardTitle>
                  <StatusPill ok={bcast.ok && !bcast.stuck && !bcast.deadAir} />
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Mode</span>
                  <span className="font-mono text-xs">{bcast.mode}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Sequence</span>
                  <span className="font-mono text-xs font-semibold">#{bcast.sequence}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Queue depth</span>
                  <span className="font-mono text-xs">{bcast.itemCount} items</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Uptime</span>
                  <span className="font-mono text-xs">{fmtMs(bcast.uptimeMs)}</span>
                </div>
                {bcast.currentTitle && (
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground shrink-0">On air</span>
                    <span className="text-xs text-right truncate max-w-[160px]" title={bcast.currentTitle}>
                      {bcast.currentTitle}
                    </span>
                  </div>
                )}
                {bcast.stuck && (
                  <div className="flex items-center gap-1.5 text-red-600 dark:text-red-400 text-xs pt-1">
                    <AlertTriangle size={11} />
                    Orchestrator appears stuck (sequence not advancing)
                  </div>
                )}
                {bcast.deadAir && !bcast.stuck && (
                  <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 text-xs pt-1">
                    <AlertTriangle size={11} />
                    Dead air — nothing on air despite items in queue
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Zap size={14} className="text-muted-foreground" />
                  Boot &amp; Reload
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Started</span>
                  <StatusPill ok={bcast.boot.started} label={bcast.boot.started ? "Yes" : "No"} />
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Bus bridge</span>
                  <StatusPill
                    ok={bcast.boot.busBridgeInstalled}
                    label={bcast.boot.busBridgeInstalled ? "Installed" : "Missing"}
                  />
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Start attempts</span>
                  <span className="font-mono text-xs">{bcast.boot.startAttempts}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Reload success rate</span>
                  <span className="font-mono text-xs">
                    {bcast.reload.successes} / {bcast.reload.attempts}
                  </span>
                </div>
                {bcast.reload.lastReloadAtMs && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Last reload</span>
                    <span className="text-xs">
                      {formatDistanceToNow(new Date(bcast.reload.lastReloadAtMs), { addSuffix: true })}
                    </span>
                  </div>
                )}
                {bcast.skipInfo && bcast.skipInfo.consecutiveSkips > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Consecutive skips</span>
                    <span
                      className={cn(
                        "font-mono text-xs font-semibold",
                        bcast.skipInfo.consecutiveSkips >= 2 ? "text-red-500" : "text-amber-500",
                      )}
                    >
                      {bcast.skipInfo.consecutiveSkips}
                    </span>
                  </div>
                )}
                {bcast.skipInfo?.deadAirDetected && (
                  <div className="flex items-center gap-1.5 text-red-600 dark:text-red-400 text-xs pt-1">
                    <AlertTriangle size={11} />
                    Dead air detected (≥2 consecutive skips)
                  </div>
                )}
                {bcast.boot.lastStartError && (
                  <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded p-2 font-mono break-all mt-1">
                    {bcast.boot.lastStartError}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : (
          <ErrorAlert
            title="Broadcast health unavailable"
            message="Could not reach the broadcast engine health endpoint."
          />
        )}
      </section>

      {/* ── Viewer Count Sparkline ──────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground/70">
          Viewer Count · Trend
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Card className="sm:col-span-2">
            <CardHeader className="pb-1">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Users size={14} className="text-muted-foreground" />
                  Viewer Count (last {viewerSamples.length} samples)
                </CardTitle>
                {tx?.viewerSlope.degraded ? (
                  <Badge className="text-[10px] bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/25 gap-1">
                    <TrendingDown size={9} />
                    Degraded
                  </Badge>
                ) : (
                  <Badge className="text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25 gap-1">
                    <TrendingUp size={9} />
                    Normal
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="pt-1">
              {transcoderQuery.isLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : (
                <ViewerSparkline samples={viewerSamples} />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity size={14} className="text-muted-foreground" />
                Slope Health
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {transcoderQuery.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : tx ? (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Status</span>
                    <StatusPill ok={!tx.viewerSlope.degraded} label={tx.viewerSlope.degraded ? "Degraded" : "OK"} />
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Δ viewers/min</span>
                    <span
                      className={cn(
                        "font-mono text-xs font-semibold",
                        tx.viewerSlope.viewerDeltaPerMin !== null && tx.viewerSlope.viewerDeltaPerMin < -30
                          ? "text-red-500"
                          : "",
                      )}
                    >
                      {tx.viewerSlope.viewerDeltaPerMin !== null
                        ? `${tx.viewerSlope.viewerDeltaPerMin > 0 ? "+" : ""}${tx.viewerSlope.viewerDeltaPerMin}`
                        : "—"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Consec. drops</span>
                    <span
                      className={cn(
                        "font-mono text-xs",
                        tx.viewerSlope.consecutiveDrops >= 3 ? "text-red-500 font-semibold" : "",
                      )}
                    >
                      {tx.viewerSlope.consecutiveDrops}
                    </span>
                  </div>
                  {tx.viewerSlope.degradedSince && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Degraded since</span>
                      <span className="text-xs">
                        {formatDistanceToNow(new Date(tx.viewerSlope.degradedSince), { addSuffix: true })}
                      </span>
                    </div>
                  )}
                </>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ── Transcoder ─────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground/70">
          Transcoder
        </h2>
        {transcoderQuery.isLoading ? (
          <SectionSkeleton />
        ) : tx ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCard
              title="FFmpeg"
              value={tx.heartbeat.ffmpegAvailable ? "Available" : "Missing"}
              icon={<Clapperboard size={14} />}
              highlight={tx.heartbeat.ffmpegAvailable ? "success" : "danger"}
              subtitle={tx.heartbeat.isRunning ? "Dispatching" : "Idle"}
            />
            <MetricCard
              title="In Queue"
              value={tx.queue.queued}
              icon={<Server size={14} />}
              subtitle={`${tx.queue.processing} processing`}
              highlight={tx.queue.queued > 10 ? "warning" : undefined}
            />
            <MetricCard
              title="Done Today"
              value={tx.queue.done}
              icon={<CheckCircle2 size={14} />}
              subtitle="completed jobs"
              highlight={tx.queue.done > 0 ? "success" : undefined}
            />
            <MetricCard
              title="Failed Today"
              value={tx.queue.failed}
              icon={<AlertTriangle size={14} />}
              highlight={tx.queue.failed > 0 ? "danger" : undefined}
              subtitle="failed jobs"
            />

            {tx.heartbeat.currentJobId && (
              <Card className="col-span-2 sm:col-span-4 border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-900/50">
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 text-sm font-medium">
                    <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                    Transcoding in progress
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 font-mono">
                    Job: {tx.heartbeat.currentJobId} · Video: {tx.heartbeat.currentJobVideoId}
                  </p>
                </CardContent>
              </Card>
            )}

            {tx.heartbeat.lastCompletedJobId && !tx.heartbeat.currentJobId && (
              <Card className="col-span-2 sm:col-span-4">
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-center gap-2 text-sm">
                    {tx.heartbeat.lastCompletedStatus === "done" ? (
                      <CheckCircle2 size={13} className="text-emerald-500" />
                    ) : (
                      <AlertTriangle size={13} className="text-red-500" />
                    )}
                    <span className="font-medium">
                      Last job{" "}
                      <span
                        className={
                          tx.heartbeat.lastCompletedStatus === "done"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        }
                      >
                        {tx.heartbeat.lastCompletedStatus}
                      </span>
                    </span>
                    {tx.heartbeat.lastCompletedAt && (
                      <span className="text-xs text-muted-foreground ml-auto">
                        {formatDistanceToNow(new Date(tx.heartbeat.lastCompletedAt), { addSuffix: true })}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 font-mono">
                    {tx.heartbeat.lastCompletedJobId}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        ) : (
          <ErrorAlert
            title="Transcoder status unavailable"
            message={transcoderQuery.error instanceof Error ? transcoderQuery.error.message : "Request failed"}
          />
        )}
      </section>

      {/* ── Stream Health (telemetry window) ───────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground/70">
          Stream Health · 5-min Window
        </h2>
        {streamHealthQuery.isLoading ? (
          <SectionSkeleton />
        ) : sh ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <MetricCard
                title="Active Sessions"
                value={sh.activeSessions}
                icon={<Users size={14} />}
                highlight={sh.activeSessions > 0 ? "success" : undefined}
                subtitle="in last 2 min"
              />
              <MetricCard
                title="Stalls"
                value={sh.totalStalls}
                icon={<AlertTriangle size={14} />}
                highlight={sh.totalStalls > 10 ? "danger" : sh.totalStalls > 3 ? "warning" : undefined}
                subtitle="in window"
              />
              <MetricCard
                title="Avg Bitrate"
                value={sh.avgBitrateKbps ? `${sh.avgBitrateKbps} kbps` : "—"}
                icon={<Activity size={14} />}
                subtitle="adaptive quality"
              />
              <MetricCard
                title="Buffer Health"
                value={sh.bufferHealthPct !== null ? `${sh.bufferHealthPct}%` : "—"}
                icon={<Radio size={14} />}
                highlight={
                  sh.bufferHealthPct !== null
                    ? sh.bufferHealthPct < 50
                      ? "danger"
                      : sh.bufferHealthPct < 75
                        ? "warning"
                        : "success"
                    : undefined
                }
                subtitle="samples >10s buffered"
              />
            </div>

            <Card>
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Startup latency</span>
                  <span className="text-xs text-muted-foreground">{sh.startupMs.sampleCount} samples</span>
                </div>
                <div className="grid grid-cols-3 gap-3 text-center">
                  {[
                    { label: "P50", value: sh.startupMs.p50 },
                    { label: "P95", value: sh.startupMs.p95 },
                    { label: "Avg", value: sh.startupMs.avg },
                  ].map(({ label, value }) => (
                    <div key={label} className="rounded-md bg-muted/50 p-2">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
                      <p className="text-base font-bold mt-0.5">
                        {value !== null ? `${value} ms` : "—"}
                      </p>
                    </div>
                  ))}
                </div>

                {Object.keys(sh.platformBreakdown).length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-2">Platform breakdown</p>
                    <div className="space-y-1.5">
                      {Object.entries(sh.platformBreakdown).map(([platform, count]) => {
                        const total = Object.values(sh.platformBreakdown).reduce((a, b) => a + b, 0);
                        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                        return (
                          <div key={platform} className="space-y-0.5">
                            <div className="flex justify-between text-xs">
                              <span className="capitalize">{platform}</span>
                              <span className="text-muted-foreground">{count} ({pct}%)</span>
                            </div>
                            <Progress value={pct} className="h-1.5" />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : (
          <ErrorAlert
            title="Stream health unavailable"
            message="Telemetry window is empty — this refills as clients connect and stream."
          />
        )}
      </section>

      {/* Footer */}
      <p className="text-[11px] text-muted-foreground text-right">
        Polls every {POLL_MS / 1000}s · Last refreshed:{" "}
        {procQuery.dataUpdatedAt
          ? formatDistanceToNow(new Date(procQuery.dataUpdatedAt), { addSuffix: true })
          : "—"}
      </p>
    </div>
  );
}
