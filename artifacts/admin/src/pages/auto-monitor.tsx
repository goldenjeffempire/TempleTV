import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  CheckCircle2, XCircle, AlertTriangle, RefreshCw, Bot,
  Clock, Zap, Server, Timer, CircleDot, Radio, Ban,
  CircuitBoard, HeartPulse, Layers, Eye, OctagonAlert,
  TrendingUp, Terminal, Wifi, Siren, CircleCheck, MemoryStick,
  Gauge,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────

interface ActiveAlert {
  id: string;
  service: string;
  code: string;
  severity: "warn" | "error" | "critical";
  message: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
}

interface ServiceStatus {
  name: string;
  label: string;
  status: "healthy" | "degraded" | "critical" | "unknown";
  detail: string;
  lastCheckedAt: number;
}

interface AutoHealAction {
  id: string;
  timestamp: number;
  service: string;
  action: string;
  severity: "info" | "warn" | "error" | "critical";
  result: "triggered" | "skipped" | "failed" | "noop";
  details: string;
}

interface AutoHealMetrics {
  broadcastSequence: number;
  broadcastItemCount: number;
  broadcastMode: string;
  sequenceAdvanceAgeMs: number;
  deadAirOpenMs: number | null;
  memoryRssMb: number;
  memoryWarnMb: number;
  memoryRestartMb: number;
  workerHealthyCount: number;
  workerTotalCount: number;
  autonomyScore: number;
}

