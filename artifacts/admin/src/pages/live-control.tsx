import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Radio,
  Smartphone,
  Globe,
  Tv,
  Mic,
  Users,
  Clock,
  Square,
  Zap,
  Info,
  CheckCircle2,
  Youtube,
  AlertTriangle,
  Loader2,
  Eye,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useSSE, useSSEEvent } from "@/contexts/SSEContext";
import { liveApi, type LiveOverride, type LiveFailureStats, type YouTubePreviewResult, type RecentYoutubeStream, type ScheduledOverride } from "@/services/adminApi";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { History, CalendarClock, X } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { cn } from "@/lib/utils";

function elapsedStr(startedAt: string | null | undefined): string {
  if (!startedAt) return "";
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  const h = Math.floor(secs / 3600),
    m = Math.floor((secs % 3600) / 60),
    s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s on air`;
  if (m > 0) return `${m}m ${s}s on air`;
  return `${s}s on air`;
}

const INITIAL_FORM = {
  title: "Temple TV Live Service",
  youtubeUrl: "",
  hlsStreamUrl: "",
  rtmpIngestKey: "",
  streamNotes: "",
  durationMins: "120",
  notify: true,
};

const PLATFORMS = [
  { icon: Smartphone, label: "Mobile", desc: "iOS & Android — HLS adaptive player" },
  { icon: Globe, label: "Web Browser", desc: "HLS.js or YouTube embed" },
  { icon: Tv, label: "Smart TV", desc: "TV web app — YouTube iframe" },
  { icon: Mic, label: "Radio Mode", desc: "Audio-only from the same stream" },
];

/**
 * Compact "N viewers reported failure" indicator shown next to the LIVE ON
 * AIR badge. Only renders when at least one device has reported a failure
 * within the backend's rolling window. The tooltip exposes the per-surface
 * breakdown so admins can tell whether the issue is platform-wide (TV +
 * mobile both failing on the same videoId is a strong signal that YouTube
 * itself is down) vs isolated to one surface.
 */
function FailureIndicator({ stats }: { stats: LiveFailureStats }) {
  const surfaceLabels: Record<string, string> = {
    "tv-hero": "TV (home)",
    "tv-player": "TV (player)",
    "mobile-hero": "Mobile (home)",
    "mobile-player": "Mobile (player)",
    unknown: "Other",
  };
  const surfaceEntries = Object.entries(stats.surfaces).filter(
    ([, v]) => typeof v === "number" && v > 0,
  ) as Array<[string, number]>;
  const windowMin = Math.round(stats.windowMs / 60_000);
  const tone = stats.deviceCount >= 3
    ? "border-red-400/60 bg-red-500/10 text-red-700 dark:text-red-300"
    : "border-amber-400/50 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            data-testid="live-failure-indicator"
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium cursor-help",
              tone,
            )}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>
              {stats.deviceCount} {stats.deviceCount === 1 ? "viewer" : "viewers"} reported failure
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <div className="text-xs space-y-1">
            <div className="font-semibold">
              YouTube embed failures (last {windowMin} min)
            </div>
            <div className="text-muted-foreground">
              {stats.totalReports} report{stats.totalReports === 1 ? "" : "s"} from{" "}
              {stats.deviceCount} device{stats.deviceCount === 1 ? "" : "s"}
              {stats.ipCount > 0 && <> across {stats.ipCount} network{stats.ipCount === 1 ? "" : "s"}</>}.
            </div>
            {surfaceEntries.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {surfaceEntries.map(([surface, count]) => (
                  <li key={surface} className="flex justify-between gap-3">
                    <span>{surfaceLabels[surface] ?? surface}</span>
                    <span className="font-mono">{count}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-1.5 text-muted-foreground italic">
              {stats.deviceCount >= 3
                ? "Multiple devices failing — likely a platform-wide YouTube issue."
                : "May be isolated. Watch for the count to grow."}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default function LiveControl() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { state: sseState } = useSSE();

  const { data: liveStatus, isLoading } = useQuery({
    queryKey: ["admin-live-status"],
    queryFn: ({ signal }) => liveApi.getStatus(signal),
    refetchInterval: 15_000,
  });

  const activeOverride: LiveOverride | null = liveStatus?.liveOverride ?? null;

  const [form, setForm] = useState(INITIAL_FORM);
  const [ticker, setTicker] = useState("");
  const tickRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // YouTube preview state — separated from the form so we can show stale
  // results while the admin is editing, and clear them only when they
  // explicitly re-preview or change the URL.
  const [previewResult, setPreviewResult] = useState<YouTubePreviewResult | null>(null);
  const [previewedUrl, setPreviewedUrl] = useState<string>("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-live-status"] });

  // Refetch immediately when the backend reports a change in viewer-side
  // failure telemetry — keeps the "N viewers reported failure" indicator
  // live without waiting for the 15s polling tick.
  useSSEEvent("live-failure-stats", () => {
    queryClient.invalidateQueries({ queryKey: ["admin-live-status"] });
  });

  // Recent YouTube streams for the "re-broadcast" dropdown. Loaded once
  // when the page mounts and refreshed when an override is started/stopped
  // (those mutations invalidate `admin-live-status`, but recent history
  // changes only when a new override actually fires — so we additionally
  // refetch on Go Live success below).
  const { data: recentYoutube } = useQuery({
    queryKey: ["admin-recent-youtube-streams"],
    queryFn: () => liveApi.getRecentYoutubeStreams(),
    staleTime: 30_000,
  });
  const recentItems: RecentYoutubeStream[] = recentYoutube?.items ?? [];
  const [recentOpen, setRecentOpen] = useState(false);

  // Upcoming scheduled overrides — refreshed every 30s so the countdown
  // stays roughly accurate, and after every schedule/cancel mutation.
  const { data: scheduled } = useQuery({
    queryKey: ["admin-scheduled-overrides"],
    queryFn: () => liveApi.getScheduled(),
    refetchInterval: 30_000,
  });
  const scheduledItems: ScheduledOverride[] = scheduled?.items ?? [];

  // Local form state for the "Schedule for later" datetime picker.
  // Hidden until the admin explicitly clicks the schedule button so
  // the default Go Live flow stays single-click for spontaneous live
  // events.
  const [scheduleMode, setScheduleMode] = useState(false);
  const [scheduledFor, setScheduledFor] = useState("");

  const refreshScheduled = () =>
    queryClient.invalidateQueries({ queryKey: ["admin-scheduled-overrides"] });

  const scheduleMutation = useMutation({
    mutationFn: (input: Parameters<typeof liveApi.schedule>[0]) =>
      liveApi.schedule(input),
    onSuccess: (res) => {
      toast({
        title: "Scheduled",
        description: res.youtubeProbeWarning
          ? `Will go live at ${new Date(res.override.scheduledFor).toLocaleString()}. Note: ${res.youtubeProbeWarning}`
          : `Will go live at ${new Date(res.override.scheduledFor).toLocaleString()}.`,
      });
      setScheduleMode(false);
      setScheduledFor("");
      refreshScheduled();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to schedule", description: err.message, variant: "destructive" });
    },
  });

  const cancelScheduleMutation = useMutation({
    mutationFn: (id: string) => liveApi.cancelScheduled(id),
    onSuccess: () => {
      toast({ title: "Scheduled broadcast cancelled" });
      refreshScheduled();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to cancel", description: err.message, variant: "destructive" });
    },
  });

  const previewYoutube = useMutation({
    mutationFn: (url: string) => liveApi.previewYoutube(url),
    onSuccess: (res, url) => {
      setPreviewResult(res);
      setPreviewedUrl(url);
      if (!res.ok || !res.exists) {
        toast({
          title: "YouTube URL not valid",
          description: res.error ?? res.reason ?? "Could not verify the video.",
          variant: "destructive",
        });
      } else if (!res.isLive) {
        toast({
          title: "Video found, but not live",
          description: res.reason ?? "It will still air, but flagged as offline.",
        });
      } else {
        toast({
          title: "Stream is live",
          description: res.title ?? "Ready to broadcast.",
        });
      }
    },
    onError: (err: Error) => {
      setPreviewResult({ ok: false, error: err.message });
      toast({ title: "Preview failed", description: err.message, variant: "destructive" });
    },
  });

  const startLive = useMutation({
    mutationFn: (data: Parameters<typeof liveApi.startOverride>[0]) =>
      liveApi.startOverride(data),
    onSuccess: (res) => {
      toast({
        title: "Live broadcast started",
        description: `Push sent to ${res.push?.sent ?? 0} devices.`,
      });
      invalidate();
      // Refresh the recent-streams list so the just-started YouTube URL
      // appears at the top of the dropdown for next time (e.g. recurring
      // weekly service that's started, ended, then re-started).
      queryClient.invalidateQueries({ queryKey: ["admin-recent-youtube-streams"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to start broadcast", description: err.message, variant: "destructive" });
    },
  });

  const stopLive = useMutation({
    mutationFn: () => liveApi.stopOverride(),
    onSuccess: () => {
      toast({ title: "Broadcast ended", description: "Resuming automated queue." });
      invalidate();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to end broadcast", description: err.message, variant: "destructive" });
    },
  });

  useSSEEvent("override-expired", () => {
    invalidate();
    toast({ title: "Broadcast auto-ended", description: "Duration limit reached." });
  });

  useSSEEvent("status", () => invalidate());

  useEffect(() => {
    if (!activeOverride?.startedAt) {
      setTicker("");
      clearInterval(tickRef.current);
      return;
    }
    const tick = () => setTicker(elapsedStr(activeOverride.startedAt));
    tick();
    tickRef.current = setInterval(tick, 1000);
    return () => clearInterval(tickRef.current);
  }, [activeOverride?.startedAt]);

  const handleGoLive = (e: React.FormEvent, opts?: { skipYoutubeValidation?: boolean }) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    startLive.mutate({
      title: form.title.trim(),
      youtubeUrl: form.youtubeUrl.trim() || undefined,
      hlsStreamUrl: form.hlsStreamUrl.trim() || undefined,
      rtmpIngestKey: form.rtmpIngestKey.trim() || undefined,
      streamNotes: form.streamNotes.trim() || undefined,
      durationMinutes: form.durationMins ? Math.max(1, parseInt(form.durationMins, 10)) : undefined,
      notify: form.notify,
      skipYoutubeValidation: opts?.skipYoutubeValidation,
    });
  };

  const handlePreviewYoutube = () => {
    const url = form.youtubeUrl.trim();
    if (!url) {
      toast({ title: "Enter a YouTube URL first", variant: "destructive" });
      return;
    }
    previewYoutube.mutate(url);
  };

  const handleSchedule = () => {
    if (!form.title.trim()) {
      toast({ title: "Broadcast title is required", variant: "destructive" });
      return;
    }
    if (!scheduledFor) {
      toast({ title: "Pick a date and time first", variant: "destructive" });
      return;
    }
    if (!form.youtubeUrl.trim() && !form.hlsStreamUrl.trim()) {
      toast({ title: "Add a YouTube URL (or HLS URL) to schedule", variant: "destructive" });
      return;
    }
    // <input type="datetime-local"> returns a wall-clock string with no
    // timezone (e.g. "2026-04-27T09:00"). new Date() interprets it as
    // local time, which is exactly what the admin sees on screen — then
    // .toISOString() converts to UTC for the wire.
    const whenIso = new Date(scheduledFor).toISOString();
    scheduleMutation.mutate({
      title: form.title.trim(),
      youtubeUrl: form.youtubeUrl.trim() || undefined,
      hlsStreamUrl: form.hlsStreamUrl.trim() || undefined,
      streamNotes: form.streamNotes.trim() || undefined,
      scheduledFor: whenIso,
      durationMinutes: form.durationMins ? Math.max(1, parseInt(form.durationMins, 10)) : undefined,
    });
  };

  // Default the datetime picker to "next hour, on the hour" — a sensible
  // starting point that avoids accidentally scheduling something in the
  // past while the admin types.
  const defaultScheduleValue = (() => {
    const d = new Date();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    // Format as YYYY-MM-DDTHH:MM in local time for <input type="datetime-local">.
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();

  const previewIsCurrent = previewedUrl === form.youtubeUrl.trim() && form.youtubeUrl.trim() !== "";
  const previewBadge = (() => {
    if (!previewIsCurrent || !previewResult) return null;
    if (!previewResult.ok || !previewResult.exists) {
      return { tone: "destructive" as const, icon: AlertTriangle, label: previewResult.error ?? "Video not found" };
    }
    if (!previewResult.isLive) {
      return { tone: "warning" as const, icon: AlertTriangle, label: "Video offline — will air anyway" };
    }
    return { tone: "success" as const, icon: CheckCircle2, label: "Live now on YouTube" };
  })();

  const handleEndBroadcast = () => {
    if (!activeOverride) return;
    if (!window.confirm("End the live broadcast? Viewers will return to the automated queue.")) return;
    stopLive.mutate();
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <PageHeader
        title="Live Control"
        description="Override the automated queue and push a live broadcast to every Temple TV surface instantly."
        badge={
          <div className={cn(
            "inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border",
            sseState === "connected"
              ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
              : "bg-amber-500/10 text-amber-600 border-amber-500/20",
          )}>
            <span className={cn(
              "h-1.5 w-1.5 rounded-full",
              sseState === "connected" ? "bg-emerald-500" : "bg-amber-500 animate-pulse",
            )} />
            {sseState === "connected" ? "Live sync active" : "Reconnecting…"}
          </div>
        }
      />

      {/* Status Banner */}
      <Card className={cn(activeOverride ? "border-red-400/40 bg-red-500/5 dark:bg-red-950/20" : "")}>
        <CardContent className="p-6">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4">
              {activeOverride ? (
                <div className="relative flex h-4 w-4 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-4 w-4 bg-red-500" />
                </div>
              ) : (
                <Radio className="h-5 w-5 text-muted-foreground" />
              )}
              <div>
                <h2 className={cn("text-xl font-bold", activeOverride ? "text-red-600 dark:text-red-400" : "")}>
                  {activeOverride ? "LIVE ON AIR" : "Off Air — Automated Queue Running"}
                </h2>
                {activeOverride ? (
                  <p className="text-sm text-muted-foreground mt-0.5">
                    <span className="font-medium text-foreground">{activeOverride.title}</span>
                    {ticker && <> · {ticker}</>}
                    {activeOverride.endsAt && !Number.isNaN(new Date(activeOverride.endsAt).getTime()) && (
                      <> · ends {new Date(activeOverride.endsAt).toLocaleTimeString()}</>
                    )}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground mt-0.5">
                    All platforms are playing from the broadcast queue.
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              {liveStatus?.failureStats && liveStatus.failureStats.deviceCount > 0 && (
                <FailureIndicator stats={liveStatus.failureStats} />
              )}
              {liveStatus && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Users className="w-4 h-4" />
                  <span>{liveStatus.viewerCount} viewers</span>
                </div>
              )}
            </div>
          </div>

          {activeOverride && (
            <>
              <Separator className="my-4" />
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                <div className="rounded-lg border bg-background p-3">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Started</div>
                  <div className="text-xs">
                    {activeOverride.startedAt
                      ? new Date(activeOverride.startedAt).toLocaleTimeString()
                      : "—"}
                  </div>
                </div>
                {activeOverride.endsAt && !Number.isNaN(new Date(activeOverride.endsAt).getTime()) && (
                  <div className="rounded-lg border bg-background p-3">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Auto-ends</div>
                    <div className="text-xs">{new Date(activeOverride.endsAt).toLocaleTimeString()}</div>
                  </div>
                )}
                {activeOverride.youtubeVideoId && (
                  <div className="rounded-lg border bg-background p-3 col-span-2 sm:col-span-1">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
                      <Youtube className="w-3 h-3 text-red-500" /> YouTube
                    </div>
                    <a
                      href={`https://www.youtube.com/watch?v=${activeOverride.youtubeVideoId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-mono text-primary hover:underline truncate block"
                    >
                      {activeOverride.youtubeVideoId}
                    </a>
                  </div>
                )}
                {activeOverride.hlsStreamUrl && (
                  <div className="rounded-lg border bg-background p-3 col-span-2 sm:col-span-1">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">HLS</div>
                    <div className="text-xs font-mono truncate" title={activeOverride.hlsStreamUrl}>{activeOverride.hlsStreamUrl}</div>
                  </div>
                )}
              </div>
              <Button
                variant="destructive"
                onClick={handleEndBroadcast}
                disabled={stopLive.isPending}
                className="gap-2"
              >
                <Square className="w-4 h-4 fill-current" />
                {stopLive.isPending ? "Ending…" : "End Broadcast"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Upcoming scheduled broadcasts. Hidden when empty so the page
          stays clean for first-time use. Each row shows the title,
          target time, source (YouTube/HLS) and a one-click cancel. */}
      {scheduledItems.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarClock className="w-4 h-4 text-primary" />
              Upcoming Scheduled Broadcasts
              <span className="text-xs font-normal text-muted-foreground">
                ({scheduledItems.length})
              </span>
            </CardTitle>
            <CardDescription>
              These will auto-go-live across every platform at the time shown.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="divide-y border rounded-lg">
              {scheduledItems.map((item) => {
                const when = new Date(item.scheduledFor);
                const minsAway = Math.max(0, Math.round((when.getTime() - Date.now()) / 60_000));
                const inHours = Math.floor(minsAway / 60);
                const remMins = minsAway % 60;
                const countdown = inHours > 0
                  ? `in ${inHours}h ${remMins}m`
                  : minsAway > 0 ? `in ${minsAway}m` : "any moment";
                return (
                  <div key={item.id} className="flex items-center gap-3 p-3">
                    <CalendarClock className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{item.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {when.toLocaleString()} <span className="text-primary">· {countdown}</span>
                      </div>
                      {item.youtubeVideoId && (
                        <div className="text-[11px] font-mono text-muted-foreground truncate">
                          YouTube: {item.youtubeVideoId}
                        </div>
                      )}
                      {!item.youtubeVideoId && item.hlsStreamUrl && (
                        <div className="text-[11px] font-mono text-muted-foreground truncate">
                          HLS: {item.hlsStreamUrl}
                        </div>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => cancelScheduleMutation.mutate(item.id)}
                      disabled={cancelScheduleMutation.isPending}
                      title="Cancel this scheduled broadcast"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Start Form */}
      {!activeOverride && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              Start a Live Broadcast
            </CardTitle>
            <CardDescription>
              Going live instantly overrides the scheduled queue on all platforms — mobile, web,
              Smart TV, and radio. All connected devices switch within seconds.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleGoLive} className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="bc-title">
                  Broadcast Title <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="bc-title"
                  placeholder="e.g. Sunday Service — Live"
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  required
                />
              </div>

              {/* YouTube Live URL — primary, fastest path. Paste any
                  watch?v= / youtu.be / live URL and the server resolves
                  the video ID, probes liveness, and pushes to every
                  surface. The preview button lets the admin verify before
                  hitting Go Live; the badge mirrors the server probe. */}
              <div className="space-y-1.5">
                <Label htmlFor="bc-yt" className="flex items-center gap-2">
                  <Youtube className="w-4 h-4 text-red-500" />
                  YouTube Live URL
                  <span className="text-[10px] font-normal text-muted-foreground uppercase tracking-wider">
                    Recommended
                  </span>
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="bc-yt"
                    type="url"
                    placeholder="https://www.youtube.com/watch?v=… or https://youtu.be/…"
                    value={form.youtubeUrl}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, youtubeUrl: e.target.value }));
                    }}
                    className="font-mono text-sm flex-1"
                  />
                  {/* Re-broadcast a recent stream — pulls distinct YouTube
                      video IDs from broadcast history. The button is hidden
                      entirely when there's no history so first-time users
                      see a clean form. Picking an item populates the URL
                      field AND auto-fires Preview so the admin sees its
                      live state immediately. */}
                  {recentItems.length > 0 && (
                    <Popover open={recentOpen} onOpenChange={setRecentOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          className="gap-2 shrink-0"
                          title="Re-broadcast a recent YouTube stream"
                        >
                          <History className="w-4 h-4" />
                          Recent
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-80 p-0">
                        <div className="p-3 border-b">
                          <div className="text-xs font-semibold">Recent YouTube broadcasts</div>
                          <div className="text-[11px] text-muted-foreground">
                            Click to fill the URL and auto-preview.
                          </div>
                        </div>
                        <div className="max-h-72 overflow-y-auto divide-y">
                          {recentItems.map((item) => (
                            <button
                              key={item.videoId}
                              type="button"
                              className="w-full flex items-start gap-2.5 p-2.5 text-left hover:bg-muted/60 transition-colors"
                              onClick={() => {
                                setForm((f) => ({ ...f, youtubeUrl: item.url, title: item.title }));
                                setRecentOpen(false);
                                // Auto-preview so the admin sees the live
                                // badge for the chosen stream without an
                                // extra click. Mirrors handlePreviewYoutube.
                                previewYoutube.mutate(item.url);
                              }}
                            >
                              <img
                                src={item.thumbnailUrl}
                                alt=""
                                className="h-10 w-16 object-cover rounded shrink-0 bg-muted"
                                loading="lazy"
                                onError={(e) => {
                                  // YouTube returns a 120x90 grey placeholder
                                  // for deleted/private videos. Hide the img
                                  // rather than show a broken icon.
                                  (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                                }}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="text-xs font-medium truncate">{item.title}</div>
                                <div className="text-[10px] text-muted-foreground font-mono truncate">
                                  {item.videoId}
                                </div>
                                {item.lastBroadcastAt && (
                                  <div className="text-[10px] text-muted-foreground">
                                    Last aired {new Date(item.lastBroadcastAt).toLocaleString()}
                                  </div>
                                )}
                              </div>
                            </button>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handlePreviewYoutube}
                    disabled={previewYoutube.isPending || !form.youtubeUrl.trim()}
                    className="gap-2 shrink-0"
                  >
                    {previewYoutube.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                    Preview
                  </Button>
                </div>
                {previewBadge && (
                  <div className={cn(
                    "flex items-center gap-2 mt-2 text-xs font-medium px-2.5 py-1.5 rounded-md border",
                    previewBadge.tone === "success" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
                    previewBadge.tone === "warning" && "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
                    previewBadge.tone === "destructive" && "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
                  )}>
                    <previewBadge.icon className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{previewBadge.label}</span>
                  </div>
                )}
                {previewIsCurrent && previewResult?.ok && previewResult.exists && (
                  <div className="flex items-center gap-3 mt-2 rounded-md border bg-muted/30 p-2">
                    {previewResult.thumbnailUrl && (
                      <img
                        src={previewResult.thumbnailUrl}
                        alt={previewResult.title ?? "YouTube preview"}
                        className="h-12 w-20 object-cover rounded shrink-0"
                      />
                    )}
                    <div className="min-w-0">
                      <div className="text-xs font-medium truncate">{previewResult.title ?? "(no title)"}</div>
                      <div className="text-[10px] text-muted-foreground font-mono">id: {previewResult.videoId}</div>
                    </div>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Pasting a YouTube live URL is the fastest way to broadcast — works on Smart TV, mobile, web, and tablet.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="bc-hls">HLS Stream URL <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <Input
                    id="bc-hls"
                    type="url"
                    placeholder="https://stream.example.com/live.m3u8"
                    value={form.hlsStreamUrl}
                    onChange={(e) => setForm((f) => ({ ...f, hlsStreamUrl: e.target.value }))}
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    Use Mux / Cloudflare Stream / any HLS source if you're not on YouTube. Players prefer YouTube when both are set.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bc-rtmp">RTMP Ingest Key <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <Input
                    id="bc-rtmp"
                    placeholder="Stream key from encoder"
                    value={form.rtmpIngestKey}
                    onChange={(e) => setForm((f) => ({ ...f, rtmpIngestKey: e.target.value }))}
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    Stored for reference — ingestion is handled by your encoder.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="bc-dur">
                    <Clock className="w-3.5 h-3.5 inline mr-1" />
                    Auto-end after (minutes)
                  </Label>
                  <Input
                    id="bc-dur"
                    type="number"
                    min="1"
                    max="1440"
                    placeholder="e.g. 120"
                    value={form.durationMins}
                    onChange={(e) => setForm((f) => ({ ...f, durationMins: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bc-notes">Internal Notes</Label>
                  <Input
                    id="bc-notes"
                    placeholder="e.g. Pastor John — Youth Sunday"
                    value={form.streamNotes}
                    onChange={(e) => setForm((f) => ({ ...f, streamNotes: e.target.value }))}
                  />
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-lg border bg-blue-500/5 border-blue-500/20 p-4">
                <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                <div className="text-xs text-muted-foreground space-y-1">
                  <p>Broadcast state propagates to every connected client via Server-Sent Events in real time.</p>
                  <p>Mobile, Smart TV, web, and radio mode all switch to this stream within seconds — no refresh needed.</p>
                  {!form.hlsStreamUrl && !form.youtubeUrl && (
                    <p>Without a YouTube or HLS URL, platforms fall back to YouTube Live channel auto-detection.</p>
                  )}
                </div>
              </div>

              {/* Schedule-for-later panel. Hidden by default so admins
                  going live spontaneously aren't slowed down by an
                  extra field. Toggling it reveals a datetime picker
                  pre-filled with "next hour, on the hour" — a sensible
                  starting point that's safely in the future. */}
              {scheduleMode && (
                <div className="rounded-lg border bg-primary/5 border-primary/30 p-4 space-y-3">
                  <div className="flex items-start gap-2">
                    <CalendarClock className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <div className="text-xs">
                      <div className="font-semibold">Schedule this broadcast for later</div>
                      <div className="text-muted-foreground">
                        Times are in your local timezone. The server will auto-go-live
                        across every platform at the chosen moment.
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-end">
                    <div className="space-y-1.5">
                      <Label htmlFor="bc-when">Date & time</Label>
                      <Input
                        id="bc-when"
                        type="datetime-local"
                        value={scheduledFor || defaultScheduleValue}
                        min={defaultScheduleValue.slice(0, 16)}
                        onChange={(e) => setScheduledFor(e.target.value)}
                      />
                    </div>
                    <Button
                      type="button"
                      onClick={handleSchedule}
                      disabled={scheduleMutation.isPending || !form.title.trim()}
                      className="gap-2"
                    >
                      <CalendarClock className="w-4 h-4" />
                      {scheduleMutation.isPending ? "Scheduling…" : "Schedule"}
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <Button
                  type="submit"
                  size="lg"
                  className="bg-red-600 hover:bg-red-500 text-white gap-2"
                  disabled={startLive.isPending || !form.title.trim()}
                >
                  <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
                  {startLive.isPending ? "Starting broadcast…" : "Go Live — Push to All Platforms"}
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="gap-2"
                  onClick={() => setScheduleMode((v) => !v)}
                >
                  <CalendarClock className="w-4 h-4" />
                  {scheduleMode ? "Hide schedule" : "Schedule for later"}
                </Button>

                {/* Emergency override: skip the YouTube probe so admins can
                    still go live during a YouTube outage that breaks the
                    oembed/watch-page detection. URL shape is still validated. */}
                {form.youtubeUrl.trim() && previewIsCurrent && previewResult?.ok && previewResult.exists && !previewResult.isLive && (
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="gap-2 border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
                    onClick={(e) => handleGoLive(e, { skipYoutubeValidation: true })}
                    disabled={startLive.isPending}
                  >
                    <AlertTriangle className="w-4 h-4" />
                    Force Go Live (skip YouTube check)
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Platform Distribution */}
      <Card>
        <CardHeader>
          <CardTitle>Platform Distribution</CardTitle>
          <CardDescription>Live state synchronises to every surface simultaneously.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {PLATFORMS.map((p) => (
              <div key={p.label} className="rounded-lg border bg-card p-4 text-center">
                <p.icon className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
                <div className="text-sm font-semibold">{p.label}</div>
                <div className="text-xs text-muted-foreground mt-1 leading-snug">{p.desc}</div>
                <div className={cn(
                  "mt-3 inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border",
                  activeOverride
                    ? "bg-red-500/10 text-red-600 border-red-500/20"
                    : "bg-muted text-muted-foreground border-border",
                )}>
                  {activeOverride ? <><CheckCircle2 className="w-3 h-3" /> In sync</> : "Standby"}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
