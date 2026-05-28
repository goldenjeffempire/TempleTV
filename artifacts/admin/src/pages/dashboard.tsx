import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { api, isTransientError} from "@/lib/api";
import { useSSE, useSSEEvent, useRecentActivity } from "@/contexts/sse-context";
import { MetricCard } from "@/components/shared/metric-card";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Video, Users, Bell, Clapperboard, Radio, ArrowRight,
  Clock, Activity, CheckCircle2, XCircle, Loader2, Zap, AlertTriangle,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDistanceToNow } from "date-fns";

interface AdminStats {
  videos: {
    total: number;
    featured: number;
    bySource: Record<string, number>;
  };
  users: {
    total: number;
    byRole: Record<string, number>;
  };
  playlists: { total: number };
  schedule: { total: number; active: number };
  notifications: { sentLast24h: number; sentTotal: number };
  broadcast: { queueDepth: number; activeQueueDepth: number };
  devices: { total: number };
  generatedAt: string;
}

interface TranscodingJob {
  id: string;
  videoId: string;
  title: string;
  status: string;
  createdAt: string;
  progress?: number;
}

interface ScheduledNotif {
  id: string;
  title: string;
  body: string;
  scheduledAt: string;
  status: string;
}

interface ReadyzResponse {
  status: string;
  dependencies: { database: string; cache: string; storage: string };
  broadcast: { viewerCount: number };
}

