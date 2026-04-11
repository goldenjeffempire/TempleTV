import {
  getGetLiveStatusQueryKey,
  useGetAdminStats,
  useGetLiveStatus,
  useListAdminVideos,
  useStartLiveOverride,
  useStopLiveOverride,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Video, ListVideo, Calendar, BellRing, Activity, Radio, Plus, Loader2, Square } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function Dashboard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: stats, isLoading: isLoadingStats } = useGetAdminStats();
  const { data: liveStatus } = useGetLiveStatus();
  const { data: videosData, isLoading: isLoadingVideos } = useListAdminVideos({ limit: 4 });
  const startLiveOverride = useStartLiveOverride({
    mutation: {
      onSuccess: (result) => {
        toast({ title: "Live override started", description: `Push sent to ${result.push.sent} devices.` });
        queryClient.invalidateQueries({ queryKey: getGetLiveStatusQueryKey() });
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
  const manualOverrideActive = Boolean(liveStatus?.liveOverride);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Overview of your ministry operations.</p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/videos" className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2">
            <Plus className="w-4 h-4 mr-2" />
            Import Video
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Videos</CardTitle>
            <Video className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingStats ? <Skeleton className="h-7 w-20" /> : (
              <>
                <div className="text-2xl font-bold">{stats?.totalVideos || 0}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  +{stats?.recentImports || 0} recent imports
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Playlists</CardTitle>
            <ListVideo className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingStats ? <Skeleton className="h-7 w-20" /> : (
              <>
                <div className="text-2xl font-bold">{stats?.totalPlaylists || 0}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Curated collections
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Schedule Entries</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingStats ? <Skeleton className="h-7 w-20" /> : (
              <>
                <div className="text-2xl font-bold">{stats?.activeScheduleEntries || 0}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Active weekly slots
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Notifications Today</CardTitle>
            <BellRing className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingStats ? <Skeleton className="h-7 w-20" /> : (
              <>
                <div className="text-2xl font-bold">{stats?.notificationsSentToday || 0}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {(stats as any)?.registeredDevices ?? 0} registered devices
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Live Status</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingStats ? <Skeleton className="h-32 w-full" /> : stats?.isLiveNow ? (
              <div className="flex flex-col items-center justify-center p-6 bg-red-500/5 border border-red-500/20 rounded-lg text-center space-y-3">
                <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center text-red-500 animate-pulse">
                  <Radio className="w-6 h-6" />
                </div>
                <div>
                  <div className="font-bold text-lg text-red-500">Live Service in Progress</div>
                  <div className="text-sm text-muted-foreground mt-1">~{stats.liveViewerEstimate} viewers currently watching</div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center p-6 bg-muted/50 border rounded-lg text-center space-y-3">
                <div className="w-12 h-12 rounded-full bg-background flex items-center justify-center text-muted-foreground shadow-sm">
                  <Activity className="w-6 h-6" />
                </div>
                <div>
                  <div className="font-bold">No Active Stream</div>
                  <div className="text-sm text-muted-foreground mt-1">Ready for the next scheduled service.</div>
                </div>
              </div>
            )}
            <div className="mt-4 rounded-lg border bg-background p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-semibold text-sm">Manual Live Override</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {manualOverrideActive
                      ? `Active: ${liveStatus?.liveOverride?.title}`
                      : "Force the app into live mode if YouTube live detection is delayed."}
                  </div>
                </div>
                {manualOverrideActive ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => stopLiveOverride.mutate()}
                    disabled={stopLiveOverride.isPending}
                  >
                    {stopLiveOverride.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Square className="w-4 h-4 mr-2" />}
                    Stop
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => startLiveOverride.mutate({ data: { title: "Temple TV Live Service", durationMinutes: 120, notify: true } })}
                    disabled={startLiveOverride.isPending}
                  >
                    {startLiveOverride.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Radio className="w-4 h-4 mr-2" />}
                    Go Live
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="col-span-1">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Recent Videos</CardTitle>
            <Link href="/videos" className="text-sm text-primary hover:underline font-medium">View all</Link>
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
            ) : videosData?.videos && videosData.videos.length > 0 ? (
              <div className="space-y-4">
                {videosData.videos.slice(0, 3).map((video) => (
                  <div key={video.id} className="flex items-center gap-4 group">
                    <div className="relative w-24 h-16 rounded overflow-hidden bg-muted shrink-0 border">
                      <img src={video.thumbnailUrl} alt={video.title} className="w-full h-full object-cover transition-transform group-hover:scale-105" />
                      {video.duration && (
                        <div className="absolute bottom-1 right-1 bg-black/80 text-white text-[10px] px-1 py-0.5 rounded font-mono">
                          {video.duration}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-medium truncate group-hover:text-primary transition-colors">{video.title}</h4>
                      <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
                        <span className="truncate">{video.preacher || "Unknown Speaker"}</span>
                        <span>•</span>
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
    </div>
  );
}
