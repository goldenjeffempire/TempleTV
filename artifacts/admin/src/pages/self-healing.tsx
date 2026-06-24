import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Bot,
  ShieldCheck,
  ShieldAlert,
  Wrench,
  Clock,
  Zap,
  RotateCw,
  Trash2,
  Play,
  CheckCheck,
  Activity,
  Server,
  Timer,
  CircleDot,
  Database,
  Cpu,
  Radio,
  Ban,
  PlugZap,
  CircuitBoard,
  ScanSearch,
  FlameKindling,
  ShieldOff,
  ArrowUpRight,
  HeartPulse,
  Layers,
  ListChecks,
  Eye,
  Pause,
  OctagonAlert,
  TrendingUp,
  Gauge,
  Terminal,
  Wifi,
  WifiOff,
  Siren,
  CircleCheck,
  LayoutDashboard,
} from "lucide-react";
import { formatDistanceToNow, formatDistance, format } from "date-fns";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface WorkerStatus {
  name: string;
  state: "running" | "circuit_open" | "stopped";
  running: boolean;
  circuitOpen: boolean;
  consecutiveFailures: number;
  totalRuns: number;
  totalErrors: number;
  lastRunAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastErrorAtMs: number | null;
  lastError: string | null;
  nextRunAtMs: number | null;
  circuitAutoResetAtMs: number | null;
}

interface AssetHealthSummary {
  healthy: number;
  quarantined: number;
  repairing: number;
  approved: number;
  blocked: number;
  total: number;
}

interface BlockedItem {
  queueItemId: string;
  queueItemTitle: string | null;
  state: string;
  lastErrorCode: string | null;
  lastError: string | null;
  suggestedFix: string | null;
  repairAttempts: number;
  lastRepairAt: string | null;
  nextRetryAt: string | null;
  autoRepairPaused: boolean;
}

interface RepairLogItem extends BlockedItem {
  latestLogEntry: {
    ts: string;
    actor: string;
    action: string;
    detail: string;
    outcome: string;
  } | null;
}

interface AutomationStatus {
  generatedAtMs: number;
  workers: WorkerStatus[];
  workerSummary: {
    total: number;
    running: number;
    circuitOpen: number;
    stopped: number;
  };
  assetHealth: AssetHealthSummary;
  blockedItems: BlockedItem[];
  recentRepairLog: RepairLogItem[];
  badUrlStats: {
    cachedBadUrls: number;
    sourceSetSize: number;
  };
  selfHealingWorker: {
    lastScanMs: number;
    isRunning: boolean;
    nextRevalidationAt: number | null;
  };
}

interface OpsStatus {
  db?: { healthy: boolean; poolActive?: number; poolMax?: number };
  storage?: { healthy: boolean };
  memory?: { rssBytes?: number; heapUsedBytes?: number };
  broadcast?: { healthy?: boolean; mode?: string };
}

