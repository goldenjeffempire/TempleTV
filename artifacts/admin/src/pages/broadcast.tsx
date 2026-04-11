import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  index: number;
  positionSecs: number;
  totalSecs: number;
  queueLength: number;
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

export default function Broadcast() {
  const [queue, setQueue] = useState<BroadcastItem[]>([]);
  const [current, setCurrent] = useState<CurrentBroadcast | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [addingId, setAddingId] = useState<string | null>(null);
  const [editingDuration, setEditingDuration] = useState<string | null>(null);
  const [durationInput, setDurationInput] = useState("");
  const { toast } = useToast();

  const { data: videoLibrary } = useListAdminVideos({ search: addSearch, limit: 50 });

  const loadQueue = useCallback(async () => {
    try {
      const [qRes, cRes] = await Promise.all([
        fetch("/api/admin/broadcast"),
        fetch("/api/broadcast/current"),
      ]);
      if (qRes.ok) setQueue(await qRes.json());
      if (cRes.ok) setCurrent(await cRes.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQueue();
    const interval = setInterval(loadQueue, 30000);
    return () => clearInterval(interval);
  }, [loadQueue]);

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

  const totalSecs = queue.reduce((acc, i) => acc + i.durationSecs, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Broadcast Queue</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Continuous broadcast — videos loop automatically based on schedule
          </p>
        </div>
        <div className="flex items-center gap-2">
          {totalSecs > 0 && (
            <Badge variant="outline" className="text-xs">
              <Clock className="w-3 h-3 mr-1" />
              {fmtTotalTime(totalSecs)}
            </Badge>
          )}
          <Button size="sm" variant="outline" onClick={loadQueue}>
            <RefreshCw className="w-4 h-4 mr-1" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowAddDialog(true)}>
            <Plus className="w-4 h-4 mr-1" />
            Add Video
          </Button>
        </div>
      </div>

      {current?.item && (
        <div className="rounded-xl border bg-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex items-center gap-1.5 bg-red-500/10 text-red-500 px-2.5 py-1 rounded-full text-xs font-semibold border border-red-500/20 animate-pulse">
              <Radio className="w-3 h-3" />
              ON AIR NOW
            </div>
            <span className="text-xs text-muted-foreground">
              {fmtDuration(current.positionSecs)} in · {queue.length} items in queue
            </span>
          </div>
          <div className="flex items-center gap-3">
            {current.item.thumbnailUrl ? (
              <img
                src={current.item.thumbnailUrl}
                alt={current.item.title}
                className="w-24 h-14 object-cover rounded-md"
              />
            ) : (
              <div className="w-24 h-14 bg-muted rounded-md flex items-center justify-center">
                <Play className="w-5 h-5 text-muted-foreground" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm truncate">{current.item.title}</p>
              <div className="flex items-center gap-2 mt-1">
                <Badge variant="secondary" className="text-xs">
                  {current.item.videoSource === "local" ? (
                    <><HardDrive className="w-3 h-3 mr-1" />Local</>
                  ) : (
                    <><Youtube className="w-3 h-3 mr-1" />YouTube</>
                  )}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {fmtDuration(current.positionSecs)} / {fmtDuration(current.item.durationSecs)}
                </span>
              </div>
              <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-red-500 rounded-full transition-all"
                  style={{ width: `${Math.min(100, (current.positionSecs / current.item.durationSecs) * 100)}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-lg border bg-card p-3 flex items-center gap-3">
              <Skeleton className="w-20 h-12 rounded" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      ) : queue.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed bg-card/50 p-12 text-center">
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
        <div className="space-y-2">
          {queue.map((item, index) => {
            const isCurrent = current?.item?.id === item.id;
            return (
              <div
                key={item.id}
                className={`rounded-lg border bg-card p-3 flex items-center gap-3 transition-all ${
                  isCurrent ? "border-red-500/40 bg-red-500/5 shadow-sm" : ""
                }`}
              >
                <div className="flex flex-col gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => move(index, "up")}
                    disabled={index === 0}
                  >
                    <ChevronUp className="w-3 h-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => move(index, "down")}
                    disabled={index === queue.length - 1}
                  >
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </div>

                <div className="relative">
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
                        <Radio className="w-3 h-3 mr-1" />
                        ON AIR
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
                      <Button
                        variant="default"
                        size="sm"
                        className="h-7 text-xs px-2"
                        onClick={() => saveDuration(item.id)}
                      >
                        Save
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs px-2"
                        onClick={() => setEditingDuration(null)}
                      >
                        ✕
                      </Button>
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
