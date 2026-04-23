import {
  getGetLiveStatusQueryKey,
  useGetAdminStats,
  useGetLiveStatus,
  useListAdminVideos,
  useStartLiveOverride,
  useStopLiveOverride,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "wouter";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSSE, useSSEEvent } from "@/contexts/SSEContext";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { cn } from "@/lib/utils";

const QUICK_LINKS = [
  { href: "/live-control", label: "Live Control", icon: Signal, desc: "Start or stop a broadcast" },
  { href: "/broadcast", label: "Broadcast Queue", icon: Tv2, desc: "Manage the video queue" },
  { href: "/videos", label: "Video Library", icon: Video, desc: "Import and manage videos" },
  { href: "/analytics", label: "Analytics", icon: BarChart2, desc: "Viewership & device data" },
  { href: "/transcoding", label: "Transcoding", icon: Cpu, desc: "Monitor encoding jobs" },
  { href: "/operations", label: "Operations", icon: ShieldCheck, desc: "Platform health & status" },
];

export default function Dashboard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { state: sseState, lastStatusPayload } = useSSE();

  const { data: stats, isLoading: isLoadingStats, isError: isErrorStats, refetch: refetchStats } = useGetAdminStats();
  const { data: liveStatus } = useGetLiveStatus();
  const { data: videosData, isLoading: isLoadingVideos, isError: isErrorVideos } = useListAdminVideos({ limit: 4 });

  const [goLiveOpen, setGoLiveOpen] = useState(false);
  const [goLiveForm, setGoLiveForm] = useState({ title: "Temple TV Live Service", durationMinutes: 120 });

  const startLiveOverride = useStartLiveOverride({
    mutation: {
      onSuccess: (result) => {
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
  });

  const manualOverrideActive = Boolean(liveStatus?.liveOverride);
  const isLiveNow = lastStatusPayload?.isLive ?? stats?.isLiveNow ?? false;
  const overrideTitle = lastStatusPayload?.liveOverride?.title ?? liveStatus?.liveOverride?.title;

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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Overview of your ministry operations."
        badge={
          sseState === "connected" ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-600 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full font-medium">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Real-time
            </span>
          ) : undefined
        }
        actions={
          <Link
            href="/videos"
            className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4"
          >
            <Plus className="w-4 h-4 mr-2" />
            Import Video
          </Link>
        }
      />

      {isErrorStats && (
        <ErrorAlert
          title="Couldn't load dashboard stats"
          message="The admin stats endpoint returned an error. Numbers may be stale."
          onRetry={() => refetchStats()}
        />
      )}

      {/* Stats row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
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

      <div className="grid gap-4 md:grid-cols-2">
        {/* Live Status */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Radio className="w-4 h-4" />
              Live Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLiveNow ? (
              <div className="flex flex-col items-center justify-center p-6 bg-red-500/5 border border-red-500/20 rounded-lg text-center space-y-3">
                <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center text-red-500">
                  <Radio className="w-6 h-6 animate-pulse" />
                </div>
                <div>
                  <div className="font-bold text-lg text-red-500">Live Service in Progress</div>
                  <div className="text-sm text-muted-foreground mt-1">
                    ~{stats?.liveViewerEstimate ?? lastStatusPayload?.deviceCount ?? 0} viewers watching
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center p-5 bg-muted/50 border rounded-lg text-center space-y-3">
                <div className="w-10 h-10 rounded-full bg-background flex items-center justify-center text-muted-foreground shadow-sm">
                  <Activity className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-semibold text-sm">No Active Stream</div>
                  <div className="text-xs text-muted-foreground mt-1">Ready for the next scheduled service.</div>
                </div>
              </div>
            )}

            <div className="rounded-lg border bg-background p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="font-semibold text-sm">Manual Live Override</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {manualOverrideActive
                      ? `Active: ${overrideTitle}`
                      : "Force live mode if YouTube detection is delayed."}
                  </div>
                </div>
                {manualOverrideActive ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => stopLiveOverride.mutate()}
                    disabled={stopLiveOverride.isPending}
                    className="shrink-0"
                  >
                    {stopLiveOverride.isPending
                      ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      : <Square className="w-4 h-4 mr-2" />}
                    Stop
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => setGoLiveOpen(true)} className="shrink-0">
                    <Radio className="w-4 h-4 mr-2" />
                    Go Live
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Recent Videos */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">Recent Videos</CardTitle>
            <Link href="/videos" className="text-sm text-primary hover:underline font-medium flex items-center gap-1">
              View all <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </CardHeader>
          <CardContent>
            {isLoadingVideos ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-4">
                    <Skeleton className="w-24 h-16 rounded" />
                    <div className="space-y-2 flex-1">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : isErrorVideos ? (
              <div className="text-center py-8 text-sm border border-destructive/30 bg-destructive/5 text-destructive rounded-lg">
                Couldn't load recent videos.
              </div>
            ) : videosData?.videos && videosData.videos.length > 0 ? (
              <div className="space-y-3">
                {videosData.videos.slice(0, 3).map((video) => (
                  <div key={video.id} className="flex items-center gap-3 group">
                    <div className="relative w-24 h-14 rounded overflow-hidden bg-muted shrink-0 border">
                      <img
                        src={video.thumbnailUrl}
                        alt={video.title}
                        className="w-full h-full object-cover transition-transform group-hover:scale-105"
                      />
                      {video.duration && (
                        <div className="absolute bottom-1 right-1 bg-black/80 text-white text-[10px] px-1 py-0.5 rounded font-mono">
                          {video.duration}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                        {video.title}
                      </h4>
                      <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                        <span className="truncate">{video.preacher || "Unknown Speaker"}</span>
                        <span>·</span>
                        <span>{video.category}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground text-sm border border-dashed rounded-lg">
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
