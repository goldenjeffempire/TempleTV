import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError } from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  RefreshCw, Play, CheckCircle2, XCircle, Clock,
  Youtube, Database, AlertTriangle, Loader2, History,
  Zap, BarChart2, Tag, Shuffle,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";

interface SyncStatus {
  lastSyncId: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncSource: string | null;
  videosFound: number | null;
  videosInserted: number | null;
  videosUpdated: number | null;
  videosSkipped: number | null;
  videosDeleted: number | null;
  errorMessage: string | null;
  totalYoutubeVideos: number;
  nextSyncAt: string | null;
  syncInProgress: boolean;
  contentWindowDays: number;
}

interface SyncHistoryItem {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  videosFound: number | null;
  videosInserted: number | null;
  videosUpdated: number | null;
  errorMessage: string | null;
  triggeredBy: string;
  source: string | null;
}

interface QuotaStatus {
  used: number;
  total: number;
  resetsAt: string;
  operations: Array<{ operation: string; cost: number; count: number }>;
}

interface CategoryStat {
  category: string;
  count: number;
  pct: number;
}

interface CategoryStats {
  total: number;
  liveServiceCount: number;
  uncategorizedCount: number;
  byCategory: CategoryStat[];
}

interface RecategorizeResult {
  processed: number;
  changed: number;
  unchanged: number;
  errors: number;
  durationMs: number;
  changesByCategory: Record<string, number>;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "completed") return <Badge className="bg-green-500/15 text-green-600 border-green-500/30 gap-1"><CheckCircle2 size={11} /> Completed</Badge>;
  if (status === "completed_with_errors") return <Badge className="bg-orange-500/15 text-orange-600 border-orange-500/30 gap-1"><AlertTriangle size={11} /> Partial</Badge>;
  if (status === "running") return <Badge className="bg-blue-500/15 text-blue-600 border-blue-500/30 gap-1"><Loader2 size={11} className="animate-spin" /> Running</Badge>;
  if (status === "failed") return <Badge className="bg-red-500/15 text-red-600 border-red-500/30 gap-1"><XCircle size={11} /> Failed</Badge>;
  if (status === "interrupted") return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 gap-1"><AlertTriangle size={11} /> Interrupted</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

const CATEGORY_COLORS: Record<string, string> = {
  live_service: "bg-red-500/15 text-red-600 border-red-500/30",
  worship: "bg-purple-500/15 text-purple-600 border-purple-500/30",
  teaching: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  prayer: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  prophecy: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  deliverance: "bg-orange-500/15 text-orange-600 border-orange-500/30",
  crusade: "bg-pink-500/15 text-pink-600 border-pink-500/30",
  conference: "bg-indigo-500/15 text-indigo-600 border-indigo-500/30",
  testimony: "bg-teal-500/15 text-teal-600 border-teal-500/30",
  faith: "bg-cyan-500/15 text-cyan-600 border-cyan-500/30",
  special: "bg-violet-500/15 text-violet-600 border-violet-500/30",
};

const CATEGORY_LABELS: Record<string, string> = {
  live_service: "Live Service",
  worship: "Worship",
  teaching: "Teaching",
  prayer: "Prayer",
  prophecy: "Prophecy",
  deliverance: "Deliverance",
  crusade: "Crusade / Revival",
  conference: "Conference",
  testimony: "Testimony",
  faith: "Faith",
  special: "Special",
};