interface EngineHealthSummary {
  sequence: number;
  uptimeMs: number;
  hasCurrent: boolean;
  mode: string;
  itemCount: number;
  currentTitle: string | null;
  nextTitle: string | null;
  currentElapsedSecs: number | null;
  currentDurationSecs: number | null;
  offAirReason: "empty" | "all_blocked" | null;
  deadAir: boolean;
  stuck: boolean;
  boot: { busBridgeInstalled: boolean; startAttempts: number; lastStartError: string | null };
  reload: { lastReloadAtMs: number | null; lastReloadOk: boolean; attempts: number; successes: number };
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function Dashboard() {
  const qc = useQueryClient();
  const { lastStatusPayload } = useSSE();
  const activity = useRecentActivity();

  const { data: stats, isLoading: statsLoading, error: statsError, refetch: refetchStats } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: () => api.get<AdminStats>("/admin/stats"),
    staleTime: 15_000,
    refetchInterval: 15_000,
  });

  const { data: readyz } = useQuery({
    queryKey: ["readyz"],
    queryFn: () => api.get<ReadyzResponse>("/readyz"),
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const { data: transcodingQueue, isLoading: transcodingLoading } = useQuery({
    queryKey: ["transcoding-queue"],
    queryFn: () => api.get<{ jobs: TranscodingJob[] }>("/admin/transcoding/queue").catch(() => ({ jobs: [] as TranscodingJob[] })),
    refetchInterval: 15_000,
    staleTime: 12_000,
  });

  const { data: scheduled } = useQuery({
    queryKey: ["scheduled-notifications-summary"],
    queryFn: () => api.get<{ items: ScheduledNotif[] }>("/admin/notifications/scheduled").catch(() => ({ items: [] })),
    staleTime: 30_000,
  });

  const { data: engineHealth } = useQuery({
    queryKey: ["dashboard-engine-health"],
    queryFn: () => api.get<EngineHealthSummary>("/broadcast-v2/health").catch(() => null),
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  useSSEEvent("broadcast-queue-updated", () => { void qc.invalidateQueries({ queryKey: ["admin-stats"] }); });
  useSSEEvent("transcoding-update", () => { void qc.invalidateQueries({ queryKey: ["transcoding-queue"] }); });
  useSSEEvent("videos-library-updated", () => { void qc.invalidateQueries({ queryKey: ["admin-stats"] }); });

  const isLive = lastStatusPayload?.isLive ?? false;
  const viewerCount = lastStatusPayload?.deviceCount ?? readyz?.broadcast?.viewerCount ?? 0;
  const dbOk = readyz?.dependencies?.database === "ok";
  const pendingJobs = transcodingQueue?.jobs?.filter(j => ["queued", "encoding", "processing"].includes(j.status)) ?? [];

  const isEngineStuck =
    engineHealth !== null &&
    engineHealth !== undefined &&
    engineHealth.sequence === 0 &&
    engineHealth.uptimeMs > 30_000 &&
    engineHealth.boot.busBridgeInstalled;

  if (statsError) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title="Dashboard" description="System overview" />
        <ErrorAlert message={(statsError as Error).message} onRetry={() => void refetchStats()} transient={isTransientError(statsError)} />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Dashboard"
        description={`${DAY_NAMES[new Date().getDay()]}, ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`}
        actions={
          <Tooltip>
            <TooltipTrigger asChild>
              <Link href="/live-control">
                <Button
                  size="sm"
                  variant={isLive ? "destructive" : "default"}
                  className={`gap-2 ${isEngineStuck ? "border-amber-500 ring-1 ring-amber-500/40" : ""}`}
                >
                  {isEngineStuck && <AlertTriangle size={13} className="text-amber-400" />}
                  <Radio size={14} />
                  {isLive ? "On Air" : "Live Control"}
                </Button>
              </Link>
            </TooltipTrigger>
            {isEngineStuck && (
              <TooltipContent side="bottom" className="max-w-[220px] text-center">
                <p className="font-medium text-amber-500 flex items-center gap-1 justify-center">
                  <AlertTriangle size={12} /> Engine check required
                </p>
                <p className="text-xs mt-1 text-muted-foreground">
                  Broadcast orchestrator stuck at sequence 0. Open Master Control before going live.
                </p>
              </TooltipContent>
            )}
          </Tooltip>
        }
      />

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Total Videos"
          value={statsLoading ? null : stats?.videos?.total}
          icon={<Video size={16} />}
          loading={statsLoading}
          subtitle={stats ? `${stats.videos.featured} featured` : "In library"}
        />
        <MetricCard
          title="Registered Users"
          value={statsLoading ? null : stats?.users?.total}
          icon={<Users size={16} />}
          loading={statsLoading}
          subtitle={`${viewerCount} active now`}
        />
        <MetricCard
          title="Transcoding Jobs"
          value={statsLoading ? null : pendingJobs.length}
          icon={<Clapperboard size={16} />}
          loading={statsLoading || transcodingLoading}
          subtitle="Pending / encoding"
          highlight={pendingJobs.length > 5 ? "warning" : undefined}
        />
        <MetricCard
          title="Scheduled Notifs"
          value={statsLoading ? null : (scheduled?.items?.length ?? 0)}
          icon={<Bell size={16} />}
          loading={statsLoading}
          subtitle="Queued to send"
        />
      </div>

      {/* Stuck / dead-air action banner — shown when the broadcast engine needs attention */}
      {(isEngineStuck || engineHealth?.deadAir) && (
        <div className={`flex items-start gap-3 p-4 rounded-lg border text-sm ${
          isEngineStuck
            ? "border-red-500/40 bg-red-500/5"
            : "border-amber-500/40 bg-amber-500/5"
        }`}>
          <AlertTriangle
            size={16}
            className={`${isEngineStuck ? "text-red-500" : "text-amber-500"} mt-0.5 flex-shrink-0`}
          />
          <div className="flex-1 min-w-0">
            <p className={`font-semibold ${isEngineStuck ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400"}`}>
              {isEngineStuck
                ? "Broadcast engine stuck — action required"
                : "Dead air — content in queue but not playing"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isEngineStuck
                ? `Engine has been running ${Math.round((engineHealth?.uptimeMs ?? 0) / 1000)}s without advancing past sequence 0. ${engineHealth?.itemCount ?? 0} item(s) in queue. Open Master Control and check for source errors.`
                : `${engineHealth?.itemCount ?? 0} item(s) queued but nothing is on air. Sources may be blocked — check Stream Health.`}
            </p>
            <div className="flex flex-wrap gap-2 mt-2.5">
              <Link href="/broadcast-v2">
                <Button size="sm" variant={isEngineStuck ? "destructive" : "default"} className="h-7 text-xs gap-1.5">
                  <Radio size={12} /> Open Master Control
                </Button>
              </Link>
              <Link href="/stream-health">
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5">
                  <Activity size={12} /> Stream Health
                </Button>
              </Link>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Live Status */}
        <Card className={isLive ? "border-red-500/40 bg-red-500/5" : ""}>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Radio size={15} className={isLive ? "text-red-500 animate-pulse" : "text-muted-foreground"} />
                Broadcast Status
              </span>
              <Link href="/live-control"><Button variant="ghost" size="sm" className="h-6 text-xs">Manage <ArrowRight size={12} className="ml-1" /></Button></Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <div className={`w-2.5 h-2.5 rounded-full ${isLive ? "bg-red-500 animate-pulse" : "bg-muted-foreground/30"}`} />
              <span className="font-semibold text-sm">{isLive ? "ON AIR" : "OFF AIR"}</span>
              {isLive && lastStatusPayload?.liveOverride && (
                <Badge variant="destructive" className="text-[10px]">Override Active</Badge>
              )}
            </div>
            {isLive && lastStatusPayload?.liveOverride && (
              <p className="text-xs text-muted-foreground truncate">{lastStatusPayload.liveOverride.title}</p>
            )}
            {/* v2 broadcast engine status */}
            {engineHealth != null && (
              <div className={`rounded-md border px-2.5 py-2 space-y-1.5 ${engineHealth.deadAir ? "border-amber-300/60 bg-amber-50/60 dark:border-amber-700/50 dark:bg-amber-950/20" : engineHealth.stuck ? "border-red-300/60 bg-red-50/60 dark:border-red-700/50 dark:bg-red-950/20" : ""}`}>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full shrink-0 ${engineHealth.hasCurrent ? "bg-emerald-500 animate-pulse" : engineHealth.deadAir ? "bg-amber-500" : "bg-muted-foreground/30"}`} />
                  <div className="min-w-0 flex-1">
                    <span className={`text-xs font-medium ${engineHealth.deadAir ? "text-amber-700 dark:text-amber-300" : ""}`}>
                      {engineHealth.stuck
                        ? "Engine stuck — check Master Control"
                        : engineHealth.deadAir
                        ? "Dead air — content in queue"
                        : engineHealth.hasCurrent
                        ? "Broadcasting"
                        : engineHealth.offAirReason === "empty"
                        ? "Queue empty"
                        : "Off air"}
                    </span>
                    {engineHealth.itemCount > 0 && (
                      <span className="text-xs text-muted-foreground ml-1.5">
                        ({engineHealth.itemCount} item{engineHealth.itemCount !== 1 ? "s" : ""})
                      </span>
                    )}
                  </div>
                  <Link href="/broadcast-v2">
                    <button className="text-[10px] text-primary hover:underline shrink-0">
                      Control →
                    </button>
                  </Link>
                </div>
                {/* Now playing title */}
                {engineHealth.hasCurrent && engineHealth.currentTitle && (
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="w-2 h-2 shrink-0" />
                    <p className="text-xs text-muted-foreground truncate min-w-0 flex-1" title={engineHealth.currentTitle}>
                      {engineHealth.currentTitle}
                    </p>
                    {engineHealth.currentElapsedSecs !== null && engineHealth.currentDurationSecs !== null && (
                      <span className="text-[10px] tabular-nums text-muted-foreground/60 shrink-0">
                        {Math.floor(engineHealth.currentElapsedSecs / 60)}:{String(engineHealth.currentElapsedSecs % 60).padStart(2, "0")}
                        {" / "}
                        {Math.floor(engineHealth.currentDurationSecs / 60)}:{String(engineHealth.currentDurationSecs % 60).padStart(2, "0")}
                      </span>
                    )}
                  </div>
                )}
                {/* Next up preview */}
                {engineHealth.hasCurrent && engineHealth.nextTitle && (
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="w-2 h-2 shrink-0" />
                    <p className="text-[10px] text-muted-foreground/60 truncate min-w-0" title={`Next: ${engineHealth.nextTitle}`}>
                      Next: {engineHealth.nextTitle}
                    </p>
                  </div>
                )}
              </div>
            )}
            <div className="text-2xl font-bold">{viewerCount.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">Active viewers</p>
            {/* System dependencies health row */}
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground pt-0.5">
              <span className="flex items-center gap-1">
                {dbOk ? <CheckCircle2 size={11} className="text-green-500" /> : <XCircle size={11} className="text-red-500" />}
                Database
              </span>
              {readyz?.dependencies?.cache && (
                <span className="flex items-center gap-1">
                  {readyz.dependencies.cache === "ok" ? <CheckCircle2 size={11} className="text-green-500" /> : <Activity size={11} className="text-amber-500" />}
                  Cache
                </span>
              )}
              {readyz?.dependencies?.storage && (
                <span className="flex items-center gap-1">
                  {readyz.dependencies.storage === "ok" ? <CheckCircle2 size={11} className="text-green-500" /> : <XCircle size={11} className="text-red-500" />}
                  Storage
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Transcoding Queue */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2"><Clapperboard size={15} />Transcoding Queue</span>
              <Link href="/transcoding"><Button variant="ghost" size="sm" className="h-6 text-xs">View all <ArrowRight size={12} className="ml-1" /></Button></Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="min-h-[160px] flex flex-col justify-center">
            {transcodingLoading ? (
              <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : pendingJobs.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-4 text-center">
                <CheckCircle2 size={20} className="text-green-500" />
                <p className="text-sm text-muted-foreground">All jobs complete</p>
              </div>
            ) : (
              <div className="space-y-2">
                {pendingJobs.slice(0, 4).map(job => (
                  <div key={job.id} className="flex items-center gap-2.5 text-sm">
                    <Loader2 size={13} className="animate-spin text-amber-500 flex-shrink-0" />
                    <span className="truncate flex-1 text-xs">{job.title || job.videoId.slice(0, 12)}</span>
                    <Badge variant="outline" className="text-[10px] flex-shrink-0 capitalize">{job.status}</Badge>
                  </div>
                ))}
                {pendingJobs.length > 4 && (
                  <p className="text-xs text-muted-foreground">+{pendingJobs.length - 4} more</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Activity Feed */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Activity size={15} /> Live Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activity.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-4 text-center">
                <Zap size={18} className="text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">No recent events</p>
              </div>
            ) : (
              <ScrollArea className="h-[160px]">
                <div className="space-y-2.5">
                  {activity.map(e => (
                    <div key={e.id} className="flex items-start gap-2 text-xs">
                      <Clock size={11} className="text-muted-foreground mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="leading-tight">{e.summary}</p>
                        <p className="text-muted-foreground/60 mt-0.5">
                          {formatDistanceToNow(new Date(e.ts), { addSuffix: true })}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Link href="/videos">
          <Card className="cursor-pointer hover:border-primary/40 transition-colors h-full">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1 text-primary"><Video size={16} /></div>
              <p className="font-medium text-sm">Manage Videos</p>
              <p className="text-xs text-muted-foreground">Upload & edit</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/broadcast-v2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Card className={`cursor-pointer transition-colors h-full ${isEngineStuck ? "border-amber-500/60 bg-amber-500/5 hover:border-amber-500/80" : "hover:border-primary/40"}`}>
                <CardContent className="pt-4 pb-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Radio size={16} className={isEngineStuck ? "text-amber-500" : "text-primary"} />
                    {isEngineStuck && (
                      <AlertTriangle size={13} className="text-amber-500 animate-pulse ml-auto" />
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <p className="font-medium text-sm">Master Control</p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {isEngineStuck ? "Engine check required" : "Broadcast queue"}
                  </p>
                </CardContent>
              </Card>
            </TooltipTrigger>
            {isEngineStuck && (
              <TooltipContent side="top" className="max-w-[220px] text-center">
                <p className="font-medium text-amber-500 flex items-center gap-1 justify-center">
                  <AlertTriangle size={12} /> Engine stuck at sequence 0
                </p>
                <p className="text-xs mt-1 text-muted-foreground">
                  The broadcast orchestrator has been running for {Math.round((engineHealth?.uptimeMs ?? 0) / 1000)}s without advancing. Open Master Control to investigate.
                </p>
              </TooltipContent>
            )}
          </Tooltip>
        </Link>

        <Link href="/notifications">
          <Card className="cursor-pointer hover:border-primary/40 transition-colors h-full">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1 text-primary"><Bell size={16} /></div>
              <p className="font-medium text-sm">Notifications</p>
              <p className="text-xs text-muted-foreground">Push & email</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/analytics">
          <Card className="cursor-pointer hover:border-primary/40 transition-colors h-full">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1 text-primary"><Activity size={16} /></div>
              <p className="font-medium text-sm">Analytics</p>
              <p className="text-xs text-muted-foreground">View insights</p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
