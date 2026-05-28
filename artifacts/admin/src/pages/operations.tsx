import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, isTransientError } from "@/lib/api";
import { apiErrorBus } from "@/lib/api-error-bus";
import { useSSE, useSSEEvent, type SSEConnectionState } from "@/contexts/sse-context";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { MetricCard } from "@/components/shared/metric-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Cpu, RefreshCw, MemoryStick, HardDrive, Zap, Clock, Server,
  Activity, WifiOff, Wifi, Loader, AlertTriangle, Info, CheckCircle2,
  Radio, Clapperboard, Heart, Bell,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface SystemMetrics {
  cpu: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  diskUsedGb: number;
  diskTotalGb: number;
  uptimeSec: number;
  version: string;
  nodeVersion: string;
  activeSseConnections: number;
  activeWsConnections: number;
  requestsPerMinute: number;
}

interface EngineHealthSummary {
  sequence: number;
  mode: string;
  uptimeMs: number;
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
}

interface EmergencyAlert {
  id: string;
  channelId: string;
  title: string;
  message: string;
  severity: string;
  isActive: boolean;
  createdAt: string;
  expiresAt: string | null;
}

type EventSeverity = "info" | "warn" | "critical";

interface SystemEvent {
  id: string;
  ts: number;
  severity: EventSeverity;
  category: string;
  message: string;
}

const MAX_EVENTS = 50;

function mkId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function mkEvent(severity: EventSeverity, category: string, message: string, ts = Date.now()): SystemEvent {
  return { id: mkId(), ts, severity, category, message };
}

function SeverityBadge({ severity }: { severity: EventSeverity }) {
  if (severity === "critical") {
    return <Badge className="text-[10px] px-1.5 py-0 shrink-0 bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30 hover:bg-red-500/15">critical</Badge>;
  }
  if (severity === "warn") {
    return <Badge className="text-[10px] px-1.5 py-0 shrink-0 bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/15">warn</Badge>;
  }
  return <Badge className="text-[10px] px-1.5 py-0 shrink-0 bg-muted text-muted-foreground border-border hover:bg-muted">info</Badge>;
}

function CategoryIcon({ category }: { category: string }) {
  const cls = "h-3 w-3 shrink-0 mt-0.5";
  switch (category) {
    case "connection": return <Wifi className={`${cls} text-blue-500`} />;
    case "broadcast": return <Radio className={`${cls} text-red-500`} />;
    case "transcoding": return <Clapperboard className={`${cls} text-amber-500`} />;
    case "memory": return <MemoryStick className={`${cls} text-orange-500`} />;
    case "prayer": return <Heart className={`${cls} text-pink-500`} />;
    case "notification": return <Bell className={`${cls} text-blue-400`} />;
    default: return <Info className={`${cls} text-muted-foreground`} />;
  }
}