interface AutoHealStatus {
  monitorStartedAt: number;
  lastScanAt: number | null;
  scanCount: number;
  totalActionsTriggered: number;
  activeAlerts: ActiveAlert[];
  services: ServiceStatus[];
  recentActions: AutoHealAction[];
  metrics: AutoHealMetrics;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function msToHuman(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function statusColor(status: ServiceStatus["status"]): string {
  switch (status) {
    case "healthy": return "text-emerald-500";
    case "degraded": return "text-amber-500";
    case "critical": return "text-red-500";
    default: return "text-muted-foreground";
  }
}

function statusBg(status: ServiceStatus["status"]): string {
  switch (status) {
    case "healthy": return "border-emerald-500/30 bg-emerald-500/5";
    case "degraded": return "border-amber-500/30 bg-amber-500/5";
    case "critical": return "border-red-500/30 bg-red-500/5 animate-pulse-subtle";
    default: return "border-border bg-muted/30";
  }
}

function statusIcon(status: ServiceStatus["status"], size = 16) {
  switch (status) {
    case "healthy": return <CheckCircle2 size={size} className="text-emerald-500 shrink-0" />;
    case "degraded": return <AlertTriangle size={size} className="text-amber-500 shrink-0" />;
    case "critical": return <XCircle size={size} className="text-red-500 shrink-0" />;
    default: return <CircleDot size={size} className="text-muted-foreground shrink-0" />;
  }
}

function severityColor(sev: AutoHealAction["severity"]): string {
  switch (sev) {
    case "critical": return "text-red-400";
    case "error": return "text-orange-400";
    case "warn": return "text-amber-400";
    default: return "text-muted-foreground";
  }
}

function resultBadge(result: AutoHealAction["result"]) {
  switch (result) {
    case "triggered":
      return <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-400 bg-emerald-500/10">triggered</Badge>;
    case "failed":
      return <Badge variant="outline" className="text-[10px] border-red-500/40 text-red-400 bg-red-500/10">failed</Badge>;
    case "skipped":
      return <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-400 bg-amber-500/10">skipped</Badge>;
    default:
      return <Badge variant="outline" className="text-[10px] text-muted-foreground">noop</Badge>;
  }
}

function alertSeverityStyles(sev: ActiveAlert["severity"]) {
  switch (sev) {
    case "critical": return "border-red-500/40 bg-red-500/10 text-red-400";
    case "error": return "border-orange-500/40 bg-orange-500/10 text-orange-400";
    default: return "border-amber-500/40 bg-amber-500/10 text-amber-400";
  }
}

function serviceIcon(name: string) {
  const cls = "shrink-0";
  switch (name) {
    case "broadcast": return <Radio size={18} className={cls} />;
    case "queue": return <Layers size={18} className={cls} />;
    case "workers": return <CircuitBoard size={18} className={cls} />;
    case "memory": return <MemoryStick size={18} className={cls} />;
    case "dead-air": return <Wifi size={18} className={cls} />;
    case "autonomy": return <Gauge size={18} className={cls} />;
    default: return <Server size={18} className={cls} />;
  }
}

function overallStatus(services: ServiceStatus[]): "healthy" | "degraded" | "critical" | "unknown" {
  if (!services.length) return "unknown";
  if (services.some((s) => s.status === "critical")) return "critical";
  if (services.some((s) => s.status === "degraded")) return "degraded";
  return "healthy";
}

// ── Sub-components ─────────────────────────────────────────────────────────

function ServiceCard({ svc }: { svc: ServiceStatus }) {
  return (
    <div className={cn("rounded-lg border p-4 flex flex-col gap-2 transition-all", statusBg(svc.status))}>
      <div className="flex items-center gap-2">
        <span className={statusColor(svc.status)}>{serviceIcon(svc.name)}</span>
        <span className="text-sm font-medium leading-tight">{svc.label}</span>
        <span className="ml-auto">{statusIcon(svc.status, 14)}</span>
      </div>
      <p className="text-xs text-muted-foreground leading-snug">{svc.detail}</p>
      <p className="text-[10px] text-muted-foreground/60">
        checked {formatDistanceToNow(svc.lastCheckedAt, { addSuffix: true })}
      </p>
    </div>
  );
}

function AlertCard({ alert }: { alert: ActiveAlert }) {
  return (
    <div className={cn("rounded-lg border px-4 py-3 flex items-start gap-3", alertSeverityStyles(alert.severity))}>
      {alert.severity === "critical"
        ? <Siren size={15} className="shrink-0 mt-0.5" />
        : <OctagonAlert size={15} className="shrink-0 mt-0.5" />}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold">{alert.code}</span>
          <span className="text-[10px] opacity-70 font-mono">{alert.service}</span>
          {alert.count > 1 && (
            <span className="text-[10px] opacity-60">×{alert.count}</span>
          )}
        </div>
        <p className="text-xs opacity-80 mt-0.5 leading-snug">{alert.message}</p>
        <p className="text-[10px] opacity-50 mt-1">
          since {format(alert.firstSeenAt, "HH:mm:ss")}
          {alert.lastSeenAt !== alert.firstSeenAt && ` · last ${format(alert.lastSeenAt, "HH:mm:ss")}`}
        </p>
      </div>
    </div>
  );
}

function ActionRow({ action }: { action: AutoHealAction }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="border-b border-border/40 last:border-0 py-2.5 px-3 cursor-pointer hover:bg-muted/30 transition-colors"
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex items-start gap-2">
        <span className={cn("text-[10px] font-mono tabular-nums shrink-0 mt-0.5 text-muted-foreground/60 w-16")}>
          {format(action.timestamp, "HH:mm:ss")}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("text-xs font-medium", severityColor(action.severity))}>{action.action}</span>
            {resultBadge(action.result)}
            <span className="text-[10px] text-muted-foreground/60 font-mono">{action.service}</span>
          </div>
          {expanded && (
            <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug font-mono bg-muted/30 rounded p-2">
              {action.details}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricChip({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5 flex flex-col gap-0.5">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className={cn("text-base font-bold tabular-nums", color ?? "text-foreground")}>{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function AutoMonitorPage() {
  const qc = useQueryClient();
  const [liveActions, setLiveActions] = useState<AutoHealAction[]>([]);
  const [, setLastTick] = useState<number>(Date.now());
  const liveActionsRef = useRef(liveActions);
  liveActionsRef.current = liveActions;

  const { data: status, isFetching, dataUpdatedAt } = useQuery<AutoHealStatus>({
    queryKey: ["autoheal-status"],
    queryFn: () => api.get<AutoHealStatus>("/api/broadcast-v2/autoheal/status"),
    refetchInterval: 5_000,
    staleTime: 4_000,
  });

  const triggerMutation = useMutation({
    mutationFn: () => api.post<{ ok: boolean; triggeredAt: number }>("/api/broadcast-v2/autoheal/trigger"),
    onSuccess: () => {
      toast.success("Manual scan triggered — checking all subsystems…");
      void qc.invalidateQueries({ queryKey: ["autoheal-status"] });
    },
    onError: () => toast.error("Failed to trigger manual scan"),
  });

  const onAction = useCallback((data: unknown) => {
    const action = data as AutoHealAction;
    setLiveActions((prev) => {
      const next = [action, ...prev];
      if (next.length > 200) next.length = 200;
      return next;
    });
    setLastTick(Date.now());
  }, []);

  const onTick = useCallback(() => {
    setLastTick(Date.now());
    void qc.invalidateQueries({ queryKey: ["autoheal-status"] });
  }, [qc]);

  useSSEEvent("autoheal-action", onAction);
  useSSEEvent("autoheal-status-tick", onTick);

  useEffect(() => {
    if (status?.recentActions.length) {
      setLiveActions((prev) => {
        const prevIds = new Set(prev.map((a) => a.id));
        const newItems = status.recentActions.filter((a) => !prevIds.has(a.id));
        if (!newItems.length) return prev;
        const merged = [...newItems, ...prev].sort((a, b) => b.timestamp - a.timestamp);
        if (merged.length > 200) merged.length = 200;
        return merged;
      });
    }
  }, [status?.recentActions]);

  const overall = overallStatus(status?.services ?? []);
  const metrics = status?.metrics;
  const activeAlerts = status?.activeAlerts ?? [];

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-10 h-10 rounded-xl flex items-center justify-center border",
            overall === "healthy" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
              : overall === "degraded" ? "border-amber-500/30 bg-amber-500/10 text-amber-500"
              : overall === "critical" ? "border-red-500/30 bg-red-500/10 text-red-500"
              : "border-border bg-muted/30 text-muted-foreground",
          )}>
            <Bot size={20} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold">Auto-Heal Monitor</h1>
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] font-semibold",
                  overall === "healthy" ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
                    : overall === "degraded" ? "border-amber-500/40 text-amber-400 bg-amber-500/10"
                    : overall === "critical" ? "border-red-500/40 text-red-400 bg-red-500/10"
                    : "text-muted-foreground",
                )}
              >
                {overall.toUpperCase()}
              </Badge>
              {isFetching && <RefreshCw size={12} className="text-muted-foreground animate-spin" />}
            </div>
            <p className="text-sm text-muted-foreground">
              5-second self-healing broadcast watchdog · {status?.scanCount ?? 0} scans · {status?.totalActionsTriggered ?? 0} auto-actions
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => qc.invalidateQueries({ queryKey: ["autoheal-status"] })}
            className="gap-1.5 h-8"
          >
            <RefreshCw size={13} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => triggerMutation.mutate()}
            disabled={triggerMutation.isPending}
            className="gap-1.5 h-8"
          >
            <Zap size={13} />
            {triggerMutation.isPending ? "Scanning…" : "Trigger Scan"}
          </Button>
        </div>
      </div>

      {/* ── Active Alerts ────────────────────────────────────────────────── */}
      {activeAlerts.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Siren size={13} className="text-red-400" />
            <span className="text-xs font-semibold text-red-400">Active Alerts</span>
            <Badge variant="outline" className="text-[10px] border-red-500/40 text-red-400 bg-red-500/10">
              {activeAlerts.length}
            </Badge>
          </div>
          <div className="flex flex-col gap-1.5">
            {activeAlerts.map((alert) => (
              <AlertCard key={alert.id} alert={alert} />
            ))}
          </div>
        </div>
      )}

      {/* ── Service Health Grid ──────────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <HeartPulse size={13} className="text-muted-foreground" />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Service Health</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
          {(status?.services ?? []).map((svc) => (
            <ServiceCard key={svc.name} svc={svc} />
          ))}
          {!status && Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-border/50 bg-muted/20 p-4 h-24 animate-pulse" />
          ))}
        </div>
      </div>

      {/* ── Metrics + Feed ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">

        {/* Metrics panel */}
        <div className="xl:col-span-2 flex flex-col gap-4">
          <Card className="border-border/60">
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <TrendingUp size={14} className="text-muted-foreground" />
                Live Metrics
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="grid grid-cols-2 gap-2">
                <MetricChip
                  label="Autonomy Score"
                  value={`${metrics?.autonomyScore ?? 0}%`}
                  sub={`${metrics?.workerHealthyCount ?? 0}/${metrics?.workerTotalCount ?? 0} workers`}
                  color={
                    (metrics?.autonomyScore ?? 0) === 100 ? "text-emerald-400"
                      : (metrics?.autonomyScore ?? 0) >= 75 ? "text-amber-400"
                      : "text-red-400"
                  }
                />
                <MetricChip
                  label="Broadcast Seq"
                  value={metrics?.broadcastSequence ?? 0}
                  sub={`${metrics?.broadcastItemCount ?? 0} items`}
                />
                <MetricChip
                  label="Seq Age"
                  value={metrics ? msToHuman(metrics.sequenceAdvanceAgeMs) : "—"}
                  sub="since last advance"
                  color={
                    (metrics?.sequenceAdvanceAgeMs ?? 0) > 90_000 ? "text-red-400"
                      : (metrics?.sequenceAdvanceAgeMs ?? 0) > 60_000 ? "text-amber-400"
                      : "text-foreground"
                  }
                />
                <MetricChip
                  label="Dead Air"
                  value={metrics?.deadAirOpenMs != null ? msToHuman(metrics.deadAirOpenMs) : "None"}
                  sub="current incident"
                  color={metrics?.deadAirOpenMs != null ? "text-red-400" : "text-emerald-400"}
                />
                <MetricChip
                  label="RSS Memory"
                  value={`${metrics?.memoryRssMb ?? 0} MB`}
                  sub={`warn ${metrics?.memoryWarnMb ?? 1500} MB`}
                  color={
                    (metrics?.memoryRssMb ?? 0) > (metrics?.memoryWarnMb ?? 1500) ? "text-red-400"
                      : (metrics?.memoryRssMb ?? 0) > (metrics?.memoryWarnMb ?? 1500) * 0.8 ? "text-amber-400"
                      : "text-foreground"
                  }
                />
                <MetricChip
                  label="Mode"
                  value={metrics?.broadcastMode ?? "—"}
                  sub="orchestrator mode"
                />
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/60">
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <Timer size={14} className="text-muted-foreground" />
                Monitor Stats
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="flex flex-col gap-2 text-sm">
                <div className="flex justify-between items-center border-b border-border/30 pb-2">
                  <span className="text-muted-foreground text-xs">Total scans</span>
                  <span className="font-mono font-semibold">{status?.scanCount ?? 0}</span>
                </div>
                <div className="flex justify-between items-center border-b border-border/30 pb-2">
                  <span className="text-muted-foreground text-xs">Auto-actions taken</span>
                  <span className="font-mono font-semibold text-emerald-400">{status?.totalActionsTriggered ?? 0}</span>
                </div>
                <div className="flex justify-between items-center border-b border-border/30 pb-2">
                  <span className="text-muted-foreground text-xs">Active alerts</span>
                  <span className={cn("font-mono font-semibold", activeAlerts.length > 0 ? "text-red-400" : "text-emerald-400")}>
                    {activeAlerts.length}
                  </span>
                </div>
                <div className="flex justify-between items-center border-b border-border/30 pb-2">
                  <span className="text-muted-foreground text-xs">Last scan</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {status?.lastScanAt ? formatDistanceToNow(status.lastScanAt, { addSuffix: true }) : "—"}
                  </span>
                </div>
                <div className="flex justify-between items-center border-b border-border/30 pb-2">
                  <span className="text-muted-foreground text-xs">Monitor uptime</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {status?.monitorStartedAt ? msToHuman(Date.now() - status.monitorStartedAt) : "—"}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground text-xs">Scan interval</span>
                  <span className="font-mono text-xs">5 s</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Live action feed */}
        <Card className="xl:col-span-3 border-border/60 flex flex-col min-h-0">
          <CardHeader className="pb-3 pt-4 px-4 shrink-0">
            <CardTitle className="text-sm flex items-center gap-2">
              <Terminal size={14} className="text-muted-foreground" />
              Automated Action Log
              <span className="ml-auto flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-[10px] text-muted-foreground font-normal">live</span>
              </span>
            </CardTitle>
            <CardDescription className="text-xs">
              All automated remediation actions taken by the watchdog. Click any row to expand details.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0 flex-1 overflow-hidden">
            <div className="h-full max-h-[520px] overflow-y-auto">
              {liveActions.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
                  <CircleCheck size={32} className="text-emerald-500/40" />
                  <p className="text-sm">No actions yet — all systems nominal</p>
                  <p className="text-xs opacity-60">Actions appear here in real-time as the monitor detects and resolves issues</p>
                </div>
              )}
              {liveActions.map((action) => (
                <ActionRow key={action.id} action={action} />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── What This Monitors ───────────────────────────────────────────── */}
      <Card className="border-border/40 bg-muted/10">
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <Eye size={14} className="text-muted-foreground" />
            What This Monitors (Every 5 Seconds)
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            {[
              {
                icon: <Radio size={14} />,
                title: "Broadcast Stuck",
                desc: "Sequence not advancing > 90s while queue has items → auto-reload orchestrator",
                color: "text-blue-400",
              },
              {
                icon: <Wifi size={14} />,
                title: "Dead Air",
                desc: "Channel offline > 30s → force-reload to restore broadcast stream",
                color: "text-red-400",
              },
              {
                icon: <Layers size={14} />,
                title: "Empty Queue",
                desc: "Active queue reaches 0 items → trigger full library scan + auto-enqueue",
                color: "text-orange-400",
              },
              {
                icon: <Ban size={14} />,
                title: "All Items Blocked",
                desc: "Every queue item suspended/blocked → bulk re-enable + reload",
                color: "text-amber-400",
              },
              {
                icon: <CircuitBoard size={14} />,
                title: "Worker Circuits",
                desc: "Critical worker circuit opens → immediate ops-alert pushed to admin",
                color: "text-purple-400",
              },
              {
                icon: <MemoryStick size={14} />,
                title: "Memory Pressure",
                desc: "RSS exceeds warn threshold → alert with details (GC handled by watchdog)",
                color: "text-cyan-400",
              },
              {
                icon: <Gauge size={14} />,
                title: "Autonomy Score",
                desc: "Tracks % of critical workers healthy; score < 100% triggers diagnostic mode",
                color: "text-emerald-400",
              },
              {
                icon: <Server size={14} />,
                title: "Orchestrator Boot",
                desc: "Orchestrator not started 2+ min after boot → critical alert with boot diagnostics",
                color: "text-indigo-400",
              },
            ].map((item) => (
              <div key={item.title} className="flex gap-2.5 p-3 rounded-lg border border-border/40 bg-background/50">
                <span className={cn("shrink-0 mt-0.5", item.color)}>{item.icon}</span>
                <div>
                  <p className="text-xs font-medium">{item.title}</p>
                  <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Last updated ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground/50">
        <Clock size={11} />
        Last updated {dataUpdatedAt ? format(dataUpdatedAt, "HH:mm:ss") : "—"} · auto-refreshes every 5 s
      </div>
    </div>
  );
}
