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
import { useToast } from "@/hooks/use-toast";

type CheckStatus = "ok" | "degraded" | "critical";

interface OpsStatus {
  generatedAt: string;
  environment: string;
  overallStatus: CheckStatus;
  checks: Array<{ key: string; label: string; status: CheckStatus }>;
  metrics: {
    uptimeSecs: number;
    activeRequests: number;
    requests: Array<{ method: string; total: number; errors: number; averageMs: number }>;
  };
  cache: {
    redis: { configured: boolean; connected: boolean };
    memory: { active: boolean };
  };
  database: {
    connected: boolean;
    counts: {
      videos: number;
      localVideos: number;
      playlists: number;
      activeScheduleEntries: number;
      registeredDevices: number;
    };
  };
  broadcast: {
    activeQueueItems: number;
    inactiveQueueItems: number;
    activeLiveOverrides: number;
    connectedAdminClients: number;
  };
  videoPipeline: {
    processing: number;
    queued: number;
    done: number;
    failed: number;
    cancelled: number;
    uploadBytes: number;
    hlsBytes: number;
  };
  uploadSessions: {
    active: number;
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function statusBadge(status: CheckStatus) {
  if (status === "ok") {
    return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/25">Healthy</Badge>;
  }
  if (status === "degraded") {
    return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/25">Needs attention</Badge>;
  }
  return <Badge className="bg-red-500/15 text-red-600 border-red-500/25">Critical</Badge>;
}

function statusIcon(status: CheckStatus) {
  if (status === "ok") return <CheckCircle2 className="w-4 h-4 text-emerald-600" />;
  if (status === "degraded") return <AlertTriangle className="w-4 h-4 text-amber-600" />;
  return <XCircle className="w-4 h-4 text-red-600" />;
}

function MetricCard({
  title,
  value,
  subtext,
  icon: Icon,
}: {
  title: string;
  value: string | number;
  subtext: string;
  icon: typeof Activity;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p className="text-xs text-muted-foreground mt-1">{subtext}</p>
      </CardContent>
    </Card>
  );
}

export default function Operations() {
  const [status, setStatus] = useState<OpsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { toast } = useToast();

  const fetchStatus = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const res = await fetch("/api/admin/ops/status");
      if (!res.ok) throw new Error("Unable to load platform status");
      setStatus(await res.json() as OpsStatus);
    } catch {
      toast({ title: "Operations status unavailable", variant: "destructive" });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchStatus();
    const interval = window.setInterval(() => fetchStatus(), 10000);
    return () => window.clearInterval(interval);
  }, [fetchStatus]);

