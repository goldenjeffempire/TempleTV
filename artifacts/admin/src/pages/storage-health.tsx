import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2, XCircle, AlertTriangle, RefreshCw, HardDrive,
  Database, Clock, Wrench, ChevronDown, ChevronUp, Info,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// ── Types ──────────────────────────────────────────────────────────────────────

interface BlobItem {
  queueId: string;
  videoId: string;
  title: string;
  objectPath: string | null;
  transcodingStatus: string;
  videoSource: string;
  sourceCleanupStatus: string | null;
  blobKey: string | null;
  blobSizeBytes: number | null;
  blobUpdatedAt: string | null;
  blobPresent: boolean;
  isSourceDeleted: boolean;
  hasGap: boolean;
  gapCount: number;
}

interface ReconStats {
  itemsChecked: number;
  blobsVerified: number;
  gapsFound: number;
  recoveries: number;
  orphanedBlobCount: number;
  deletedOrphanBlobCount: number;
  consecutiveErrors: number;
  lastRunAt: number | null;
  lastPassElapsedMs: number | null;
}

interface BlobStatusResponse {
  generatedAtMs: number;
  items: BlobItem[];
  totalItems: number;
  healthyCount: number;
  missingCount: number;
  noObjectPath: number;
  reconStats: ReconStats;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatRelative(ms: number | null): string {
  if (!ms) return "—";
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function itemStatus(item: BlobItem): "healthy" | "deleted" | "missing" | "no-path" {
  if (item.isSourceDeleted) return "deleted";
  if (item.blobPresent) return "healthy";
  if (!item.objectPath) return "no-path";
  return "missing";
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({
  label, value, icon, tone,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  tone?: "green" | "red" | "amber" | "default";
}) {
  const colorMap = {
    green:   "text-green-600 dark:text-green-400 bg-green-500/10",
    red:     "text-red-600 dark:text-red-400 bg-red-500/10",
    amber:   "text-amber-600 dark:text-amber-400 bg-amber-500/10",
    default: "text-muted-foreground bg-muted/40",
  };
  const cls = colorMap[tone ?? "default"];
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0", cls)}>
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground leading-none mb-1">{label}</p>
          <p className="text-xl font-semibold tabular-nums leading-none">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: ReturnType<typeof itemStatus> }) {
  switch (status) {
    case "healthy":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-400">
          <CheckCircle2 size={13} /> Present
        </span>
      );
    case "deleted":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <Info size={13} /> Source deleted
        </span>
      );
    case "missing":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400">
          <XCircle size={13} /> Missing
        </span>
      );
    case "no-path":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">
          <AlertTriangle size={13} /> No object path
        </span>
      );
  }
}

function GapBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Badge variant="outline" className="text-amber-600 border-amber-400/40 bg-amber-500/5 text-[10px] px-1.5 py-0 h-4">
      {count}× gap
    </Badge>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function StorageHealth() {
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [repairing, setRepairing] = useState<Set<string>>(new Set());

  const { data, isLoading, isFetching, dataUpdatedAt, error } = useQuery<BlobStatusResponse>({
    queryKey: ["storage-blob-status"],
    queryFn: async () => {
      const res = await fetch("/api/broadcast-v2/mp4-blob-status", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<BlobStatusResponse>;
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const repairMutation = useMutation({
    mutationFn: async (videoId: string) => {
      const res = await fetch(`/api/broadcast-v2/storage-repair/${videoId}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ ok: boolean; tier: string; message: string }>;
    },
    onMutate: (videoId) => {
      setRepairing((s) => new Set(s).add(videoId));
    },
    onSuccess: (result, videoId) => {
      setRepairing((s) => { const n = new Set(s); n.delete(videoId); return n; });
      toast.success(`Repair triggered — tier: ${result.tier}`, {
        description: result.message,
        duration: 8_000,
      });
      void qc.invalidateQueries({ queryKey: ["storage-blob-status"] });
    },
    onError: (err: Error, videoId) => {
      setRepairing((s) => { const n = new Set(s); n.delete(videoId); return n; });
      toast.error(`Repair failed: ${err.message}`);
    },
  });

  const handleRefresh = () => {
    void qc.invalidateQueries({ queryKey: ["storage-blob-status"] });
  };

  const handleRepair = (videoId: string, title: string) => {
    if (repairing.has(videoId)) return;
    repairMutation.mutate(videoId);
    toast.info(`Triggering recovery for "${title}"…`);
  };

  if (error) {
    return (
      <div className="p-6 max-w-3xl">
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 flex items-start gap-3">
          <XCircle size={16} className="text-destructive mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-destructive">Failed to load storage health</p>
            <p className="text-xs text-muted-foreground mt-1">{String(error)}</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={handleRefresh}>Retry</Button>
          </div>
        </div>
      </div>
    );
  }

  const items = data?.items ?? [];
  const missingItems = items.filter((i) => itemStatus(i) === "missing" || i.hasGap);
  const displayItems = showAll ? items : items.slice(0, 30);

  const reconStats = data?.reconStats;
  const lastRunMs = reconStats?.lastRunAt ?? null;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Storage Health</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            MP4 blob availability for active broadcast queue items
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={isFetching}
          className="gap-1.5 flex-shrink-0"
        >
          <RefreshCw size={13} className={isFetching ? "animate-spin" : ""} />
          {isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {/* Last-updated line */}
      {dataUpdatedAt > 0 && (
        <p className="text-[11px] text-muted-foreground -mt-4">
          Last updated {formatRelative(dataUpdatedAt)} · auto-refreshes every 30 s
        </p>
      )}

      {/* Summary stat cards */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[1,2,3,4].map((i) => <Skeleton key={i} className="h-[74px]" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            label="Total MP4 items"
            value={data?.totalItems ?? 0}
            icon={<Database size={16} />}
          />
          <StatCard
            label="Blobs present"
            value={data?.healthyCount ?? 0}
            icon={<CheckCircle2 size={16} />}
            tone={data && data.healthyCount === data.totalItems ? "green" : "default"}
          />
          <StatCard
            label="Blobs missing"
            value={data?.missingCount ?? 0}
            icon={<XCircle size={16} />}
            tone={(data?.missingCount ?? 0) > 0 ? "red" : "green"}
          />
          <StatCard
            label="No object path"
            value={data?.noObjectPath ?? 0}
            icon={<AlertTriangle size={16} />}
            tone={(data?.noObjectPath ?? 0) > 0 ? "amber" : "default"}
          />
        </div>
      )}

      {/* Reconciliation worker stats */}
      {reconStats && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <HardDrive size={14} className="text-muted-foreground" />
              Reconciliation Worker
              {reconStats.consecutiveErrors > 0 && (
                <Badge variant="destructive" className="text-[10px] h-4 px-1.5">
                  {reconStats.consecutiveErrors} errors
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Items checked</p>
                <p className="font-semibold tabular-nums">{reconStats.itemsChecked.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Blobs verified</p>
                <p className="font-semibold tabular-nums">{reconStats.blobsVerified.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Gaps found</p>
                <p className={cn("font-semibold tabular-nums", reconStats.gapsFound > 0 ? "text-red-600 dark:text-red-400" : "")}>
                  {reconStats.gapsFound.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Recoveries</p>
                <p className="font-semibold tabular-nums text-green-600 dark:text-green-400">
                  {reconStats.recoveries.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Orphaned blobs</p>
                <p className="font-semibold tabular-nums">{reconStats.orphanedBlobCount.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Orphans deleted</p>
                <p className="font-semibold tabular-nums">{reconStats.deletedOrphanBlobCount.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock size={11} />Last pass</p>
                <p className="font-semibold text-xs">{formatRelative(lastRunMs)}</p>
              </div>
              {reconStats.lastPassElapsedMs !== null && (
                <div>
                  <p className="text-xs text-muted-foreground">Pass duration</p>
                  <p className="font-semibold tabular-nums text-xs">
                    {reconStats.lastPassElapsedMs < 1000
                      ? `${reconStats.lastPassElapsedMs} ms`
                      : `${(reconStats.lastPassElapsedMs / 1000).toFixed(1)} s`}
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Missing / gap items — call-to-action section */}
      {!isLoading && missingItems.length > 0 && (
        <Card className="border-red-300/40 dark:border-red-700/40 bg-red-500/3">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2 text-red-700 dark:text-red-400">
              <AlertTriangle size={14} />
              {missingItems.length} item{missingItems.length !== 1 ? "s" : ""} need attention
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {missingItems.map((item) => (
                <div key={item.queueId} className="px-4 py-3 flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.title}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <StatusBadge status={itemStatus(item)} />
                      {item.hasGap && <GapBadge count={item.gapCount} />}
                      {item.objectPath && (
                        <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[240px]">
                          {item.objectPath}
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 flex-shrink-0"
                    disabled={repairing.has(item.videoId)}
                    onClick={() => handleRepair(item.videoId, item.title)}
                  >
                    <Wrench size={12} />
                    {repairing.has(item.videoId) ? "Repairing…" : "Trigger repair"}
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Full queue item table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Database size={14} className="text-muted-foreground" />
            Active queue items ({data?.totalItems ?? 0})
            {isLoading && <RefreshCw size={12} className="animate-spin text-muted-foreground" />}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="px-4 py-3 space-y-3">
              {[1,2,3,4,5].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-24" />
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No non-YouTube items in the active queue.
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Title</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Status</th>
                      <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Size</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Upload date</th>
                      <th className="px-4 py-2 text-xs font-medium text-muted-foreground"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {displayItems.map((item) => {
                      const status = itemStatus(item);
                      const rowCls = status === "missing"
                        ? "bg-red-500/3 hover:bg-red-500/6"
                        : status === "no-path"
                          ? "bg-amber-500/3 hover:bg-amber-500/6"
                          : "hover:bg-muted/30";
                      return (
                        <tr key={item.queueId} className={cn("transition-colors", rowCls)}>
                          <td className="px-4 py-2.5 max-w-xs">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="truncate font-medium text-sm">{item.title}</span>
                              {item.hasGap && <GapBadge count={item.gapCount} />}
                            </div>
                            {item.objectPath && (
                              <p className="text-[10px] font-mono text-muted-foreground truncate mt-0.5 max-w-[280px]">
                                {item.objectPath}
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <StatusBadge status={status} />
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-xs whitespace-nowrap">
                            {formatBytes(item.blobSizeBytes)}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                            {formatDate(item.blobUpdatedAt)}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {(status === "missing" || item.hasGap) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
                                disabled={repairing.has(item.videoId)}
                                onClick={() => handleRepair(item.videoId, item.title)}
                              >
                                <Wrench size={11} />
                                {repairing.has(item.videoId) ? "…" : "Repair"}
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Show more toggle */}
              {items.length > 30 && (
                <div className="px-4 py-3 border-t flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    Showing {displayItems.length} of {items.length} items
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowAll((v) => !v)}
                    className="gap-1.5 text-xs"
                  >
                    {showAll ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    {showAll ? "Show fewer" : `Show all ${items.length}`}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* All-healthy state */}
      {!isLoading && data && data.missingCount === 0 && data.noObjectPath === 0 && data.totalItems > 0 && (
        <div className="rounded-lg border border-green-300/40 bg-green-500/5 px-4 py-3 flex items-center gap-3">
          <CheckCircle2 size={16} className="text-green-600 dark:text-green-400 flex-shrink-0" />
          <p className="text-sm text-green-700 dark:text-green-400">
            All {data.totalItems} MP4 blobs are present and accounted for.
          </p>
        </div>
      )}
    </div>
  );
}
