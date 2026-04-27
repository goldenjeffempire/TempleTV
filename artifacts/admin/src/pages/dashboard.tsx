import {
  getGetAdminStatsQueryKey,
  getGetLiveStatusQueryKey,
  useGetAdminStats,
  useGetLiveStatus,
  useListAdminVideos,
  useListSchedule,
  useStartLiveOverride,
  useStopLiveOverride,
} from "@workspace/api-client-react";

type ScheduleEntryRow = {
  id: string;
  title: string;
  dayOfWeek: number;
  startTime: string;
  endTime?: string;
  contentType: string;
  isRecurring: boolean;
};
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  AlertCircle,
  Video,
  ListVideo,
  Calendar,
  BellRing,
  Activity,
  Radio,
  Plus,
  Loader2,
  Square,
  Users,
  Signal,
  ShieldCheck,
  Cpu,
  Tv2,
  BarChart2,
  ArrowRight,
  Clock,
  CheckCircle2,
  XCircle,
  CalendarClock,
  Youtube,
  Zap,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "wouter";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSSE, useSSEEvent } from "@/contexts/SSEContext";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { cn } from "@/lib/utils";
import { adminGet, transcodingApi, type TranscodingQueue } from "@/services/adminApi";
import { RenderDeployHealthPanel } from "@/components/RenderDeployHealthPanel";

const QUICK_LINKS = [
  { href: "/live-control", label: "Live Control", icon: Signal, desc: "Start or stop a broadcast" },
  { href: "/broadcast", label: "Broadcast Queue", icon: Tv2, desc: "Manage the video queue" },
  { href: "/videos", label: "Video Library", icon: Video, desc: "Import and manage videos" },
  { href: "/analytics", label: "Analytics", icon: BarChart2, desc: "Viewership & device data" },
  { href: "/transcoding", label: "Transcoding", icon: Cpu, desc: "Monitor encoding jobs" },
  { href: "/operations", label: "Operations", icon: ShieldCheck, desc: "Platform health & status" },
];

type ScheduledNotif = {
  id: string;
  title: string;
  body: string;
  type: string;
  scheduledAt: string;
  status: string;
  videoId: string | null;
};

// Slim view of /api/broadcast/current — only the fields the Mission Control
// hero needs to show "what's airing right now" when YouTube is off-air.
type BroadcastQueueItem = {
  id: string;
  title: string;
  thumbnailUrl?: string | null;
  durationSecs: number;
};
type BroadcastCurrent = {
  item: BroadcastQueueItem | null;
  nextItem: BroadcastQueueItem | null;
  positionSecs: number;
  totalSecs: number;
  progressPercent: number;
  queueLength: number;
  syncedAt: string;
  serverTimeMs: number;
  itemStartEpochSecs?: number;
  currentItemEndsAtMs?: number;
};

