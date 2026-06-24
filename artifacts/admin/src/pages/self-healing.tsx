import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
} from "lucide-react";
import { formatDistanceToNow, formatDistance } from "date-fns";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function ms(n: number | null | undefined): string {
  if (n == null) return "—";
  return formatDistanceToNow(new Date(n), { addSuffix: true });
}

function stateColor(state: string): string {
  switch (state) {
    case "healthy": case "approved": return "bg-emerald-600";
    case "quarantined": return "bg-amber-500";
    case "repairing": return "bg-blue-500";
    case "blocked": return "bg-red-600";
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

// Live countdown timer that re-renders every second
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

// ── Worker Card ───────────────────────────────────────────────────────────────

function WorkerCard({ w }: { w: WorkerStatus }) {
  const isHealthy = w.state === "running" && !w.circuitOpen;
  const isCircuitOpen = w.circuitOpen;

  return (
    <div className={`rounded-lg border p-3 text-xs space-y-2 ${
      isCircuitOpen
        ? "border-red-800 bg-red-950/20"
        : isHealthy
        ? "border-zinc-800 bg-zinc-900/50"
        : "border-zinc-700 bg-zinc-900/30"
    }`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-zinc-200 truncate text-[11px]">{w.name}</span>
        {isCircuitOpen ? (
          <Badge className="bg-red-600 text-white text-[10px] px-1.5 py-0">Circuit Open</Badge>
        ) : isHealthy ? (
          <Badge className="bg-emerald-600 text-white text-[10px] px-1.5 py-0">Running</Badge>
        ) : (
          <Badge className="bg-zinc-500 text-white text-[10px] px-1.5 py-0">Stopped</Badge>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-zinc-500">
        <span>Runs: <span className="text-zinc-300">{w.totalRuns}</span></span>
        <span>Errors: <span className={w.consecutiveFailures > 0 ? "text-amber-400" : "text-zinc-300"}>{w.consecutiveFailures}</span></span>
        <span className="col-span-2">Last: <span className="text-zinc-300">{ms(w.lastRunAtMs)}</span></span>
        {w.nextRunAtMs && (
          <span className="col-span-2">Next: <span className="text-zinc-300">{w.nextRunAtMs < Date.now() ? "soon" : ms(w.nextRunAtMs)}</span></span>
        )}
      </div>
      {w.circuitOpen && w.circuitAutoResetAtMs && (
        <div className="flex items-center gap-1 text-amber-400 text-[10px]">
          <Timer size={10} />
          <span>Auto-reset <CountdownTimer targetMs={w.circuitAutoResetAtMs} /></span>
        </div>
      )}
      {w.lastError && isCircuitOpen && (
        <p className="text-red-400 text-[10px] truncate" title={w.lastError}>
          {w.lastError.slice(0, 80)}
        </p>
      )}
    </div>
  );
}

// ── State bar ─────────────────────────────────────────────────────────────────

function HealthBar({ summary }: { summary: AssetHealthSummary }) {
  const { healthy, approved, quarantined, repairing, blocked, total } = summary;
  if (total === 0) return <p className="text-zinc-500 text-xs">No items tracked.</p>;
  const pct = (n: number) => Math.round((n / total) * 100);
  const segments = [
    { label: "Healthy", count: healthy + approved, color: "bg-emerald-500" },
    { label: "Quarantined", count: quarantined, color: "bg-amber-500" },
    { label: "Repairing", count: repairing, color: "bg-blue-500" },
    { label: "Blocked", count: blocked, color: "bg-red-600" },
  ].filter((s) => s.count > 0);

  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden gap-0.5">
        {segments.map((s) => (
          <div
            key={s.label}
            className={`${s.color} transition-all`}
            style={{ width: `${pct(s.count)}%`, minWidth: s.count > 0 ? "4px" : "0" }}
            title={`${s.label}: ${s.count}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        {[
          { label: "Healthy", count: healthy + approved, color: "bg-emerald-500" },
          { label: "Quarantined", count: quarantined, color: "bg-amber-500" },
          { label: "Repairing", count: repairing, color: "bg-blue-500" },
          { label: "Blocked", count: blocked, color: "bg-red-600" },
        ].map((s) => (
          <div key={s.label} className="flex items-center gap-1.5 text-xs">
            <span className={`w-2 h-2 rounded-full ${s.color}`} />
            <span className="text-zinc-400">{s.label}:</span>
            <span className="text-zinc-200 font-mono">{s.count}</span>
          </div>
        ))}
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-zinc-400">Total:</span>
          <span className="text-zinc-200 font-mono">{total}</span>
        </div>
      </div>
    </div>
  );
}

// ── Repair Feed Entry ─────────────────────────────────────────────────────────

function RepairFeedEntry({ item }: { item: RepairLogItem }) {
  const entry = item.latestLogEntry;
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-zinc-800/60 last:border-0">
      <div className="mt-0.5 shrink-0">
        {entry ? outcomeIcon(entry.outcome) : <CircleDot size={12} className="text-zinc-500" />}
      </div>
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${stateColor(item.state)} text-white`}>
            {item.state}
          </span>
          {entry && (
            <span className="text-[10px] text-zinc-400">{actionLabel(entry.action)}</span>
          )}
          <span className="text-[10px] text-zinc-600 ml-auto shrink-0">
            {entry ? ms(new Date(entry.ts).getTime()) : ms(item.lastRepairAt ? new Date(item.lastRepairAt).getTime() : null)}
          </span>
        </div>
        <p className="text-xs text-zinc-300 truncate">
          {item.queueItemTitle ?? item.queueItemId.slice(0, 16) + "…"}
        </p>
        {entry?.detail && (
          <p className="text-[10px] text-zinc-500 line-clamp-2">{entry.detail}</p>
        )}
        {item.suggestedFix && item.state === "blocked" && (
          <p className="text-[10px] text-amber-400">Fix: {item.suggestedFix}</p>
        )}
      </div>
      <div className="shrink-0 text-[10px] text-zinc-600 text-right">
        #{item.repairAttempts}
      </div>
    </div>
  );
}

// ── Blocked Items Table ───────────────────────────────────────────────────────

function BlockedItemsTable({
  items,
  onApprove,
  onReset,
  approving,
}: {
  items: BlockedItem[];
  onApprove: (id: string) => void;
  onReset: (id: string) => void;
  approving: Set<string>;
}) {
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 py-6 justify-center text-zinc-500 text-sm">
        <CheckCircle2 size={16} className="text-emerald-500" />
        No blocked items — all sources healthy.
      </div>
    );
  }

  return (
    <div className="divide-y divide-zinc-800">
      {items.map((item) => {
        const blockedAt = item.lastRepairAt ? new Date(item.lastRepairAt).getTime() : null;
        const autoUnblockAt = blockedAt ? blockedAt + 4 * 60 * 60 * 1000 : null;
        return (
          <div key={item.queueItemId} className="py-3 flex items-start gap-3 text-xs">
            <ShieldAlert size={14} className="text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0 space-y-1">
              <p className="font-medium text-zinc-200 truncate">
                {item.queueItemTitle ?? item.queueItemId}
              </p>
              {item.lastErrorCode && (
                <p className="text-zinc-500 font-mono">{item.lastErrorCode}</p>
              )}
              {item.suggestedFix && (
                <p className="text-amber-400/80">{item.suggestedFix}</p>
              )}
              {autoUnblockAt && (
                <div className="flex items-center gap-1 text-zinc-500">
                  <Timer size={10} />
                  <span>Auto-unblocks in <CountdownTimer targetMs={autoUnblockAt} /></span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => onApprove(item.queueItemId)}
                    disabled={approving.has(item.queueItemId)}
                  >
                    {approving.has(item.queueItemId) ? (
                      <RefreshCw size={10} className="animate-spin" />
                    ) : (
                      <ShieldCheck size={10} className="mr-1" />
                    )}
                    Approve
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Force-approve this item to re-enter rotation</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[10px] text-zinc-400"
                    onClick={() => onReset(item.queueItemId)}
                    disabled={approving.has(item.queueItemId)}
                  >
                    <RotateCw size={10} className="mr-1" />
                    Reset
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Reset repair attempts and restart the repair cycle</TooltipContent>
              </Tooltip>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Bulk Actions ──────────────────────────────────────────────────────────────

function BulkActions({ onRefetch }: { onRefetch: () => void }) {
  const [open, setOpen] = useState<string | null>(null);

  const approveAll = useMutation({
    mutationFn: () => api.post<{ ok: boolean; approved: number }>("/broadcast-v2/asset-health/bulk-approve", {}),
    onSuccess: (res) => {
      toast.success(`Approved ${res.approved} item(s)`);
      onRefetch();
    },
    onError: () => toast.error("Bulk approve failed"),
  });

  const resetAll = useMutation({
    mutationFn: () => api.post<{ ok: boolean; reset: number }>("/broadcast-v2/asset-health/bulk-reset", {}),
    onSuccess: (res) => {
      toast.success(`Reset ${res.reset} item(s)`);
      onRefetch();
    },
    onError: () => toast.error("Bulk reset failed"),
  });

  const clearBadUrls = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/broadcast-v2/clear-bad-urls", {}),
    onSuccess: () => {
      toast.success("Bad URL cache cleared");
      onRefetch();
    },
    onError: () => toast.error("Failed to clear bad URL cache"),
  });

  const forceRepair = useMutation({
    mutationFn: () => api.post<{ ok: boolean; scanned: number }>("/broadcast-v2/asset-health/run-repair", {}),
    onSuccess: (res) => {
      toast.success(`Full scan complete — ${res.scanned} items checked`);
      onRefetch();
    },
    onError: () => toast.error("Force repair failed"),
  });

  const actions = [
    {
      id: "approve-all",
      label: "Approve All Blocked",
      description: "Force-approve all blocked items so they re-enter the broadcast rotation immediately.",
      icon: <CheckCheck size={13} />,
      variant: "outline" as const,
      onConfirm: () => { approveAll.mutate(); setOpen(null); },
      loading: approveAll.isPending,
    },
    {
      id: "reset-all",
      label: "Reset All Repairs",
      description: "Reset all non-healthy items back to quarantined, restarting the repair cycle from scratch.",
      icon: <RotateCw size={13} />,
      variant: "outline" as const,
      onConfirm: () => { resetAll.mutate(); setOpen(null); },
      loading: resetAll.isPending,
    },
    {
      id: "clear-bad-urls",
      label: "Clear Bad URL Cache",
      description: "Flush the in-memory bad-URL cache. Sources that were temporarily unreachable will be re-probed.",
      icon: <Trash2 size={13} />,
      variant: "outline" as const,
      onConfirm: () => { clearBadUrls.mutate(); setOpen(null); },
      loading: clearBadUrls.isPending,
    },
    {
      id: "force-repair",
      label: "Force Full Scan",
      description: "Trigger an immediate self-healing scan of all active queue items instead of waiting for the next scheduled cycle.",
      icon: <Play size={13} />,
      variant: "default" as const,
      onConfirm: () => { forceRepair.mutate(); setOpen(null); },
      loading: forceRepair.isPending,
    },
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => (
        <Popover
          key={action.id}
          open={open === action.id}
          onOpenChange={(v) => setOpen(v ? action.id : null)}
        >
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant={action.variant}
              disabled={action.loading}
              className="gap-1.5 h-8 text-xs"
            >
              {action.loading ? <RefreshCw size={12} className="animate-spin" /> : action.icon}
              {action.label}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-4 space-y-3" align="end">
            <p className="text-sm font-medium">{action.label}</p>
            <p className="text-xs text-zinc-400">{action.description}</p>
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="ghost" className="text-xs" onClick={() => setOpen(null)}>
                Cancel
              </Button>
              <Button size="sm" className="text-xs" onClick={action.onConfirm}>
                Confirm
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ))}
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

  const handleRefetch = useCallback(() => {
    void refetch();
  }, [refetch]);

  useSSEEvent("asset-health-updated", () => {
    void qc.invalidateQueries({ queryKey: ["automation-status"] });
  });

  // Per-item approve/reset approving state
  const [approving, setApproving] = useState<Set<string>>(new Set());

  const approveItem = useCallback(async (queueItemId: string) => {
    setApproving((s) => new Set([...s, queueItemId]));
    try {
      await api.post(`/broadcast-v2/asset-health/${queueItemId}/approve`, {});
      toast.success("Item approved — re-entering rotation");
      void refetch();
    } catch {
      toast.error("Approve failed");
    } finally {
      setApproving((s) => { const n = new Set(s); n.delete(queueItemId); return n; });
    }
  }, [refetch]);

  const resetItem = useCallback(async (queueItemId: string) => {
    setApproving((s) => new Set([...s, queueItemId]));
    try {
      await api.post(`/broadcast-v2/asset-health/${queueItemId}/reset`, {});
      toast.success("Repair cycle reset");
      void refetch();
    } catch {
      toast.error("Reset failed");
    } finally {
      setApproving((s) => { const n = new Set(s); n.delete(queueItemId); return n; });
    }
  }, [refetch]);

  if (isLoading) return (
    <div className="flex items-center justify-center h-48 text-zinc-400">
      <RefreshCw className="animate-spin mr-2" size={18} /> Loading automation status…
    </div>
  );

  if (isError || !data) return (
    <div className="flex items-center justify-center h-48 text-red-400">
      <XCircle className="mr-2" size={18} /> Failed to load automation status.
    </div>
  );

  const { workers, workerSummary, assetHealth, recentRepairLog, badUrlStats, selfHealingWorker } = data;
  const hasBlocked = assetHealth.blocked > 0;
  const hasIssues = assetHealth.blocked > 0 || assetHealth.quarantined > 0;

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-screen-xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Bot size={22} className="text-violet-400" />
          <div>
            <h1 className="text-xl font-semibold">Automation Center</h1>
            <p className="text-xs text-zinc-400 mt-0.5">
              Self-healing · Last updated {dataUpdatedAt ? formatDistanceToNow(new Date(dataUpdatedAt), { addSuffix: true }) : "—"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {hasBlocked && (
            <Badge className="bg-red-600 text-white gap-1">
              <ShieldAlert size={11} /> {assetHealth.blocked} blocked
            </Badge>
          )}
          {hasIssues && !hasBlocked && (
            <Badge className="bg-amber-500 text-white gap-1">
              <AlertTriangle size={11} /> {assetHealth.quarantined} quarantined
            </Badge>
          )}
          {!hasIssues && (
            <Badge className="bg-emerald-600 text-white gap-1">
              <CheckCircle2 size={11} /> All sources healthy
            </Badge>
          )}
          <Button size="sm" variant="outline" onClick={handleRefetch} disabled={isFetching} className="gap-1.5">
            <RefreshCw size={13} className={isFetching ? "animate-spin" : ""} /> Refresh
          </Button>
        </div>
      </div>

      {/* Bulk actions */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-xs text-zinc-500">
          Self-healing scan {selfHealingWorker.isRunning ? "running now" : selfHealingWorker.lastScanMs > 0 ? `last ran ${ms(selfHealingWorker.lastScanMs)}` : "not yet run"}
          {" · "}{badUrlStats.cachedBadUrls} bad URL{badUrlStats.cachedBadUrls !== 1 ? "s" : ""} cached
        </p>
        <BulkActions onRefetch={handleRefetch} />
      </div>

      {/* Queue health breakdown */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity size={14} className="text-emerald-400" /> Queue Source Health
          </CardTitle>
        </CardHeader>
        <CardContent>
          <HealthBar summary={assetHealth} />
        </CardContent>
      </Card>

      {/* Workers + blocked items side-by-side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Worker health */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Zap size={14} className="text-amber-400" /> Background Workers
              <span className="text-zinc-500 text-xs font-normal">
                {workerSummary.running}/{workerSummary.total} running
              </span>
              {workerSummary.circuitOpen > 0 && (
                <Badge className="bg-red-600 text-white text-[10px]">{workerSummary.circuitOpen} open</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {workers.map((w) => (
                <WorkerCard key={w.name} w={w} />
              ))}
              {workers.length === 0 && (
                <p className="text-zinc-500 text-xs col-span-2">No workers registered yet.</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Blocked items */}
        <Card className={hasBlocked ? "border-red-800" : ""}>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <ShieldAlert size={14} className={hasBlocked ? "text-red-400" : "text-zinc-400"} />
              Blocked Items
              {hasBlocked && (
                <Badge className="bg-red-600 text-white text-[10px]">{assetHealth.blocked}</Badge>
              )}
              {!hasBlocked && (
                <Badge className="bg-emerald-600 text-white text-[10px]">None</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <BlockedItemsTable
              items={data?.blockedItems ?? []}
              onApprove={(id) => void approveItem(id)}
              onReset={(id) => void resetItem(id)}
              approving={approving}
            />
          </CardContent>
        </Card>
      </div>

      {/* Repair activity feed */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Wrench size={14} className="text-sky-400" /> Repair Activity
            <span className="text-zinc-500 text-xs font-normal">Most recent first · live</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recentRepairLog.length === 0 ? (
            <p className="text-zinc-500 text-xs py-4 text-center">No repair activity yet — all items are healthy.</p>
          ) : (
            <div className="divide-y divide-zinc-800">
              {recentRepairLog.map((item) => (
                <RepairFeedEntry key={item.queueItemId} item={item} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bad URL cache stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Cached bad URLs", value: String(badUrlStats.cachedBadUrls), icon: <XCircle size={13} className="text-red-400" /> },
          { label: "Source sets tracked", value: String(badUrlStats.sourceSetSize), icon: <Server size={13} className="text-zinc-400" /> },
          { label: "Last scan", value: selfHealingWorker.lastScanMs > 0 ? ms(selfHealingWorker.lastScanMs) : "—", icon: <Clock size={13} className="text-zinc-400" /> },
          { label: "Total items tracked", value: String(assetHealth.total), icon: <Activity size={13} className="text-zinc-400" /> },
        ].map(({ label, value, icon }) => (
          <div key={label} className="bg-zinc-900 rounded-lg p-3 text-xs space-y-1.5">
            <div className="flex items-center gap-1.5 text-zinc-500">{icon} {label}</div>
            <p className="text-zinc-200 font-mono text-sm">{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
