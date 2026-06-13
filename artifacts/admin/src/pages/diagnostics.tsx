import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
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
  Cpu, MemoryStick, Clock, Radio, Clapperboard,
  Activity, Users, RefreshCw, CheckCircle2, AlertTriangle,
  TrendingDown, TrendingUp, Server, Zap, HardDrive, Database,
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
    stopped: boolean;
    storageCircuitOpenUntil: number;
    storageErrorStreak: number;
    circuitOpen: boolean;
    circuitOpenRemainingMs: number | null;
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

interface MemoryDiagnostics {
  generatedAt: string;
  uptimeSecs: number;
  memory: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    externalMb: number;
    arrayBuffersMb: number;
  };
  caches: Array<{ name: string; size: number; peak: number }>;
  memorySamples: Array<{ ts: number; heapUsedMb: number; externalMb: number }>;
  heapSpaces: Array<{ spaceName: string; spaceUsedSizeMb: number; spaceSizeMb: number }>;
  watchdog: {
    enabled: boolean;
    sampleIntervalMs: number;
    thresholds: {
      rssAlertMb: number;
      externalGrowthAlertMbPerMin: number;
      heapUsedGrowthAlertMbPerMin: number;
    };
    current: {
      rssMb: number;
      externalGrowthMbPerMin: number | null;
      consecutiveSlopeOver: number;
      heapUsedGrowthMbPerMin: number | null;
      consecutiveHeapOver: number;
    };
    alerts: {
      rssAlertActive: boolean;
      slopeAlertActive: boolean;
      heapUsedAlertActive: boolean;
    };
  };
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
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
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

