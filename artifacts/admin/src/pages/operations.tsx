import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  HardDrive,
  Loader2,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
  Wifi,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { opsApi, type OpsStatus } from "@/services/adminApi";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { MetricCard } from "@/components/shared/metric-card";
import { useRecentSSEEvents, useSSE } from "@/contexts/SSEContext";

type CheckStatus = "ok" | "degraded" | "critical";

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function StatusBadge({ status }: { status: CheckStatus }) {
  if (status === "ok") {
    return <Badge className="bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-400">Healthy</Badge>;
  }
  if (status === "degraded") {
    return <Badge className="bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400">Degraded</Badge>;
  }
  return <Badge className="bg-red-500/15 text-red-700 border-red-500/30 dark:text-red-400">Critical</Badge>;
}

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === "ok") return <CheckCircle2 className="w-4 h-4 text-emerald-600" />;
  if (status === "degraded") return <AlertTriangle className="w-4 h-4 text-amber-600" />;
  return <XCircle className="w-4 h-4 text-red-600" />;
}

function OverallStatusCard({ status }: { status: OpsStatus }) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-card border-b">
          <div className="flex items-start gap-4">
            <div className="w-11 h-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-base font-semibold">Platform Status</h2>
                <StatusBadge status={status.overallStatus} />
              </div>
              <p className="text-sm text-muted-foreground mt-0.5">
                {status.overallStatus === "ok"
                  ? "All core systems operating normally."
                  : "One or more systems require operator review."}
              </p>
            </div>
          </div>
          <div className="text-xs text-muted-foreground shrink-0">
            Updated {new Date(status.generatedAt).toLocaleTimeString()} · {status.environment}
          </div>
        </div>
        {status.checks.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x">
            {status.checks.map((check) => (
              <div key={check.key} className="p-4 flex items-center gap-2.5">
                <StatusIcon status={check.status} />
                <div>
                  <div className="text-sm font-medium">{check.label}</div>
                  <div className="text-xs text-muted-foreground capitalize">{check.status}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function eventBadge(event: string) {
  switch (event) {
    case "status":
      return <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-400 text-[10px]">status</Badge>;
    case "broadcast-control-updated":
      return <Badge variant="outline" className="border-red-500/40 text-red-700 dark:text-red-400 text-[10px]">control</Badge>;
    case "broadcast-queue-updated":
      return <Badge variant="outline" className="border-blue-500/40 text-blue-700 dark:text-blue-400 text-[10px]">queue</Badge>;
    case "override-expired":
      return <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400 text-[10px]">override</Badge>;
    default:
      return <Badge variant="outline" className="text-[10px]">{event}</Badge>;
  }
}

function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function ActivityFeedCard() {
  const events = useRecentSSEEvents();
  const { state } = useSSE();
  // Force re-render every 15s so relative times stay fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Activity className="w-4 h-4 text-primary" />
          Operational Activity Feed
          <Badge
            variant="outline"
            className={
              state === "connected"
                ? "ml-auto border-emerald-500/40 text-emerald-700 dark:text-emerald-400 text-[10px]"
                : state === "reconnecting" || state === "connecting"
                  ? "ml-auto border-amber-500/40 text-amber-700 dark:text-amber-400 text-[10px]"
                  : "ml-auto border-muted text-muted-foreground text-[10px]"
            }
          >
            {state}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center border border-dashed rounded-md bg-muted/10">
            Listening for live broadcast events…
          </div>
        ) : (
          <ul className="divide-y max-h-72 overflow-y-auto -mx-1">
            {events.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-2 px-1">
                {eventBadge(entry.event)}
                <span className="flex-1 text-sm truncate">{entry.summary}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                  {relativeTime(entry.ts)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function Operations() {
  const [status, setStatus] = useState<OpsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const data = await opsApi.getStatus();
      setStatus(data);
      setError(null);
    } catch (err: unknown) {
      setError((err as Error)?.message ?? "Unable to load platform status");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const id = window.setInterval(() => loadStatus(), 10_000);
    return () => window.clearInterval(id);
  }, [loadStatus]);

  const totalRequests = useMemo(
    () => status?.metrics.requests.reduce((t, r) => t + r.total, 0) ?? 0,
    [status],
  );
  const totalErrors = useMemo(
    () => status?.metrics.requests.reduce((t, r) => t + r.errors, 0) ?? 0,
    [status],
  );

  const pipeline = status?.videoPipeline;
  const pipelineTotal = pipeline
    ? pipeline.processing + pipeline.queued + pipeline.done + pipeline.failed + pipeline.cancelled
    : 0;
  const successPct = pipelineTotal > 0
    ? Math.round((pipeline!.done / pipelineTotal) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operations Center"
        description="Production readiness, streaming health, and platform telemetry."
        actions={
          <Button variant="outline" size="sm" onClick={() => loadStatus(true)} disabled={refreshing}>
            {refreshing
              ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              : <RefreshCw className="w-4 h-4 mr-2" />}
            Refresh
          </Button>
        }
      />

      {error && (
        <ErrorAlert
          title="Operations status unavailable"
          message={error}
          onRetry={() => loadStatus(true)}
        />
      )}

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-36 rounded-xl" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : status ? (
        <>
          <OverallStatusCard status={status} />

          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title="API Uptime"
              value={formatUptime(status.metrics.uptimeSecs)}
              subtitle={`${status.metrics.activeRequests} active requests`}
              icon={<Server className="h-4 w-4" />}
            />
            <MetricCard
              title="HTTP Requests"
              value={totalRequests.toLocaleString()}
              subtitle={`${totalErrors} server errors`}
              icon={<Activity className="h-4 w-4" />}
              highlight={totalErrors > 0 ? "warning" : undefined}
            />
            <MetricCard
              title="Registered Devices"
              value={status.database.counts.registeredDevices.toLocaleString()}
              subtitle="Push notification endpoints"
              icon={<Smartphone className="h-4 w-4" />}
            />
            <MetricCard
              title="Broadcast Queue"
              value={status.broadcast.activeQueueItems}
              subtitle={`${status.broadcast.activeLiveOverrides} live override(s) active`}
              icon={<Radio className="h-4 w-4" />}
              highlight={status.broadcast.activeLiveOverrides > 0 ? "danger" : undefined}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Database className="w-4 h-4 text-primary" />
                  Content Database
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                {[
                  { label: "Videos", value: status.database.counts.videos, href: "/videos" },
                  { label: "Local uploads", value: status.database.counts.localVideos, href: "/videos" },
                  { label: "Playlists", value: status.database.counts.playlists, href: "/playlists" },
                  { label: "Schedule slots", value: status.database.counts.activeScheduleEntries, href: "/schedule" },
                ].map(({ label, value, href }) => (
                  <Link
                    key={label}
                    href={href}
                    className="rounded-lg border bg-muted/30 p-3 block hover:bg-muted hover:border-primary/30 transition-colors group"
                  >
                    <div className="text-xl font-bold group-hover:text-primary transition-colors">{value}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
                  </Link>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Wifi className="w-4 h-4 text-primary" />
                  Cache & Streaming
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <div className="font-medium text-sm">Redis cache</div>
                    <div className="text-xs text-muted-foreground">
                      {status.cache.redis.configured
                        ? "Configured — distributed caching"
                        : "Memory cache fallback (no Redis)"}
                    </div>
                  </div>
                  <StatusBadge
                    status={
                      status.cache.redis.connected
                        ? "ok"
                        : status.cache.redis.configured
                          ? "degraded"
                          : "ok"
                    }
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-muted/40 p-3">
                    <div className="text-lg font-semibold">{status.broadcast.connectedAdminClients}</div>
                    <div className="text-xs text-muted-foreground">Admin SSE clients</div>
                  </div>
                  <div className="rounded-lg bg-muted/40 p-3">
                    <div className="text-lg font-semibold">{status.uploadSessions.active}</div>
                    <div className="text-xs text-muted-foreground">Active upload sessions</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <ActivityFeedCard />

          {pipeline && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <HardDrive className="w-4 h-4 text-primary" />
                  Video Pipeline
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="flex items-center justify-between text-sm mb-2">
                    <span className="text-muted-foreground">Successful encodes</span>
                    <span className="font-semibold">{successPct}%</span>
                  </div>
                  <Progress value={successPct} className="h-2" />
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  {[
                    { label: "Processing", value: pipeline.processing, href: "/transcoding", danger: false },
                    { label: "Queued", value: pipeline.queued, href: "/transcoding", danger: false },
                    { label: "Done", value: pipeline.done, href: "/transcoding", danger: false },
                    { label: "Failed", value: pipeline.failed, href: "/transcoding", danger: pipeline.failed > 0 },
                    { label: "Cancelled", value: pipeline.cancelled, href: "/transcoding", danger: false },
                  ].map(({ label, value, href, danger }) => (
                    <Link
                      key={label}
                      href={href}
                      className={`rounded-lg border p-3 block hover:border-primary/40 hover:bg-muted/40 transition-colors group ${danger ? "border-red-500/30 bg-red-500/5" : ""}`}
                    >
                      <div className={`text-xl font-semibold group-hover:text-primary transition-colors ${danger ? "text-red-600" : ""}`}>
                        {value}
                      </div>
                      <div className="text-xs text-muted-foreground">{label}</div>
                    </Link>
                  ))}
                </div>
                <div className="grid md:grid-cols-2 gap-3 pt-1">
                  <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                    <HardDrive className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div>
                      <div className="text-sm font-medium">{formatBytes(pipeline.uploadBytes)}</div>
                      <div className="text-xs text-muted-foreground">Uploaded media storage</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                    <Clock3 className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div>
                      <div className="text-sm font-medium">{formatBytes(pipeline.hlsBytes)}</div>
                      <div className="text-xs text-muted-foreground">Adaptive streaming renditions</div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {status.metrics.requests.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Activity className="w-4 h-4 text-primary" />
                  Request Metrics
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b">
                        <th className="pb-2 font-medium">Method / Route</th>
                        <th className="pb-2 font-medium text-right">Total</th>
                        <th className="pb-2 font-medium text-right">Errors</th>
                        <th className="pb-2 font-medium text-right">Avg ms</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {status.metrics.requests.map((r, i) => (
                        <tr key={i}>
                          <td className="py-2 font-mono text-xs">{r.method}</td>
                          <td className="py-2 text-right tabular-nums">{r.total.toLocaleString()}</td>
                          <td className={`py-2 text-right tabular-nums ${r.errors > 0 ? "text-red-500" : ""}`}>
                            {r.errors}
                          </td>
                          <td className="py-2 text-right tabular-nums text-muted-foreground">{r.averageMs}ms</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      ) : !error ? (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground">
            Operations status is unavailable.
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