  const totalRequests = useMemo(
    () => status?.metrics.requests.reduce((total, item) => total + item.total, 0) ?? 0,
    [status],
  );
  const totalErrors = useMemo(
    () => status?.metrics.requests.reduce((total, item) => total + item.errors, 0) ?? 0,
    [status],
  );
  const pipelineTotal = status
    ? status.videoPipeline.processing + status.videoPipeline.queued + status.videoPipeline.done + status.videoPipeline.failed + status.videoPipeline.cancelled
    : 0;
  const successPercent = pipelineTotal > 0 ? Math.round((status!.videoPipeline.done / pipelineTotal) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Operations Center</h1>
          <p className="text-muted-foreground mt-1">Production readiness, streaming health, and platform telemetry.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchStatus(true)} disabled={refreshing}>
          {refreshing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
          Refresh
        </Button>
      </div>

      {loading ? (
        <Card>
          <CardContent className="p-12 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      ) : status ? (
        <>
          <Card className="overflow-hidden">
            <CardContent className="p-0">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-card border-b">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                    <ShieldCheck className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="flex items-center gap-3">
                      <h2 className="text-lg font-semibold">Platform Status</h2>
                      {statusBadge(status.overallStatus)}
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      {status.overallStatus === "ok"
                        ? "Core platform systems are operating normally."
                        : "One or more systems need operator review."}
                    </p>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  Updated {new Date(status.generatedAt).toLocaleTimeString()} · {status.environment}
                </div>
              </div>
              <div className="grid md:grid-cols-5 divide-y md:divide-y-0 md:divide-x">
                {status.checks.map((check) => (
                  <div key={check.key} className="p-4 flex items-center gap-3">
                    {statusIcon(check.status)}
                    <div>
                      <div className="text-sm font-medium">{check.label}</div>
                      <div className="text-xs text-muted-foreground capitalize">{check.status}</div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <MetricCard title="API Uptime" value={formatUptime(status.metrics.uptimeSecs)} subtext={`${status.metrics.activeRequests} active requests`} icon={Server} />
            <MetricCard title="HTTP Requests" value={totalRequests} subtext={`${totalErrors} server-side errors`} icon={Activity} />
            <MetricCard title="Registered Devices" value={status.database.counts.registeredDevices} subtext="Push notification endpoints" icon={Smartphone} />
            <MetricCard title="Broadcast Queue" value={status.broadcast.activeQueueItems} subtext={`${status.broadcast.activeLiveOverrides} live overrides active`} icon={Radio} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="w-5 h-5 text-primary" />
                  Content Database
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                {[
                  ["Videos", status.database.counts.videos],
                  ["Local uploads", status.database.counts.localVideos],
                  ["Playlists", status.database.counts.playlists],
                  ["Schedule slots", status.database.counts.activeScheduleEntries],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border bg-muted/30 p-3">
                    <div className="text-2xl font-bold">{value}</div>
                    <div className="text-xs text-muted-foreground">{label}</div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wifi className="w-5 h-5 text-primary" />
                  Cache & Streaming
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <div className="font-medium text-sm">Redis cache</div>
                    <div className="text-xs text-muted-foreground">
                      {status.cache.redis.configured ? "Configured for distributed caching" : "Using memory cache fallback"}
                    </div>
                  </div>
                  {status.cache.redis.connected ? statusBadge("ok") : status.cache.redis.configured ? statusBadge("degraded") : statusBadge("ok")}
                </div>
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <div className="font-medium text-sm">Broadcast admin clients</div>
                    <div className="text-xs text-muted-foreground">Live event connections currently open</div>
                  </div>
                  <Badge variant="outline">{status.broadcast.connectedAdminClients}</Badge>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-muted/40 p-3">
                    <div className="text-lg font-semibold">{status.broadcast.inactiveQueueItems}</div>
                    <div className="text-xs text-muted-foreground">Inactive queue items</div>
                  </div>
                  <div className="rounded-lg bg-muted/40 p-3">
                    <div className="text-lg font-semibold">{status.uploadSessions.active}</div>
                    <div className="text-xs text-muted-foreground">Active upload sessions</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <HardDrive className="w-5 h-5 text-primary" />
                Video Pipeline
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="flex items-center justify-between text-sm mb-2">
                  <span className="text-muted-foreground">Completed encodes</span>
                  <span className="font-medium">{successPercent}%</span>
                </div>
                <Progress value={successPercent} className="h-2" />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {[
                  ["Processing", status.videoPipeline.processing],
                  ["Queued", status.videoPipeline.queued],
                  ["Done", status.videoPipeline.done],
                  ["Failed", status.videoPipeline.failed],
                  ["Cancelled", status.videoPipeline.cancelled],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border p-3">
                    <div className="text-xl font-semibold">{value}</div>
                    <div className="text-xs text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>
              <div className="grid md:grid-cols-2 gap-3 pt-2">
                <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                  <HardDrive className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <div className="text-sm font-medium">{formatBytes(status.videoPipeline.uploadBytes)}</div>
                    <div className="text-xs text-muted-foreground">Uploaded media storage</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                  <Clock3 className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <div className="text-sm font-medium">{formatBytes(status.videoPipeline.hlsBytes)}</div>
                    <div className="text-xs text-muted-foreground">Adaptive streaming renditions</div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground">Operations status is unavailable.</CardContent>
        </Card>
      )}
    </div>
  );
}