function categoryLabel(cat: string) {
  return CATEGORY_LABELS[cat] ?? cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function categoryColor(cat: string) {
  return CATEGORY_COLORS[cat] ?? "bg-muted text-muted-foreground border-border";
}

const BAR_COLORS: Record<string, string> = {
  live_service: "bg-red-500",
  worship: "bg-purple-500",
  teaching: "bg-blue-500",
  prayer: "bg-emerald-500",
  prophecy: "bg-amber-500",
  deliverance: "bg-orange-500",
  crusade: "bg-pink-500",
  conference: "bg-indigo-500",
  testimony: "bg-teal-500",
  faith: "bg-cyan-500",
  special: "bg-violet-500",
};

export default function YoutubeSyncPage() {
  const qc = useQueryClient();
  const [historyLimit] = useState(20);
  const [lastRecategorize, setLastRecategorize] = useState<RecategorizeResult | null>(null);

  const { data: status, isLoading: statusLoading, error: statusError, refetch: refetchStatus } = useQuery({
    queryKey: ["yt-sync-status"],
    queryFn: () => api.get<SyncStatus>("/admin/youtube/sync/status"),
    refetchInterval: 10_000,
    staleTime: 8_000,
  });

  const { data: history, isLoading: historyLoading, error: historyError } = useQuery({
    queryKey: ["yt-sync-history", historyLimit],
    queryFn: () => api.get<{ items: SyncHistoryItem[] }>(`/admin/youtube/sync/history?limit=${historyLimit}`),
    refetchInterval: 15_000,
    staleTime: 12_000,
  });

  const { data: quota, isLoading: quotaLoading } = useQuery({
    queryKey: ["youtube-quota"],
    queryFn: () => api.get<QuotaStatus>("/admin/youtube/quota").catch(() => null),
    refetchInterval: 60_000,
    staleTime: 55_000,
  });

  const { data: catStats, isLoading: catStatsLoading, refetch: refetchCatStats } = useQuery({
    queryKey: ["yt-category-stats"],
    queryFn: () => api.get<CategoryStats>("/admin/youtube/sync/category-stats"),
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const triggerMutation = useMutation({
    mutationFn: () => api.post<{
      syncId: string; inserted: number; updated: number; total: number; durationMs: number; source: string;
    }>("/admin/youtube/sync"),
    onSuccess: (result) => {
      toast.success(
        `Sync complete — ${result.total.toLocaleString()} videos (${result.inserted} new, ${result.updated} updated) in ${(result.durationMs / 1000).toFixed(1)}s`,
        { duration: 6000 },
      );
      void qc.invalidateQueries({ queryKey: ["yt-sync-status"] });
      void qc.invalidateQueries({ queryKey: ["yt-sync-history"] });
      void qc.invalidateQueries({ queryKey: ["youtube-quota"] });
      void qc.invalidateQueries({ queryKey: ["yt-category-stats"] });
    },
    onError: (e) => {
      const msg = e instanceof HttpError ? e.message : "Sync failed";
      toast.error(msg);
    },
  });

  const recategorizeMutation = useMutation({
    mutationFn: () => api.post<RecategorizeResult>("/admin/youtube/recategorize"),
    onSuccess: (result) => {
      setLastRecategorize(result);
      toast.success(
        `Re-categorized ${result.processed.toLocaleString()} videos — ${result.changed} updated in ${(result.durationMs / 1000).toFixed(1)}s`,
        { duration: 8000 },
      );
      void qc.invalidateQueries({ queryKey: ["yt-category-stats"] });
      void refetchCatStats();
    },
    onError: (e) => {
      const msg = e instanceof HttpError ? e.message : "Re-categorization failed";
      toast.error(msg);
    },
  });

  const quotaPct = quota ? Math.round((quota.used / quota.total) * 100) : 0;
  const isSyncing = status?.syncInProgress || triggerMutation.isPending;
  const isRecategorizing = recategorizeMutation.isPending;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader
        title="YouTube Sync"
        description="Monitor and control the @TEMPLETVJCTM channel sync pipeline."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => { void refetchStatus(); }} className="gap-1.5">
              <RefreshCw size={13} /> Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => triggerMutation.mutate()}
              disabled={isSyncing || isRecategorizing}
              className="gap-1.5"
            >
              {isSyncing ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {isSyncing ? "Syncing…" : "Sync Now"}
            </Button>
          </div>
        }
      />

      {statusError && (
        <ErrorAlert
          message={(statusError as Error).message}
          onRetry={() => void refetchStatus()}
          transient={isTransientError(statusError)}
        />
      )}

      {!statusLoading && status?.lastSyncStatus === "interrupted" && (
        <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-500/8 border border-amber-500/25 text-amber-700 dark:text-amber-400">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Last sync was interrupted by a server restart</p>
            <p className="text-xs mt-0.5 text-amber-600/80 dark:text-amber-400/70">
              The sync process was cut short before it could complete. Videos synced up to the interruption point are safe in the database.
              Run a manual sync to ensure the library is fully up to date.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="flex-shrink-0 border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
            onClick={() => triggerMutation.mutate()}
            disabled={isSyncing}
          >
            {isSyncing ? <Loader2 size={12} className="animate-spin mr-1" /> : <Play size={12} className="mr-1" />}
            Sync Now
          </Button>
        </div>
      )}

      {/* ── Status overview ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-1">Total Videos</p>
                {statusLoading ? <Skeleton className="h-8 w-20" /> : (
                  <p className="text-2xl font-bold">{(status?.totalYoutubeVideos ?? 0).toLocaleString()}</p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">
                  {status?.contentWindowDays ? `${status.contentWindowDays / 365}-year window` : "YouTube videos synced"}
                </p>
              </div>
              <div className="p-2 bg-red-500/10 rounded-lg">
                <Youtube size={18} className="text-red-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-1">Last Sync</p>
                {statusLoading ? <Skeleton className="h-8 w-28" /> : (
                  <p className="text-2xl font-bold">
                    {status?.lastSyncAt
                      ? formatDistanceToNow(new Date(status.lastSyncAt), { addSuffix: true })
                      : "Never"}
                  </p>
                )}
                {status?.lastSyncStatus && (
                  <div className="mt-0.5"><StatusBadge status={status.lastSyncStatus} /></div>
                )}
              </div>
              <div className="p-2 bg-primary/10 rounded-lg">
                <Clock size={18} className="text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-1">Next Sync</p>
                {statusLoading ? <Skeleton className="h-8 w-24" /> : (
                  <p className="text-2xl font-bold">
                    {isSyncing ? "Now" : status?.nextSyncAt
                      ? formatDistanceToNow(new Date(status.nextSyncAt), { addSuffix: true })
                      : "—"}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">
                  {isSyncing ? "Sync in progress…" : "Auto-scheduled"}
                </p>
              </div>
              <div className={`p-2 rounded-lg ${isSyncing ? "bg-blue-500/10" : "bg-muted"}`}>
                <Zap size={18} className={isSyncing ? "text-blue-500 animate-pulse" : "text-muted-foreground"} />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Last sync detail ──────────────────────────────────────────────── */}
      {status?.lastSyncAt && status.videosFound != null && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Database size={14} /> Last Sync Results
              {status.lastSyncStatus && (
                <span className="ml-auto">
                  <StatusBadge status={status.lastSyncStatus} />
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Found</p>
                <p className="text-lg font-bold">{(status.videosFound ?? 0).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">New</p>
                <p className="text-lg font-bold text-green-600">+{(status.videosInserted ?? 0).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Updated</p>
                <p className="text-lg font-bold text-blue-600">{(status.videosUpdated ?? 0).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Deleted</p>
                <p className="text-lg font-bold text-muted-foreground">{(status.videosDeleted ?? 0).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Source</p>
                <Badge variant="outline" className="text-[11px]">
                  {status.lastSyncSource === "youtube_api" ? "YouTube API v3"
                    : status.lastSyncSource === "rss" ? "RSS Feed"
                    : (status.lastSyncSource ?? "—")}
                </Badge>
              </div>
            </div>
            {status.errorMessage && (
              <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-red-500/5 border border-red-500/20 text-red-600 text-sm">
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                <span>{status.errorMessage}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Category Breakdown ────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Tag size={14} /> Category Breakdown
              {catStatsLoading && <Loader2 size={11} className="animate-spin text-muted-foreground" />}
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => recategorizeMutation.mutate()}
              disabled={isRecategorizing || isSyncing}
              className="gap-1.5 text-xs h-7"
            >
              {isRecategorizing
                ? <><Loader2 size={11} className="animate-spin" /> Re-categorizing…</>
                : <><Shuffle size={11} /> Re-categorize All</>
              }
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {catStatsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
            </div>
          ) : !catStats || catStats.total === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Tag size={24} className="text-muted-foreground/20" />
              <p className="text-sm text-muted-foreground">No YouTube videos synced yet</p>
            </div>
          ) : (
            <>
              {/* Live Service highlight */}
              <div className="flex items-center gap-3 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                <div className="p-1.5 bg-red-500/10 rounded-md">
                  <Youtube size={14} className="text-red-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-red-600">Live Service</span>
                    <span className="text-sm font-bold">{(catStats.liveServiceCount).toLocaleString()}</span>
                  </div>
                  <Progress
                    value={catStats.total > 0 ? (catStats.liveServiceCount / catStats.total) * 100 : 0}
                    className="h-1.5 [&>div]:bg-red-500"
                  />
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {catStats.total > 0 ? Math.round((catStats.liveServiceCount / catStats.total) * 100) : 0}% of library
                  </p>
                </div>
              </div>

              {/* All categories stacked bar */}
              <div className="flex h-3 w-full rounded-full overflow-hidden gap-px">
                {catStats.byCategory.map((cat) => (
                  <div
                    key={cat.category}
                    className={`${BAR_COLORS[cat.category] ?? "bg-muted-foreground"} transition-all`}
                    style={{ width: `${cat.pct}%`, minWidth: cat.pct > 0 ? "2px" : "0" }}
                    title={`${categoryLabel(cat.category)}: ${cat.count} (${cat.pct}%)`}
                  />
                ))}
              </div>

              {/* Category list */}
              <div className="divide-y border rounded-lg overflow-hidden">
                {catStats.byCategory.map((cat) => (
                  <div key={cat.category} className="flex items-center gap-3 px-3 py-2.5">
                    <Badge className={`text-[10px] shrink-0 ${categoryColor(cat.category)}`}>
                      {categoryLabel(cat.category)}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${BAR_COLORS[cat.category] ?? "bg-muted-foreground"}`}
                          style={{ width: `${cat.pct}%` }}
                        />
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="text-sm font-semibold">{cat.count.toLocaleString()}</span>
                      <span className="text-[11px] text-muted-foreground ml-1.5">{cat.pct}%</span>
                    </div>
                  </div>
                ))}
              </div>

              <p className="text-xs text-muted-foreground">
                {catStats.total.toLocaleString()} total YouTube videos · Re-categorize applies current keyword rules to all unlocked videos.
              </p>
            </>
          )}

          {/* Re-categorize result */}
          {lastRecategorize && (
            <div className="p-3 rounded-lg bg-green-500/5 border border-green-500/20 space-y-2">
              <div className="flex items-center gap-2 text-green-600 text-sm font-medium">
                <CheckCircle2 size={13} />
                Re-categorization complete in {(lastRecategorize.durationMs / 1000).toFixed(1)}s
              </div>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <p className="text-xs text-muted-foreground">Processed</p>
                  <p className="text-base font-bold">{lastRecategorize.processed.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Recategorized</p>
                  <p className="text-base font-bold text-green-600">{lastRecategorize.changed.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Unchanged</p>
                  <p className="text-base font-bold text-muted-foreground">{lastRecategorize.unchanged.toLocaleString()}</p>
                </div>
              </div>
              {Object.keys(lastRecategorize.changesByCategory).length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {Object.entries(lastRecategorize.changesByCategory)
                    .sort(([, a], [, b]) => b - a)
                    .map(([cat, cnt]) => (
                      <Badge key={cat} className={`text-[10px] gap-1 ${categoryColor(cat)}`}>
                        +{cnt} {categoryLabel(cat)}
                      </Badge>
                    ))}
                </div>
              )}
              {lastRecategorize.errors > 0 && (
                <p className="text-xs text-amber-600 flex items-center gap-1">
                  <AlertTriangle size={11} /> {lastRecategorize.errors} row(s) failed to update.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── YouTube API Quota ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><BarChart2 size={14} /> YouTube API Quota</CardTitle>
        </CardHeader>
        <CardContent>
          {quotaLoading ? <Skeleton className="h-16 w-full" /> : !quota ? (
            <div className="flex items-center gap-3 py-3 text-sm text-muted-foreground">
              <AlertTriangle size={16} className="flex-shrink-0" />
              <div>
                <p className="font-medium text-foreground">API key not configured</p>
                <p className="text-xs">Set YOUTUBE_API_KEY to enable full historical sync. RSS fallback is active (last ~15 videos only).</p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{quota.used.toLocaleString()} / {quota.total.toLocaleString()} units used today</span>
                <Badge variant={quotaPct > 90 ? "destructive" : quotaPct > 70 ? "secondary" : "outline"}>
                  {quotaPct}%
                </Badge>
              </div>
              <Progress value={quotaPct} className="h-2.5" />
              <p className="text-xs text-muted-foreground">Resets {format(new Date(quota.resetsAt), "MMM d, h:mm a")}</p>
              {quotaPct > 80 && (
                <div className="flex items-center gap-2 text-amber-600 text-xs font-medium">
                  <AlertTriangle size={13} /> Quota running low — sync will fall back to RSS if exhausted.
                </div>
              )}
              {quota.operations.length > 0 && (
                <div className="mt-2 divide-y border rounded-lg overflow-hidden">
                  {quota.operations.map(op => (
                    <div key={op.operation} className="flex items-center justify-between px-3 py-2 text-xs">
                      <span className="capitalize text-muted-foreground">{op.operation.replace(/_/g, " ")}</span>
                      <span className="font-mono font-medium">{(op.count * op.cost).toLocaleString()} units</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Sync History ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <History size={14} /> Sync History
            {historyLoading && <Loader2 size={12} className="animate-spin ml-auto text-muted-foreground" />}
          </CardTitle>
        </CardHeader>
        {historyError && (
          <CardContent className="pt-0">
            <ErrorAlert message="Failed to load sync history" onRetry={() => void qc.invalidateQueries({ queryKey: ["yt-sync-history"] })} />
          </CardContent>
        )}
        {!historyError && (
          <CardContent className="p-0">
            {historyLoading ? (
              <div className="divide-y">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full rounded-none" />)}
              </div>
            ) : (history?.items?.length ?? 0) === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <History size={28} className="text-muted-foreground/20" />
                <p className="text-sm text-muted-foreground">No sync history yet</p>
              </div>
            ) : (
              <div className="divide-y">
                {history!.items.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-shrink-0">
                      <StatusBadge status={item.status} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium">
                          {item.videosFound != null
                            ? `${item.videosFound.toLocaleString()} found · +${item.videosInserted ?? 0} new · ${item.videosUpdated ?? 0} updated`
                            : item.status === "running"
                              ? "Running…"
                              : item.status === "interrupted"
                                ? "Interrupted before completion"
                                : "—"}
                        </p>
                        <Badge variant="outline" className="text-[10px] capitalize">
                          {item.triggeredBy}
                        </Badge>
                        {item.source && (
                          <Badge variant="outline" className="text-[10px]">
                            {item.source === "youtube_api" ? "API v3" : item.source === "rss" ? "RSS" : item.source}
                          </Badge>
                        )}
                      </div>
                      {item.errorMessage && (
                        <p className="text-xs text-red-500 mt-0.5 truncate">{item.errorMessage}</p>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(item.startedAt), { addSuffix: true })}
                      </p>
                      {item.completedAt && (
                        <p className="text-[11px] text-muted-foreground/60">
                          {format(new Date(item.startedAt), "HH:mm:ss")}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
