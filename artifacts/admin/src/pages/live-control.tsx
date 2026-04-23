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
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useSSE, useSSEEvent } from "@/contexts/SSEContext";
import { liveApi, type LiveOverride } from "@/services/adminApi";
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

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin-live-status"] });

  const startLive = useMutation({
    mutationFn: (data: Parameters<typeof liveApi.startOverride>[0]) =>
      liveApi.startOverride(data),
    onSuccess: (res) => {
      toast({
        title: "Live broadcast started",
        description: `Push sent to ${res.push?.sent ?? 0} devices.`,
      });
      invalidate();
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

  const handleGoLive = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    startLive.mutate({
      title: form.title.trim(),
      hlsStreamUrl: form.hlsStreamUrl.trim() || undefined,
      rtmpIngestKey: form.rtmpIngestKey.trim() || undefined,
      streamNotes: form.streamNotes.trim() || undefined,
      durationMinutes: form.durationMins ? Math.max(1, parseInt(form.durationMins, 10)) : undefined,
      notify: form.notify,
    });
  };

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
                    {activeOverride.endsAt && (
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
            {liveStatus && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Users className="w-4 h-4" />
                <span>{liveStatus.viewerCount} viewers</span>
              </div>
            )}
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
                {activeOverride.endsAt && (
                  <div className="rounded-lg border bg-background p-3">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Auto-ends</div>
                    <div className="text-xs">{new Date(activeOverride.endsAt).toLocaleTimeString()}</div>
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

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="bc-hls">HLS Stream URL</Label>
                  <Input
                    id="bc-hls"
                    type="url"
                    placeholder="https://stream.example.com/live.m3u8"
                    value={form.hlsStreamUrl}
                    onChange={(e) => setForm((f) => ({ ...f, hlsStreamUrl: e.target.value }))}
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    Mux, Cloudflare Stream, or any HLS source. Leave empty to use YouTube Live detection.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bc-rtmp">RTMP Ingest Key</Label>
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
                  {!form.hlsStreamUrl && (
                    <p>Without an HLS URL, platforms fall back to YouTube Live detection via the YouTube Data API.</p>
                  )}
                </div>
              </div>

              <Button
                type="submit"
                size="lg"
                className="bg-red-600 hover:bg-red-500 text-white gap-2 w-full sm:w-auto"
                disabled={startLive.isPending || !form.title.trim()}
              >
                <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
                {startLive.isPending ? "Starting broadcast…" : "Go Live — Push to All Platforms"}
              </Button>
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
