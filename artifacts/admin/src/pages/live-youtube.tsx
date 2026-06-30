import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError} from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Tv2, RefreshCw, Play, Square, Users, Loader2, Clock } from "lucide-react";

interface YoutubeLiveStatus {
  isLive: boolean;
  isUpcoming?: boolean;
  upcomingVideoId?: string | null;
  upcomingTitle?: string | null;
  broadcastId?: string;
  videoId?: string | null;
  title?: string | null;
  viewerCount?: number | null;
  scheduledStartTime?: string;
  actualStartTime?: string;
  streamKey?: string;
}

interface YoutubeScheduled {
  id: string;
  title: string;
  scheduledStartTime: string;
  status: string;
}

export default function LiveYoutubePage() {
  const qc = useQueryClient();
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [pendingStopId, setPendingStopId] = useState<string | null>(null);

  const { data: status, isLoading, error, refetch } = useQuery({
    queryKey: ["youtube-live-status"],
    queryFn: () => api.get<YoutubeLiveStatus>("/youtube/live/status"),
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  const { data: broadcasts, error: broadcastsError } = useQuery({
    queryKey: ["youtube-broadcasts"],
    queryFn: () => api.get<{ broadcasts: YoutubeScheduled[] }>("/youtube/live/broadcasts"),
    staleTime: 60_000,
    retry: 1,
  });

  // SSE-driven invalidation — refresh immediately when YouTube live state changes
  // so operators see the updated status without waiting for the 30-second poll.
  useSSEEvent("yt-status", () => {
    void qc.invalidateQueries({ queryKey: ["youtube-live-status"] });
    void qc.invalidateQueries({ queryKey: ["youtube-broadcasts"] });
  });
  useSSEEvent("youtube-live-status-changed", () => {
    void qc.invalidateQueries({ queryKey: ["youtube-live-status"] });
  });

  const startMutation = useMutation({
    mutationFn: (broadcastId: string) => api.post(`/youtube/live/${broadcastId}/start`),
    onSuccess: () => {
      toast.success("YouTube broadcast started");
      void qc.invalidateQueries({ queryKey: ["youtube-live-status"] });
      void qc.invalidateQueries({ queryKey: ["youtube-broadcasts"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to start"),
  });

  const stopMutation = useMutation({
    mutationFn: (broadcastId: string) => api.post(`/youtube/live/${broadcastId}/stop`),
    onSuccess: () => {
      toast.success("YouTube broadcast ended");
      void qc.invalidateQueries({ queryKey: ["youtube-live-status"] });
      void qc.invalidateQueries({ queryKey: ["youtube-broadcasts"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to stop"),
  });

  const handleStopClick = (broadcastId: string) => {
    setPendingStopId(broadcastId);
    setShowStopConfirm(true);
  };

  const handleStopConfirm = () => {
    if (pendingStopId) stopMutation.mutate(pendingStopId);
    setShowStopConfirm(false);
    setPendingStopId(null);
  };

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <PageHeader
        title="YouTube Live"
        description="Manage YouTube live broadcasts and stream keys."
        actions={
          <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
            <RefreshCw size={13} /> Refresh
          </Button>
        }
      />

      {error && (
        <ErrorAlert
          message={(error as Error).message}
          onRetry={() => void refetch()}
          transient={isTransientError(error)}
        />
      )}
      {broadcastsError && !error && (
        <ErrorAlert message="Could not load scheduled broadcasts — YouTube API may not be configured." />
      )}

      <Card className={
        status?.isLive
          ? "border-red-500/40 bg-red-500/5"
          : status?.isUpcoming
            ? "border-yellow-500/40 bg-yellow-500/5"
            : ""
      }>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Tv2 size={15} className={
                status?.isLive
                  ? "text-red-500"
                  : status?.isUpcoming
                    ? "text-yellow-500"
                    : "text-muted-foreground"
              } />
              YouTube Broadcast Status
            </span>
            {status?.isLive && (status.broadcastId ?? status.videoId) && (
              <Button
                size="sm"
                variant="destructive"
                className="h-7 gap-1 text-xs"
                onClick={() => handleStopClick((status.broadcastId ?? status.videoId)!)}
                disabled={stopMutation.isPending}
              >
                {stopMutation.isPending
                  ? <><Loader2 size={11} className="animate-spin" /> Stopping…</>
                  : <><Square size={11} /> End Broadcast</>}
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? <Skeleton className="h-16 w-full" /> : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className={`w-2.5 h-2.5 rounded-full ${
                  status?.isLive
                    ? "bg-red-500 animate-pulse"
                    : status?.isUpcoming
                      ? "bg-yellow-500 animate-pulse"
                      : "bg-muted-foreground/30"
                }`} />
                <span className="font-bold">
                  {status?.isLive ? "LIVE ON YOUTUBE" : status?.isUpcoming ? "UPCOMING BROADCAST" : "Not Live"}
                </span>
              </div>
              {status?.isLive && (
                <>
                  {status.title && <p className="text-sm">{status.title}</p>}
                  {status.viewerCount != null && (
                    <p className="text-sm text-muted-foreground flex items-center gap-1">
                      <Users size={13} /> {status.viewerCount.toLocaleString()} concurrent viewers
                    </p>
                  )}
                </>
              )}
              {!status?.isLive && status?.isUpcoming && (
                <div className="space-y-1">
                  {status.upcomingTitle && <p className="text-sm">{status.upcomingTitle}</p>}
                  <p className="text-sm text-muted-foreground flex items-center gap-1">
                    <Clock size={13} /> Scheduled — broadcast will go live automatically when it starts
                  </p>
                </div>
              )}
              {!status?.isLive && !status?.isUpcoming && (
                <p className="text-sm text-muted-foreground">No active YouTube broadcast.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {(broadcasts?.broadcasts?.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Scheduled Broadcasts</CardTitle>
          </CardHeader>
          <CardContent className="p-0 divide-y">
            {broadcasts!.broadcasts.map(b => (
              <div key={b.id} className="flex items-center gap-3 px-4 py-3">
                <Tv2 size={14} className="text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{b.title}</p>
                  {b.scheduledStartTime && (
                    <p className="text-xs text-muted-foreground">{new Date(b.scheduledStartTime).toLocaleString()}</p>
                  )}
                </div>
                <Badge
                  variant="outline"
                  className={`capitalize text-[11px] flex-shrink-0 ${
                    b.status === "live" ? "border-red-500/50 text-red-600 bg-red-500/5" :
                    b.status === "upcoming" ? "border-yellow-500/50 text-yellow-600 bg-yellow-500/5" : ""
                  }`}
                >
                  {b.status}
                </Badge>
                {b.status === "ready" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs flex-shrink-0"
                    onClick={() => startMutation.mutate(b.id)}
                    disabled={startMutation.isPending}
                  >
                    {startMutation.isPending && startMutation.variables === b.id
                      ? <><Loader2 size={11} className="animate-spin" /> Starting…</>
                      : <><Play size={11} /> Go Live</>}
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Confirm End Broadcast */}
      <AlertDialog open={showStopConfirm} onOpenChange={setShowStopConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End YouTube Broadcast?</AlertDialogTitle>
            <AlertDialogDescription>
              This will immediately terminate the live YouTube broadcast
              {status?.title ? ` "${status.title}"` : ""}. Viewers currently watching will be disconnected.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingStopId(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleStopConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              End Broadcast
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