interface RecoveryLogEntry {
  ts: number;
  type: "info" | "warn" | "error" | "success";
  message: string;
  detail?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ms(n: number | null | undefined): string {
  if (n == null) return "—";
  return formatDistanceToNow(new Date(n), { addSuffix: true });
}

function stateColor(state: string): string {
  switch (state) {
    case "healthy": case "approved": return "bg-emerald-500";
    case "quarantined": return "bg-amber-500";
    case "repairing": return "bg-blue-500";
    case "blocked": return "bg-red-500";
    default: return "bg-zinc-500";
  }
}

function outcomeIcon(outcome: string) {
  if (outcome === "success") return <CheckCircle2 size={12} className="text-emerald-400" />;
  if (outcome === "failure") return <XCircle size={12} className="text-red-400" />;
  if (outcome === "pending") return <CircleDot size={12} className="text-blue-400" />;
  return <AlertTriangle size={12} className="text-amber-400" />;
}

function actionLabel(action: string): string {
  const map: Record<string, string> = {
    quarantined: "Quarantined",
    repair_started: "Repair started",
    repair_success: "Repaired",
    repair_failure: "Repair failed",
    blocked: "Blocked",
    auto_unblocked: "Auto-unblocked",
    approved: "Approved",
    reset: "Reset",
    stuck_repairing_recovered: "Stuck state recovered",
  };
  return map[action] ?? action.replace(/_/g, " ");
}

function workerDisplayName(name: string): string {
  const map: Record<string, string> = {
    "refresh-token-pruner": "Token Pruner",
    "notification-stuck-recovery": "Notif Recovery",
    "storage-reconciliation": "Storage Reconcile",
    "thumbnail-sweep": "Thumbnail Sweep",
    "content-scheduling": "Content Schedule",
    "broadcast-health-monitor": "Broadcast Monitor",
    "queue-self-healing": "Queue Self-Heal",
    "media-integrity-scanner": "Media Scanner",
    "dead-air-tracker": "Dead Air Tracker",
    "orphan-cleanup": "Orphan Cleanup",
    "faststart-recovery": "Faststart Recovery",
    "transcoding-auto-retry": "Transcode Retry",
    "content-rotation": "Content Rotation",
    "queue-exhaustion-monitor": "Queue Exhaustion",
  };
  return map[name] ?? name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function computeHealthScore(data: AutomationStatus): number {
  let score = 100;
  const { assetHealth, workerSummary } = data;
  if (assetHealth.total > 0) {
    const unhealthyFraction = (assetHealth.blocked + assetHealth.quarantined * 0.5) / assetHealth.total;
    score -= Math.min(40, unhealthyFraction * 40);
  }
  if (workerSummary.total > 0) {
    const badFraction = (workerSummary.circuitOpen * 2 + workerSummary.stopped) / workerSummary.total;
    score -= Math.min(30, badFraction * 30);
  }
  if (data.badUrlStats.cachedBadUrls > 10) score -= Math.min(15, (data.badUrlStats.cachedBadUrls - 10) * 0.5);
  if (data.selfHealingWorker.isRunning) score = Math.max(score, 85);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function healthScoreLabel(score: number): { label: string; color: string; bg: string } {
  if (score >= 95) return { label: "Excellent", color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/30" };
  if (score >= 80) return { label: "Good", color: "text-green-400", bg: "bg-green-500/10 border-green-500/30" };
  if (score >= 60) return { label: "Degraded", color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/30" };
  if (score >= 40) return { label: "Critical", color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/30" };
  return { label: "Emergency", color: "text-red-400", bg: "bg-red-500/10 border-red-500/30" };
}

function CountdownTimer({ targetMs }: { targetMs: number }) {
  const [remaining, setRemaining] = useState<string>("");
  useEffect(() => {
    const update = () => {
      const diff = targetMs - Date.now();
      if (diff <= 0) { setRemaining("now"); return; }
      setRemaining(formatDistance(new Date(targetMs), new Date(), { addSuffix: false }));
    };
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, [targetMs]);
  return <span>{remaining}</span>;
}

// ── System Health Score ────────────────────────────────────────────────────────

function SystemHealthScore({ data }: { data: AutomationStatus }) {
  const score = computeHealthScore(data);
  const { label, color, bg } = healthScoreLabel(score);
  const { assetHealth, workerSummary, badUrlStats } = data;
  const healthyPct =
    assetHealth.total > 0
      ? Math.round(((assetHealth.healthy + assetHealth.approved) / assetHealth.total) * 100)
      : 100;

  return (
    <div className={cn("rounded-xl border p-5 flex flex-col sm:flex-row items-start sm:items-center gap-5", bg)}>
      <div className="flex-shrink-0 flex flex-col items-center gap-1">
        <div className={cn("text-5xl font-bold tabular-nums", color)}>{score}</div>
        <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">/100</div>
      </div>
      <div className="flex-1 space-y-3 min-w-0">
        <div className="flex items-center gap-2">
          <HeartPulse size={16} className={color} />
          <span className={cn("text-base font-semibold", color)}>System Health: {label}</span>
          {data.selfHealingWorker.isRunning && (
            <Badge className="bg-blue-600/80 text-white text-[10px] gap-1 animate-pulse">
              <ScanSearch size={9} /> Scanning
            </Badge>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            {
              label: "Sources healthy",
              value: `${healthyPct}%`,
              sub: `${assetHealth.healthy + assetHealth.approved}/${assetHealth.total}`,
              ok: assetHealth.blocked === 0,
            },
            {
              label: "Workers up",
              value: `${workerSummary.running}/${workerSummary.total}`,
              sub: workerSummary.circuitOpen > 0 ? `${workerSummary.circuitOpen} tripped` : "all clear",
              ok: workerSummary.circuitOpen === 0 && workerSummary.stopped === 0,
            },
            {
              label: "Blocked items",
              value: String(assetHealth.blocked),
              sub: assetHealth.quarantined > 0 ? `${assetHealth.quarantined} quarantined` : "none quarantined",
              ok: assetHealth.blocked === 0,
            },
            {
              label: "Bad URLs cached",
              value: String(badUrlStats.cachedBadUrls),
              sub: `${badUrlStats.sourceSetSize} source sets`,
              ok: badUrlStats.cachedBadUrls < 5,
            },
          ].map(({ label, value, sub, ok }) => (
            <div key={label} className="space-y-0.5">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</div>
              <div className={cn("text-lg font-bold tabular-nums", ok ? "text-emerald-400" : "text-amber-400")}>{value}</div>
              <div className="text-[10px] text-muted-foreground">{sub}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Health Bar ─────────────────────────────────────────────────────────────────

function HealthBar({ summary }: { summary: AssetHealthSummary }) {
  const { healthy, quarantined, repairing, approved, blocked, total } = summary;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);

  const segments = [
    { label: "Healthy", count: healthy + approved, color: "bg-emerald-500", key: "h" },
    { label: "Repairing", count: repairing, color: "bg-blue-500", key: "r" },
    { label: "Quarantined", count: quarantined, color: "bg-amber-500", key: "q" },
    { label: "Blocked", count: blocked, color: "bg-red-500", key: "b" },
  ];

  return (
    <div className="space-y-3">
      <div className="flex h-3 rounded-full overflow-hidden gap-0.5">
        {segments.map(({ color, count, key }) =>
          count > 0 ? (
            <div
              key={key}
              className={cn("transition-all duration-700", color)}
              style={{ width: `${pct(count)}%`, minWidth: count > 0 ? 4 : 0 }}
            />
          ) : null
        )}
        {total === 0 && <div className="flex-1 bg-muted rounded-full" />}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {segments.map(({ label, count, color, key }) => (
          <div key={key} className="flex items-center gap-1.5 text-xs">
            <span className={cn("w-2 h-2 rounded-full flex-shrink-0", color)} />
            <span className="text-muted-foreground">{label}:</span>
            <span className="font-medium tabular-nums">{count}</span>
          </div>
        ))}
        <div className="flex items-center gap-1.5 text-xs ml-auto">
          <span className="text-muted-foreground">Total:</span>
          <span className="font-medium tabular-nums">{total}</span>
        </div>
      </div>
    </div>
  );
}

// ── Worker Card ───────────────────────────────────────────────────────────────

function WorkerCard({
  w,
  onRestart,
  onResetCircuit,
  isActing,
}: {
  w: WorkerStatus;
  onRestart: (name: string) => void;
  onResetCircuit: (name: string) => void;
  isActing: boolean;
}) {
  const isCircuitOpen = w.circuitOpen;
  const isHealthy = w.state === "running" && !w.circuitOpen;
  const errorRate = w.totalRuns > 0 ? Math.round((w.totalErrors / w.totalRuns) * 100) : 0;

  return (
    <div
      className={cn(
        "rounded-lg border p-3.5 text-xs space-y-3 transition-colors",
        isCircuitOpen
          ? "border-red-800/60 bg-red-950/20"
          : isHealthy
          ? "border-border bg-card"
          : "border-border/50 bg-muted/20"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <CircuitBoard
            size={13}
            className={
              isCircuitOpen
                ? "text-red-400"
                : isHealthy
                ? "text-emerald-400"
                : "text-muted-foreground"
            }
          />
          <span className="font-medium text-foreground truncate text-[11px]">
            {workerDisplayName(w.name)}
          </span>
        </div>
        {isCircuitOpen ? (
          <Badge className="bg-red-600 text-white text-[10px] px-1.5 py-0 gap-1 flex-shrink-0">
            <Ban size={8} /> Tripped
          </Badge>
        ) : isHealthy ? (
          <Badge className="bg-emerald-600/80 text-white text-[10px] px-1.5 py-0">Running</Badge>
        ) : (
          <Badge className="bg-zinc-600 text-white text-[10px] px-1.5 py-0">Stopped</Badge>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 text-muted-foreground">
        <div>
          <div className="text-[9px] uppercase tracking-wider mb-0.5">Runs</div>
          <div className="text-foreground font-mono font-medium">{w.totalRuns}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider mb-0.5">Consec Err</div>
          <div
            className={cn(
              "font-mono font-medium",
              w.consecutiveFailures > 0 ? "text-amber-400" : "text-foreground"
            )}
          >
            {w.consecutiveFailures}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider mb-0.5">Err%</div>
          <div
            className={cn(
              "font-mono font-medium",
              errorRate > 10 ? "text-amber-400" : "text-foreground"
            )}
          >
            {errorRate}%
          </div>
        </div>
      </div>

      <div className="text-[10px] text-muted-foreground space-y-0.5">
        <div>
          Last: <span className="text-foreground">{ms(w.lastRunAtMs)}</span>
        </div>
        {w.nextRunAtMs && (
          <div>
            Next: <span className="text-foreground">{ms(w.nextRunAtMs)}</span>
          </div>
        )}
        {isCircuitOpen && w.circuitAutoResetAtMs && (
          <div className="text-amber-400">
            Auto-reset in: <CountdownTimer targetMs={w.circuitAutoResetAtMs} />
          </div>
        )}
        {w.lastError && (
          <div className="text-red-400 truncate" title={w.lastError}>
            {w.lastError}
          </div>
        )}
      </div>

      <div className="flex gap-1.5 pt-1 border-t border-border/50">
        {isCircuitOpen && (
          <Button
            size="sm"
            variant="destructive"
            className="h-6 text-[10px] px-2 flex-1 gap-1"
            disabled={isActing}
            onClick={() => onResetCircuit(w.name)}
          >
            {isActing ? (
              <RefreshCw size={9} className="animate-spin" />
            ) : (
              <PlugZap size={9} />
            )}
            Reset Circuit
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-[10px] px-2 flex-1 gap-1"
          disabled={isActing}
          onClick={() => onRestart(w.name)}
        >
          {isActing ? (
            <RefreshCw size={9} className="animate-spin" />
          ) : (
            <RotateCw size={9} />
          )}
          Restart
        </Button>
      </div>
    </div>
  );
}

// ── Blocked Item Row ──────────────────────────────────────────────────────────

function BlockedItemRow({
  item,
  onApprove,
  onReset,
  onPause,
  isActing,
}: {
  item: BlockedItem;
  onApprove: (id: string) => void;
  onReset: (id: string) => void;
  onPause: (id: string) => void;
  isActing: boolean;
}) {
  const blockedAt = item.lastRepairAt ? new Date(item.lastRepairAt).getTime() : null;
  const autoUnblockAt =
    blockedAt && item.state === "blocked" ? blockedAt + 4 * 60 * 60 * 1000 : null;

  return (
    <div
      className={cn(
        "py-3 px-4 flex items-start gap-3 text-xs border rounded-lg",
        item.state === "blocked"
          ? "border-red-800/40 bg-red-950/10"
          : "border-amber-800/30 bg-amber-950/10"
      )}
    >
      <div
        className={cn(
          "mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0",
          stateColor(item.state)
        )}
      />
      <div className="flex-1 min-w-0 space-y-1.5">
        <p className="font-medium text-foreground truncate">
          {item.queueItemTitle ?? item.queueItemId}
        </p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
          {item.lastErrorCode && (
            <span className="font-mono bg-muted px-1 rounded text-[10px]">
              {item.lastErrorCode}
            </span>
          )}
          <span>
            Attempts: <span className="text-foreground">{item.repairAttempts}</span>
          </span>
          {item.lastRepairAt && (
            <span>
              Last repair:{" "}
              <span className="text-foreground">
                {ms(new Date(item.lastRepairAt).getTime())}
              </span>
            </span>
          )}
          {item.autoRepairPaused && (
            <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[10px] px-1">
              Auto-repair paused
            </Badge>
          )}
        </div>
        {item.suggestedFix && (
          <p className="text-amber-400/80">{item.suggestedFix}</p>
        )}
        {autoUnblockAt && autoUnblockAt > Date.now() && (
          <div className="flex items-center gap-1 text-muted-foreground text-[10px]">
            <Timer size={9} />
            Auto-unblocks in <CountdownTimer targetMs={autoUnblockAt} />
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px] gap-1"
              onClick={() => onApprove(item.queueItemId)}
              disabled={isActing}
            >
              {isActing ? (
                <RefreshCw size={9} className="animate-spin" />
              ) : (
                <ShieldCheck size={9} />
              )}
              Approve
            </Button>
          </TooltipTrigger>
          <TooltipContent>Force-approve to re-enter rotation immediately</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px]"
              onClick={() => onReset(item.queueItemId)}
              disabled={isActing}
            >
              <RotateCw size={9} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset repair cycle</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px]"
              onClick={() => onPause(item.queueItemId)}
              disabled={isActing}
            >
              <Pause size={9} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {item.autoRepairPaused ? "Resume auto-repair" : "Pause auto-repair"}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

// ── Repair Feed Entry ─────────────────────────────────────────────────────────

function RepairFeedEntry({ item }: { item: RepairLogItem }) {
  const log = item.latestLogEntry;
  return (
    <div className="py-2.5 flex items-start gap-3 text-xs">
      <div className="mt-0.5 flex-shrink-0">
        {log ? (
          outcomeIcon(log.outcome)
        ) : (
          <CircleDot size={12} className="text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground truncate">
            {item.queueItemTitle ?? item.queueItemId}
          </span>
          <Badge
            className={cn(
              "text-[9px] px-1 py-0 border-0 text-white",
              stateColor(item.state)
            )}
          >
            {item.state}
          </Badge>
        </div>
        {log && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className="font-medium text-foreground/70">{actionLabel(log.action)}</span>
            {log.detail && <span className="truncate">{log.detail}</span>}
            <span className="ml-auto text-[10px] flex-shrink-0">
              {ms(new Date(log.ts).getTime())}
            </span>
          </div>
        )}
        {item.lastErrorCode && (
          <span className="font-mono text-muted-foreground text-[10px]">
            {item.lastErrorCode}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Recovery Console Log ──────────────────────────────────────────────────────

function RecoveryConsoleLog({ entries }: { entries: RecoveryLogEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  const typeConfig: Record<RecoveryLogEntry["type"], { color: string; prefix: string }> = {
    info: { color: "text-blue-400", prefix: "[INFO]" },
    warn: { color: "text-amber-400", prefix: "[WARN]" },
    error: { color: "text-red-400", prefix: "[ERR ]" },
    success: { color: "text-emerald-400", prefix: "[ OK ]" },
  };

  return (
    <div className="bg-zinc-950 border border-border rounded-lg font-mono text-xs p-4 h-56 overflow-y-auto space-y-1">
      {entries.length === 0 && (
        <div className="text-zinc-500 italic">Awaiting recovery actions…</div>
      )}
      {entries.map((e, i) => {
        const cfg = typeConfig[e.type];
        return (
          <div key={i} className="flex gap-2">
            <span className="text-zinc-600 flex-shrink-0">{format(new Date(e.ts), "HH:mm:ss")}</span>
            <span className={cn("flex-shrink-0 font-semibold", cfg.color)}>{cfg.prefix}</span>
            <span className="text-zinc-300">{e.message}</span>
            {e.detail && <span className="text-zinc-500 truncate">{e.detail}</span>}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

// ── Cache Stat Card ───────────────────────────────────────────────────────────

function CacheStatCard({
  label,
  value,
  subtext,
  icon,
  critical,
}: {
  label: string;
  value: string | number;
  subtext?: string;
  icon: React.ReactNode;
  critical?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-4 space-y-2",
        critical ? "border-amber-800/40 bg-amber-950/10" : "border-border bg-card"
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={cn(critical ? "text-amber-400" : "text-muted-foreground")}>
          {icon}
        </span>
      </div>
      <div
        className={cn(
          "text-2xl font-bold tabular-nums",
          critical ? "text-amber-400" : "text-foreground"
        )}
      >
        {value}
      </div>
      {subtext && <div className="text-[11px] text-muted-foreground">{subtext}</div>}
    </div>
  );
}

// ── Bulk Action Button ────────────────────────────────────────────────────────

function BulkActionBtn({
  label,
  description,
  icon,
  variant = "outline",
  onConfirm,
  loading,
  danger,
}: {
  label: string;
  description: string;
  icon: React.ReactNode;
  variant?: "outline" | "default" | "destructive";
  onConfirm: () => void;
  loading: boolean;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant={variant} disabled={loading} className="gap-1.5 h-8 text-xs">
          {loading ? <RefreshCw size={12} className="animate-spin" /> : icon}
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4 space-y-3" align="end">
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
        {danger && (
          <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded p-2">
            <AlertTriangle size={12} />
            This action cannot be undone.
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <Button size="sm" variant="ghost" className="text-xs" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={danger ? "destructive" : "default"}
            className="text-xs"
            onClick={() => { onConfirm(); setOpen(false); }}
          >
            Confirm
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Shared hook ───────────────────────────────────────────────────────────────

function useOpsStatus() {
  return useQuery<OpsStatus>({
    queryKey: ["ops-status-automation"],
    queryFn: () => api.get<OpsStatus>("/admin/ops/status"),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
}

// ── Overview Tab ──────────────────────────────────────────────────────────────

function OverviewTab({ data, onRefetch }: { data: AutomationStatus; onRefetch: () => void }) {
  const { data: ops } = useOpsStatus();
  const hasAlerts = data.assetHealth.blocked > 0 || data.workerSummary.circuitOpen > 0;

  const systemChecks = [
    {
      label: "Self-Healing Worker",
      ok: data.selfHealingWorker.isRunning || data.selfHealingWorker.lastScanMs > 0,
      detail: data.selfHealingWorker.isRunning
        ? "Scan in progress"
        : data.selfHealingWorker.lastScanMs > 0
        ? `Last scan ${ms(data.selfHealingWorker.lastScanMs)}`
        : "Not yet run",
    },
    {
      label: "Background Workers",
      ok: data.workerSummary.circuitOpen === 0 && data.workerSummary.stopped === 0,
      detail: `${data.workerSummary.running}/${data.workerSummary.total} running`,
    },
    {
      label: "Source Integrity",
      ok: data.assetHealth.blocked === 0,
      detail:
        data.assetHealth.blocked > 0
          ? `${data.assetHealth.blocked} blocked, ${data.assetHealth.quarantined} quarantined`
          : "All sources reachable",
    },
    {
      label: "Bad URL Cache",
      ok: data.badUrlStats.cachedBadUrls < 20,
      detail: `${data.badUrlStats.cachedBadUrls} entries, ${data.badUrlStats.sourceSetSize} sets`,
    },
    {
      label: "Database",
      ok: ops?.db?.healthy !== false,
      detail: ops?.db
        ? `Pool: ${ops.db.poolActive ?? "?"}/${ops.db.poolMax ?? "?"} connections`
        : "Checking…",
    },
    {
      label: "Object Storage",
      ok: ops?.storage?.healthy !== false,
      detail: ops?.storage ? (ops.storage.healthy ? "Healthy" : "Degraded") : "Checking…",
    },
    {
      label: "Auto-Repair Loop",
      ok: !data.blockedItems.some((i) => i.autoRepairPaused),
      detail: data.blockedItems.some((i) => i.autoRepairPaused)
        ? "Some items have paused auto-repair"
        : "All items in repair rotation",
    },
    {
      label: "Queue Sources",
      ok:
        data.assetHealth.total === 0 ||
        (data.assetHealth.healthy + data.assetHealth.approved) / data.assetHealth.total > 0.8,
      detail: `${
        data.assetHealth.total > 0
          ? Math.round(
              ((data.assetHealth.healthy + data.assetHealth.approved) / data.assetHealth.total) *
                100
            )
          : 100
      }% sources healthy`,
    },
  ];

  return (
    <div className="space-y-6">
      {hasAlerts && (
        <div className="flex items-start gap-3 bg-red-950/30 border border-red-800/50 rounded-lg p-4 text-sm">
          <Siren size={18} className="text-red-400 flex-shrink-0 mt-0.5 animate-pulse" />
          <div className="space-y-1">
            <p className="font-semibold text-red-300">Automation Intervention Required</p>
            <p className="text-xs text-red-400/80">
              {data.assetHealth.blocked > 0 &&
                `${data.assetHealth.blocked} source(s) are blocked and cannot air. `}
              {data.workerSummary.circuitOpen > 0 &&
                `${data.workerSummary.circuitOpen} worker circuit breaker(s) have tripped. `}
              The self-healing system is actively working to resolve these issues automatically.
            </p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <ListChecks size={14} className="text-primary" /> System Checks
          </CardTitle>
          <CardDescription className="text-xs">
            Real-time status of all automation subsystems
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {systemChecks.map(({ label, ok, detail }) => (
              <div
                key={label}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 border text-xs",
                  ok
                    ? "border-emerald-800/30 bg-emerald-950/10"
                    : "border-amber-800/30 bg-amber-950/10"
                )}
              >
                {ok ? (
                  <CircleCheck size={14} className="text-emerald-400 flex-shrink-0" />
                ) : (
                  <OctagonAlert size={14} className="text-amber-400 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div
                    className={cn("font-medium", ok ? "text-foreground" : "text-amber-300")}
                  >
                    {label}
                  </div>
                  <div className="text-muted-foreground">{detail}</div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity size={14} className="text-emerald-400" /> Queue Source Health
          </CardTitle>
        </CardHeader>
        <CardContent>
          <HealthBar summary={data.assetHealth} />
        </CardContent>
      </Card>

      {data.recentRepairLog.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Wrench size={14} className="text-sky-400" /> Recent Repair Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              {data.recentRepairLog.slice(0, 8).map((item) => (
                <RepairFeedEntry key={item.queueItemId} item={item} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Workers Tab ───────────────────────────────────────────────────────────────

function WorkersTab({ data, onRefetch }: { data: AutomationStatus; onRefetch: () => void }) {
  const [acting, setActing] = useState<Set<string>>(new Set());

  const act = (name: string, fn: () => Promise<unknown>, successMsg: string) => {
    setActing((s) => new Set([...s, name]));
    fn()
      .then(() => { toast.success(successMsg); void onRefetch(); })
      .catch(() => toast.error("Action failed"))
      .finally(() =>
        setActing((s) => {
          const n = new Set(s);
          n.delete(name);
          return n;
        })
      );
  };

  const onRestart = (name: string) =>
    act(
      name,
      () => api.post(`/broadcast-v2/workers/${name}/restart`, {}),
      `Worker "${workerDisplayName(name)}" restarted`
    );

  const onResetCircuit = (name: string) =>
    act(
      name,
      () => api.post(`/broadcast-v2/workers/${name}/reset-circuit`, {}),
      `Circuit reset for "${workerDisplayName(name)}"`
    );

  const { circuitOpen, stopped, running, total } = data.workerSummary;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "Total", value: total, icon: <Layers size={14} />, cls: "" },
          { label: "Running", value: running, icon: <Activity size={14} />, cls: "text-emerald-400" },
          { label: "Stopped", value: stopped, icon: <Ban size={14} />, cls: stopped > 0 ? "text-amber-400" : "" },
          { label: "Tripped", value: circuitOpen, icon: <OctagonAlert size={14} />, cls: circuitOpen > 0 ? "text-red-400" : "" },
        ].map(({ label, value, icon, cls }) => (
          <Card key={label}>
            <CardContent className="p-3">
              <div className={cn("flex items-center gap-1.5 text-xs text-muted-foreground mb-1", cls)}>
                {icon}
                {label}
              </div>
              <div className={cn("text-2xl font-bold tabular-nums", cls || "text-foreground")}>
                {value}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {circuitOpen > 0 && (
        <div className="flex items-start gap-3 bg-red-950/30 border border-red-800/50 rounded-lg p-3 text-xs">
          <OctagonAlert size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
          <span className="text-red-400/80">
            {circuitOpen} circuit breaker{circuitOpen !== 1 ? "s" : ""} tripped. Affected workers are
            suspended and will auto-reset after 10 minutes. Use "Reset Circuit" to restore immediately.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {data.workers.map((w) => (
          <WorkerCard
            key={w.name}
            w={w}
            onRestart={onRestart}
            onResetCircuit={onResetCircuit}
            isActing={acting.has(w.name)}
          />
        ))}
        {data.workers.length === 0 && (
          <div className="col-span-3 py-12 text-center text-muted-foreground text-sm">
            <CircuitBoard size={32} className="mx-auto mb-3 opacity-30" />
            No workers registered yet
          </div>
        )}
      </div>
    </div>
  );
}

// ── Queue Tab ─────────────────────────────────────────────────────────────────

function QueueTab({ data, onRefetch }: { data: AutomationStatus; onRefetch: () => void }) {
  const [approving, setApproving] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"all" | "blocked" | "quarantined" | "repairing">("all");

  const act = async (id: string, fn: () => Promise<unknown>, msg: string) => {
    setApproving((s) => new Set([...s, id]));
    try {
      await fn();
      toast.success(msg);
      void onRefetch();
    } catch {
      toast.error("Action failed");
    } finally {
      setApproving((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  };

  const approveAll = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; approved: number }>("/broadcast-v2/asset-health/bulk-approve", {}),
    onSuccess: (r) => { toast.success(`Approved ${r.approved} item(s)`); onRefetch(); },
    onError: () => toast.error("Bulk approve failed"),
  });
  const resetAll = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; reset: number }>("/broadcast-v2/asset-health/bulk-reset", {}),
    onSuccess: (r) => { toast.success(`Reset ${r.reset} item(s)`); onRefetch(); },
    onError: () => toast.error("Bulk reset failed"),
  });
  const clearBadUrls = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/broadcast-v2/clear-bad-urls", {}),
    onSuccess: () => { toast.success("Bad URL cache cleared — sources will be re-probed"); onRefetch(); },
    onError: () => toast.error("Failed to clear bad URL cache"),
  });
  const forceRepair = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; scanned: number }>("/broadcast-v2/asset-health/run-repair", {}),
    onSuccess: (r) => { toast.success(`Scan triggered — ${r.scanned} items queued`); onRefetch(); },
    onError: () => toast.error("Force repair failed"),
  });

  const displayItems = data.blockedItems.filter((item) =>
    filter === "all"
      ? true
      : filter === "blocked"
      ? item.state === "blocked"
      : filter === "quarantined"
      ? item.state === "quarantined"
      : filter === "repairing"
      ? item.state === "repairing"
      : true
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Radio size={14} className="text-primary" /> Queue Source Distribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <HealthBar summary={data.assetHealth} />
        </CardContent>
      </Card>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-1.5">
          {(["all", "blocked", "quarantined", "repairing"] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? "default" : "outline"}
              className="h-7 text-xs capitalize px-3"
              onClick={() => setFilter(f)}
            >
              {f}{" "}
              {f !== "all" && (
                <span className="ml-1 opacity-70">
                  {f === "blocked"
                    ? data.assetHealth.blocked
                    : f === "quarantined"
                    ? data.assetHealth.quarantined
                    : data.assetHealth.repairing}
                </span>
              )}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <BulkActionBtn
            label="Force Scan"
            description="Trigger an immediate self-healing scan of all active queue items instead of waiting for the next scheduled cycle."
            icon={<ScanSearch size={12} />}
            onConfirm={() => forceRepair.mutate()}
            loading={forceRepair.isPending}
          />
          <BulkActionBtn
            label="Clear Bad URLs"
            description="Flush the in-memory bad-URL cache. All cached bad sources will be re-probed on next access."
            icon={<Trash2 size={12} />}
            onConfirm={() => clearBadUrls.mutate()}
            loading={clearBadUrls.isPending}
          />
          <BulkActionBtn
            label="Reset All"
            description="Reset all non-healthy items back to quarantined, restarting the repair cycle from scratch."
            icon={<RotateCw size={12} />}
            onConfirm={() => resetAll.mutate()}
            loading={resetAll.isPending}
          />
          <BulkActionBtn
            label="Approve All"
            description="Force-approve all blocked items so they re-enter the broadcast rotation immediately."
            icon={<CheckCheck size={12} />}
            variant="default"
            onConfirm={() => approveAll.mutate()}
            loading={approveAll.isPending}
          />
        </div>
      </div>

      {displayItems.length === 0 ? (
        <div className="py-12 text-center">
          <ShieldCheck size={36} className="mx-auto mb-3 text-emerald-400 opacity-60" />
          <p className="text-sm font-medium text-emerald-400">
            {filter === "all" ? "All sources are healthy" : `No ${filter} items`}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            The self-healing system is maintaining source integrity
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {displayItems.map((item) => (
            <BlockedItemRow
              key={item.queueItemId}
              item={item}
              onApprove={(id) =>
                void act(id, () => api.post(`/broadcast-v2/asset-health/${id}/approve`, {}), "Item approved")
              }
              onReset={(id) =>
                void act(id, () => api.post(`/broadcast-v2/asset-health/${id}/reset`, {}), "Repair cycle reset")
              }
              onPause={(id) =>
                void act(
                  id,
                  () => api.post(`/broadcast-v2/asset-health/${id}/pause`, {}),
                  item.autoRepairPaused ? "Auto-repair resumed" : "Auto-repair paused"
                )
              }
              isActing={approving.has(item.queueItemId)}
            />
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Wrench size={14} className="text-sky-400" /> Repair Activity Log
            <span className="text-muted-foreground text-xs font-normal">Most recent first</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.recentRepairLog.length === 0 ? (
            <p className="text-muted-foreground text-xs py-4 text-center">
              No repair activity — all items are healthy.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {data.recentRepairLog.map((item) => (
                <RepairFeedEntry key={item.queueItemId} item={item} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Recovery Tab ──────────────────────────────────────────────────────────────

function RecoveryTab({ data, onRefetch }: { data: AutomationStatus; onRefetch: () => void }) {
  const [log, setLog] = useState<RecoveryLogEntry[]>([]);
  const [recovering, setRecovering] = useState(false);
  const [revalidating, setRevalidating] = useState(false);

  const pushLog = useCallback(
    (type: RecoveryLogEntry["type"], message: string, detail?: string) => {
      setLog((prev) => [...prev, { ts: Date.now(), type, message, detail }]);
    },
    []
  );

  const runFullRecovery = useCallback(async () => {
    setRecovering(true);
    setLog([]);
    try {
      pushLog("info", "Starting full recovery sequence…");
      await new Promise((r) => setTimeout(r, 400));
      pushLog("info", "Step 1: Clearing bad URL cache…");
      await api.post("/broadcast-v2/clear-bad-urls", {});
      pushLog("success", "Bad URL cache cleared");
      await new Promise((r) => setTimeout(r, 300));
      pushLog("info", "Step 2: Running source revalidation…");
      await api.post("/broadcast-v2/revalidate-sources", {});
      pushLog("success", "Source revalidation complete");
      await new Promise((r) => setTimeout(r, 300));
      pushLog("info", "Step 3: Running self-healing scan…");
      const scanRes = await api.post<{ ok: boolean; scanned?: number }>(
        "/broadcast-v2/asset-health/run-repair",
        {}
      );
      pushLog("success", `Scan complete`, `${scanRes.scanned ?? 0} items checked`);
      await new Promise((r) => setTimeout(r, 300));
      pushLog("info", "Step 4: Refreshing automation status…");
      await onRefetch();
      pushLog("success", "Full recovery sequence complete", "All systems restored");
      toast.success("Full recovery sequence complete");
    } catch (err) {
      pushLog("error", "Recovery sequence failed", String(err));
      toast.error("Recovery sequence encountered an error");
    } finally {
      setRecovering(false);
    }
  }, [onRefetch, pushLog]);

  const runRevalidation = useCallback(async () => {
    setRevalidating(true);
    setLog((prev) => [
      ...prev,
      { ts: Date.now(), type: "info", message: "Triggering source revalidation…" },
    ]);
    try {
      await api.post("/broadcast-v2/revalidate-sources", {});
      pushLog("success", "Source revalidation dispatched", "All queue sources will be re-probed");
      toast.success("Source revalidation triggered");
      void onRefetch();
    } catch {
      pushLog("error", "Revalidation failed");
      toast.error("Revalidation failed");
    } finally {
      setRevalidating(false);
    }
  }, [onRefetch, pushLog]);

  const runRepairScan = useCallback(async () => {
    pushLog("info", "Triggering immediate repair scan…");
    try {
      const res = await api.post<{ ok: boolean; scanned?: number }>(
        "/broadcast-v2/asset-health/run-repair",
        {}
      );
      pushLog("success", "Repair scan dispatched", `${res.scanned ?? 0} items queued`);
      toast.success("Repair scan triggered");
      void onRefetch();
    } catch {
      pushLog("error", "Repair scan failed");
      toast.error("Repair scan failed");
    }
  }, [onRefetch, pushLog]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border-red-800/30">
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              <FlameKindling size={18} className="text-red-400" />
              <div>
                <p className="text-sm font-semibold">Full Recovery</p>
                <p className="text-[11px] text-muted-foreground">
                  Wipes cache, revalidates all sources, runs scan
                </p>
              </div>
            </div>
            <Button
              className="w-full gap-2 h-9"
              variant="destructive"
              disabled={recovering}
              onClick={() => void runFullRecovery()}
            >
              {recovering ? (
                <>
                  <RefreshCw size={13} className="animate-spin" /> Running…
                </>
              ) : (
                <>
                  <Zap size={13} /> Run Full Recovery
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        <Card className="border-amber-800/30">
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Wifi size={18} className="text-amber-400" />
              <div>
                <p className="text-sm font-semibold">Source Revalidation</p>
                <p className="text-[11px] text-muted-foreground">
                  Re-probes all queue sources for reachability
                </p>
              </div>
            </div>
            <Button
              className="w-full gap-2 h-9"
              variant="outline"
              disabled={revalidating || recovering}
              onClick={() => void runRevalidation()}
            >
              {revalidating ? (
                <>
                  <RefreshCw size={13} className="animate-spin" /> Revalidating…
                </>
              ) : (
                <>
                  <ScanSearch size={13} /> Revalidate Sources
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        <Card className="border-blue-800/30">
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Wrench size={18} className="text-blue-400" />
              <div>
                <p className="text-sm font-semibold">Repair Scan</p>
                <p className="text-[11px] text-muted-foreground">
                  Triggers immediate self-healing scan cycle
                </p>
              </div>
            </div>
            <Button
              className="w-full gap-2 h-9"
              variant="outline"
              disabled={recovering}
              onClick={() => void runRepairScan()}
            >
              <Play size={13} /> Run Repair Scan
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Terminal size={14} className="text-primary" /> Recovery Console
              {(recovering || revalidating) && (
                <Badge className="bg-blue-600/80 text-white text-[10px] gap-1 animate-pulse">
                  <Activity size={9} /> Active
                </Badge>
              )}
            </CardTitle>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs"
              onClick={() => setLog([])}
            >
              Clear
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <RecoveryConsoleLog entries={log} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock size={14} className="text-muted-foreground" /> Auto-Recovery Schedule
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <div className="space-y-1">
              <p className="text-muted-foreground uppercase tracking-wider text-[10px]">Last Scan</p>
              <p className="font-medium">
                {data.selfHealingWorker.lastScanMs > 0
                  ? ms(data.selfHealingWorker.lastScanMs)
                  : "Not yet run"}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-muted-foreground uppercase tracking-wider text-[10px]">
                Next Revalidation
              </p>
              <p className="font-medium">
                {data.selfHealingWorker.nextRevalidationAt
                  ? ms(data.selfHealingWorker.nextRevalidationAt)
                  : "Continuous monitoring"}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-muted-foreground uppercase tracking-wider text-[10px]">Scanner</p>
              <p
                className={cn(
                  "font-medium flex items-center gap-1",
                  data.selfHealingWorker.isRunning ? "text-blue-400" : "text-emerald-400"
                )}
              >
                {data.selfHealingWorker.isRunning ? (
                  <>
                    <RefreshCw size={11} className="animate-spin" /> Scanning now
                  </>
                ) : (
                  <>
                    <CircleCheck size={11} /> Idle
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="text-xs text-muted-foreground border-t border-border pt-3 space-y-1.5">
            {[
              "Queue sources are probed automatically every scan cycle. Failed sources are quarantined after >2 failures.",
              "Blocked items are automatically unblocked after 4 hours to recover from temporary CDN outages.",
              "Full recovery escalation fires automatically if the broadcast stalls >7 minutes.",
              "Circuit breakers auto-reset after 10 minutes to allow worker self-recovery.",
              "Storage reconciliation runs every 10 minutes to detect and quarantine zero-byte blobs.",
            ].map((text) => (
              <div key={text} className="flex items-start gap-2">
                <CheckCircle2 size={12} className="text-emerald-400 mt-0.5 flex-shrink-0" />
                <span>{text}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Cache & Resources Tab ─────────────────────────────────────────────────────

function CacheTab({ data, onRefetch }: { data: AutomationStatus; onRefetch: () => void }) {
  const { data: ops } = useOpsStatus();

  const clearBadUrls = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/broadcast-v2/clear-bad-urls", {}),
    onSuccess: () => { toast.success("Bad URL cache cleared"); onRefetch(); },
    onError: () => toast.error("Failed to clear cache"),
  });

  const memoryMb = ops?.memory?.rssBytes
    ? Math.round(ops.memory.rssBytes / 1024 / 1024)
    : null;
  const heapMb = ops?.memory?.heapUsedBytes
    ? Math.round(ops.memory.heapUsedBytes / 1024 / 1024)
    : null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm flex items-center gap-2">
                <ShieldOff size={14} className="text-red-400" /> Bad URL Cache
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                Tracks unreachable source URLs to prevent repeated probing of known-bad sources
              </CardDescription>
            </div>
            <BulkActionBtn
              label="Flush Cache"
              description="Flush all cached bad URL entries. All sources will be re-probed on next access — this may cause brief delays."
              icon={<Trash2 size={12} />}
              onConfirm={() => clearBadUrls.mutate()}
              loading={clearBadUrls.isPending}
              danger
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <CacheStatCard
              label="Cached bad URLs"
              value={data.badUrlStats.cachedBadUrls}
              subtext="In-memory bad URL entries"
              icon={<WifiOff size={14} />}
              critical={data.badUrlStats.cachedBadUrls > 10}
            />
            <CacheStatCard
              label="Source sets"
              value={data.badUrlStats.sourceSetSize}
              subtext="Unique source groups"
              icon={<Database size={14} />}
            />
            <CacheStatCard
              label="Last scan"
              value={
                data.selfHealingWorker.lastScanMs > 0
                  ? ms(data.selfHealingWorker.lastScanMs)
                  : "—"
              }
              subtext="Last self-heal cycle"
              icon={<Clock size={14} />}
            />
            <CacheStatCard
              label="Items tracked"
              value={data.assetHealth.total}
              subtext="Queue items monitored"
              icon={<Eye size={14} />}
            />
          </div>
          {data.badUrlStats.cachedBadUrls > 0 && (
            <div className="text-xs text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded p-3 flex items-start gap-2">
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
              <span>
                {data.badUrlStats.cachedBadUrls} bad URL
                {data.badUrlStats.cachedBadUrls !== 1 ? "s" : ""} cached. These sources are skipped
                during broadcast rotation and will be retried after the 4-hour block window. Click
                "Flush Cache" to force immediate re-probing.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Cpu size={14} className="text-muted-foreground" /> System Resources
          </CardTitle>
          <CardDescription className="text-xs">
            Live process and database resource utilization
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <CacheStatCard
              label="Process RSS"
              value={memoryMb != null ? `${memoryMb} MB` : "—"}
              subtext="Resident set size"
              icon={<Server size={14} />}
              critical={memoryMb != null && memoryMb > 800}
            />
            <CacheStatCard
              label="Heap used"
              value={heapMb != null ? `${heapMb} MB` : "—"}
              subtext="V8 heap utilization"
              icon={<Gauge size={14} />}
              critical={heapMb != null && heapMb > 400}
            />
            <CacheStatCard
              label="DB pool"
              value={
                ops?.db
                  ? `${ops.db.poolActive ?? 0}/${ops.db.poolMax ?? "?"}`
                  : "—"
              }
              subtext="Active connections"
              icon={<Database size={14} />}
              critical={
                ops?.db?.poolActive != null &&
                ops.db.poolMax != null &&
                ops.db.poolActive / ops.db.poolMax > 0.8
              }
            />
            <CacheStatCard
              label="Storage"
              value={
                ops?.storage ? (ops.storage.healthy ? "Healthy" : "Degraded") : "—"
              }
              subtext="Object storage health"
              icon={<Server size={14} />}
              critical={ops?.storage?.healthy === false}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp size={14} className="text-primary" /> Automation Policies
          </CardTitle>
          <CardDescription className="text-xs">
            Active fault tolerance rules governing the self-healing engine
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            {[
              { label: "Max repair attempts before block", value: "3 attempts", icon: <ArrowUpRight size={12} /> },
              { label: "Auto-unblock window", value: "4 hours", icon: <Timer size={12} /> },
              { label: "Circuit breaker auto-reset", value: "10 minutes", icon: <PlugZap size={12} /> },
              { label: "Stale broadcast tier-1 reload", value: "3 minutes", icon: <RefreshCw size={12} /> },
              { label: "Stale broadcast tier-2 full recovery", value: "7 minutes", icon: <FlameKindling size={12} /> },
              { label: "Queue refill minimum threshold", value: "10 items", icon: <Layers size={12} /> },
              { label: "Dead-air fallback trigger", value: "5 minutes off-air", icon: <Radio size={12} /> },
              { label: "Storage reconciliation interval", value: "10 minutes", icon: <Database size={12} /> },
              { label: "Transcoding auto-retry cooldown", value: "24 hours / 3 attempts", icon: <Wrench size={12} /> },
              { label: "Bad URL skip threshold", value: "Auto-quarantine on failure", icon: <ShieldOff size={12} /> },
            ].map(({ label, value, icon }) => (
              <div
                key={label}
                className="flex items-center justify-between py-2 border-b border-border/50 last:border-0 text-xs"
              >
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="text-primary/60">{icon}</span>
                  {label}
                </div>
                <span className="font-medium font-mono text-foreground">{value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SelfHealingPage() {
  const qc = useQueryClient();

  const { data, isLoading, isError, refetch, isFetching, dataUpdatedAt } =
    useQuery<AutomationStatus>({
      queryKey: ["automation-status"],
      queryFn: () => api.get<AutomationStatus>("/broadcast-v2/automation-status"),
      refetchInterval: 15_000,
      staleTime: 10_000,
    });

  const handleRefetch = useCallback(async () => {
    await refetch();
  }, [refetch]);

  useSSEEvent("asset-health-updated", () => {
    void qc.invalidateQueries({ queryKey: ["automation-status"] });
  });

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground gap-3">
        <RefreshCw className="animate-spin" size={20} />
        <span>Loading automation status…</span>
      </div>
    );

  if (isError || !data)
    return (
      <div className="flex items-center justify-center h-64 text-red-400 gap-3">
        <XCircle size={20} />
        <span>Failed to load automation status — check API connectivity</span>
      </div>
    );

  const score = computeHealthScore(data);
  const { label: scoreLabel, color: scoreColor } = healthScoreLabel(score);
  const hasAlerts = data.assetHealth.blocked > 0 || data.workerSummary.circuitOpen > 0;

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-screen-xl mx-auto">
      {/* Page header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-violet-500/10 border border-violet-500/20">
            <Bot size={20} className="text-violet-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              24/7 Automation Center
              {data.selfHealingWorker.isRunning && (
                <Badge className="bg-blue-600/80 text-white text-[10px] gap-1">
                  <Activity size={9} className="animate-pulse" /> Live
                </Badge>
              )}
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Self-healing · Queue repair · Worker recovery · Source revalidation
              {dataUpdatedAt
                ? ` · Updated ${formatDistanceToNow(new Date(dataUpdatedAt), { addSuffix: true })}`
                : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasAlerts ? (
            <Badge className="bg-red-600 text-white gap-1">
              <ShieldAlert size={11} /> {data.assetHealth.blocked} blocked
            </Badge>
          ) : (
            <Badge className="bg-emerald-600/80 text-white gap-1">
              <CheckCircle2 size={11} /> All clear
            </Badge>
          )}
          <Badge variant="outline" className={cn("gap-1", scoreColor)}>
            <HeartPulse size={10} /> {scoreLabel}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleRefetch()}
            disabled={isFetching}
            className="gap-1.5 h-8"
          >
            <RefreshCw size={13} className={isFetching ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Health score */}
      <SystemHealthScore data={data} />

      {/* Tabs */}
      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList className="h-9">
          <TabsTrigger value="overview" className="text-xs gap-1.5">
            <LayoutDashboard size={12} /> Overview
          </TabsTrigger>
          <TabsTrigger value="workers" className="text-xs gap-1.5">
            <CircuitBoard size={12} /> Workers
            {data.workerSummary.circuitOpen > 0 && (
              <span className="ml-0.5 text-[10px] bg-red-600 text-white rounded-full px-1">
                {data.workerSummary.circuitOpen}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="queue" className="text-xs gap-1.5">
            <Radio size={12} /> Queue
            {data.assetHealth.blocked > 0 && (
              <span className="ml-0.5 text-[10px] bg-amber-500 text-white rounded-full px-1">
                {data.assetHealth.blocked}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="recovery" className="text-xs gap-1.5">
            <FlameKindling size={12} /> Recovery
          </TabsTrigger>
          <TabsTrigger value="cache" className="text-xs gap-1.5">
            <Database size={12} /> Cache &amp; Resources
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab data={data} onRefetch={handleRefetch} />
        </TabsContent>
        <TabsContent value="workers">
          <WorkersTab data={data} onRefetch={handleRefetch} />
        </TabsContent>
        <TabsContent value="queue">
          <QueueTab data={data} onRefetch={handleRefetch} />
        </TabsContent>
        <TabsContent value="recovery">
          <RecoveryTab data={data} onRefetch={handleRefetch} />
        </TabsContent>
        <TabsContent value="cache">
          <CacheTab data={data} onRefetch={handleRefetch} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
