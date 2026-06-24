import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2, XCircle, AlertTriangle, RefreshCw, Activity,
  Cpu, Database, HardDrive, Wifi, Clock, Server, Zap,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

// ── Types ────────────────────────────────────────────────────────────────────

interface WorkerHealth {
  name: string;
  running: boolean;
  circuitOpen: boolean;
  consecutiveFailures: number;
  totalRuns: number;
  lastRunAtMs: number | null;
  lastSuccessAtMs: number | null;
  nextRunAtMs: number | null;
}

interface SystemHealthData {
  checkedAt: string;
  ok: boolean;
  issues: string[];
  broadcast: { started: boolean; sequence: number; itemCount: number };
  workers: WorkerHealth[];
  unhealthyWorkerCount: number;
  queue: {
    activeItems: number | null;
    threshold: number;
    belowThreshold: boolean;
    totalRebuilds: number;
    lastRebuildAtMs: number | null;
  };
  transcoder: {
    enabled: boolean;
    isRunning: boolean;
    circuitOpen: boolean;
    currentJobId: string | null;
  };
  dbPool: {
    active: number;
    idle: number;
    waiting: number;
    max: number;
    utilizationPct: number;
    highUtilAlertActive: boolean;
    waitingAlertActive: boolean;
  };
  storage: { healthy: boolean; enabled: boolean; consecutiveFailures: number };
  contentRotation: {
    strategy: string;
    intervalMs: number;
    lastShuffleAtMs: number;
    shuffleCount: number;
  };
  memory: {
    rssMb: number;
    rssWarnMb: number;
    rssRestartMb: number;
    rssAlertActive: boolean;
    heapUsedGrowthMbPerMin: number | null;
    externalGrowthMbPerMin: number | null;
    arrayBuffersAlertActive: boolean;
    eventLoopLagMs: number | null;
  };
  deadAir: {
    totalIncidents: number;
    openIncident: boolean;
    onAirPct: number | null;
    longestIncidentMs: number;
    frameLivenessOk: boolean;
    lastFrameAtMs: number;
  };
  apiOriginConfigured: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusBadge({ ok, label }: { ok: boolean; label?: string }) {
  return ok ? (
    <Badge className="bg-emerald-600 text-white text-xs gap-1">
      <CheckCircle2 size={11} /> {label ?? "Healthy"}
    </Badge>
  ) : (
    <Badge className="bg-red-600 text-white text-xs gap-1">
      <XCircle size={11} /> {label ?? "Unhealthy"}
    </Badge>
  );
}

function WarnBadge({ label }: { label: string }) {
  return (
    <Badge className="bg-amber-500 text-white text-xs gap-1">
      <AlertTriangle size={11} /> {label}
    </Badge>
  );
}

function workerState(w: WorkerHealth): "running" | "circuit_open" | "stopped" {
  if (w.circuitOpen) return "circuit_open";
  if (w.running) return "running";
  return "stopped";
}

function WorkerBadge({ w }: { w: WorkerHealth }) {
  const state = workerState(w);
  if (state === "running")
    return <Badge className="bg-emerald-600 text-white text-xs">Running</Badge>;
  if (state === "circuit_open")
    return <Badge className="bg-red-600 text-white text-xs">Circuit Open</Badge>;
  return <Badge className="bg-zinc-500 text-white text-xs">Stopped</Badge>;
}

function ms(n: number | null): string {
  if (n == null) return "—";
  return formatDistanceToNow(new Date(n), { addSuffix: true });
}

function dur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SystemHealthPage() {
  const { data, isLoading, isError, refetch, isFetching, dataUpdatedAt } = useQuery<SystemHealthData>({
    queryKey: ["system-health"],
    queryFn: async () => {
      const r = await fetch("/api/admin/broadcast/system-health", { credentials: "include" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return r.json() as Promise<SystemHealthData>;
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const handleRefresh = useCallback(() => { void refetch(); }, [refetch]);

  if (isLoading) return (
    <div className="flex items-center justify-center h-48 text-zinc-400">
      <RefreshCw className="animate-spin mr-2" size={18} /> Loading system health…
    </div>
  );

  if (isError || !data) return (
    <div className="flex items-center justify-center h-48 text-red-400">
      <XCircle className="mr-2" size={18} /> Failed to load system health. Check API connectivity.
    </div>
  );

  const rssPct = Math.min(100, Math.round((data.memory.rssMb / data.memory.rssRestartMb) * 100));
  const dbPct  = data.dbPool.utilizationPct;

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-screen-xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Activity size={22} className="text-emerald-400" />
          <div>
            <h1 className="text-xl font-semibold">System Health</h1>
            <p className="text-xs text-zinc-400 mt-0.5">
              Auto-refreshes every 15 s · Last checked {dataUpdatedAt ? formatDistanceToNow(new Date(dataUpdatedAt), { addSuffix: true }) : "—"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge ok={data.ok} label={data.ok ? "All Systems OK" : `${data.issues.length} Issue${data.issues.length !== 1 ? "s" : ""}`} />
          <Button size="sm" variant="outline" onClick={handleRefresh} disabled={isFetching} className="gap-1.5">
            <RefreshCw size={13} className={isFetching ? "animate-spin" : ""} /> Refresh
          </Button>
        </div>
      </div>

      {/* Active issues banner */}
      {data.issues.length > 0 && (
        <Card className="border-red-800 bg-red-950/30">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm text-red-400 flex items-center gap-2">
              <AlertTriangle size={15} /> {data.issues.length} Active Issue{data.issues.length !== 1 ? "s" : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <ul className="space-y-1">
              {data.issues.map((issue, i) => (
                <li key={i} className="text-xs text-red-300 flex items-start gap-1.5">
                  <XCircle size={11} className="mt-0.5 shrink-0" /> {issue}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Top-level status grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: "Broadcast",  ok: data.broadcast.started,           icon: <Wifi size={14} />,      detail: `seq ${data.broadcast.sequence}` },
          { label: "Workers",    ok: data.unhealthyWorkerCount === 0,  icon: <Zap size={14} />,       detail: `${data.workers.filter(w => w.running && !w.circuitOpen).length}/${data.workers.length} running` },
          { label: "Queue",      ok: !data.queue.belowThreshold,       icon: <Server size={14} />,    detail: `${data.queue.activeItems ?? 0} items` },
          { label: "DB Pool",    ok: !data.dbPool.waitingAlertActive,  icon: <Database size={14} />,  detail: `${data.dbPool.utilizationPct}% util` },
          { label: "Storage",    ok: !data.storage.enabled || data.storage.healthy, icon: <HardDrive size={14} />, detail: data.storage.enabled ? (data.storage.healthy ? "healthy" : `${data.storage.consecutiveFailures} failures`) : "disabled" },
          { label: "On Air",     ok: !data.deadAir.openIncident,       icon: <Activity size={14} />, detail: data.deadAir.onAirPct != null ? `${data.deadAir.onAirPct}% uptime` : "tracking…" },
        ].map(({ label, ok, icon, detail }) => (
          <Card key={label} className={`border ${ok ? "border-zinc-800" : "border-red-800 bg-red-950/20"}`}>
            <CardContent className="p-3 flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-zinc-400 text-xs">
                {icon} {label}
              </div>
              <StatusBadge ok={ok} />
              <p className="text-xs text-zinc-500">{detail}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Memory */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Cpu size={15} className="text-blue-400" /> Memory (RSS)
              {data.memory.rssAlertActive && <WarnBadge label="Pressure" />}
              {data.memory.arrayBuffersAlertActive && <WarnBadge label="ArrayBuffers" />}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="flex justify-between text-xs text-zinc-400 mb-1">
                <span>{data.memory.rssMb} MB RSS</span>
                <span>restart at {data.memory.rssRestartMb} MB</span>
              </div>
              <Progress
                value={rssPct}
                className={`h-2 ${rssPct > 85 ? "[&>div]:bg-red-500" : rssPct > 65 ? "[&>div]:bg-amber-500" : "[&>div]:bg-emerald-500"}`}
              />
              <div className="flex justify-between text-xs text-zinc-600 mt-1">
                <span>0 MB</span>
                <span className="text-amber-500">warn {data.memory.rssWarnMb} MB</span>
                <span>{data.memory.rssRestartMb} MB</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {[
                { label: "Heap growth", value: data.memory.heapUsedGrowthMbPerMin != null ? `${data.memory.heapUsedGrowthMbPerMin} MB/min` : "—" },
                { label: "External growth", value: data.memory.externalGrowthMbPerMin != null ? `${data.memory.externalGrowthMbPerMin} MB/min` : "—" },
                { label: "Event loop lag", value: data.memory.eventLoopLagMs != null ? `${Math.round(data.memory.eventLoopLagMs)} ms` : "—" },
                { label: "ArrayBuffers", value: data.memory.arrayBuffersAlertActive ? "⚠ growing" : "normal" },
              ].map(({ label, value }) => (
                <div key={label} className="bg-zinc-900 rounded p-2">
                  <p className="text-zinc-500">{label}</p>
                  <p className="text-zinc-200 font-mono mt-0.5">{value}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Dead-air + Broadcast */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity size={15} className="text-emerald-400" /> Broadcast / Dead-Air
              {data.deadAir.openIncident && <WarnBadge label="Off Air" />}
              {!data.deadAir.frameLivenessOk && <WarnBadge label="No Frames" />}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-xs">
              {[
                { label: "On-air uptime", value: data.deadAir.onAirPct != null ? `${data.deadAir.onAirPct}%` : "tracking…" },
                { label: "Total incidents", value: String(data.deadAir.totalIncidents) },
                { label: "Longest incident", value: data.deadAir.longestIncidentMs > 0 ? dur(data.deadAir.longestIncidentMs) : "none" },
                { label: "Frame stream", value: data.deadAir.frameLivenessOk ? "live" : (data.deadAir.lastFrameAtMs === 0 ? "waiting" : "⚠ stale") },
                { label: "Orchestrator", value: data.broadcast.started ? `running (seq ${data.broadcast.sequence})` : "⚠ stopped" },
                { label: "Queue items", value: String(data.broadcast.itemCount) },
              ].map(({ label, value }) => (
                <div key={label} className="bg-zinc-900 rounded p-2">
                  <p className="text-zinc-500">{label}</p>
                  <p className="text-zinc-200 font-mono mt-0.5">{value}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* DB Pool */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Database size={15} className="text-violet-400" /> Database Pool
              {data.dbPool.waitingAlertActive && <WarnBadge label="Saturated" />}
              {data.dbPool.highUtilAlertActive && !data.dbPool.waitingAlertActive && <WarnBadge label="High Util" />}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="flex justify-between text-xs text-zinc-400 mb-1">
                <span>{data.dbPool.active} active / {data.dbPool.idle} idle</span>
                <span>{dbPct}% of {data.dbPool.max}</span>
              </div>
              <Progress
                value={dbPct}
                className={`h-2 ${dbPct > 90 ? "[&>div]:bg-red-500" : dbPct > 70 ? "[&>div]:bg-amber-500" : "[&>div]:bg-violet-500"}`}
              />
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              {[
                { label: "Active",   value: String(data.dbPool.active) },
                { label: "Idle",     value: String(data.dbPool.idle) },
                { label: "Waiting",  value: String(data.dbPool.waiting) },
              ].map(({ label, value }) => (
                <div key={label} className="bg-zinc-900 rounded p-2 text-center">
                  <p className="text-zinc-500">{label}</p>
                  <p className="text-zinc-200 font-mono mt-0.5 text-sm">{value}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Transcoder + Storage + Content Rotation */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Zap size={15} className="text-amber-400" /> Services
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">Transcoder</span>
              <div className="flex items-center gap-2">
                {data.transcoder.enabled
                  ? <StatusBadge ok={data.transcoder.isRunning && !data.transcoder.circuitOpen} label={data.transcoder.circuitOpen ? "Circuit Open" : (data.transcoder.isRunning ? "Running" : "Idle")} />
                  : <Badge className="bg-zinc-600 text-white text-xs">Disabled</Badge>}
                {data.transcoder.currentJobId && (
                  <span className="text-zinc-500 font-mono">{data.transcoder.currentJobId.slice(0, 8)}</span>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">Object Storage</span>
              {data.storage.enabled
                ? <StatusBadge ok={data.storage.healthy} label={data.storage.healthy ? "Healthy" : `${data.storage.consecutiveFailures} failures`} />
                : <Badge className="bg-zinc-600 text-white text-xs">Disabled</Badge>}
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">API Origin</span>
              <StatusBadge ok={data.apiOriginConfigured} label={data.apiOriginConfigured ? "Configured" : "Missing"} />
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">Content Rotation</span>
              <span className="text-zinc-300">{data.contentRotation.strategy} · {data.contentRotation.shuffleCount} shuffles</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Worker grid */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Server size={15} className="text-sky-400" /> Background Workers
            <span className="text-zinc-500 text-xs font-normal">
              {data.workers.filter(w => w.running && !w.circuitOpen).length} / {data.workers.length} healthy
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
            {data.workers.map((w) => (
              <div
                key={w.name}
                className={`rounded-lg border p-3 text-xs space-y-1.5 ${
                  w.circuitOpen
                    ? "border-red-800 bg-red-950/20"
                    : w.running
                    ? "border-zinc-800 bg-zinc-900/50"
                    : "border-zinc-700 bg-zinc-900/30"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-zinc-200 truncate">{w.name}</span>
                  <WorkerBadge w={w} />
                </div>
                <div className="grid grid-cols-2 gap-x-3 text-zinc-500">
                  <span>Runs: <span className="text-zinc-300">{w.totalRuns}</span></span>
                  <span>Fails: <span className={w.consecutiveFailures > 0 ? "text-amber-400" : "text-zinc-300"}>{w.consecutiveFailures}</span></span>
                  <span className="col-span-2">
                    Last run: <span className="text-zinc-300">{ms(w.lastRunAtMs)}</span>
                  </span>
                  <span className="col-span-2">
                    Next run: <span className="text-zinc-300">
                      {w.nextRunAtMs ? (w.nextRunAtMs < Date.now() ? "soon" : ms(w.nextRunAtMs)) : "—"}
                    </span>
                  </span>
                </div>
                {w.circuitOpen && (
                  <div className="flex items-center gap-1 text-red-400">
                    <AlertTriangle size={10} />
                    <span>Circuit open after {w.consecutiveFailures} consecutive failures</span>
                  </div>
                )}
              </div>
            ))}
          </div>
          {data.workers.length === 0 && (
            <p className="text-zinc-500 text-xs">No workers registered yet — start the API server to initialise.</p>
          )}
        </CardContent>
      </Card>

      {/* Queue details */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock size={15} className="text-orange-400" /> Broadcast Queue
            {data.queue.belowThreshold && <WarnBadge label="Below Threshold" />}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            {[
              { label: "Active items",     value: String(data.queue.activeItems ?? 0) },
              { label: "Min threshold",    value: String(data.queue.threshold) },
              { label: "Total rebuilds",   value: String(data.queue.totalRebuilds) },
              { label: "Last rebuild",     value: ms(data.queue.lastRebuildAtMs) },
            ].map(({ label, value }) => (
              <Tooltip key={label}>
                <TooltipTrigger asChild>
                  <div className="bg-zinc-900 rounded p-3">
                    <p className="text-zinc-500">{label}</p>
                    <p className="text-zinc-200 font-mono mt-1 text-sm">{value}</p>
                  </div>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