function MemoryHistorySection() {
  const { data, isLoading, isError } = useQuery<MemoryDiagnostics>({
    queryKey: ["diagnostics", "memory"],
    queryFn: () => api.get<MemoryDiagnostics>("/admin/diagnostics/memory"),
    staleTime: 30_000,
    retry: 1,
    retryDelay: 5_000,
  });

  if (isLoading) {
    return (
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground/70">
          Memory History
        </h2>
        <SectionSkeleton />
      </section>
    );
  }

  if (isError) return null;

  const samples = data?.memorySamples ?? [];
  if (samples.length < 2) return null;

  const spanMin = Math.round(
    ((samples[samples.length - 1]?.ts ?? 0) - (samples[0]?.ts ?? 0)) / 60_000,
  );

  const recent = [...samples].reverse().slice(0, 12);

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground/70">
        Memory History
      </h2>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity size={14} className="text-muted-foreground" />
            Heap + External — Last {spanMin} min
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          <ResponsiveContainer width="100%" height={140}>
            <AreaChart data={samples} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="mhHeapGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="mhExtGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(38 92% 50%)" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="hsl(38 92% 50%)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="ts"
                tickFormatter={(v: number) =>
                  new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                }
                tick={{ fontSize: 9 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fontSize: 9 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => `${v}MB`}
                width={40}
              />
              <RechartsTooltip
                formatter={(value: number, name: string) => [
                  `${(value as number).toFixed(1)} MB`,
                  name === "heapUsedMb" ? "JS Heap" : "Native (external)",
                ]}
                labelFormatter={(ts: number) => new Date(ts).toLocaleTimeString()}
                contentStyle={{ fontSize: 11 }}
              />
              <Area
                type="monotone"
                dataKey="heapUsedMb"
                stroke="hsl(var(--primary))"
                fill="url(#mhHeapGrad)"
                strokeWidth={1.5}
                dot={false}
              />
              <Area
                type="monotone"
                dataKey="externalMb"
                stroke="hsl(38 92% 50%)"
                fill="url(#mhExtGrad)"
                strokeWidth={1.5}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
          <div className="flex gap-4 justify-end">
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="inline-block w-3 h-0.5 bg-primary rounded" />
              JS Heap
            </span>
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="inline-block w-3 h-0.5 bg-amber-500 rounded" />
              Native (ext)
            </span>
          </div>

          {/* Recent samples table */}
          <div className="border rounded-md overflow-hidden">
            <div className="grid grid-cols-3 bg-muted/40 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <span>Time</span>
              <span className="text-right">JS Heap</span>
              <span className="text-right">Native (ext)</span>
            </div>
            <div className="divide-y divide-border/40">
              {recent.map((s) => (
                <div
                  key={s.ts}
                  className="grid grid-cols-3 px-3 py-1.5 text-[11px] font-mono"
                >
                  <span className="text-muted-foreground">
                    {new Date(s.ts).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span className="text-right">{s.heapUsedMb.toFixed(1)} MB</span>
                  <span className="text-right text-amber-600 dark:text-amber-400">
                    {s.externalMb.toFixed(1)} MB
                  </span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

export default function DiagnosticsPage() {
  const POLL_MS = 15_000;
  const SLOW_POLL_MS = 30_000;

  const procQuery = useQuery<ProcessInfo>({
    queryKey: ["diagnostics", "process-info"],
    queryFn: () => api.get("/admin/process-info"),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
    retry: false,
  });

  const transcoderQuery = useQuery<TranscoderStatus>({
    queryKey: ["diagnostics", "transcoder-status"],
    queryFn: () => api.get("/admin/transcoder-status"),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
    retry: false,
  });

  const broadcastQuery = useQuery<BroadcastHealth>({
    queryKey: ["diagnostics", "broadcast-health"],
    queryFn: () => api.get("/broadcast-v2/health"),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
    retry: false,
  });

  const streamHealthQuery = useQuery<StreamHealthMetrics>({
    queryKey: ["diagnostics", "stream-health"],
    queryFn: () => api.get("/admin/stream-health/metrics"),
    refetchInterval: SLOW_POLL_MS,
    staleTime: SLOW_POLL_MS,
    retry: false,
  });

  const memDiagQuery = useQuery<MemoryDiagnostics>({
    queryKey: ["diagnostics", "memory"],
    queryFn: () => api.get("/admin/diagnostics/memory"),
    refetchInterval: SLOW_POLL_MS,
    staleTime: SLOW_POLL_MS,
    retry: false,
  });

  const qc = useQueryClient();

  // SSE-driven invalidation — surface real-time state changes immediately
  // rather than waiting for the POLL_MS / SLOW_POLL_MS cycle.
  useSSEEvent("transcoding-update", () => {
    void qc.invalidateQueries({ queryKey: ["diagnostics", "transcoder-status"] });
  });
  useSSEEvent("broadcast-queue-updated", () => {
    void qc.invalidateQueries({ queryKey: ["diagnostics", "broadcast-health"] });
  });
  useSSEEvent("stream-health-degraded", () => {
    void qc.invalidateQueries({ queryKey: ["diagnostics", "stream-health"] });
  });
  useSSEEvent("stream-health-recovered", () => {
    void qc.invalidateQueries({ queryKey: ["diagnostics", "stream-health"] });
  });

  const isRefreshing =
    procQuery.isFetching ||
    transcoderQuery.isFetching ||
    broadcastQuery.isFetching ||
    streamHealthQuery.isFetching ||
    memDiagQuery.isFetching;

  function refetchAll() {
    void procQuery.refetch();
    void transcoderQuery.refetch();
    void broadcastQuery.refetch();
    void streamHealthQuery.refetch();
    void memDiagQuery.refetch();
  }

  const proc = procQuery.data;
  const tx = transcoderQuery.data;
  const bcast = broadcastQuery.data;
  const sh = streamHealthQuery.data;
  const memDiag = memDiagQuery.data;

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

      {/* ── Memory Watchdog · In-Memory Stores ──────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground/70">
          Memory Watchdog · In-Memory Stores
        </h2>
        {memDiagQuery.isLoading ? (
          <SectionSkeleton />
        ) : memDiag ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* ── Watchdog state card ── */}
            <Card className={cn(
              (memDiag.watchdog.alerts.rssAlertActive ||
               memDiag.watchdog.alerts.slopeAlertActive ||
               memDiag.watchdog.alerts.heapUsedAlertActive)
                ? "border-red-200 bg-red-50/50 dark:bg-red-950/20 dark:border-red-900/50"
                : "",
            )}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <MemoryStick size={14} className="text-muted-foreground" />
                    Watchdog State
                  </CardTitle>
                  <StatusPill
                    ok={!memDiag.watchdog.alerts.rssAlertActive && !memDiag.watchdog.alerts.slopeAlertActive && !memDiag.watchdog.alerts.heapUsedAlertActive}
                    label={
                      memDiag.watchdog.alerts.rssAlertActive || memDiag.watchdog.alerts.slopeAlertActive || memDiag.watchdog.alerts.heapUsedAlertActive
                        ? "Alert active"
                        : "All clear"
                    }
                  />
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">RSS alert</span>
                  <Badge className={cn(
                    "text-[10px] font-semibold px-2 py-0.5",
                    memDiag.watchdog.alerts.rssAlertActive
                      ? "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/25"
                      : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25",
                  )}>
                    {memDiag.watchdog.alerts.rssAlertActive ? `ACTIVE — ${memDiag.watchdog.current.rssMb} MB` : "OK"}
                  </Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Native memory slope</span>
                  <span className={cn(
                    "font-mono text-xs font-semibold",
                    memDiag.watchdog.alerts.slopeAlertActive
                      ? "text-red-500"
                      : (memDiag.watchdog.current.externalGrowthMbPerMin ?? 0) > 20
                        ? "text-amber-500"
                        : "text-foreground",
                  )}>
                    {memDiag.watchdog.current.externalGrowthMbPerMin !== null
                      ? `${memDiag.watchdog.current.externalGrowthMbPerMin > 0 ? "+" : ""}${memDiag.watchdog.current.externalGrowthMbPerMin.toFixed(1)} MB/min`
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">JS heap slope</span>
                  <span className={cn(
                    "font-mono text-xs font-semibold",
                    memDiag.watchdog.alerts.heapUsedAlertActive
                      ? "text-red-500"
                      : (memDiag.watchdog.current.heapUsedGrowthMbPerMin ?? 0) > 15
                        ? "text-amber-500"
                        : "text-foreground",
                  )}>
                    {memDiag.watchdog.current.heapUsedGrowthMbPerMin !== null
                      ? `${memDiag.watchdog.current.heapUsedGrowthMbPerMin > 0 ? "+" : ""}${memDiag.watchdog.current.heapUsedGrowthMbPerMin.toFixed(1)} MB/min`
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground text-xs">Heap alert threshold</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {memDiag.watchdog.thresholds.heapUsedGrowthAlertMbPerMin} MB/min × 3 samples
                  </span>
                </div>
                {(memDiag.watchdog.alerts.slopeAlertActive || memDiag.watchdog.alerts.heapUsedAlertActive) && (
                  <div className="flex items-start gap-1.5 text-red-600 dark:text-red-400 text-xs pt-1">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                    {memDiag.watchdog.alerts.heapUsedAlertActive
                      ? "JS heap is growing — possible object leak. Use Heap Snapshot on the API to investigate."
                      : "Native memory growing — possible Buffer/binding leak."}
                  </div>
                )}
                {memDiag.heapSpaces.length > 0 && (
                  <div className="pt-2 border-t border-border/40 mt-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground/60 mb-1.5">V8 Heap Spaces</p>
                    <div className="space-y-1">
                      {memDiag.heapSpaces.map(({ spaceName, spaceUsedSizeMb, spaceSizeMb }) => {
                        const pct = spaceSizeMb > 0 ? Math.round((spaceUsedSizeMb / spaceSizeMb) * 100) : 0;
                        const friendly = spaceName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
                        return (
                          <div key={spaceName} className="flex items-center gap-2">
                            <span className="text-[10px] font-mono text-muted-foreground w-28 shrink-0 truncate" title={spaceName}>
                              {friendly}
                            </span>
                            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                              <div
                                className={cn(
                                  "h-full rounded-full transition-all",
                                  pct > 85 ? "bg-red-500" : pct > 60 ? "bg-amber-500" : "bg-primary/60",
                                )}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-[10px] font-mono text-muted-foreground shrink-0 w-20 text-right">
                              {spaceUsedSizeMb.toFixed(1)}/{spaceSizeMb.toFixed(1)} MB
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ── Memory history sparkline card — full width ── */}
            {memDiag.memorySamples.length > 1 && (
              <Card className="col-span-1 sm:col-span-2">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Activity size={14} className="text-muted-foreground" />
                    Heap Usage — Last {Math.round(((memDiag.memorySamples[memDiag.memorySamples.length - 1]?.ts ?? 0) - (memDiag.memorySamples[0]?.ts ?? 0)) / 60_000)} min
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <ResponsiveContainer width="100%" height={80}>
                    <AreaChart data={memDiag.memorySamples} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="heapGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                        </linearGradient>
                        <linearGradient id="extGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(38 92% 50%)" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="hsl(38 92% 50%)" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="ts"
                        tickFormatter={(v: number) => new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        tick={{ fontSize: 9 }}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        tick={{ fontSize: 9 }}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v: number) => `${v}MB`}
                        width={40}
                      />
                      <RechartsTooltip
                        formatter={(value: number, name: string) => [
                          `${value.toFixed(1)} MB`,
                          name === "heapUsedMb" ? "JS Heap" : "Native (external)",
                        ]}
                        labelFormatter={(ts: number) => new Date(ts).toLocaleTimeString()}
                        contentStyle={{ fontSize: 11 }}
                      />
                      <Area type="monotone" dataKey="heapUsedMb" stroke="hsl(var(--primary))" fill="url(#heapGrad)" strokeWidth={1.5} dot={false} />
                      <Area type="monotone" dataKey="externalMb" stroke="hsl(38 92% 50%)" fill="url(#extGrad)" strokeWidth={1.5} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                  <div className="flex gap-4 mt-1 justify-end">
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <span className="inline-block w-3 h-0.5 bg-primary rounded" />
                      JS Heap
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <span className="inline-block w-3 h-0.5 bg-amber-500 rounded" />
                      Native (ext)
                    </span>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ── Named in-memory stores card ── */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Database size={14} className="text-muted-foreground" />
                  In-Memory Stores
                  <span className="text-[10px] font-normal text-muted-foreground ml-1">
                    ({memDiag.caches.length} registered)
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {memDiag.caches.length > 0 ? (
                  <div>
                    <div className="flex justify-between text-[10px] text-muted-foreground/60 uppercase tracking-wide mb-1.5 px-0.5">
                      <span>Store</span>
                      <div className="flex gap-4">
                        <span>Now</span>
                        <span className="w-16 text-right">Peak</span>
                      </div>
                    </div>
                    <div className="divide-y divide-border/40">
                      {memDiag.caches.map(({ name, size, peak }) => {
                        const atPeak = size > 0 && size >= peak * 0.9;
                        const elevated = peak > 5000 || size > 5000;
                        const warning = peak > 1000 || size > 1000;
                        return (
                          <div key={name} className="flex justify-between items-center py-1.5 first:pt-0 last:pb-0">
                            <span
                              className="text-[11px] font-mono text-muted-foreground truncate mr-2 max-w-[180px]"
                              title={name}
                            >
                              {name}
                            </span>
                            <div className="flex items-center gap-2 shrink-0">
                              <Badge
                                variant="outline"
                                className={cn(
                                  "text-[10px] font-mono",
                                  elevated
                                    ? "border-red-500/40 text-red-600 dark:text-red-400"
                                    : warning
                                      ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
                                      : "",
                                )}
                              >
                                {size.toLocaleString()}
                              </Badge>
                              <span
                                className={cn(
                                  "text-[10px] font-mono w-16 text-right",
                                  atPeak && (elevated || warning)
                                    ? "text-red-500 dark:text-red-400 font-semibold"
                                    : "text-muted-foreground/60",
                                )}
                                title={`Lifetime high-water mark: ${peak.toLocaleString()}`}
                              >
                                ↑{peak.toLocaleString()}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground py-2">No stores registered.</p>
                )}
              </CardContent>
            </Card>
          </div>
        ) : memDiagQuery.error ? (
          <ErrorAlert
            title="Memory diagnostics unavailable"
            message={memDiagQuery.error instanceof Error ? memDiagQuery.error.message : "Request failed"}
          />
        ) : null}
      </section>

      {/* ── Memory History ──────────────────────────────────────────────────── */}
      <MemoryHistorySection />

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

            {/* ── Storage circuit-breaker status ── */}
            <Card className={cn(
              "col-span-2 sm:col-span-4",
              tx.heartbeat.circuitOpen
                ? "border-red-200 bg-red-50/50 dark:bg-red-950/20 dark:border-red-900/50"
                : tx.heartbeat.storageErrorStreak > 0
                  ? "border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-900/50"
                  : "",
            )}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Zap size={14} className="text-muted-foreground" />
                    Storage Circuit Breaker
                  </CardTitle>
                  <StatusPill
                    ok={!tx.heartbeat.circuitOpen}
                    label={tx.heartbeat.circuitOpen ? "OPEN — paused" : "Closed — OK"}
                  />
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Error streak</span>
                  <span className={cn(
                    "font-mono text-xs font-semibold",
                    tx.heartbeat.storageErrorStreak >= 3 ? "text-red-500" :
                    tx.heartbeat.storageErrorStreak > 0 ? "text-amber-500" : "",
                  )}>
                    {tx.heartbeat.storageErrorStreak} / 3
                  </span>
                </div>
                {tx.heartbeat.circuitOpen && tx.heartbeat.circuitOpenRemainingMs !== null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Reopens in</span>
                    <span className="font-mono text-xs text-red-600 dark:text-red-400 font-semibold">
                      {fmtMs(tx.heartbeat.circuitOpenRemainingMs)}
                    </span>
                  </div>
                )}
                {tx.heartbeat.circuitOpen && (
                  <div className="flex items-center gap-1.5 text-red-600 dark:text-red-400 text-xs pt-1">
                    <AlertTriangle size={11} />
                    Job dispatch paused — 3 consecutive storage errors. Auto-resumes after cool-down.
                  </div>
                )}
                {!tx.heartbeat.circuitOpen && tx.heartbeat.storageErrorStreak > 0 && (
                  <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400 text-xs pt-1">
                    <AlertTriangle size={11} />
                    {tx.heartbeat.storageErrorStreak} storage error{tx.heartbeat.storageErrorStreak > 1 ? "s" : ""} — circuit trips at 3
                  </div>
                )}
              </CardContent>
            </Card>

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
