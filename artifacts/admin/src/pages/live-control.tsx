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
import { liveApi, type LiveOverride, type YouTubePreviewResult, type RecentYoutubeStream } from "@/services/adminApi";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { History } from "lucide-react";
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
