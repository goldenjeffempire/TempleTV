import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, isTransientError } from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Activity, Wifi, Server, CheckCircle2, AlertCircle, RefreshCw,
  Radio, Zap, Users, BarChart2, Clock, ShieldAlert, ShieldCheck,
  Ban, RotateCcw, Shield, WifiOff,
} from "lucide-react";

interface NetworkStatus {
  encoderStatus: string;
  streamStatus: string;
  cdnStatus: string;
  playerStatus: string;
  lastCheckedAt: string;
}

interface ReadyzResponse {
  status: string;
  uptimeSec: number;
  version: string;
  dependencies: { database: string; cache: string; storage: string };
  broadcast: { channelId: string; viewerCount: number; hasCurrent: boolean };
}

interface EngineHealth {
  ok: boolean;
  stuck?: boolean;
  channelId: string;
  sequence: number;
  mode: string;
  hasCurrent: boolean;
  currentTitle?: string | null;
  nextTitle?: string | null;
  currentDurationSecs?: number | null;
  currentElapsedSecs?: number | null;
  offAirReason?: "empty" | "all_blocked" | null;
  deadAir?: boolean;
  itemCount: number;
  uptimeMs: number;
  boot: { started: boolean; busBridgeInstalled: boolean; startAttempts: number; lastStartError: string | null };
  reload: { lastReloadAtMs: number | null; lastReloadOk: boolean; attempts: number; successes: number };
  allBlocked?: { allSourcesBlocked: boolean; allBlockedSinceMs: number | null; allBlockedDurationMs: number | null };
}

interface DiagnosticsAnalytics {
  activeSessions: number;
  peakSessionsLast5Min: number;
  totalSessions: number;
  eventCounts: Record<string, number>;
  lastEventAtMs: number | null;
}

interface ScanItemResult {
  id: string;
  title: string;
  url: string | null;
  kind: "hls" | "mp4" | "unknown";
  reachable: boolean;
  httpStatus: number | null;
  consecutiveFailures: number;
  lastCheckedAtMs: number;
  lastFailedAtMs: number | null;
}

interface AutoSuspendedItem {
  itemId: string;
  title: string | null;
  failCount: number;
  suspendedAtMs: number;
}

interface DiagnosticsReport {
  analytics: DiagnosticsAnalytics | null;
  autoSuspended: AutoSuspendedItem[];
  mediaScan: {
    lastScanAtMs: number | null;
    scanDurationMs: number | null;
    totalItems: number;
    reachable: number;
    unreachable: number;
    scanning: boolean;
    items: ScanItemResult[];
  } | null;
}

function StatusDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  const color = ok ? "bg-green-500" : warn ? "bg-amber-500" : "bg-red-500";
  return <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${color}`} />;
}

function StatusRow({ label, value, ok, warn }: { label: string; value: string; ok: boolean; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b last:border-0">
      <div className="flex items-center gap-2.5">
        <StatusDot ok={ok} warn={warn} />
        <span className="text-sm">{label}</span>
      </div>
      <Badge variant={ok ? "outline" : warn ? "secondary" : "destructive"} className="capitalize text-[11px]">
        {value}
      </Badge>
    </div>
  );
}

function formatAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

function formatUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

export default function StreamHealthPage() {
  const qc = useQueryClient();

  const { data: readyz, isLoading: readyzLoading, error: readyzError, refetch } = useQuery({
    queryKey: ["readyz"],
    queryFn: () => api.get<ReadyzResponse>("/readyz"),
    refetchInterval: 15_000,
    staleTime: 12_000,
  });

  const { data: networkStatus, isLoading: networkLoading } = useQuery({
    queryKey: ["network-status"],
    queryFn: () => api.get<NetworkStatus>("/network/status").catch(() => null),
    refetchInterval: 15_000,
    staleTime: 12_000,
  });

  const { data: engineHealth, isLoading: engineLoading } = useQuery({
    queryKey: ["broadcast-v2-engine-health"],
    queryFn: () => api.get<EngineHealth>("/broadcast-v2/health"),
    refetchInterval: 10_000,
    staleTime: 8_000,
  });

  const { data: diagnostics } = useQuery({
    queryKey: ["broadcast-v2-diagnostics-health"],
    queryFn: () => api.get<DiagnosticsReport>("/broadcast-v2/diagnostics"),
    refetchInterval: 10_000,
    staleTime: 8_000,
  });

  useSSEEvent("stream-health", () => { void qc.invalidateQueries({ queryKey: ["readyz"] }); });
  useSSEEvent("broadcast-queue-updated", () => {
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics-health"] });
  });

  const deps = readyz?.dependencies;
  const allDepsOk = deps ? Object.values(deps).every(v => v === "ok") : false;
  const uptimeHrs = readyz ? Math.floor(readyz.uptimeSec / 3600) : 0;
  const uptimeMins = readyz ? Math.floor((readyz.uptimeSec % 3600) / 60) : 0;

  const isEngineHealthy =
    !engineHealth?.stuck &&
    !engineHealth?.deadAir &&
    engineHealth?.boot.started &&
    !engineHealth?.allBlocked?.allSourcesBlocked;

  const allOk = allDepsOk && (engineHealth ? isEngineHealthy : true);

  const clearBadUrlsMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean }>("/broadcast-v2/clear-bad-urls", {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
    },
  });

  const analytics = diagnostics?.analytics;
  const stallCount = analytics?.eventCounts?.["stall"] ?? 0;
  const skipCount = analytics?.eventCounts?.["skip"] ?? 0;
  const recoveryCount = analytics?.eventCounts?.["recovery"] ?? 0;
  const autoSuspended = diagnostics?.autoSuspended ?? [];
  const mediaScan = diagnostics?.mediaScan ?? null;

  const elapsedPct = engineHealth?.currentDurationSecs && engineHealth?.currentElapsedSecs
    ? Math.min(100, Math.round((engineHealth.currentElapsedSecs / engineHealth.currentDurationSecs) * 100))
    : null;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Stream Health"
        description="Real-time system health, engine diagnostics, and playback analytics."
        actions={
          <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
            <RefreshCw size={13} /> Refresh
          </Button>
        }
      />

      {readyzError && (
        <ErrorAlert
          message={(readyzError as Error).message}
          onRetry={() => void refetch()}
          transient={isTransientError(readyzError)}
        />
      )}

      {/* Overall status banner */}
      <div className={`flex items-center gap-3 p-4 rounded-lg border ${allOk ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}`}>
        {readyzLoading ? <Skeleton className="h-6 w-48" /> : (
          <>
            {allOk
              ? <CheckCircle2 size={20} className="text-green-500 flex-shrink-0" />
              : <AlertCircle size={20} className="text-red-500 flex-shrink-0" />}
            <div>
              <p className="font-semibold text-sm">{allOk ? "All systems operational" : "Degraded — check below"}</p>
              {readyz && (
                <p className="text-xs text-muted-foreground">
                  API uptime: {uptimeHrs}h {uptimeMins}m · v{readyz.version}
                  {engineHealth && ` · Engine uptime: ${formatUptime(engineHealth.uptimeMs)}`}
                </p>
              )}
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* API Dependencies */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Server size={15} /> API Dependencies
            </CardTitle>
          </CardHeader>
          <CardContent>
            {readyzLoading ? (
              <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : deps ? (
              <div>
                <StatusRow label="Database" value={deps.database} ok={deps.database === "ok"} />
                <StatusRow label="Cache" value={deps.cache} ok={deps.cache === "ok"} warn={deps.cache !== "ok"} />
                <StatusRow label="Storage" value={deps.storage} ok={deps.storage === "ok"} />
                <div className="flex items-center justify-between py-2.5">
                  <div className="flex items-center gap-2.5">
                    <StatusDot ok={true} />
                    <span className="text-sm">Live Viewers</span>
                  </div>
                  <span className="font-semibold text-sm">{(readyz?.broadcast.viewerCount ?? 0).toLocaleString()}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">No data</p>
            )}
          </CardContent>
        </Card>

        {/* Broadcast Engine v2 */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Radio size={15} /> Broadcast Engine v2
              </CardTitle>
              {engineHealth && (
                <Badge
                  variant={engineHealth.deadAir || engineHealth.stuck ? "destructive" : engineHealth.hasCurrent ? "default" : "secondary"}
                  className="text-[10px]"
                >
                  {engineHealth.stuck ? "STUCK" : engineHealth.deadAir ? "DEAD AIR" : engineHealth.hasCurrent ? "ON AIR" : "OFF AIR"}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {engineLoading ? (
              <div className="space-y-2">{[1,2,3,4].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
            ) : engineHealth ? (
              <div className="space-y-0">
                {/* Current title */}
                {engineHealth.currentTitle && (
                  <div className="pb-3 mb-1">
                    <p className="text-xs text-muted-foreground mb-1">Now playing</p>
                    <p className="text-sm font-medium truncate">{engineHealth.currentTitle}</p>
                    {elapsedPct !== null && (
                      <div className="mt-2 space-y-1">
                        <Progress value={elapsedPct} className="h-1.5" />
                        <p className="text-[10px] text-muted-foreground tabular-nums">
                          {Math.floor((engineHealth.currentElapsedSecs ?? 0) / 60)}:{String(Math.floor((engineHealth.currentElapsedSecs ?? 0) % 60)).padStart(2,"0")}
                          {" / "}
                          {Math.floor((engineHealth.currentDurationSecs ?? 0) / 60)}:{String(Math.floor((engineHealth.currentDurationSecs ?? 0) % 60)).padStart(2,"0")}
                        </p>
                      </div>
                    )}
                  </div>
                )}
                {engineHealth.nextTitle && (
                  <div className="text-xs text-muted-foreground pb-2 border-b mb-1 truncate">
                    Up next: <span className="text-foreground font-medium">{engineHealth.nextTitle}</span>
                  </div>
                )}
                <StatusRow
                  label="Mode"
                  value={engineHealth.mode}
                  ok={engineHealth.mode === "queue"}
                />
                <StatusRow
                  label="Sequence"
                  value={String(engineHealth.sequence)}
                  ok={engineHealth.sequence > 0 || engineHealth.uptimeMs < 30_000}
                />
                <StatusRow
                  label="Queue items"
                  value={String(engineHealth.itemCount)}
                  ok={engineHealth.itemCount > 0}
                />
                <StatusRow
                  label="Sources"
                  value={engineHealth.allBlocked?.allSourcesBlocked ? "all blocked" : "ok"}
                  ok={!engineHealth.allBlocked?.allSourcesBlocked}
                />
                {engineHealth.allBlocked?.allSourcesBlocked && engineHealth.allBlocked.allBlockedDurationMs != null && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400 px-1 pb-1">
                    Blocked for {Math.round(engineHealth.allBlocked.allBlockedDurationMs / 1000)}s — auto-recovery in progress
                  </p>
                )}
                <StatusRow
                  label="Boot"
                  value={engineHealth.boot.started ? "ok" : `retrying (${engineHealth.boot.startAttempts})`}
                  ok={engineHealth.boot.started}
                />
                <StatusRow
                  label="Last reload"
                  value={engineHealth.reload.lastReloadAtMs ? `${engineHealth.reload.lastReloadOk ? "ok" : "fail"} · ${formatAgo(engineHealth.reload.lastReloadAtMs)}` : "—"}
                  ok={engineHealth.reload.lastReloadOk}
                />
                {engineHealth.offAirReason && (
                  <div className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                    Off-air reason: <span className="font-medium">{engineHealth.offAirReason === "empty" ? "Queue is empty" : "All sources blocked"}</span>
                  </div>
                )}
                {engineHealth.boot.lastStartError && (
                  <div className="mt-1 rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300 break-words">
                    {engineHealth.boot.lastStartError}
                  </div>
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Playback Analytics */}
        {analytics && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <BarChart2 size={15} /> Playback Analytics
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="rounded-lg bg-muted/40 p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Users size={12} className="text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Active sessions</span>
                  </div>
                  <p className="text-2xl font-bold tabular-nums">{analytics.activeSessions}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Peak 5m: {analytics.peakSessionsLast5Min}</p>
                </div>
                <div className="rounded-lg bg-muted/40 p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Activity size={12} className="text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Total sessions</span>
                  </div>
                  <p className="text-2xl font-bold tabular-nums">{analytics.totalSessions.toLocaleString()}</p>
                  {analytics.lastEventAtMs && (
                    <p className="text-[10px] text-muted-foreground mt-0.5">Last: {formatAgo(analytics.lastEventAtMs)}</p>
                  )}
                </div>
              </div>
              <div className="space-y-0">
                <div className="flex items-center justify-between py-2 border-b">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-red-500" />
                    <span className="text-sm">Stalls</span>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">{stallCount}</span>
                </div>
                <div className="flex items-center justify-between py-2 border-b">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-amber-500" />
                    <span className="text-sm">Skips</span>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">{skipCount}</span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-500" />
                    <span className="text-sm">Recoveries</span>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">{recoveryCount}</span>
                </div>
                {analytics.bufferUtilizationPct !== undefined && (
                  <div className="flex items-center justify-between py-2 border-t">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-blue-500" />
                      <span className="text-sm">Buffer utilization</span>
                    </div>
                    <span className={`text-sm font-semibold tabular-nums${analytics.bufferUtilizationPct > 80 ? " text-amber-600 dark:text-amber-400" : ""}`}>
                      {analytics.bufferUtilizationPct}%
                    </span>
                  </div>
                )}
              </div>
              {stallCount > 5 && (
                <div className="mt-3 flex items-center gap-2 rounded bg-amber-50 px-2.5 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                  <ShieldAlert size={13} />
                  Elevated stall rate — check source URLs and CDN connectivity.
                </div>
              )}
              {stallCount === 0 && analytics.activeSessions > 0 && (
                <div className="mt-3 flex items-center gap-2 rounded bg-green-50 px-2.5 py-2 text-xs text-green-700 dark:bg-green-950/30 dark:text-green-300">
                  <ShieldCheck size={13} />
                  Zero stalls in this session — playback healthy.
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Engine Boot & Reload Metrics */}
        {engineHealth && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Zap size={15} /> Engine Boot &amp; Reliability
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="rounded-lg bg-muted/40 p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Clock size={12} className="text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Engine uptime</span>
                  </div>
                  <p className="text-xl font-bold tabular-nums">{formatUptime(engineHealth.uptimeMs)}</p>
                </div>
                <div className="rounded-lg bg-muted/40 p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <RefreshCw size={12} className="text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Reload success</span>
                  </div>
                  <p className="text-xl font-bold tabular-nums">
                    {engineHealth.reload.attempts > 0
                      ? `${Math.round((engineHealth.reload.successes / engineHealth.reload.attempts) * 100)}%`
                      : "—"}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{engineHealth.reload.successes}/{engineHealth.reload.attempts} ok</p>
                </div>
              </div>
              <div className="space-y-0">
                <StatusRow
                  label="Bus bridge"
                  value={engineHealth.boot.busBridgeInstalled ? "installed" : "missing"}
                  ok={engineHealth.boot.busBridgeInstalled}
                />
                <StatusRow
                  label="Start attempts"
                  value={String(engineHealth.boot.startAttempts)}
                  ok={engineHealth.boot.startAttempts <= 1}
                  warn={engineHealth.boot.startAttempts > 1 && engineHealth.boot.startAttempts < 4}
                />
                <StatusRow
                  label="Sequence"
                  value={`#${engineHealth.sequence}`}
                  ok={engineHealth.sequence > 0 || engineHealth.uptimeMs < 30_000}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Network Status */}
        {networkStatus && (
          <Card className="md:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2"><Wifi size={15} /> Network Components</CardTitle>
            </CardHeader>
            <CardContent>
              {networkLoading ? (
                <div className="space-y-2">{[1,2,3,4].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
              ) : (
                <div className="grid grid-cols-2 gap-x-8">
                  <StatusRow label="Encoder" value={networkStatus.encoderStatus} ok={networkStatus.encoderStatus === "ok"} />
                  <StatusRow label="Stream" value={networkStatus.streamStatus} ok={networkStatus.streamStatus === "ok"} />
                  <StatusRow label="CDN" value={networkStatus.cdnStatus} ok={networkStatus.cdnStatus === "ok"} />
                  <StatusRow label="Players" value={networkStatus.playerStatus} ok={networkStatus.playerStatus === "ok"} />
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Source Circuit Breaker — suspended items + clear button */}
        <Card className={`md:col-span-2 ${autoSuspended.length > 0 ? "border-amber-500/40" : ""}`}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Shield size={15} /> Source Circuit Breaker
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5"
                disabled={clearBadUrlsMutation.isPending}
                onClick={() => clearBadUrlsMutation.mutate()}
              >
                {clearBadUrlsMutation.isPending
                  ? <RefreshCw size={11} className="animate-spin" />
                  : <RotateCcw size={11} />}
                Clear All Blocks
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {autoSuspended.length === 0 ? (
              <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                <ShieldCheck size={15} className="text-green-500" />
                No items currently suspended — all sources in active rotation.
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5 pb-1">
                  <Ban size={12} />
                  {autoSuspended.length} item{autoSuspended.length !== 1 ? "s" : ""} temporarily suspended due to repeated source failures — auto-recover after 5 min.
                </p>
                <div className="divide-y rounded-md border border-amber-200 dark:border-amber-900/40">
                  {autoSuspended.slice(-6).reverse().map((item) => (
                    <div key={item.itemId} className="flex items-center justify-between px-3 py-2 gap-2">
                      <span className="text-sm truncate min-w-0 flex-1">{item.title ?? item.itemId}</span>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="text-xs text-muted-foreground tabular-nums">{item.failCount}× failed</span>
                        <Badge variant="destructive" className="text-[10px]">{formatAgo(item.suspendedAtMs)}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {clearBadUrlsMutation.isSuccess && (
              <div className="mt-2 text-xs text-green-600 dark:text-green-400 flex items-center gap-1.5">
                <ShieldCheck size={12} /> All URL blocks cleared — orchestrator reloaded.
              </div>
            )}
            {clearBadUrlsMutation.isError && (
              <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                Failed to clear blocks — {(clearBadUrlsMutation.error as Error).message}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Media Integrity Scanner results */}
        {mediaScan && (
          <Card className="md:col-span-2">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <WifiOff size={15} /> Media Integrity Scanner
                </CardTitle>
                {mediaScan.scanning && (
                  <Badge variant="secondary" className="text-[10px] gap-1 flex items-center">
                    <RefreshCw size={10} className="animate-spin" /> Scanning…
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="rounded-lg bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground mb-1">Total sources</p>
                  <p className="text-xl font-bold tabular-nums">{mediaScan.totalItems}</p>
                </div>
                <div className="rounded-lg bg-green-500/10 p-3">
                  <p className="text-xs text-muted-foreground mb-1">Reachable</p>
                  <p className="text-xl font-bold tabular-nums text-green-600 dark:text-green-400">{mediaScan.reachable}</p>
                </div>
                <div className={`rounded-lg p-3 ${mediaScan.unreachable > 0 ? "bg-red-500/10" : "bg-muted/40"}`}>
                  <p className="text-xs text-muted-foreground mb-1">Unreachable</p>
                  <p className={`text-xl font-bold tabular-nums ${mediaScan.unreachable > 0 ? "text-red-600 dark:text-red-400" : ""}`}>
                    {mediaScan.unreachable}
                  </p>
                </div>
              </div>
              {mediaScan.lastScanAtMs && (
                <p className="text-xs text-muted-foreground mb-3">
                  Last scan: {formatAgo(mediaScan.lastScanAtMs)}
                  {mediaScan.scanDurationMs != null && ` · took ${Math.round(mediaScan.scanDurationMs / 1000)}s`}
                </p>
              )}
              {mediaScan.items.filter(i => !i.reachable).length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-red-600 dark:text-red-400 flex items-center gap-1.5">
                    <AlertCircle size={12} /> Unreachable sources
                  </p>
                  <div className="divide-y rounded-md border border-red-200 dark:border-red-900/40">
                    {mediaScan.items.filter(i => !i.reachable).slice(0, 6).map(item => (
                      <div key={item.id} className="flex items-start gap-2.5 px-3 py-2">
                        <WifiOff size={12} className="text-red-500 mt-0.5 flex-shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium truncate">{item.title}</p>
                          {item.url && <p className="text-[10px] text-muted-foreground truncate">{item.url}</p>}
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <Badge variant="outline" className="text-[10px] capitalize">{item.kind}</Badge>
                          {item.httpStatus != null && (
                            <Badge variant="destructive" className="text-[10px]">HTTP {item.httpStatus}</Badge>
                          )}
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap">{item.consecutiveFailures}× fail</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : mediaScan.totalItems > 0 ? (
                <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                  <ShieldCheck size={15} /> All {mediaScan.totalItems} sources are currently reachable.
                </div>
              ) : null}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
