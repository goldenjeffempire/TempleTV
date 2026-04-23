import { useState, useEffect, useCallback, useRef } from "react";
import { VideoUploadModal } from "@/components/VideoUploadModal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { useToast } from "@/hooks/use-toast";
import { getAdminEventSourceUrl } from "@/lib/admin-access";
import {
  Radio, Trash2, Plus, ChevronUp, ChevronDown, Clock, Play,
  Loader2, Search, HardDrive, Youtube, RefreshCw, Tv, Signal,
  Mic, SkipForward, AlertCircle, Timer, Bell, BellOff, XCircle,
  CheckCircle2, Upload, Wifi, WifiOff, Activity, Zap, Video,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
type BroadcastItem = {
  id: string;
  videoId: string | null;
  youtubeId: string | null;
  title: string;
  thumbnailUrl: string | null;
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
  liveOverride?: {
    id: string;
    title: string;
    startedAt: string;
    endsAt: string | null;
    elapsedSecs: number | null;
    remainingSecs: number | null;
  } | null;
};

type LiveStatus = {
  isLive: boolean;
  deviceCount: number;
  ytLive: boolean;
  ytVideoId: string | null;
  ytTitle: string | null;
  liveOverride: {
    id: string;
    title: string;
    startedAt: string;
    endsAt: string | null;
    elapsedSecs: number | null;
    remainingSecs: number | null;
  } | null;
};

type LibraryVideo = {
  id: string;
  youtubeId: string | null;
  title: string;
  thumbnailUrl: string | null;
  duration: string | null;
  category: string | null;
  videoSource: string;
};

type SseState = "connecting" | "connected" | "reconnecting" | "offline";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDuration(secs: number): string {
  if (!secs || secs < 0) return "0:00";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtHMS(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtWallClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function parseDurationSecs(dur: string | null): number {
  if (!dur) return 0;
  const n = parseInt(dur, 10);
  if (!isNaN(n)) return n;
  const iso = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (iso) {
    return (parseInt(iso[1] ?? "0") * 3600) +
      (parseInt(iso[2] ?? "0") * 60) +
      parseInt(iso[3] ?? "0");
  }
  return 0;
}

async function adminFetch(url: string, opts?: RequestInit): Promise<Response> {
  const token = window.localStorage.getItem("temple-tv-admin-token")?.trim();
  const headers: Record<string, string> = { ...(opts?.headers as Record<string, string>) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(url, { ...opts, headers });
}

// ─── Constants ────────────────────────────────────────────────────────────────
const SERVICE_PRESETS = [
  { label: "Morning Service", icon: "☀️" },
  { label: "Evening Service", icon: "🌙" },
  { label: "Youth Service", icon: "✨" },
  { label: "Prayer Meeting", icon: "🙏" },
  { label: "Special Program", icon: "🎙️" },
  { label: "Revival / Conference", icon: "🔥" },
];

const DURATION_PRESETS = [
  { label: "30 min", value: 30 },
  { label: "1 hr", value: 60 },
  { label: "1.5 hr", value: 90 },
  { label: "2 hr", value: 120 },
  { label: "3 hr", value: 180 },
  { label: "4 hr", value: 240 },
];

const EXTEND_PRESETS = [
  { label: "+15m", value: 15 },
  { label: "+30m", value: 30 },
  { label: "+1hr", value: 60 },
];

// ─── Live Clock ───────────────────────────────────────────────────────────────
function LiveClock() {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="font-mono tabular-nums text-sm">
      {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </span>
  );
}

// ─── Now Playing Card ─────────────────────────────────────────────────────────
function NowPlayingCard({
  current,
  livePosition,
}: {
  current: CurrentBroadcast | null;
  livePosition: number;
}) {
  const override = current?.liveOverride;
  const item = current?.item;
  const totalSecs = current?.totalSecs ?? 1;

  if (!current) {
    return (
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Activity className="w-4 h-4" />
          Now Playing
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="w-20 h-14 rounded" />
          <div className="space-y-2 flex-1">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
        <Skeleton className="h-1.5 w-full rounded-full" />
      </div>
    );
  }

  if (override) {
    const elapsed = override.elapsedSecs ?? 0;
    const remaining = override.remainingSecs;
    const total = (elapsed + (remaining ?? 0)) || 1;
    const progress = Math.min(100, (elapsed / total) * 100);

    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
            </span>
            <span className="text-sm font-semibold text-red-600">LIVE</span>
          </div>
          {remaining != null && (
            <span className="text-xs text-muted-foreground font-mono">{fmtHMS(remaining)} remaining</span>
          )}
        </div>
        <div>
          <p className="font-semibold text-base leading-tight">{override.title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Started {new Date(override.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {override.endsAt && ` · Ends ${new Date(override.endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
          </p>
        </div>
        <Progress value={progress} className="h-1.5" />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Activity className="w-4 h-4" />
          <span>Queue is empty — nothing playing</span>
        </div>
      </div>
    );
  }

  const progress = totalSecs > 0 ? Math.min(100, (livePosition / totalSecs) * 100) : 0;
  const remaining = Math.max(0, totalSecs - livePosition);

  return (
    <div className="rounded-xl border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
          </span>
          <span className="text-sm font-medium text-emerald-600">On Air</span>
        </div>
        <span className="text-xs text-muted-foreground font-mono">{fmtHMS(livePosition)} / {fmtHMS(totalSecs)}</span>
      </div>

      <div className="flex gap-3">
        {item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt=""
            className="w-[88px] h-14 object-cover rounded border border-border shrink-0"
          />
        ) : (
          <div className="w-[88px] h-14 rounded border border-border bg-muted flex items-center justify-center shrink-0">
            <Video className="w-5 h-5 text-muted-foreground/40" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm leading-tight line-clamp-2">{item.title}</p>
          <div className="flex items-center gap-2 mt-1">
            {item.videoSource === "youtube"
              ? <Youtube className="w-3 h-3 text-red-500" />
              : <HardDrive className="w-3 h-3 text-indigo-500" />
            }
            <span className="text-xs text-muted-foreground font-mono">{fmtHMS(remaining)} left</span>
          </div>
        </div>
      </div>

      <Progress value={progress} className="h-1.5" />

      {current.nextItem && (
        <div className="flex items-center gap-2 pt-1 border-t border-dashed">
          <SkipForward className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground truncate">
            Up next: <span className="text-foreground">{current.nextItem.title}</span>
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Live Override Panel ──────────────────────────────────────────────────────
function LiveOverridePanel({
  liveStatus,
  onGoLive,
  onEndLive,
  onExtend,
  onNotify,
}: {
  liveStatus: LiveStatus | null;
  onGoLive: () => void;
  onEndLive: () => void;
  onExtend: (minutes: number) => void;
  onNotify: () => void;
}) {
  const override = liveStatus?.liveOverride;
  const [extendLoading, setExtendLoading] = useState<number | null>(null);

  async function handleExtend(minutes: number) {
    setExtendLoading(minutes);
    try { await onExtend(minutes); } finally { setExtendLoading(null); }
  }

  if (!override) {
    return (
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium flex items-center gap-2">
            <Mic className="w-4 h-4 text-muted-foreground" />
            Live Broadcast Control
          </span>
          <Badge variant="outline" className="text-[10px] py-0 text-muted-foreground">Auto</Badge>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Currently streaming the automated broadcast queue. Start a live override to pre-empt with a manual broadcast.
        </p>
        <Button size="sm" className="w-full" onClick={onGoLive}>
          <Radio className="w-4 h-4 mr-2 text-red-400" />
          Go Live Now
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold text-red-600 flex items-center gap-2">
          <Radio className="w-4 h-4 animate-pulse" />
          Live Override Active
        </span>
        {override.remainingSecs != null && (
          <span className="text-xs font-mono text-muted-foreground">{fmtHMS(override.remainingSecs)} left</span>
        )}
      </div>
      <p className="text-sm font-medium mb-1">{override.title}</p>
      {override.endsAt && (
        <p className="text-xs text-muted-foreground mb-3">
          Ends at {new Date(override.endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {EXTEND_PRESETS.map((p) => (
          <Button
            key={p.value}
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => handleExtend(p.value)}
            disabled={extendLoading === p.value}
          >
            {extendLoading === p.value ? <Loader2 className="w-3 h-3 animate-spin" /> : p.label}
          </Button>
        ))}
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onNotify}>
          <Bell className="w-3 h-3 mr-1" />
          Notify
        </Button>
      </div>
      <Button variant="destructive" size="sm" className="w-full" onClick={onEndLive}>
        <XCircle className="w-4 h-4 mr-2" />
        End Live & Resume Queue
      </Button>
    </div>
  );
}

// ─── Broadcast Guide ──────────────────────────────────────────────────────────
function BroadcastGuide({ queue, positionSecs }: { queue: BroadcastItem[]; positionSecs: number }) {
  const activeItems = queue.filter((i) => i.isActive);
  if (activeItems.length === 0) return null;

  const totalCycle = activeItems.reduce((s, i) => s + i.durationSecs, 0);
  if (totalCycle === 0) return null;

  const nowMs = Date.now();
  const posMs = positionSecs * 1000;
  const totalMs = totalCycle * 1000;

  const cyclePositionMs = posMs % totalMs;
  let accMs = 0;
  let currentIdx = 0;
  let offsetInCurrentMs = 0;
  for (let i = 0; i < activeItems.length; i++) {
    const itemMs = activeItems[i].durationSecs * 1000;
    if (cyclePositionMs < accMs + itemMs) {
      currentIdx = i;
      offsetInCurrentMs = cyclePositionMs - accMs;
      break;
    }
    accMs += itemMs;
  }

  const guideItems = [];
  let wallMs = nowMs - offsetInCurrentMs;
  for (let j = 0; j < Math.min(activeItems.length, 8); j++) {
    const idx = (currentIdx + j) % activeItems.length;
    const item = activeItems[idx];
    guideItems.push({ item, startMs: wallMs, isCurrent: j === 0 });
    wallMs += item.durationSecs * 1000;
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-sm font-medium flex items-center gap-2 mb-3">
        <Timer className="w-4 h-4 text-muted-foreground" />
        Broadcast Guide
        <span className="ml-auto text-xs text-muted-foreground font-normal">
          {fmtDuration(totalCycle)} cycle
        </span>
      </p>
      <div className="space-y-1">
        {guideItems.map(({ item, startMs, isCurrent }) => (
          <div
            key={`${item.id}-${startMs}`}
            className={`flex items-center gap-2.5 py-1.5 px-2 rounded-md text-xs ${isCurrent ? "bg-primary/10 font-medium" : "text-muted-foreground"}`}
          >
            <span className="font-mono w-11 shrink-0">{fmtWallClock(new Date(startMs))}</span>
            <span className="truncate flex-1">{item.title}</span>
            <span className="font-mono shrink-0">{fmtDuration(item.durationSecs)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Queue Item ───────────────────────────────────────────────────────────────
function QueueItem({
  item,
  index,
  total,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onRemove,
  onDurationEdit,
  wallClockStart,
}: {
  item: BroadcastItem;
  index: number;
  total: number;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onDurationEdit: (durationSecs: number) => void;
  wallClockStart: Date;
}) {
  const [editingDuration, setEditingDuration] = useState(false);
  const [durationInput, setDurationInput] = useState("");

  function startEdit() {
    const m = Math.floor(item.durationSecs / 60);
    const s = item.durationSecs % 60;
    setDurationInput(s > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${m}`);
    setEditingDuration(true);
  }

  function commitEdit() {
    setEditingDuration(false);
    const parts = durationInput.trim().split(":").map(Number);
    let secs = 0;
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      secs = parts[0] * 60 + parts[1];
    } else if (parts.length === 1 && !isNaN(parts[0])) {
      secs = parts[0] * 60;
    }
    if (secs > 0 && secs !== item.durationSecs) {
      onDurationEdit(secs);
    }
  }

  return (
    <div className={`group flex items-center gap-3 px-3 py-2.5 rounded-lg border bg-card transition-colors hover:bg-muted/40 ${!item.isActive ? "opacity-50" : ""}`}>
      {/* Position */}
      <span className="text-xs text-muted-foreground w-5 text-center shrink-0 tabular-nums">{index + 1}</span>

      {/* Thumbnail */}
      {item.thumbnailUrl ? (
        <img
          src={item.thumbnailUrl}
          alt=""
          className="w-[60px] h-9 object-cover rounded border border-border shrink-0"
        />
      ) : (
        <div className="w-[60px] h-9 rounded border border-border bg-muted flex items-center justify-center shrink-0">
          <Video className="w-3.5 h-3.5 text-muted-foreground/40" />
        </div>
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate leading-tight">{item.title}</p>
        <div className="flex items-center gap-2 mt-0.5">
          {item.videoSource === "youtube"
            ? <Youtube className="w-3 h-3 text-red-400 shrink-0" />
            : <HardDrive className="w-3 h-3 text-indigo-400 shrink-0" />
          }
          <button
            className="text-xs text-muted-foreground font-mono hover:text-foreground hover:underline transition-colors"
            onClick={startEdit}
            title="Click to edit duration"
          >
            {editingDuration ? (
              <input
                autoFocus
                className="w-16 text-xs font-mono bg-transparent border-b border-primary outline-none"
                value={durationInput}
                onChange={(e) => setDurationInput(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit();
                  if (e.key === "Escape") setEditingDuration(false);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              fmtDuration(item.durationSecs)
            )}
          </button>
          <span className="text-[10px] text-muted-foreground/60">@ {fmtWallClock(wallClockStart)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={isFirst}
          onClick={onMoveUp}
          title="Move up"
        >
          <ChevronUp className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={isLast}
          onClick={onMoveDown}
          title="Move down"
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={onRemove}
          title="Remove from queue"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ─── Add from Library Dialog ──────────────────────────────────────────────────
function AddFromLibraryDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdd: (video: LibraryVideo) => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [querySearch, setQuerySearch] = useState("");
  const [videos, setVideos] = useState<LibraryVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fetchVideos = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "30" });
      if (q) params.set("search", q);
      const res = await adminFetch(`/api/admin/videos?${params}`);
      if (res.ok) {
        const data = await res.json();
        setVideos(data.videos ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) fetchVideos(querySearch);
  }, [open, querySearch, fetchVideos]);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setQuerySearch(value), 350);
  };

  async function handleAdd(video: LibraryVideo) {
    setAddingId(video.id);
    try {
      await onAdd(video);
    } finally {
      setAddingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setSearch(""); setQuerySearch(""); } onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="flex items-center gap-2">
            <Plus className="w-5 h-5" />
            Add from Library
          </DialogTitle>
          <DialogDescription>Search and add videos to the broadcast queue.</DialogDescription>
        </DialogHeader>
        <div className="px-6 pt-4 pb-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              className="pl-9"
              placeholder="Search videos…"
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              autoFocus
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-2 min-h-0 space-y-1">
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-2">
                <Skeleton className="w-14 h-9 rounded" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))
          ) : videos.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {querySearch ? "No videos found" : "Search for a video to add"}
            </div>
          ) : (
            videos.map((video) => (
              <div
                key={video.id}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors"
              >
                {video.thumbnailUrl ? (
                  <img src={video.thumbnailUrl} alt="" className="w-14 h-9 object-cover rounded border border-border shrink-0" />
                ) : (
                  <div className="w-14 h-9 rounded border border-border bg-muted shrink-0 flex items-center justify-center">
                    <Video className="w-3.5 h-3.5 text-muted-foreground/40" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{video.title}</p>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {video.videoSource === "youtube" ? <Youtube className="w-3 h-3 text-red-400" /> : <HardDrive className="w-3 h-3 text-indigo-400" />}
                    {video.category && <span className="capitalize">{video.category}</span>}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 h-7"
                  onClick={() => handleAdd(video)}
                  disabled={addingId === video.id}
                >
                  {addingId === video.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                </Button>
              </div>
            ))
          )}
        </div>
        <div className="px-6 py-4 border-t">
          <Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Go Live Dialog ───────────────────────────────────────────────────────────
function GoLiveDialog({
  open,
  onOpenChange,
  onGoLive,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onGoLive: (title: string, durationMins: number, notify: boolean) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [durationMins, setDurationMins] = useState(120);
  const [customDuration, setCustomDuration] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const [notify, setNotify] = useState(true);
  const [loading, setLoading] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);

  function handlePreset(preset: { label: string; icon: string }) {
    setTitle(`${preset.icon} ${preset.label}`);
    setSelectedPreset(preset.label);
  }

  async function handleSubmit() {
    const mins = useCustom ? (parseInt(customDuration, 10) || 0) : durationMins;
    if (!title.trim() || mins <= 0) return;
    setLoading(true);
    try {
      await onGoLive(title.trim(), mins, notify);
      onOpenChange(false);
      setTitle("");
      setSelectedPreset(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Radio className="w-5 h-5 text-red-500" />
            Go Live
          </DialogTitle>
          <DialogDescription>Override the broadcast queue with a manual live event.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Service Preset</Label>
            <div className="flex flex-wrap gap-1.5">
              {SERVICE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => handlePreset(p)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${selectedPreset === p.label ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted border-border"}`}
                >
                  {p.icon} {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="live-title">Broadcast Title</Label>
            <Input
              id="live-title"
              value={title}
              onChange={(e) => { setTitle(e.target.value); setSelectedPreset(null); }}
              placeholder="e.g. Sunday Morning Service"
            />
          </div>
          <div className="space-y-2">
            <Label>Duration</Label>
            {!useCustom && (
              <div className="flex flex-wrap gap-1.5">
                {DURATION_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => setDurationMins(p.value)}
                    className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${durationMins === p.value ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted border-border"}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Switch checked={useCustom} onCheckedChange={setUseCustom} id="custom-dur" />
              <Label htmlFor="custom-dur" className="cursor-pointer text-sm font-normal">Custom duration</Label>
            </div>
            {useCustom && (
              <Input
                type="number"
                min={1}
                max={720}
                placeholder="Minutes (e.g. 90)"
                value={customDuration}
                onChange={(e) => setCustomDuration(e.target.value)}
              />
            )}
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="go-live-notify" className="text-sm">Notify viewers</Label>
              <p className="text-xs text-muted-foreground">Send push notification to mobile &amp; TV users</p>
            </div>
            <Switch id="go-live-notify" checked={notify} onCheckedChange={setNotify} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            disabled={loading || !title.trim() || (useCustom ? !customDuration : false)}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Radio className="w-4 h-4 mr-2" />}
            Go Live
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Broadcast() {
  // ── core state ─────────────────────────────────────────────────────────────
  const [queue, setQueue] = useState<BroadcastItem[]>([]);
  const [current, setCurrent] = useState<CurrentBroadcast | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sseState, setSseState] = useState<SseState>("connecting");
  const [livePosition, setLivePosition] = useState(0);

  // ── dialog state ───────────────────────────────────────────────────────────
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showGoLiveDialog, setShowGoLiveDialog] = useState(false);
  const [showEndDialog, setShowEndDialog] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);

  // ── action state ───────────────────────────────────────────────────────────
  const [endingLive, setEndingLive] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const { toast } = useToast();
  const tickerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const sseRef = useRef<EventSource | undefined>(undefined);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reconnectAttempt = useRef(0);

  // ── data loading ───────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    try {
      const [qRes, cRes, lRes] = await Promise.all([
        adminFetch("/api/admin/broadcast"),
        adminFetch("/api/broadcast/current"),
        adminFetch("/api/admin/live"),
      ]);

      if (qRes.ok) setQueue(await qRes.json());
      if (cRes.ok) {
        const c = await cRes.json();
        setCurrent(c);
        setLivePosition(c.positionSecs ?? 0);
      }
      if (lRes.ok) setLiveStatus(await lRes.json());

      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  // ── SSE ────────────────────────────────────────────────────────────────────
  const connectSSE = useCallback(() => {
    if (sseRef.current) {
      sseRef.current.close();
    }

    const url = getAdminEventSourceUrl("/api/admin/live/events");
    const es = new EventSource(url);
    sseRef.current = es;

    es.addEventListener("open", () => {
      setSseState("connected");
      reconnectAttempt.current = 0;
    });

    es.addEventListener("broadcast-queue-updated", () => {
      loadAll();
    });

    es.addEventListener("broadcast-control-updated", () => {
      loadAll();
    });

    es.addEventListener("status", () => {
      loadAll();
    });

    es.addEventListener("override-expired", () => {
      loadAll();
      toast({ title: "Live broadcast ended", description: "Resuming automated queue." });
    });

    es.onerror = () => {
      setSseState("reconnecting");
      es.close();
      const backoff = Math.min(1000 * Math.pow(2, reconnectAttempt.current), 30000);
      reconnectAttempt.current++;
      reconnectTimer.current = setTimeout(() => {
        if (document.visibilityState !== "hidden") connectSSE();
      }, backoff);
    };
  }, [loadAll, toast]);

  // ── position ticker ────────────────────────────────────────────────────────
  useEffect(() => {
    tickerRef.current = setInterval(() => {
      setLivePosition((p) => p + 1);
    }, 1000);
    return () => clearInterval(tickerRef.current);
  }, []);

  // ── polling fallback (30s) ─────────────────────────────────────────────────
  useEffect(() => {
    pollRef.current = setInterval(loadAll, 30_000);
    return () => clearInterval(pollRef.current);
  }, [loadAll]);

  // ── initial load + SSE ─────────────────────────────────────────────────────
  useEffect(() => {
    loadAll();
    connectSSE();
    return () => {
      sseRef.current?.close();
      clearTimeout(reconnectTimer.current);
    };
  }, [loadAll, connectSSE]);

  // ── page visibility — reconnect SSE when tab becomes visible ───────────────
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible" && sseState !== "connected") {
        reconnectAttempt.current = 0;
        connectSSE();
        loadAll();
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [sseState, connectSSE, loadAll]);

  // ── queue operations ───────────────────────────────────────────────────────
  const handleAddFromLibrary = useCallback(async (video: LibraryVideo) => {
    const res = await adminFetch("/api/admin/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: video.id }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    toast({ title: "Added to queue", description: video.title });
    await loadAll();
  }, [toast, loadAll]);

  const handleRemove = useCallback(async (id: string) => {
    setRemovingId(id);
    try {
      const res = await adminFetch(`/api/admin/broadcast/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setQueue((q) => q.filter((i) => i.id !== id));
    } catch (e) {
      toast({ title: "Remove failed", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    } finally {
      setRemovingId(null);
    }
  }, [toast]);

  const handleReorder = useCallback(async (id: string, direction: "up" | "down") => {
    const idx = queue.findIndex((i) => i.id === id);
    if (idx === -1) return;
    if (direction === "up" && idx === 0) return;
    if (direction === "down" && idx === queue.length - 1) return;

    const newQueue = [...queue];
    const swap = direction === "up" ? idx - 1 : idx + 1;
    [newQueue[idx], newQueue[swap]] = [newQueue[swap], newQueue[idx]];
    setQueue(newQueue);

    try {
      const res = await adminFetch("/api/admin/broadcast/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: newQueue.map((i) => i.id) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      toast({ title: "Reorder failed", variant: "destructive" });
      await loadAll();
    }
  }, [queue, toast, loadAll]);

  const handleDurationEdit = useCallback(async (id: string, durationSecs: number) => {
    setQueue((q) => q.map((i) => i.id === id ? { ...i, durationSecs } : i));
    try {
      const res = await adminFetch(`/api/admin/broadcast/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ durationSecs }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      toast({ title: "Duration update failed", variant: "destructive" });
      await loadAll();
    }
  }, [toast, loadAll]);

  const handleClearQueue = useCallback(async () => {
    setClearConfirm(false);
    const ids = [...queue.map((i) => i.id)];
    for (const id of ids) {
      await adminFetch(`/api/admin/broadcast/${id}`, { method: "DELETE" }).catch(() => {});
    }
    setQueue([]);
    toast({ title: "Queue cleared" });
  }, [queue, toast]);

  // ── live controls ──────────────────────────────────────────────────────────
  const handleGoLive = useCallback(async (title: string, durationMins: number, notify: boolean) => {
    const res = await adminFetch("/api/admin/live/override/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, durationMins, sendPushNotification: notify }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    toast({ title: "Now live!", description: title });
    await loadAll();
  }, [toast, loadAll]);

  const handleEndLive = useCallback(async () => {
    setShowEndDialog(false);
    setEndingLive(true);
    try {
      const res = await adminFetch("/api/admin/live/override/stop", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Live ended", description: "Resuming automated broadcast queue." });
      await loadAll();
    } catch (e) {
      toast({ title: "Failed to end live", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    } finally {
      setEndingLive(false);
    }
  }, [toast, loadAll]);

  const handleExtendLive = useCallback(async (minutes: number) => {
    const res = await adminFetch("/api/admin/live/override/extend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ durationMins: minutes }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast({ title: `Extended by ${minutes} minutes` });
    await loadAll();
  }, [toast, loadAll]);

  const handleSendNotification = useCallback(async () => {
    const override = liveStatus?.liveOverride;
    if (!override) return;
    const res = await adminFetch("/api/admin/notifications/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "📺 Live Now", body: override.title }),
    });
    if (res.ok) toast({ title: "Notification sent" });
    else toast({ title: "Notification failed", variant: "destructive" });
  }, [liveStatus, toast]);

  // ── derived values ─────────────────────────────────────────────────────────
  const totalQueueSecs = queue.filter((i) => i.isActive).reduce((s, i) => s + i.durationSecs, 0);
  const isLive = !!liveStatus?.liveOverride;

  // ── wall clock start times for guide ──────────────────────────────────────
  const wallClockStarts = (() => {
    const starts: Date[] = [];
    const now = new Date();
    let acc = 0;
    for (const item of queue) {
      const posInCycle = livePosition % (totalQueueSecs || 1);
      let elapsed = acc - posInCycle;
      if (elapsed < 0) elapsed += totalQueueSecs || 0;
      starts.push(new Date(now.getTime() + elapsed * 1000 - (livePosition % (item.durationSecs || 1)) * 1000));
      acc += item.durationSecs;
    }
    return starts;
  })();

  // ── SSE indicator ──────────────────────────────────────────────────────────
  const SseIndicator = () => {
    switch (sseState) {
      case "connected":
        return <div className="flex items-center gap-1.5 text-xs text-emerald-600"><Wifi className="w-3 h-3" /><span>Live</span></div>;
      case "reconnecting":
        return <div className="flex items-center gap-1.5 text-xs text-amber-500"><Loader2 className="w-3 h-3 animate-spin" /><span>Reconnecting…</span></div>;
      default:
        return <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><WifiOff className="w-3 h-3" /><span>Offline</span></div>;
    }
  };

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b bg-background sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Tv className="w-5 h-5 text-primary" />
              Broadcast Control
            </h1>
            <div className="flex items-center gap-3 mt-0.5">
              <SseIndicator />
              <span className="text-muted-foreground text-xs">·</span>
              <LiveClock />
              {liveStatus?.deviceCount != null && (
                <>
                  <span className="text-muted-foreground text-xs">·</span>
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Signal className="w-3 h-3" />
                    {liveStatus.deviceCount} viewer{liveStatus.deviceCount !== 1 ? "s" : ""}
                  </span>
                </>
              )}
            </div>
          </div>
          {isLive && (
            <Badge className="bg-red-500 text-white animate-pulse ml-2">LIVE</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={loadAll} title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </Button>
          {isLive ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowEndDialog(true)}
              disabled={endingLive}
            >
              {endingLive ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <XCircle className="w-4 h-4 mr-2" />}
              End Live
            </Button>
          ) : (
            <Button size="sm" onClick={() => setShowGoLiveDialog(true)} className="bg-red-600 hover:bg-red-700 text-white">
              <Radio className="w-4 h-4 mr-2" />
              Go Live
            </Button>
          )}
        </div>
      </div>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-5 gap-6 p-6">
          <div className="lg:col-span-2 space-y-4">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
          </div>
          <div className="lg:col-span-3">
            <Skeleton className="h-10 mb-4 rounded-lg" />
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
            </div>
          </div>
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <AlertCircle className="w-10 h-10 text-destructive/60 mx-auto" />
            <p className="font-medium">Failed to load broadcast data</p>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button onClick={loadAll} variant="outline">
              <RefreshCw className="w-4 h-4 mr-2" />
              Retry
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-5 gap-6 p-6 overflow-auto">

          {/* ── Left Panel ───────────────────────────────────────────────── */}
          <div className="lg:col-span-2 space-y-4">
            <NowPlayingCard current={current} livePosition={livePosition} />

            <LiveOverridePanel
              liveStatus={liveStatus}
              onGoLive={() => setShowGoLiveDialog(true)}
              onEndLive={() => setShowEndDialog(true)}
              onExtend={handleExtendLive}
              onNotify={handleSendNotification}
            />

            <BroadcastGuide queue={queue} positionSecs={livePosition} />
          </div>

          {/* ── Right Panel (Queue) ───────────────────────────────────────── */}
          <div className="lg:col-span-3 flex flex-col gap-3">
            {/* Queue header */}
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-sm">Broadcast Queue</h2>
                <p className="text-xs text-muted-foreground">
                  {queue.length} item{queue.length !== 1 ? "s" : ""}
                  {totalQueueSecs > 0 && ` · ${fmtDuration(totalQueueSecs)} cycle`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {queue.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-destructive hover:text-destructive text-xs"
                    onClick={() => setClearConfirm(true)}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                    Clear All
                  </Button>
                )}
                <Button variant="outline" size="sm" className="h-8" onClick={() => setShowUploadModal(true)}>
                  <Upload className="w-3.5 h-3.5 mr-1.5" />
                  Upload
                </Button>
                <Button size="sm" className="h-8" onClick={() => setShowAddDialog(true)}>
                  <Plus className="w-3.5 h-3.5 mr-1.5" />
                  Add from Library
                </Button>
              </div>
            </div>

            {/* Queue list */}
            {queue.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center py-16 text-center border-2 border-dashed rounded-xl">
                <Radio className="w-10 h-10 text-muted-foreground/30 mb-3" />
                <p className="font-medium text-sm text-muted-foreground mb-1">Queue is empty</p>
                <p className="text-xs text-muted-foreground mb-4">Add videos to start the automated broadcast</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setShowAddDialog(true)}>
                    <Plus className="w-4 h-4 mr-2" />
                    Add from Library
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowUploadModal(true)}>
                    <Upload className="w-4 h-4 mr-2" />
                    Upload Video
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                {queue.map((item, idx) => (
                  <QueueItem
                    key={item.id}
                    item={item}
                    index={idx}
                    total={queue.length}
                    isFirst={idx === 0}
                    isLast={idx === queue.length - 1}
                    onMoveUp={() => handleReorder(item.id, "up")}
                    onMoveDown={() => handleReorder(item.id, "down")}
                    onRemove={() => handleRemove(item.id)}
                    onDurationEdit={(secs) => handleDurationEdit(item.id, secs)}
                    wallClockStart={wallClockStarts[idx] ?? new Date()}
                  />
                ))}

                {/* Queue footer */}
                <div className="pt-2 pb-1 px-3 flex items-center justify-between text-xs text-muted-foreground border-t">
                  <span>{queue.length} item{queue.length !== 1 ? "s" : ""}</span>
                  <span className="font-mono">{fmtDuration(totalQueueSecs)} total cycle</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Modals / Dialogs ─────────────────────────────────────────────── */}
      <VideoUploadModal
        open={showUploadModal}
        onOpenChange={setShowUploadModal}
        broadcastMode
        storageKey="ttv-broadcast-upload-v1"
        onUploadsComplete={() => {
          loadAll();
          setTimeout(loadAll, 2000);
        }}
      />

      <AddFromLibraryDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onAdd={handleAddFromLibrary}
      />

      <GoLiveDialog
        open={showGoLiveDialog}
        onOpenChange={setShowGoLiveDialog}
        onGoLive={handleGoLive}
      />

      <AlertDialog open={showEndDialog} onOpenChange={setShowEndDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End live broadcast?</AlertDialogTitle>
            <AlertDialogDescription>
              The manual live override will end and the automated broadcast queue will resume.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleEndLive}
            >
              End Live
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={clearConfirm} onOpenChange={setClearConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear entire queue?</AlertDialogTitle>
            <AlertDialogDescription>
              All {queue.length} items will be removed from the broadcast queue. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleClearQueue}
            >
              Clear Queue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