function formatHMS(totalSecs: number): string {
  if (!Number.isFinite(totalSecs) || totalSecs < 0) totalSecs = 0;
  const s = Math.floor(totalSecs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtTime(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function fmtRelativeFuture(iso: string, nowMs: number): string {
  const ms = new Date(iso).getTime() - nowMs;
  if (ms <= 0) return "now";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  return `in ${Math.round(hr / 24)}d`;
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { state: sseState, lastStatusPayload } = useSSE();

  const { data: stats, isLoading: isLoadingStats, isError: isErrorStats, refetch: refetchStats } = useGetAdminStats();
  const { data: liveStatus } = useGetLiveStatus();
  const { data: videosData, isLoading: isLoadingVideos, isError: isErrorVideos } = useListAdminVideos({ limit: 4 });
  const { data: schedule, isLoading: isLoadingSchedule } = useListSchedule();

  const [transcoding, setTranscoding] = useState<TranscodingQueue | null>(null);
  const [transcodingLoading, setTranscodingLoading] = useState(true);
  const [transcodingError, setTranscodingError] = useState<string | null>(null);
  const [pendingNotifs, setPendingNotifs] = useState<ScheduledNotif[] | null>(null);
  const [pendingNotifsLoading, setPendingNotifsLoading] = useState(true);
  const [pendingNotifsError, setPendingNotifsError] = useState<string | null>(null);
  const [broadcast, setBroadcast] = useState<BroadcastCurrent | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Tick every 5s — fast enough to advance the on-deck progress bar smoothly
  // when YouTube is off-air and we're showing the broadcast queue's currently
  // airing item; still slow enough to keep the dashboard cheap to render.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const refetchBroadcast = useCallback(async () => {
    try {
      // Public endpoint — no admin token required.
      const r = await fetch("/api/broadcast/current", {
        headers: { Accept: "application/json" },
      });
      if (!r.ok) return;
      const json = (await r.json()) as BroadcastCurrent;
      setBroadcast(json);
    } catch {
      // Network blip — keep the previous payload, the next tick will retry.
    }
  }, []);

  const refetchTranscoding = useCallback(async () => {
    try {
      const data = await transcodingApi.getQueue();
      setTranscoding(data);
      setTranscodingError(null);
    } catch (err) {
      setTranscodingError((err as Error)?.message ?? "Failed to load encoding queue");
    } finally {
      setTranscodingLoading(false);
    }
  }, []);

  const refetchPendingNotifs = useCallback(async () => {
    try {
      const data = await adminGet<ScheduledNotif[]>("/admin/notifications/scheduled");
      setPendingNotifs(data);
      setPendingNotifsError(null);
    } catch (err) {
      setPendingNotifsError((err as Error)?.message ?? "Failed to load scheduled notifications");
    } finally {
      setPendingNotifsLoading(false);
    }
  }, []);

  useEffect(() => {
    refetchTranscoding();
    refetchPendingNotifs();
    refetchBroadcast();
    const id = setInterval(() => {
      refetchTranscoding();
      refetchPendingNotifs();
      refetchBroadcast();
    }, 30_000);
    return () => clearInterval(id);
  }, [refetchTranscoding, refetchPendingNotifs, refetchBroadcast]);

  const [goLiveOpen, setGoLiveOpen] = useState(false);
  const [goLiveForm, setGoLiveForm] = useState({ title: "Temple TV Live Service", durationMinutes: 120 });

  const startLiveOverride = useStartLiveOverride({
    mutation: {
      onSuccess: (result: { push: { sent: number; failed: number } }) => {
        toast({ title: "Live override started", description: `Push sent to ${result.push.sent} devices.` });
        queryClient.invalidateQueries({ queryKey: getGetLiveStatusQueryKey() });
        setGoLiveOpen(false);
      },
      onError: () => toast({ title: "Failed to start live override", variant: "destructive" }),
    },
  });

  const stopLiveOverride = useStopLiveOverride({
    mutation: {
      onSuccess: () => {
        toast({ title: "Live override stopped" });
        queryClient.invalidateQueries({ queryKey: getGetLiveStatusQueryKey() });
      },
      onError: () => toast({ title: "Failed to stop live override", variant: "destructive" }),
    },
  });

  useSSEEvent("status", () => {
    queryClient.invalidateQueries({ queryKey: getGetLiveStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetAdminStatsQueryKey() });
  });

  useSSEEvent("broadcast-control-updated", () => {
    queryClient.invalidateQueries({ queryKey: getGetLiveStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetAdminStatsQueryKey() });
    refetchBroadcast();
  });

  // The api-server emits "transition" on the broadcast SSE channel whenever
  // the current queue item changes (item ends + next one starts). Refetch
  // immediately so the hero never lags behind the actual on-air program.
  useSSEEvent("transition", () => {
    refetchBroadcast();
  });

  useSSEEvent("override-expired", () => {
    queryClient.invalidateQueries({ queryKey: getGetLiveStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetAdminStatsQueryKey() });
  });

  const manualOverrideActive = Boolean(liveStatus?.liveOverride);
  // Prefer SSE-pushed real-time payload, fall back to the (now-fresh) stats
  // endpoint, finally to the standalone live-status REST call. Each layer
  // is independently up to date so the hero never gets stuck on "Off Air"
  // when YouTube has organically gone live.
  const isLiveNow =
    lastStatusPayload?.isLive ?? stats?.isLiveNow ?? Boolean(liveStatus?.isLive) ?? false;
  const overrideTitle = lastStatusPayload?.liveOverride?.title ?? liveStatus?.liveOverride?.title;
  const ytLive = lastStatusPayload?.ytLive ?? stats?.ytLive ?? Boolean(liveStatus?.ytLive) ?? false;
  const liveTitle =
    lastStatusPayload?.liveOverride?.title ??
    lastStatusPayload?.ytTitle ??
    overrideTitle ??
    stats?.liveTitle ??
    "Live broadcast";
  // Real concurrent viewers (SSE-connected mobile/TV/admin clients).
  // YouTube's own scraped viewer count is shown separately below.
  const concurrentViewers =
    (lastStatusPayload as unknown as { concurrentViewers?: number } | null)?.concurrentViewers ??
    stats?.concurrentViewers ??
    0;
  const ytViewerCount =
    (lastStatusPayload as unknown as { ytViewerCount?: number | null } | null)?.ytViewerCount ??
    stats?.ytViewerCount ??
    null;
  // Headline number for the hero — prefer YouTube's reported viewers when
  // we're live on YouTube, otherwise show our own concurrent SSE count.
  const viewerCount = ytViewerCount ?? concurrentViewers;

  // ── On-deck queue program (shown in the hero when YouTube is off-air) ──
  // The api-server returns `positionSecs` snapped to `syncedAt`; we extrapolate
  // from `itemStartEpochSecs` + the local clock so the progress bar advances
  // every render even between refetches.
  const onDeckItem = !isLiveNow ? (broadcast?.item ?? null) : null;
  const onDeckDurationSecs = onDeckItem?.durationSecs ?? 0;
  const onDeckPositionSecs = useMemo(() => {
    if (!onDeckItem || !broadcast) return 0;
    const startSec = broadcast.itemStartEpochSecs;
    const live =
      typeof startSec === "number"
        ? Math.floor(nowMs / 1000) - startSec
        : broadcast.positionSecs;
    if (!Number.isFinite(live)) return 0;
    return Math.max(0, Math.min(onDeckDurationSecs || live, live));
  }, [onDeckItem, broadcast, nowMs, onDeckDurationSecs]);
  const onDeckProgress =
    onDeckDurationSecs > 0
      ? Math.min(100, Math.max(0, (onDeckPositionSecs / onDeckDurationSecs) * 100))
      : 0;

  const handleGoLive = (e: React.FormEvent) => {
    e.preventDefault();
    startLiveOverride.mutate({
      data: {
        title: goLiveForm.title.trim() || "Temple TV Live Service",
        durationMinutes: Math.max(1, goLiveForm.durationMinutes),
        notify: true,
      },
    });
  };

  // Compute today's schedule + currently airing slot in UTC
  const nowUtc = useMemo(() => new Date(nowMs), [nowMs]);
  const currentDayUtc = nowUtc.getUTCDay();
  const currentMinUtc = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes();

  const todaySchedule = useMemo<ScheduleEntryRow[]>(() => {
    if (!schedule) return [];
    return [...schedule]
      .filter((s) => s.dayOfWeek === currentDayUtc && s.isRecurring)
      .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  }, [schedule, currentDayUtc]);

  const onAirSlot = useMemo(() => {
    return todaySchedule.find((s) => {
      const start = timeToMinutes(s.startTime);
      const end = s.endTime ? timeToMinutes(s.endTime) : start + 60;
      return currentMinUtc >= start && currentMinUtc < end;
    });
  }, [todaySchedule, currentMinUtc]);

  const upcomingNotifs = useMemo(() => {
    if (!pendingNotifs) return [];
    return pendingNotifs
      .filter((n) => n.status === "pending" && new Date(n.scheduledAt).getTime() > nowMs - 60_000)
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime())
      .slice(0, 4);
  }, [pendingNotifs, nowMs]);

  const tStats = transcoding?.stats;
  const transcodingTotal = (tStats?.activeCount ?? 0) + (tStats?.queuedCount ?? 0) + (tStats?.failedToday ?? 0);
  const transcodingHasFailures = (tStats?.failedToday ?? 0) > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mission Control"
        description="Live overview of broadcast operations, encoding pipeline, and outbound notifications."
        badge={
          sseState === "connected" ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-600 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full font-medium">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Real-time
            </span>
          ) : undefined
        }
        actions={
          <div className="flex items-center gap-2">
            {!isLiveNow && !manualOverrideActive ? (
              <Button onClick={() => setGoLiveOpen(true)} size="sm" className="gap-2">
                <Radio className="w-4 h-4" /> Go Live
              </Button>
            ) : manualOverrideActive ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (window.confirm("Stop the live override? Viewers will return to the automated queue immediately.")) {
                    stopLiveOverride.mutate();
                  }
                }}
                disabled={stopLiveOverride.isPending}
                className="gap-2"
              >
                {stopLiveOverride.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
                Stop Override
              </Button>
            ) : null}
            <Link
              href="/notifications"
              className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium border border-input bg-background hover:bg-accent h-9 px-3 gap-2"
            >
              <BellRing className="w-4 h-4" /> Notification
            </Link>
            <Link
              href="/videos"
              className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4"
            >
              <Plus className="w-4 h-4 mr-2" />
              Import Video
            </Link>
          </div>
        }
      />

      {isErrorStats && (
        <ErrorAlert
          title="Couldn't load dashboard stats"
          message="The admin stats endpoint returned an error. Numbers may be stale."
          onRetry={() => refetchStats()}
        />
      )}

      {/* Render deploy health — API + worker liveness + recent fatals,
          so crashloops surface here instead of requiring the operator to
          open the Render dashboard. Pinned at the top of Mission Control
          deliberately: header turns amber/red when something's wrong. */}
      <RenderDeployHealthPanel />

      {/* Top row: ON AIR hero + Today's strip */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* ON AIR hero */}
        <Card
          className={cn(
            "lg:col-span-1 relative overflow-hidden",
            isLiveNow ? "border-red-500/50 bg-red-500/5" : "",
          )}
        >
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm uppercase tracking-wider">
              <Radio className={cn("w-4 h-4", isLiveNow && "text-red-500 animate-pulse")} />
              {isLiveNow ? "On Air" : "Off Air"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLiveNow ? (
              <>
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Now broadcasting</div>
                  <div className="font-bold text-lg leading-snug line-clamp-2">{liveTitle}</div>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-red-500">
                    <Users className="w-4 h-4" />
                    {viewerCount.toLocaleString()}
                    <span className="text-xs text-muted-foreground font-normal ml-1">
                      {ytViewerCount != null ? "YouTube viewers" : "concurrent viewers"}
                    </span>
                  </div>
                  {ytViewerCount != null && concurrentViewers > 0 && (
                    <div
                      className="flex items-center gap-1.5 text-xs text-muted-foreground"
                      title="Real concurrent SSE-connected clients across mobile, TV, and admin surfaces."
                    >
                      <Activity className="w-3 h-3" />
                      {concurrentViewers.toLocaleString()} on Temple TV
                    </div>
                  )}
                  <span className="text-xs px-2 py-0.5 rounded-full border bg-background flex items-center gap-1">
                    {manualOverrideActive ? (
                      <>
                        <Zap className="w-3 h-3 text-amber-500" />
                        Override
                      </>
                    ) : (
                      <>
                        <Youtube className="w-3 h-3 text-red-500" />
                        YouTube
                      </>
                    )}
                  </span>
                </div>
                <Link
                  href="/live-control"
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                >
                  Open live control <ArrowRight className="w-3 h-3" />
                </Link>
              </>
            ) : onDeckItem ? (
              <>
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                    <Tv2 className="w-3 h-3" />
                    On-air from queue
                  </div>
                  <div className="font-bold text-base leading-snug line-clamp-2">{onDeckItem.title}</div>
                </div>
                <div className="space-y-1.5">
                  <div
                    className="h-1.5 bg-muted rounded-full overflow-hidden"
                    role="progressbar"
                    aria-valuenow={Math.round(onDeckProgress)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="On-air progress"
                  >
                    <div
                      className="h-full bg-primary transition-[width] duration-500 ease-linear"
                      style={{ width: `${onDeckProgress}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
                    <span>
                      {formatHMS(onDeckPositionSecs)} / {formatHMS(onDeckDurationSecs)}
                    </span>
                    <span>{Math.round(onDeckProgress)}%</span>
                  </div>
                </div>
                {broadcast?.nextItem && (
                  <div className="text-xs text-muted-foreground line-clamp-1">
                    Up next:{" "}
                    <span className="text-foreground/80 font-medium">{broadcast.nextItem.title}</span>
                  </div>
                )}
                {ytLive && (
                  <p className="text-[11px] text-amber-500/90">
                    YouTube is live but the bridge has not detected it yet.
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Link
                    href="/broadcast"
                    className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                  >
                    Open queue <ArrowRight className="w-3 h-3" />
                  </Link>
                  <span className="text-muted-foreground/40">·</span>
                  <Link
                    href="/live-control"
                    className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                  >
                    Live control <ArrowRight className="w-3 h-3" />
                  </Link>
                </div>
              </>
            ) : (
              <>
                <div className="font-semibold text-sm">No active broadcast</div>
                <p className="text-xs text-muted-foreground">
                  {ytLive
                    ? "YouTube is live but the bridge has not detected it yet."
                    : broadcast && broadcast.queueLength === 0
                      ? "The broadcast queue is empty. Standing by for the next scheduled service."
                      : "Standing by for the next scheduled service."}
                </p>
                <div className="flex items-center gap-2">
                  <Link
                    href="/live-control"
                    className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                  >
                    Live control <ArrowRight className="w-3 h-3" />
                  </Link>
                  <span className="text-muted-foreground/40">·</span>
                  <Link
                    href="/schedule"
                    className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                  >
                    View schedule <ArrowRight className="w-3 h-3" />
                  </Link>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Today's schedule strip */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarClock className="w-4 h-4" />
                Today · {DAY_LABELS[currentDayUtc]}{" "}
                <span className="text-xs font-normal text-muted-foreground ml-1">UTC</span>
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Recurring slots scheduled for {DAY_LABELS[currentDayUtc]} (server-side schedule grid is in UTC).
              </CardDescription>
            </div>
            <Link href="/schedule" className="text-xs text-primary hover:underline flex items-center gap-1">
              Full grid <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent>
            {isLoadingSchedule ? (
              <div className="flex gap-2 overflow-hidden">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16 w-40 rounded-lg shrink-0" />
                ))}
              </div>
            ) : todaySchedule.length === 0 ? (
              <div className="text-center py-6 text-xs text-muted-foreground border border-dashed rounded-lg">
                No recurring slots scheduled for {DAY_LABELS[currentDayUtc]}.
              </div>
            ) : (
              <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
                {todaySchedule.map((slot) => {
                  const isOnAir = slot.id === onAirSlot?.id;
                  const isPast =
                    !isOnAir &&
                    timeToMinutes(slot.endTime ?? slot.startTime) <= currentMinUtc;
                  return (
                    <Link
                      key={slot.id}
                      href="/schedule"
                      className={cn(
                        "shrink-0 w-44 border rounded-lg p-3 transition-colors group",
                        isOnAir
                          ? "border-red-500/60 bg-red-500/10 ring-2 ring-red-500/30"
                          : isPast
                          ? "border-border bg-muted/30 opacity-60 hover:opacity-100"
                          : "border-border bg-card hover:border-primary/40 hover:bg-accent",
                      )}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span
                          className={cn(
                            "text-[10px] uppercase tracking-wider font-semibold",
                            isOnAir ? "text-red-600" : "text-muted-foreground",
                          )}
                        >
                          {fmtTime(slot.startTime)}
                          {slot.endTime ? ` – ${fmtTime(slot.endTime)}` : ""}
                        </span>
                        {isOnAir && (
                          <span className="inline-flex items-center gap-1 text-[9px] font-bold text-red-600 bg-red-500/15 px-1.5 py-0.5 rounded-full border border-red-500/30 animate-pulse">
                            <Radio className="w-2.5 h-2.5" /> NOW
                          </span>
                        )}
                      </div>
                      <div className="text-sm font-semibold truncate group-hover:text-primary transition-colors">
                        {slot.title}
                      </div>
                      <div className="text-[10px] text-muted-foreground capitalize mt-0.5">
                        {slot.contentType}
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Stats row */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          {
            title: "Total Videos",
            icon: Video,
            value: (stats?.totalVideos ?? 0).toLocaleString(),
            sub: `+${stats?.recentImports ?? 0} recent imports`,
          },
          {
            title: "Active Playlists",
            icon: ListVideo,
            value: stats?.totalPlaylists ?? 0,
            sub: "Curated collections",
          },
          {
            title: "Schedule Entries",
            icon: Calendar,
            value: stats?.activeScheduleEntries ?? 0,
            sub: "Active weekly slots",
          },
          {
            title: "Notifications Today",
            icon: BellRing,
            value: stats?.notificationsSentToday ?? 0,
            sub: `${stats?.registeredDevices ?? 0} registered devices`,
          },
          {
            title: "Registered Members",
            icon: Users,
            value: stats?.registeredUsers ?? 0,
            sub: "View all members →",
            subHref: "/users",
            highlight: true,
          },
        ].map((card) => (
          <Card key={card.title} className={card.highlight ? "border-primary/20 bg-primary/5" : ""}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
              <card.icon className={cn("h-4 w-4", card.highlight ? "text-primary" : "text-muted-foreground")} />
            </CardHeader>
            <CardContent>
              {isLoadingStats ? (
                <Skeleton className="h-7 w-20" />
              ) : (
                <>
                  <div className={cn("text-2xl font-bold", card.highlight ? "text-primary" : "")}>
                    {card.value}
                  </div>
                  {card.subHref ? (
                    <Link href={card.subHref} className="text-xs text-muted-foreground mt-1 underline underline-offset-2 hover:text-foreground transition-colors block">
                      {card.sub}
                    </Link>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-1">{card.sub}</p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Pipeline row: transcoding + upcoming notifications + recent videos */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Transcoding pipeline */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Cpu className="w-4 h-4" />
                Encoding Pipeline
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">HLS transcoding status across the queue.</CardDescription>
            </div>
            <Link href="/transcoding" className="text-xs text-primary hover:underline flex items-center gap-1">
              Open <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent>
            {transcodingLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : transcodingError ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                <div className="flex items-center gap-2 font-semibold text-amber-700 dark:text-amber-400">
                  <AlertCircle className="w-3.5 h-3.5" />
                  Encoding queue unavailable
                </div>
                <p className="text-muted-foreground mt-1">{transcodingError}</p>
                <button
                  onClick={refetchTranscoding}
                  className="mt-2 text-amber-700 dark:text-amber-400 hover:underline font-medium"
                >
                  Retry now
                </button>
              </div>
            ) : transcodingTotal === 0 ? (
              <div className="text-center py-6 text-xs text-muted-foreground border border-dashed rounded-lg">
                Queue is empty — nothing to encode.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-md border bg-blue-500/5 border-blue-500/20 p-2 text-center">
                    <div className="text-[10px] uppercase tracking-wider text-blue-700 dark:text-blue-400 flex items-center justify-center gap-1">
                      <Activity className="w-3 h-3" /> Active
                    </div>
                    <div className="text-xl font-bold text-blue-600">{tStats?.activeCount ?? 0}</div>
                  </div>
                  <div className="rounded-md border bg-amber-500/5 border-amber-500/20 p-2 text-center">
                    <div className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400 flex items-center justify-center gap-1">
                      <Clock className="w-3 h-3" /> Queued
                    </div>
                    <div className="text-xl font-bold text-amber-600">{tStats?.queuedCount ?? 0}</div>
                  </div>
                  <div
                    className={cn(
                      "rounded-md border p-2 text-center",
                      transcodingHasFailures
                        ? "bg-red-500/5 border-red-500/30"
                        : "bg-emerald-500/5 border-emerald-500/20",
                    )}
                  >
                    <div
                      className={cn(
                        "text-[10px] uppercase tracking-wider flex items-center justify-center gap-1",
                        transcodingHasFailures
                          ? "text-red-700 dark:text-red-400"
                          : "text-emerald-700 dark:text-emerald-400",
                      )}
                    >
                      {transcodingHasFailures ? (
                        <>
                          <XCircle className="w-3 h-3" /> Failed
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="w-3 h-3" /> OK
                        </>
                      )}
                    </div>
                    <div
                      className={cn(
                        "text-xl font-bold",
                        transcodingHasFailures ? "text-red-600" : "text-emerald-600",
                      )}
                    >
                      {tStats?.failedToday ?? 0}
                    </div>
                  </div>
                </div>

                {(transcoding?.jobs ?? [])
                  .filter((j) => j.status === "processing" || j.status === "queued" || j.status === "failed")
                  .slice(0, 3)
                  .map((j) => (
                    <div key={j.id} className="flex items-center gap-2 text-xs">
                      {j.status === "processing" && <Loader2 className="w-3 h-3 animate-spin text-blue-500 shrink-0" />}
                      {j.status === "queued" && <Clock className="w-3 h-3 text-amber-500 shrink-0" />}
                      {j.status === "failed" && <XCircle className="w-3 h-3 text-red-500 shrink-0" />}
                      <span className="truncate flex-1" title={j.videoTitle}>
                        {j.videoTitle ?? j.videoId.slice(0, 8)}
                      </span>
                      {j.status === "processing" && (
                        <span className="font-mono text-muted-foreground tabular-nums">{j.progress}%</span>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Upcoming notifications */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <BellRing className="w-4 h-4" />
                Upcoming Notifications
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">Scheduled push notifications waiting to fire.</CardDescription>
            </div>
            <Link href="/notifications" className="text-xs text-primary hover:underline flex items-center gap-1">
              All <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent>
            {pendingNotifsLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : pendingNotifsError ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                <div className="flex items-center gap-2 font-semibold text-amber-700 dark:text-amber-400">
                  <AlertCircle className="w-3.5 h-3.5" />
                  Notification queue unavailable
                </div>
                <p className="text-muted-foreground mt-1">{pendingNotifsError}</p>
                <button
                  onClick={refetchPendingNotifs}
                  className="mt-2 text-amber-700 dark:text-amber-400 hover:underline font-medium"
                >
                  Retry now
                </button>
              </div>
            ) : upcomingNotifs.length === 0 ? (
              <div className="text-center py-6 text-xs text-muted-foreground border border-dashed rounded-lg">
                No notifications scheduled.
              </div>
            ) : (
              <div className="space-y-2">
                {upcomingNotifs.map((n) => (
                  <div
                    key={n.id}
                    className="flex items-start gap-2 p-2 rounded-md border bg-muted/20 hover:bg-muted/40 transition-colors"
                  >
                    <div className="w-7 h-7 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0 mt-0.5">
                      <BellRing className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{n.title}</div>
                      <div className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                        <Clock className="w-2.5 h-2.5" />
                        {fmtRelativeFuture(n.scheduledAt, nowMs)} ·{" "}
                        {new Date(n.scheduledAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Videos */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Video className="w-4 h-4" />
                Recent Videos
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">Latest content imported into the library.</CardDescription>
            </div>
            <Link href="/videos" className="text-xs text-primary hover:underline flex items-center gap-1">
              All <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent>
            {isLoadingVideos ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="w-20 h-12 rounded" />
                    <div className="space-y-2 flex-1">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : isErrorVideos ? (
              <div className="text-center py-6 text-xs border border-destructive/30 bg-destructive/5 text-destructive rounded-lg">
                Couldn't load recent videos.
              </div>
            ) : videosData?.videos && videosData.videos.length > 0 ? (
              <div className="space-y-2.5">
                {videosData.videos.slice(0, 3).map((video: { id: string; thumbnailUrl: string; title: string; duration?: string | null; preacher?: string | null; category?: string | null }) => (
                  <div key={video.id} className="flex items-center gap-2.5 group">
                    <div className="relative w-20 h-12 rounded overflow-hidden bg-muted shrink-0 border">
                      <img
                        src={video.thumbnailUrl}
                        alt={video.title}
                        className="w-full h-full object-cover transition-transform group-hover:scale-105"
                      />
                      {video.duration && (
                        <div className="absolute bottom-0.5 right-0.5 bg-black/80 text-white text-[9px] px-1 py-0.5 rounded font-mono">
                          {video.duration}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                        {video.title}
                      </h4>
                      <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
                        <span className="truncate">{video.preacher || "Unknown Speaker"}</span>
                        <span>·</span>
                        <span>{video.category}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-6 text-xs text-muted-foreground border border-dashed rounded-lg">
                No videos imported yet.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick Links */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Quick Access</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {QUICK_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-lg border bg-card p-4 flex flex-col gap-2.5 hover:border-primary/40 hover:bg-accent transition-colors group"
            >
              <link.icon className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
              <div>
                <div className="text-sm font-semibold leading-tight">{link.label}</div>
                <div className="text-xs text-muted-foreground mt-0.5 leading-snug">{link.desc}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Go Live Dialog */}
      <Dialog open={goLiveOpen} onOpenChange={setGoLiveOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Start Live Override</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleGoLive} className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label>Broadcast Title</Label>
              <Input
                value={goLiveForm.title}
                onChange={(e) => setGoLiveForm({ ...goLiveForm, title: e.target.value })}
                placeholder="e.g. Sunday Morning Service"
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Duration (minutes)</Label>
              <Input
                type="number"
                min={1}
                max={720}
                value={goLiveForm.durationMinutes}
                onChange={(e) =>
                  setGoLiveForm({ ...goLiveForm, durationMinutes: parseInt(e.target.value) || 120 })
                }
                required
              />
              <p className="text-xs text-muted-foreground">The override will automatically expire after this duration.</p>
            </div>
            <div className="p-3 bg-amber-500/10 text-amber-700 dark:text-amber-400 rounded-md text-xs border border-amber-500/20">
              This forces all connected apps into live mode and sends a push notification to all subscribers.
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => setGoLiveOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" className="flex-1" disabled={startLiveOverride.isPending}>
                {startLiveOverride.isPending
                  ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  : <Radio className="w-4 h-4 mr-2" />}
                Go Live
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