function SystemEventsLog() {
  const { state, recentActivity } = useSSE();
  const prevState = useRef<SSEConnectionState>(state);
  const [localEvents, setLocalEvents] = useState<SystemEvent[]>([]);
  const seenAlertIds = useRef(new Set<string>());

  function pushEvent(ev: SystemEvent) {
    setLocalEvents((prev) => {
      const next = [ev, ...prev];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }

  useEffect(() => {
    const prev = prevState.current;
    prevState.current = state;
    if (prev === state) return;

    if (state === "connected" && prev !== "connecting") {
      pushEvent(mkEvent("info", "connection", "Real-time connection restored"));
    } else if (state === "reconnecting") {
      pushEvent(mkEvent("warn", "connection", "Real-time connection lost — reconnecting…"));
    } else if (state === "offline") {
      pushEvent(mkEvent("critical", "connection", "Real-time connection offline — check network"));
    }
  }, [state]);

  useSSEEvent("broadcast-queue-updated", () => {
    pushEvent(mkEvent("info", "broadcast", "Broadcast queue updated"));
  });

  useSSEEvent("transcoding-update", (data) => {
    const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const status = d.status as string | undefined;
    if (status === "hls_ready") pushEvent(mkEvent("info", "transcoding", `Transcoding complete: ${d.videoTitle ?? "video"}`));
    else if (status === "failed") pushEvent(mkEvent("critical", "transcoding", `Transcoding failed: ${d.videoTitle ?? "video"}`));
    else if (status === "encoding") pushEvent(mkEvent("info", "transcoding", `Transcoding started: ${d.videoTitle ?? "video"}`));
  });

  useSSEEvent("ops-alert-sent", (data) => {
    const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    pushEvent(mkEvent("warn", "system", `System alert: ${d.message ?? "ops alert received"}`));
  });

  useSSEEvent("override-expired", () => {
    pushEvent(mkEvent("info", "broadcast", "Live override expired — broadcast resumed from queue"));
  });

  useSSEEvent("youtube-quota-throttled", () => {
    pushEvent(mkEvent("warn", "system", "YouTube API quota throttled — sync may be delayed"));
  });

  useSSEEvent("youtube-quota-exhausted", () => {
    pushEvent(mkEvent("critical", "system", "YouTube API quota exhausted — sync disabled until reset"));
  });

  useEffect(() => {
    const unsub = apiErrorBus.subscribe((ev) => {
      const label = ev.status === 0 ? "Network error" : `HTTP ${ev.status}`;
      const shortPath = ev.path.replace(/^\/api(\/v1)?/, "");
      const severity: EventSeverity = ev.status >= 500 || ev.status === 0 ? "critical" : "warn";
      pushEvent(mkEvent(severity, "system", `${label} on ${shortPath}: ${ev.message}`, ev.ts));
    });
    return unsub;
  }, []);

  const { data: engineHealth, dataUpdatedAt } = useQuery({
    queryKey: ["ops-engine-health"],
    queryFn: () => api.get<EngineHealthSummary>("/broadcast-v2/health").catch(() => null),
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const { data: emergencyAlerts } = useQuery({
    queryKey: ["ops-emergency-alerts"],
    queryFn: () => api.get<EmergencyAlert[]>("/admin/emergency").catch(() => [] as EmergencyAlert[]),
    refetchInterval: 60_000,
    staleTime: 55_000,
  });

  useEffect(() => {
    if (!emergencyAlerts) return;
    for (const alert of emergencyAlerts) {
      if (seenAlertIds.current.has(alert.id)) continue;
      seenAlertIds.current.add(alert.id);
      const severity: EventSeverity =
        alert.severity === "critical" || alert.severity === "emergency" ? "critical"
          : alert.severity === "warning" ? "warn" : "info";
      const ts = new Date(alert.createdAt).getTime();
      pushEvent(mkEvent(severity, "system", `Emergency alert: ${alert.title} — ${alert.message}`, ts));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emergencyAlerts]);

  const lastEngineErrorRef = useRef<string | null>(null);
  const lastReloadAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!engineHealth) return;

    const startErr = engineHealth.boot.lastStartError;
    if (startErr && startErr !== lastEngineErrorRef.current) {
      lastEngineErrorRef.current = startErr;
      const ts = engineHealth.boot.lastStartAttemptAtMs ?? Date.now();
      pushEvent(mkEvent("critical", "broadcast", `Broadcast engine boot error: ${startErr}`, ts));
    }

    const reloadAt = engineHealth.reload.lastReloadAtMs;
    if (reloadAt && reloadAt !== lastReloadAtRef.current) {
      lastReloadAtRef.current = reloadAt;
      if (!engineHealth.reload.lastReloadOk && engineHealth.reload.lastReloadError) {
        pushEvent(mkEvent("warn", "broadcast", `Engine reload failed: ${engineHealth.reload.lastReloadError}`, reloadAt));
      } else if (engineHealth.reload.lastReloadOk && engineHealth.reload.attempts > 1) {
        pushEvent(mkEvent("info", "broadcast", "Broadcast engine reloaded successfully", reloadAt));
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUpdatedAt]);

  const activityEvents: SystemEvent[] = recentActivity.map((a) => {
    let severity: EventSeverity = "info";
    let category = "system";
    if (a.event === "prayer-received") category = "prayer";
    else if (a.event.startsWith("transcoding")) { category = "transcoding"; if (a.event.includes("failed")) severity = "critical"; }
    else if (a.event.startsWith("broadcast") || a.event === "override-expired") category = "broadcast";
    else if (a.event.startsWith("youtube-quota")) { category = "system"; severity = a.event.includes("exhausted") ? "critical" : "warn"; }
    else if (a.event.startsWith("live-ingest")) category = "broadcast";
    else if (a.event.startsWith("notification")) category = "notification";
    return { id: `act-${a.id}`, ts: a.ts, severity, category, message: a.summary };
  });

  const allEvents = [...localEvents, ...activityEvents]
    .sort((a, b) => b.ts - a.ts)
    .filter((ev, idx, arr) => arr.findIndex((e) => e.message === ev.message && Math.abs(e.ts - ev.ts) < 500) === idx)
    .slice(0, MAX_EVENTS);

  const connectionStatusLabel =
    state === "connected" ? "Live" : state === "reconnecting" ? "Reconnecting" : state === "connecting" ? "Connecting" : "Offline";

  const connectionStatusClass =
    state === "connected"
      ? "text-green-600 dark:text-green-400"
      : state === "reconnecting" || state === "connecting"
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Activity size={15} />
            System Events
          </span>
          <div className={`flex items-center gap-1.5 text-xs font-normal ${connectionStatusClass}`}>
            {state === "connected" && <Wifi size={11} />}
            {(state === "connecting" || state === "reconnecting") && <Loader size={11} className="animate-spin" />}
            {state === "offline" && <WifiOff size={11} />}
            {connectionStatusLabel}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {allEvents.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <CheckCircle2 size={20} className="text-green-500" />
            <p className="text-sm text-muted-foreground">No events yet</p>
            <p className="text-xs text-muted-foreground/60">System events will appear here as they occur</p>
          </div>
        ) : (
          <ScrollArea className="h-[320px]">
            <div className="space-y-1 pr-2">
              {allEvents.map((ev) => (
                <div key={ev.id} className="flex items-start gap-2 py-2 border-b border-border/40 last:border-0">
                  <CategoryIcon category={ev.category} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs leading-snug">{ev.message}</p>
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                      {formatDistanceToNow(new Date(ev.ts), { addSuffix: true })}
                    </p>
                  </div>
                  <SeverityBadge severity={ev.severity} />
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

export default function OperationsPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["system-metrics"],
    queryFn: () => api.get<SystemMetrics>("/admin/system/metrics").catch(() => null),
    refetchInterval: 10_000,
    staleTime: 8_000,
  });

  const { data: readyz } = useQuery({
    queryKey: ["readyz"],
    queryFn: () => api.get<{ status: string; uptimeSec: number; version: string; dependencies: Record<string, string> }>("/readyz"),
    refetchInterval: 15_000,
    staleTime: 12_000,
  });

  const { data: engineHealth } = useQuery({
    queryKey: ["ops-engine-health"],
    queryFn: () => api.get<EngineHealthSummary>("/broadcast-v2/health").catch(() => null),
    refetchInterval: 15_000,
    staleTime: 12_000,
  });

  const memPct = data ? Math.round((data.memoryUsedMb / data.memoryTotalMb) * 100) : 0;
  const uptimeStr = readyz ? (() => {
    const s = readyz.uptimeSec;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  })() : "—";

  const isEngineStuck =
    engineHealth !== null &&
    engineHealth !== undefined &&
    engineHealth.sequence === 0 &&
    engineHealth.uptimeMs > 30_000 &&
    engineHealth.boot.busBridgeInstalled;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="Operations"
        description="System metrics, performance, and infrastructure health."
        actions={
          <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
            <RefreshCw size={13} /> Refresh
          </Button>
        }
      />

      {error && (
        <ErrorAlert
          message={(error as Error).message}
          onRetry={() => void refetch()}
          transient={isTransientError(error)}
        />
      )}

      {isEngineStuck && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-amber-700 dark:text-amber-400">Broadcast engine stuck at sequence 0</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              The broadcast orchestrator has been running for {Math.round((engineHealth?.uptimeMs ?? 0) / 1000)}s without advancing.
              {engineHealth?.boot.lastStartError && ` Last error: ${engineHealth.boot.lastStartError}`}
            </p>
          </div>
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard title="CPU Usage" value={data ? `${data.cpu}%` : null} icon={<Cpu size={16} />} loading={isLoading} highlight={data && data.cpu > 80 ? "danger" : data && data.cpu > 60 ? "warning" : undefined} />
        <MetricCard title="Memory" value={data ? `${memPct}%` : null} icon={<MemoryStick size={16} />} loading={isLoading} subtitle={data ? `${data.memoryUsedMb}MB / ${data.memoryTotalMb}MB` : undefined} highlight={memPct > 85 ? "danger" : memPct > 70 ? "warning" : undefined} />
        <MetricCard title="API Uptime" value={uptimeStr} icon={<Clock size={16} />} loading={isLoading} />
        <MetricCard
          title="Connections"
          value={data ? data.activeSseConnections + data.activeWsConnections : undefined}
          icon={<Zap size={16} />}
          loading={isLoading}
          subtitle={data ? `SSE: ${data.activeSseConnections} · WS: ${data.activeWsConnections}` : "Active right now"}
        />
      </div>

      {/* Broadcast engine quick metrics */}
      {engineHealth && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            title="Engine Uptime"
            value={(() => {
              const s = Math.round(engineHealth.uptimeMs / 1000);
              const h = Math.floor(s / 3600);
              const m = Math.floor((s % 3600) / 60);
              if (h > 0) return `${h}h ${m}m`;
              if (m > 0) return `${m}m ${s % 60}s`;
              return `${s}s`;
            })()}
            icon={<Radio size={16} />}
            loading={false}
            subtitle={isEngineStuck ? "Stuck — check Master Control" : `Sequence #${engineHealth.sequence}`}
            highlight={isEngineStuck ? "danger" : undefined}
          />
          <MetricCard
            title="Reload Reliability"
            value={engineHealth.reload.attempts > 0
              ? `${Math.round((engineHealth.reload.successes / engineHealth.reload.attempts) * 100)}%`
              : "—"}
            icon={<RefreshCw size={16} />}
            loading={false}
            subtitle={`${engineHealth.reload.successes}/${engineHealth.reload.attempts} ok`}
          />
          <MetricCard
            title="Boot Attempts"
            value={String(engineHealth.boot.startAttempts)}
            icon={<Zap size={16} />}
            loading={false}
            subtitle={engineHealth.boot.started ? "Started ok" : "Retrying…"}
            highlight={engineHealth.boot.startAttempts > 3 ? "danger" : engineHealth.boot.startAttempts > 1 ? "warning" : undefined}
          />
          <MetricCard
            title="Engine Mode"
            value={engineHealth.mode}
            icon={<Activity size={16} />}
            loading={false}
            subtitle={engineHealth.boot.busBridgeInstalled ? "Bus bridge ok" : "Bus bridge missing"}
            highlight={!engineHealth.boot.busBridgeInstalled ? "danger" : undefined}
          />
        </div>
      )}

      {/* Details */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2"><Server size={15} /> Environment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading ? (
              <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
            ) : (
              [
                { label: "API Version", value: readyz?.version ?? data?.version ?? "—" },
                { label: "Node.js", value: data?.nodeVersion ?? "—" },
                { label: "Status", value: readyz?.status ?? "—" },
                { label: "Requests/min", value: data?.requestsPerMinute != null ? String(data.requestsPerMinute) : "—" },
              ].map(row => (
                <div key={row.label} className="flex items-center justify-between py-1.5 border-b last:border-0">
                  <span className="text-sm text-muted-foreground">{row.label}</span>
                  <Badge variant="outline" className="text-xs font-mono">{row.value}</Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2"><HardDrive size={15} /> Dependencies</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {isLoading ? (
              <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
            ) : readyz?.dependencies ? (
              Object.entries(readyz.dependencies).map(([key, val]) => (
                <div key={key} className="flex items-center justify-between py-1.5 border-b last:border-0">
                  <span className="text-sm capitalize">{key}</span>
                  <Badge variant={val === "ok" ? "outline" : "destructive"} className="text-[11px]">{val}</Badge>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">No data available</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Broadcast engine health */}
      {engineHealth && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2"><Radio size={15} /> Broadcast Engine</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Sequence", value: String(engineHealth.sequence) },
                { label: "Mode", value: engineHealth.mode },
                { label: "Uptime", value: (() => { const s = Math.round(engineHealth.uptimeMs / 1000); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; })() },
                { label: "Reload success", value: `${engineHealth.reload.successes}/${engineHealth.reload.attempts}` },
              ].map(row => (
                <div key={row.label} className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">{row.label}</span>
                  <Badge variant="outline" className="text-xs font-mono w-fit">{row.value}</Badge>
                </div>
              ))}
            </div>
            {engineHealth.boot.lastStartError && (
              <p className="mt-3 text-xs text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2">
                Last boot error: {engineHealth.boot.lastStartError}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* System events log */}
      <SystemEventsLog />
    </div>
  );
}
