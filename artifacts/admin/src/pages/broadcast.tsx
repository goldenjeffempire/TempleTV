import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useListAdminVideos } from "@workspace/api-client-react";
import {
  Radio,
  Trash2,
  Plus,
  ChevronUp,
  ChevronDown,
  Clock,
  Play,
  Loader2,
  Search,
  HardDrive,
  Youtube,
  RefreshCw,
  Tv,
  Signal,
  Mic,
  SkipForward,
  Calendar,
  ListVideo,
  AlertCircle,
  Headphones,
} from "lucide-react";

type BroadcastItem = {
  id: string;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  durationSecs: number;
  localVideoUrl: string | null;
  videoSource: string;
  isActive: boolean;
  sortOrder: number;
};

type CurrentBroadcast = {
  item: BroadcastItem | null;
  nextItem: BroadcastItem | null;
  index: number;
  positionSecs: number;
  totalSecs: number;
  queueLength: number;
  progressPercent?: number;
  liveOverride?: { id: string; title: string; startedAt: string; endsAt: string | null } | null;
  failoverReason?: string | null;
};

type GuideItem = {
  id: string;
  title: string;
  thumbnailUrl: string;
  durationSecs: number;
  startMs: number;
  endMs: number;
  isCurrent: boolean;
  positionSecs: number;
  progressPercent: number;
  videoSource: string;
};

function fmtDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtTotalTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m cycle`;
  return `${m}m cycle`;
}

function fmtWallClock(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function LiveClock() {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="font-mono text-sm">
      {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </span>
  );
}

export default function Broadcast() {
  const [queue, setQueue] = useState<BroadcastItem[]>([]);
  const [current, setCurrent] = useState<CurrentBroadcast | null>(null);
  const [guide, setGuide] = useState<GuideItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showGoLiveDialog, setShowGoLiveDialog] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [addingId, setAddingId] = useState<string | null>(null);
  const [editingDuration, setEditingDuration] = useState<string | null>(null);
  const [durationInput, setDurationInput] = useState("");
  const [goLiveTitle, setGoLiveTitle] = useState("");
  const [goLiveHours, setGoLiveHours] = useState("2");
  const [goingLive, setGoingLive] = useState(false);
  const [endingLive, setEndingLive] = useState(false);
  const [livePosition, setLivePosition] = useState(0);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { toast } = useToast();

  const { data: videoLibrary } = useListAdminVideos({ search: addSearch, limit: 50 });

  const loadQueue = useCallback(async () => {
    try {
      const [qRes, cRes, gRes] = await Promise.all([
        fetch("/api/admin/broadcast"),
        fetch("/api/broadcast/current"),
        fetch("/api/broadcast/guide"),
      ]);
      if (qRes.ok) setQueue(await qRes.json());
      if (cRes.ok) {
        const c = await cRes.json();
        setCurrent(c);
        setLivePosition(c.positionSecs ?? 0);
      }
      if (gRes.ok) {
        const g = await gRes.json();
        setGuide(g.items ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQueue();
    const interval = setInterval(loadQueue, 15000);
    return () => clearInterval(interval);
  }, [loadQueue]);

  useEffect(() => {
    if (tickerRef.current) clearInterval(tickerRef.current);
    if (current?.item && !current.liveOverride) {
      tickerRef.current = setInterval(() => {
        setLivePosition((p) => p + 1);
      }, 1000);
    }
    return () => {
      if (tickerRef.current) clearInterval(tickerRef.current);
    };
  }, [current?.item?.id, current?.liveOverride]);

  const addToQueue = async (video: { id: string; youtubeId: string; title: string; thumbnailUrl: string; videoSource?: string; localVideoUrl?: string | null }) => {
    setAddingId(video.id);
    try {
      const res = await fetch("/api/admin/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: video.id,
          youtubeId: video.youtubeId,
          title: video.title,
          thumbnailUrl: video.thumbnailUrl,
          videoSource: video.videoSource ?? "youtube",
          localVideoUrl: video.localVideoUrl ?? null,
          durationSecs: 1800,
        }),
      });
      if (!res.ok) throw new Error("Failed to add");
      toast({ title: "Added to broadcast queue" });
      setShowAddDialog(false);
      await loadQueue();
    } catch {
      toast({ title: "Failed to add video", variant: "destructive" });
    } finally {
      setAddingId(null);
    }
  };

  const removeFromQueue = async (id: string) => {
    try {
      await fetch(`/api/admin/broadcast/${id}`, { method: "DELETE" });
      toast({ title: "Removed from queue" });
      await loadQueue();
    } catch {
      toast({ title: "Failed to remove", variant: "destructive" });
    }
  };

  const move = async (index: number, direction: "up" | "down") => {
    const newQueue = [...queue];
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= newQueue.length) return;
    [newQueue[index], newQueue[swapIndex]] = [newQueue[swapIndex]!, newQueue[index]!];
    setQueue(newQueue);
    try {
      await fetch("/api/admin/broadcast/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds: newQueue.map((i) => i.id) }),
      });
      await loadQueue();
    } catch {
      toast({ title: "Failed to reorder", variant: "destructive" });
    }
  };

  const saveDuration = async (id: string) => {
    const mins = parseInt(durationInput, 10);
    if (isNaN(mins) || mins < 1) {
      toast({ title: "Enter a valid duration in minutes", variant: "destructive" });
      return;
    }
    try {
      await fetch(`/api/admin/broadcast/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ durationSecs: mins * 60 }),
      });
      toast({ title: "Duration updated" });
      setEditingDuration(null);
      await loadQueue();
    } catch {
      toast({ title: "Failed to update duration", variant: "destructive" });
    }
  };

  const handleGoLive = async () => {
    if (!goLiveTitle.trim()) {
      toast({ title: "Broadcast title is required", variant: "destructive" });
      return;
    }
    setGoingLive(true);
    try {
      const hours = parseFloat(goLiveHours) || 2;
      const durationMinutes = Math.round(hours * 60);
      const res = await fetch("/api/admin/live/override/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: goLiveTitle.trim(), durationMinutes, notify: true }),
      });
      if (!res.ok) throw new Error("Failed to go live");
      toast({ title: "Station is now LIVE!" });
      setShowGoLiveDialog(false);
      setGoLiveTitle("");
      await loadQueue();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      toast({ title: msg, variant: "destructive" });
    } finally {
      setGoingLive(false);
    }
  };

  const handleEndLive = async () => {
    setEndingLive(true);
    try {
      await fetch("/api/admin/live/override/stop", { method: "POST" });
      toast({ title: "Live broadcast ended" });
      await loadQueue();
    } catch {
      toast({ title: "Failed to end live broadcast", variant: "destructive" });
    } finally {
      setEndingLive(false);
    }
  };

  const totalSecs = queue.reduce((acc, i) => acc + i.durationSecs, 0);
  const isOnAir = !!(current?.item || current?.liveOverride);
  const currentProgress = current?.item
    ? Math.min(100, (livePosition / current.item.durationSecs) * 100)
    : 0;
  const remaining = current?.item ? Math.max(0, current.item.durationSecs - livePosition) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Tv className="w-6 h-6" />
            Broadcast Control
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            24/7 continuous channel — manage your on-air lineup and live events
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/50 border text-sm">
            <div className={`w-2 h-2 rounded-full ${isOnAir ? "bg-red-500 animate-pulse" : "bg-muted-foreground/40"}`} />
            <LiveClock />
          </div>
          <Button size="sm" variant="outline" onClick={loadQueue}>
            <RefreshCw className="w-4 h-4" />
          </Button>
          {current?.liveOverride ? (
            <Button size="sm" variant="destructive" onClick={handleEndLive} disabled={endingLive}>
              {endingLive ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Signal className="w-4 h-4 mr-1" />}
              End Live
            </Button>
          ) : (
            <Button size="sm" className="bg-red-600 hover:bg-red-700 text-white" onClick={() => setShowGoLiveDialog(true)}>
              <Mic className="w-4 h-4 mr-1" />
              Go Live
            </Button>
          )}
          <Button size="sm" onClick={() => setShowAddDialog(true)}>
            <Plus className="w-4 h-4 mr-1" />
            Add Video
          </Button>
        </div>
      </div>

      {current?.liveOverride && (
        <div className="rounded-xl border-2 border-red-500/40 bg-red-500/5 p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="flex items-center gap-1.5 bg-red-500 text-white px-2.5 py-1 rounded-full text-xs font-bold animate-pulse">
              <Signal className="w-3 h-3" />
              LIVE ON AIR
            </div>
            <span className="text-sm font-medium">{current.liveOverride.title}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>Started {new Date(current.liveOverride.startedAt).toLocaleTimeString()}</span>
            {current.liveOverride.endsAt && (
              <span>· Ends {new Date(current.liveOverride.endsAt).toLocaleTimeString()}</span>
            )}
            <Badge variant="outline" className="text-xs border-red-500/30 text-red-500">
              <Mic className="w-3 h-3 mr-1" />Live Override Active
            </Badge>
          </div>
        </div>
      )}

      {current?.item && !current.liveOverride && (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="px-4 py-2.5 bg-red-500/8 border-b flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 bg-red-500/15 text-red-500 px-2.5 py-1 rounded-full text-xs font-bold border border-red-500/25">
                <Radio className="w-3 h-3" />
                ON AIR NOW
              </div>
              <span className="text-xs text-muted-foreground">
                Item {(current.index ?? 0) + 1} of {queue.length} · {fmtTotalTime(totalSecs)}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Headphones className="w-3.5 h-3.5" />
              Radio mirror active
            </div>
          </div>
          <div className="p-4 flex items-start gap-4">
            <div className="relative shrink-0">
              {current.item.thumbnailUrl ? (
                <img
                  src={current.item.thumbnailUrl}
                  alt={current.item.title}
                  className="w-32 h-20 object-cover rounded-lg shadow-md"
                />
              ) : (
                <div className="w-32 h-20 bg-muted rounded-lg flex items-center justify-center">
                  <Play className="w-6 h-6 text-muted-foreground" />
                </div>
              )}
              <div className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 border-2 border-background animate-pulse" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-base truncate">{current.item.title}</p>
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                <span className="text-green-600 dark:text-green-400 font-medium">{fmtDuration(livePosition)} elapsed</span>
                <span>·</span>
                <span>{fmtDuration(remaining)} remaining</span>
                <span>·</span>
                <Badge variant="secondary" className="text-xs h-4">
                  {current.item.videoSource === "local" ? <><HardDrive className="w-3 h-3 mr-1" />Local</> : <><Youtube className="w-3 h-3 mr-1" />YouTube</>}
                </Badge>
              </div>
              <div className="mt-3 space-y-1">
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>{Math.round(currentProgress)}% complete</span>
                  <span>{fmtDuration(current.item.durationSecs)} total</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-red-500 rounded-full transition-all duration-1000"
                    style={{ width: `${currentProgress}%` }}
                  />
                </div>
              </div>
            </div>
            {current.nextItem && (
              <div className="shrink-0 hidden sm:block">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
                  <SkipForward className="w-3 h-3" />Up Next
                </p>
                <div className="flex items-center gap-2">
                  {current.nextItem.thumbnailUrl ? (
                    <img src={current.nextItem.thumbnailUrl} alt="" className="w-16 h-10 object-cover rounded opacity-60" />
                  ) : (
                    <div className="w-16 h-10 bg-muted rounded opacity-60" />
                  )}
                  <p className="text-xs text-muted-foreground max-w-[120px] line-clamp-2">{current.nextItem.title}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {guide.length > 1 && (
        <div className="rounded-xl border bg-card">
          <div className="px-4 py-2.5 border-b flex items-center gap-2">
            <Calendar className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Program Guide — Next 8 Programs</h2>
          </div>
          <div className="p-3 flex gap-2 overflow-x-auto pb-4">
            {guide.slice(0, 8).map((item, idx) => (
              <div
                key={`${item.id}-${idx}`}
                className={`shrink-0 w-40 rounded-lg border p-2.5 space-y-1.5 ${
                  item.isCurrent
                    ? "border-red-500/40 bg-red-500/5"
                    : "bg-muted/30"
                }`}
              >
                {item.thumbnailUrl ? (
                  <div className="relative">
                    <img src={item.thumbnailUrl} alt="" className="w-full h-20 object-cover rounded" />
                    {item.isCurrent && (
                      <div className="absolute inset-0 rounded flex items-center justify-center bg-black/40">
                        <div className="flex items-center gap-1 text-white text-[10px] font-bold bg-red-500 px-2 py-0.5 rounded-full">
                          <Radio className="w-2.5 h-2.5" /> ON AIR
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="w-full h-20 bg-muted rounded flex items-center justify-center">
                    <Play className="w-5 h-5 text-muted-foreground" />
                  </div>
                )}
                <p className="text-xs font-medium line-clamp-2 leading-tight">{item.title}</p>
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{fmtWallClock(item.startMs)}</span>
                  <span>{fmtDuration(item.durationSecs)}</span>
                </div>
                {item.isCurrent && (
                  <div className="h-1 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-red-500 rounded-full" style={{ width: `${item.progressPercent}%` }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-card">
        <div className="px-4 py-2.5 border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ListVideo className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Broadcast Queue</h2>
            {totalSecs > 0 && (
              <Badge variant="outline" className="text-xs">
                <Clock className="w-3 h-3 mr-1" />
                {fmtTotalTime(totalSecs)}
              </Badge>
            )}
          </div>
          <span className="text-xs text-muted-foreground">{queue.length} video{queue.length !== 1 ? "s" : ""} · loops continuously</span>
        </div>

        {loading ? (
          <div className="p-3 space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="rounded-lg border bg-card/50 p-3 flex items-center gap-3">
                <Skeleton className="w-20 h-12 rounded" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
            ))}
          </div>
        ) : queue.length === 0 ? (
          <div className="p-12 text-center">
            <Radio className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="font-medium text-muted-foreground">No videos in broadcast queue</p>
            <p className="text-sm text-muted-foreground/60 mt-1">
              Add videos from your library to start the continuous broadcast
            </p>
            <Button className="mt-4" onClick={() => setShowAddDialog(true)}>
              <Plus className="w-4 h-4 mr-1" />
              Add First Video
            </Button>
          </div>
        ) : (
          <div className="p-3 space-y-2">
            {queue.map((item, index) => {
              const isCurrent = current?.item?.id === item.id;
              return (
                <div
                  key={item.id}
                  className={`rounded-lg border bg-card p-3 flex items-center gap-3 transition-all ${
                    isCurrent ? "border-red-500/40 bg-red-500/5 shadow-sm" : "hover:bg-muted/30"
                  }`}
                >
                  <div className="text-xs text-muted-foreground font-mono w-5 text-center shrink-0">
                    {index + 1}
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      onClick={() => move(index, "up")}
                      disabled={index === 0}
                    >
                      <ChevronUp className="w-3 h-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      onClick={() => move(index, "down")}
                      disabled={index === queue.length - 1}
                    >
                      <ChevronDown className="w-3 h-3" />
                    </Button>
                  </div>

                  <div className="relative shrink-0">
                    {item.thumbnailUrl ? (
                      <img
                        src={item.thumbnailUrl}
                        alt={item.title}
                        className="w-20 h-12 object-cover rounded"
                      />
                    ) : (
                      <div className="w-20 h-12 bg-muted rounded flex items-center justify-center">
                        <Play className="w-4 h-4 text-muted-foreground" />
                      </div>
                    )}
                    {isCurrent && (
                      <div className="absolute inset-0 rounded flex items-center justify-center bg-black/50">
                        <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.title}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="secondary" className="text-xs h-5">
                        {item.videoSource === "local" ? (
                          <><HardDrive className="w-3 h-3 mr-1" />Local</>
                        ) : (
                          <><Youtube className="w-3 h-3 mr-1" />YouTube</>
                        )}
                      </Badge>
                      {isCurrent && (
                        <Badge className="text-xs h-5 bg-red-500 text-white border-0">
                          <Radio className="w-3 h-3 mr-1" />ON AIR
                        </Badge>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {editingDuration === item.id ? (
                      <div className="flex items-center gap-1">
                        <Input
                          className="h-7 w-16 text-xs"
                          value={durationInput}
                          onChange={(e) => setDurationInput(e.target.value)}
                          placeholder="min"
                          type="number"
                          min={1}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveDuration(item.id);
                            if (e.key === "Escape") setEditingDuration(null);
                          }}
                          autoFocus
                        />
                        <Button variant="default" size="sm" className="h-7 text-xs px-2" onClick={() => saveDuration(item.id)}>Save</Button>
                        <Button variant="ghost" size="sm" className="h-7 text-xs px-2" onClick={() => setEditingDuration(null)}>✕</Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() => {
                          setEditingDuration(item.id);
                          setDurationInput(String(Math.round(item.durationSecs / 60)));
                        }}
                      >
                        <Clock className="w-3 h-3" />
                        {fmtDuration(item.durationSecs)}
                      </Button>
                    )}

                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => removeFromQueue(item.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={showGoLiveDialog} onOpenChange={setShowGoLiveDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Signal className="w-5 h-5 text-red-500" />
              Go Live — Override Broadcast
            </DialogTitle>
            <DialogDescription>
              Activate live mode to pre-empt the automated queue. This is for real-time live services.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label>Broadcast Title</Label>
              <Input
                value={goLiveTitle}
                onChange={(e) => setGoLiveTitle(e.target.value)}
                placeholder="e.g. Sunday Live Service — Temple TV"
              />
            </div>
            <div className="space-y-2">
              <Label>Duration (hours)</Label>
              <Input
                type="number"
                min={0.5}
                max={12}
                step={0.5}
                value={goLiveHours}
                onChange={(e) => setGoLiveHours(e.target.value)}
                placeholder="2"
              />
              <p className="text-xs text-muted-foreground">Live broadcast will automatically end after this duration.</p>
            </div>
            <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-700 dark:text-amber-400">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              This will override the automated broadcast queue for all viewers and radio listeners.
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setShowGoLiveDialog(false)}>Cancel</Button>
              <Button
                className="flex-1 bg-red-600 hover:bg-red-700 text-white"
                onClick={handleGoLive}
                disabled={goingLive || !goLiveTitle.trim()}
              >
                {goingLive ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Signal className="w-4 h-4 mr-1" />}
                Go Live Now
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Add Video to Broadcast Queue</DialogTitle>
          </DialogHeader>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search video library..."
              value={addSearch}
              onChange={(e) => setAddSearch(e.target.value)}
            />
          </div>

          <div className="overflow-y-auto flex-1 space-y-2 pr-1">
            {videoLibrary?.videos?.map((video) => {
              const alreadyAdded = queue.some((q) => q.youtubeId === video.youtubeId);
              return (
                <div
                  key={video.id}
                  className="flex items-center gap-3 rounded-lg border bg-card p-2.5"
                >
                  {video.thumbnailUrl ? (
                    <img
                      src={video.thumbnailUrl}
                      alt={video.title}
                      className="w-20 h-12 object-cover rounded"
                    />
                  ) : (
                    <div className="w-20 h-12 bg-muted rounded flex items-center justify-center">
                      <Play className="w-4 h-4 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{video.title}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Badge variant="secondary" className="text-xs h-4">
                        {video.category}
                      </Badge>
                      {(video as any).videoSource === "local" && (
                        <Badge variant="outline" className="text-xs h-4 text-blue-500 border-blue-500/30">
                          <HardDrive className="w-2.5 h-2.5 mr-1" />Local
                        </Badge>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={alreadyAdded ? "secondary" : "default"}
                    disabled={alreadyAdded || addingId === video.id}
                    onClick={() => addToQueue({
                      id: video.id,
                      youtubeId: video.youtubeId,
                      title: video.title,
                      thumbnailUrl: video.thumbnailUrl,
                      videoSource: (video as any).videoSource,
                      localVideoUrl: (video as any).localVideoUrl,
                    })}
                    className="shrink-0"
                  >
                    {addingId === video.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : alreadyAdded ? (
                      "In Queue"
                    ) : (
                      <><Plus className="w-4 h-4 mr-1" />Add</>
                    )}
                  </Button>
                </div>
              );
            })}
            {!videoLibrary?.videos?.length && (
              <p className="text-center text-sm text-muted-foreground py-8">
                No videos found. Import videos in the Video Library first.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
