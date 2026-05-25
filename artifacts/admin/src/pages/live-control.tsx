import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError, isTransientError} from "@/lib/api";
import { useSSE, useSSEEvent } from "@/contexts/sse-context";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Radio, Square, Play, Clock, Users, Zap, AlertCircle, CheckCircle2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface LiveStatus {
  isLive: boolean;
  liveOverride: {
    id: string;
    title: string;
    hlsUrl: string | null;
    youtubeId: string | null;
    startedAt: string;
    endsAt: string | null;
    elapsedSecs: number;
    remainingSecs: number | null;
  } | null;
}

interface RecentOverride {
  id: string;
  title: string;
  startedAt: string;
  stoppedAt: string | null;
  durationSecs: number | null;
}

export default function LiveControlPage() {
  const qc = useQueryClient();
  const { lastStatusPayload } = useSSE();

  const [title, setTitle] = useState("");
  const [hlsUrl, setHlsUrl] = useState("");
  const [youtubeId, setYoutubeId] = useState("");
  const [durationMins, setDurationMins] = useState("");
  const [useYoutube, setUseYoutube] = useState(false);

  const { data: liveStatus, isLoading, error, refetch } = useQuery({
    queryKey: ["live-status"],
    queryFn: () => api.get<LiveStatus>("/live/status"),
    refetchInterval: 10_000,
    staleTime: 8_000,
  });

  const { data: recent } = useQuery({
    queryKey: ["live-recent"],
    queryFn: () => api.get<{ items: RecentOverride[] }>("/live/recent"),
    staleTime: 30_000,
  });

  useSSEEvent("status", () => { void qc.invalidateQueries({ queryKey: ["live-status"] }); });
  useSSEEvent("override-expired", () => {
    void qc.invalidateQueries({ queryKey: ["live-status"] });
    void qc.invalidateQueries({ queryKey: ["live-recent"] });
  });

  const startMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post("/live/start", body),
    onSuccess: () => {
      toast.success("Live override started");
      void qc.invalidateQueries({ queryKey: ["live-status"] });
      void qc.invalidateQueries({ queryKey: ["live-recent"] });
      setTitle(""); setHlsUrl(""); setYoutubeId(""); setDurationMins("");
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to start override"),
  });

  const stopMutation = useMutation({
    mutationFn: () => api.post("/live/stop"),
    onSuccess: () => {
      toast.success("Live override stopped");
      void qc.invalidateQueries({ queryKey: ["live-status"] });
      void qc.invalidateQueries({ queryKey: ["live-recent"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Failed to stop override"),
  });

  const isLive = lastStatusPayload?.isLive ?? liveStatus?.isLive ?? false;
  const override = liveStatus?.liveOverride ?? null;
  const viewerCount = lastStatusPayload?.deviceCount ?? 0;

  const handleStart = () => {
    if (!title.trim()) { toast.error("Title is required"); return; }
    if (useYoutube) {
      const ytId = youtubeId.trim();
      if (!ytId) { toast.error("YouTube video ID is required"); return; }
      if (!/^[A-Za-z0-9_-]{8,15}$/.test(ytId)) {
        toast.error("YouTube ID looks invalid — should be 11 characters like dQw4w9WgXcQ");
        return;
      }
    } else {
      const url = hlsUrl.trim();
      if (!url) { toast.error("HLS URL is required"); return; }
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad protocol");
      } catch {
        toast.error("HLS URL must be a valid http(s):// address");
        return;
      }
    }

    const body: Record<string, unknown> = { title: title.trim() };
    if (useYoutube) body.youtubeId = youtubeId.trim();
    else body.hlsUrl = hlsUrl.trim();
    if (durationMins) body.durationMins = Number(durationMins);
    startMutation.mutate(body);
  };

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <PageHeader
        title="Live Control"
        description="Manage live broadcast overrides and go live instantly."
        actions={
          isLive ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  disabled={stopMutation.isPending}
                  className="gap-2"
                >
                  <Square size={14} />
                  {stopMutation.isPending ? "Stopping…" : "Stop Broadcast"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Stop Live Broadcast?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will immediately end the live broadcast override. Viewers will be
                    returned to the regular broadcast queue. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => stopMutation.mutate()}
                  >
                    Stop Broadcast
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : undefined
        }
      />

      {error && (
        <ErrorAlert
          message={(error as Error).message}
          onRetry={() => void refetch()}
          transient={isTransientError(error)}
        />
      )}

      {/* Current Status */}
      <Card className={isLive ? "border-red-500/40 bg-red-500/5" : ""}>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Radio size={15} className={isLive ? "text-red-500 animate-pulse" : "text-muted-foreground"} />
            Current Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? <Skeleton className="h-16 w-full" /> : (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${isLive ? "bg-red-500 animate-pulse" : "bg-muted-foreground/30"}`} />
                <span className="font-bold text-lg">{isLive ? "ON AIR" : "OFF AIR"}</span>
                {isLive && <Badge variant="destructive" className="animate-pulse">LIVE</Badge>}
                {isLive && (
                  <span className="text-sm text-muted-foreground flex items-center gap-1">
                    <Users size={13} /> {viewerCount.toLocaleString()} viewers
                  </span>
                )}
              </div>

              {override && (
                <div className="pl-6 space-y-1">
                  <p className="font-medium text-sm">{override.title}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock size={11} /> Started {formatDistanceToNow(new Date(override.startedAt), { addSuffix: true })}
                    </span>
                    {override.remainingSecs != null && (
                      <span className="flex items-center gap-1">
                        <Zap size={11} /> {Math.floor(override.remainingSecs / 60)}m remaining
                      </span>
                    )}
                  </div>
                  {override.hlsUrl && <p className="text-xs text-muted-foreground font-mono truncate">{override.hlsUrl}</p>}
                  {override.youtubeId && <p className="text-xs text-muted-foreground">YouTube: {override.youtubeId}</p>}
                </div>
              )}

              {!isLive && (
                <p className="text-sm text-muted-foreground pl-6">No active broadcast. Use the form below to go live.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Start Override Form */}
      {!isLive && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Start Live Override</CardTitle>
            <CardDescription>Broadcast an HLS stream or YouTube video to all viewers instantly.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Broadcast Title *</Label>
              <Input
                id="title"
                placeholder="e.g., Sunday Morning Service"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-3">
              <Switch id="use-yt" checked={useYoutube} onCheckedChange={setUseYoutube} />
              <Label htmlFor="use-yt" className="cursor-pointer">Use YouTube video</Label>
            </div>

            {useYoutube ? (
              <div className="space-y-2">
                <Label htmlFor="ytid">YouTube Video ID *</Label>
                <Input
                  id="ytid"
                  placeholder="e.g., dQw4w9WgXcQ"
                  value={youtubeId}
                  onChange={(e) => setYoutubeId(e.target.value)}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="hls">HLS Manifest URL *</Label>
                <Input
                  id="hls"
                  placeholder="https://cdn.example.com/stream/master.m3u8"
                  value={hlsUrl}
                  onChange={(e) => setHlsUrl(e.target.value)}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="dur">Duration (minutes, optional)</Label>
              <Input
                id="dur"
                type="number"
                placeholder="Leave blank for indefinite"
                value={durationMins}
                onChange={(e) => setDurationMins(e.target.value)}
                min={1}
                className="max-w-[200px]"
              />
            </div>

            <Button
              onClick={handleStart}
              disabled={startMutation.isPending || !title.trim()}
              className="gap-2"
            >
              <Play size={14} />
              {startMutation.isPending ? "Starting…" : "Go Live"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Recent overrides */}
      {(recent?.items?.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Recent Overrides</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {recent!.items.slice(0, 8).map(r => (
                <div key={r.id} className="flex items-center gap-2.5 text-sm py-2 border-b last:border-0">
                  {r.stoppedAt ? (
                    <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />
                  ) : (
                    <AlertCircle size={14} className="text-amber-500 flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="truncate font-medium text-sm">{r.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(r.startedAt), { addSuffix: true })}
                      {r.durationSecs ? ` · ${Math.floor(r.durationSecs / 60)}m` : ""}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
