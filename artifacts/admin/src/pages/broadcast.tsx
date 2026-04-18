import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { getAdminEventSourceUrl } from "@/lib/admin-access";
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
  SmartphoneIcon,
  Timer,
  Bell,
  BellOff,
  XCircle,
  CheckCircle2,
} from "lucide-react";

/* ─────────────────────────────── types ──────────────────────────── */
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
  liveOverride?: {
    id: string;
    title: string;
    startedAt: string;
    endsAt: string | null;
  } | null;
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

/* ─────────────────────────────── helpers ────────────────────────── */
function fmtDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
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

function fmtTotalTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m cycle`;
  return `${m}m cycle`;
}

function fmtWallClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtEndPreview(durationMinutes: number): string {
  const end = new Date(Date.now() + durationMinutes * 60 * 1000);
  return end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ─────────────────────────────── LiveClock ─────────────────────── */
function LiveClock() {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="font-mono text-sm tabular-nums">
      {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </span>
  );
}

/* ─────────────────────────────── presets ───────────────────────── */
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
  { label: "+ 15 min", value: 15 },
  { label: "+ 30 min", value: 30 },
  { label: "+ 1 hr", value: 60 },
];

/* ─────────────────────────────── component ─────────────────────── */
export default function Broadcast() {
  const [queue, setQueue] = useState<BroadcastItem[]>([]);
  const [current, setCurrent] = useState<CurrentBroadcast | null>(null);
  const [guide, setGuide] = useState<GuideItem[]>([]);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [realtimeState, setRealtimeState] = useState<"connecting" | "connected" | "reconnecting" | "offline">("connecting");
  const [lastRealtimeAt, setLastRealtimeAt] = useState<Date | null>(null);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showGoLiveDialog, setShowGoLiveDialog] = useState(false);
  const [showEndDialog, setShowEndDialog] = useState(false);

  const [addSearch, setAddSearch] = useState("");
  const [addingId, setAddingId] = useState<string | null>(null);
  const [editingDuration, setEditingDuration] = useState<string | null>(null);
  const [durationInput, setDurationInput] = useState("");

  // Go Live form state
  const [glTitle, setGlTitle] = useState("");
  const [glDuration, setGlDuration] = useState(120);
  const [glCustomDuration, setGlCustomDuration] = useState("");
  const [glUseCustom, setGlUseCustom] = useState(false);
  const [glNotify, setGlNotify] = useState(true);
  const [glPreset, setGlPreset] = useState<string | null>(null);
  const [goingLive, setGoingLive] = useState(false);
  const [endingLive, setEndingLive] = useState(false);
  const [extendingLive, setExtendingLive] = useState(false);
  const [sendingNotif, setSendingNotif] = useState(false);

  // Live countdown ticker
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Local position ticker for on-air panel
  const [livePosition, setLivePosition] = useState(0);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { toast } = useToast();
  const { data: videoLibrary } = useListAdminVideos({ search: addSearch, limit: 50 });

  /* ── data loading ────────────────────────────────────────────── */
  const loadAll = useCallback(async () => {
    try {
      const [qRes, cRes, gRes, lRes] = await Promise.all([
        fetch("/api/admin/broadcast"),
        fetch("/api/broadcast/current"),
        fetch("/api/broadcast/guide"),
        fetch("/api/admin/live"),
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
      if (lRes.ok) {
        const ls = await lRes.json();
        setLiveStatus(ls);
        if (ls.liveOverride?.remainingSecs != null) {
          setCountdown(ls.liveOverride.remainingSecs);
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
    const interval = setInterval(loadAll, 30000);
    return () => clearInterval(interval);
  }, [loadAll]);

  /* ── SSE real-time live status ───────────────────────────────── */
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let destroyed = false;

    const connect = () => {
      if (destroyed) return;
      try {
        setRealtimeState(attempt > 0 ? "reconnecting" : "connecting");
        es = new EventSource(getAdminEventSourceUrl("/api/admin/live/events"));

        es.addEventListener("status", (e: MessageEvent) => {
          try {
            const ls = JSON.parse(e.data) as LiveStatus;
            setLiveStatus(ls);
            setLastRealtimeAt(new Date());
            if (ls.liveOverride?.remainingSecs != null) {
              setCountdown(ls.liveOverride.remainingSecs);
            } else if (!ls.liveOverride) {
              setCountdown(null);
            }
            attempt = 0;
          } catch {}
        });

        es.addEventListener("override-expired", () => {
          setLastRealtimeAt(new Date());
          loadAll();
        });

        es.addEventListener("broadcast-queue-updated", () => {
          setLastRealtimeAt(new Date());
          loadAll();
        });

        es.addEventListener("broadcast-current-updated", (e: MessageEvent) => {
          try {
            const payload = JSON.parse(e.data);
            if (payload?.current) {
              setCurrent(payload.current);
              setLivePosition(payload.current.positionSecs ?? 0);
            }
          } catch {}
          setLastRealtimeAt(new Date());
          loadAll();
        });

        es.addEventListener("broadcast-schedule-updated", () => {
          setLastRealtimeAt(new Date());
          loadAll();
        });

        es.addEventListener("broadcast-control-updated", () => {
          setLastRealtimeAt(new Date());
          loadAll();
        });

        es.onopen = () => {
          attempt = 0;
          setRealtimeState("connected");
        };

        es.onerror = () => {
          es?.close();
          es = null;
          if (destroyed) return;
          setRealtimeState("reconnecting");
          const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
          attempt++;
          reconnectTimer = setTimeout(connect, delay);
        };
      } catch {}
    };

    connect();

    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      setRealtimeState("offline");
    };
  }, [loadAll]);

  // Position ticker
  useEffect(() => {
    if (tickerRef.current) clearInterval(tickerRef.current);
    if (current?.item && !current.liveOverride) {
      tickerRef.current = setInterval(() => setLivePosition((p) => p + 1), 1000);
    }
    return () => { if (tickerRef.current) clearInterval(tickerRef.current); };
  }, [current?.item?.id, !!current?.liveOverride]);

  // Countdown ticker for live override
  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (liveStatus?.liveOverride?.remainingSecs != null) {
      countdownRef.current = setInterval(() => setCountdown((c) => (c !== null ? Math.max(0, c - 1) : null)), 1000);
    } else {
      setCountdown(null);
    }
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [liveStatus?.liveOverride?.id]);

  /* ── actions ─────────────────────────────────────────────────── */
  const handleGoLive = async () => {
    const finalTitle = glTitle.trim();
    if (!finalTitle) {
      toast({ title: "Please enter a broadcast title", variant: "destructive" });
      return;
    }
    const mins = glUseCustom
      ? Math.max(5, Math.min(480, parseInt(glCustomDuration, 10) || 120))
      : glDuration;

    setGoingLive(true);
    try {
      const res = await fetch("/api/admin/live/override/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: finalTitle, durationMinutes: mins, notify: glNotify }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? "Failed to go live");
      }
      const data = await res.json();
      toast({
        title: "🔴 You're LIVE!",
        description: glNotify && data.push?.sent > 0
          ? `Push notifications sent to ${data.push.sent} device${data.push.sent !== 1 ? "s" : ""}`
          : "Live broadcast started — no push tokens registered yet",
      });
      setShowGoLiveDialog(false);
      await loadAll();
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "Failed to go live", variant: "destructive" });
    } finally {
      setGoingLive(false);
    }
  };

  const handleEndLive = async () => {
    setEndingLive(true);
    try {
      const res = await fetch("/api/admin/live/override/stop", { method: "POST" });
      if (!res.ok) throw new Error("Failed to end broadcast");
      toast({ title: "Live broadcast ended", description: "Automatic queue will resume." });
      setShowEndDialog(false);
      setCountdown(null);
      await loadAll();
    } catch {
      toast({ title: "Failed to end broadcast", variant: "destructive" });
    } finally {
      setEndingLive(false);
    }
  };

  const handleExtend = async (extraMinutes: number) => {
    setExtendingLive(true);
    try {
      const res = await fetch("/api/admin/live/override/extend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extraMinutes }),
      });
      if (!res.ok) throw new Error("Failed to extend");
      const data = await res.json();
      const newEndsAt = data.override?.endsAt;
      toast({
        title: `Extended by ${extraMinutes} min`,
        description: newEndsAt
          ? `New end time: ${fmtTime(newEndsAt)}`
          : undefined,
      });
      await loadAll();
    } catch {
      toast({ title: "Failed to extend broadcast", variant: "destructive" });
    } finally {
      setExtendingLive(false);
    }
  };

  const handleNotifyViewers = async () => {
    const lo = liveStatus?.liveOverride;
    if (!lo) return;
    setSendingNotif(true);
    try {
      const res = await fetch("/api/admin/notifications/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Temple TV is LIVE now!",
          body: lo.title,
          type: "live_service",
        }),
      });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      toast({
        title: "Notifications sent",
        description: `Sent to ${data.sent ?? 0} device${(data.sent ?? 0) !== 1 ? "s" : ""}`,
      });
    } catch {
      toast({ title: "Failed to send notifications", variant: "destructive" });
    } finally {
      setSendingNotif(false);
    }
  };

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
      await loadAll();
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
      await loadAll();
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
      await loadAll();
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
      await loadAll();
    } catch {
      toast({ title: "Failed to update", variant: "destructive" });
    }
  };

  /* ── derived values ───────────────────────────────────────────── */
  const totalSecs = queue.reduce((acc, i) => acc + i.durationSecs, 0);
  const isOnAir = !!liveStatus?.isLive;
  const hasLiveOverride = !!liveStatus?.liveOverride;
  const lo = liveStatus?.liveOverride;
  const currentProgress = current?.item
    ? Math.min(100, (livePosition / current.item.durationSecs) * 100)
    : 0;
  const remaining = current?.item ? Math.max(0, current.item.durationSecs - livePosition) : 0;
  const liveDurationSecs = lo
    ? Math.max(0, new Date(lo.endsAt ?? lo.startedAt).getTime() - new Date(lo.startedAt).getTime()) / 1000
    : 0;
  const liveProgress = lo && liveDurationSecs > 0 && countdown !== null
    ? Math.min(100, Math.max(0, ((liveDurationSecs - countdown) / liveDurationSecs) * 100))
    : 0;

  /* ── effective duration for go live dialog ────────────────────── */
  const effectiveDuration = glUseCustom
    ? Math.max(5, parseInt(glCustomDuration, 10) || 120)
    : glDuration;

  return (
    <div className="space-y-5">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Tv className="w-6 h-6" />
            Broadcast Control
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            24/7 continuous channel — manage your on-air lineup and live events
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/50 border text-sm">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isOnAir ? "bg-red-500 animate-pulse" : "bg-muted-foreground/40"}`} />
            <LiveClock />
            {liveStatus?.deviceCount != null && liveStatus.deviceCount > 0 && (
              <span className="text-xs text-muted-foreground border-l pl-2 ml-1">
                <SmartphoneIcon className="w-3 h-3 inline mr-1" />{liveStatus.deviceCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/40 border text-xs">
            <div className={`w-2 h-2 rounded-full ${
              realtimeState === "connected"
                ? "bg-green-500"
                : realtimeState === "reconnecting"
                  ? "bg-yellow-500 animate-pulse"
                  : "bg-muted-foreground/40"
            }`} />
            <span className="capitalize">{realtimeState}</span>
            {lastRealtimeAt && (
              <span className="text-muted-foreground border-l pl-2">
                update {lastRealtimeAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={loadAll}>
            <RefreshCw className="w-4 h-4" />
          </Button>
          {hasLiveOverride ? (
            <Button size="sm" variant="destructive" onClick={() => setShowEndDialog(true)}>
              <Signal className="w-4 h-4 mr-1.5" />
              End Live
            </Button>
          ) : (
            <Button
              size="sm"
              className="bg-red-600 hover:bg-red-700 text-white shadow-sm"
              onClick={() => setShowGoLiveDialog(true)}
            >
              <Mic className="w-4 h-4 mr-1.5" />
              Go Live
            </Button>
          )}
          <Button size="sm" onClick={() => setShowAddDialog(true)}>
            <Plus className="w-4 h-4 mr-1.5" />
            Add Video
          </Button>
        </div>
      </div>

      {/* ── YouTube live detection banner ── */}
      {liveStatus?.ytLive && !hasLiveOverride && (
        <div className="rounded-xl border border-yellow-500/40 bg-yellow-500/5 p-4 flex items-center gap-3">
          <Youtube className="w-5 h-5 text-yellow-600 dark:text-yellow-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-yellow-700 dark:text-yellow-300">YouTube Live Detected</p>
            <p className="text-xs text-muted-foreground truncate">{liveStatus.ytTitle}</p>
          </div>
          <Button size="sm" variant="outline" className="border-yellow-500/40 text-yellow-700 dark:text-yellow-300"
            onClick={() => {
              setGlTitle(liveStatus.ytTitle ?? "Temple TV Live Service");
              setShowGoLiveDialog(true);
            }}>
            <Signal className="w-3.5 h-3.5 mr-1" />
            Go Live Now
          </Button>
        </div>
      )}

      {/* ── LIVE STATUS PANEL ── */}
      {hasLiveOverride && lo && (
        <div className="rounded-xl border-2 border-red-500/50 bg-red-500/5 overflow-hidden">
          {/* Top bar */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-red-500/10 border-b border-red-500/20">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 bg-red-500 text-white px-2.5 py-1 rounded-full text-xs font-bold tracking-wide">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-white"></span>
                </span>
                LIVE ON AIR
              </div>
              <span className="text-sm font-semibold truncate max-w-xs">{lo.title}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {liveStatus?.deviceCount != null && (
                <span className="flex items-center gap-1">
                  <SmartphoneIcon className="w-3.5 h-3.5" />
                  {liveStatus.deviceCount} registered device{liveStatus.deviceCount !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>

          {/* Main content */}
          <div className="p-4 space-y-3">
            {/* Times row */}
            <div className="flex items-center gap-6 text-sm">
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Started</p>
                <p className="font-mono font-semibold">{fmtTime(lo.startedAt)}</p>
              </div>
              {lo.endsAt && (
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Scheduled End</p>
                  <p className="font-mono font-semibold">{fmtTime(lo.endsAt)}</p>
                </div>
              )}
              {lo.elapsedSecs != null && (
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">On Air For</p>
                  <p className="font-mono font-semibold text-green-600 dark:text-green-400">{fmtHMS(lo.elapsedSecs)}</p>
                </div>
              )}
              {countdown !== null && (
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Remaining</p>
                  <p className={`font-mono font-bold tabular-nums ${countdown < 300 ? "text-red-500" : "text-foreground"}`}>
                    {fmtHMS(countdown)}
                  </p>
                </div>
              )}
            </div>

            {/* Progress bar */}
            {lo.endsAt && liveDurationSecs > 0 && (
              <div className="space-y-1">
                <div className="h-2 bg-red-500/15 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-red-500 rounded-full transition-all duration-1000"
                    style={{ width: `${liveProgress}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>{Math.round(liveProgress)}% elapsed</span>
                  <span>{fmtDuration(liveDurationSecs)} total</span>
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-2 flex-wrap pt-1">
              {EXTEND_PRESETS.map((p) => (
                <Button
                  key={p.value}
                  size="sm"
                  variant="outline"
                  className="text-xs h-8"
                  disabled={extendingLive}
                  onClick={() => handleExtend(p.value)}
                >
                  {extendingLive ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Timer className="w-3 h-3 mr-1" />}
                  {p.label}
                </Button>
              ))}
              <Button
                size="sm"
                variant="outline"
                className="text-xs h-8"
                disabled={sendingNotif}
                onClick={handleNotifyViewers}
              >
                {sendingNotif
                  ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" />
                  : <Bell className="w-3 h-3 mr-1.5" />}
                Notify Viewers
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="text-xs h-8 ml-auto"
                onClick={() => setShowEndDialog(true)}
              >
                <XCircle className="w-3.5 h-3.5 mr-1.5" />
                End Live Broadcast
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── On Air Now (automatic queue) ── */}
      {current?.item && !hasLiveOverride && (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="px-4 py-2.5 bg-muted/30 border-b flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 bg-red-500/15 text-red-500 px-2.5 py-1 rounded-full text-xs font-bold border border-red-500/25">
                <Radio className="w-3 h-3" />
                ON AIR — AUTOMATED
              </div>
              <span className="text-xs text-muted-foreground">
                {(current.index ?? 0) + 1} of {queue.length} · {fmtTotalTime(totalSecs)}
              </span>
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Headphones className="w-3.5 h-3.5" />
              Radio mirror active
            </div>
          </div>
          <div className="p-4 flex items-start gap-4">
            <div className="relative shrink-0">
              {current.item.thumbnailUrl ? (
                <img src={current.item.thumbnailUrl} alt="" className="w-32 h-20 object-cover rounded-lg shadow-sm" />
              ) : (
                <div className="w-32 h-20 bg-muted rounded-lg flex items-center justify-center">
                  <Play className="w-6 h-6 text-muted-foreground" />
                </div>
              )}
              <div className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-red-500 border-2 border-background animate-pulse" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-base truncate">{current.item.title}</p>
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                <span className="text-green-600 dark:text-green-400 font-medium">{fmtDuration(livePosition)} elapsed</span>
                <span>·</span>
                <span>{fmtDuration(remaining)} remaining</span>
                <Badge variant="secondary" className="text-xs h-4 ml-1">
                  {current.item.videoSource === "local"
                    ? <><HardDrive className="w-3 h-3 mr-1" />Local</>
                    : <><Youtube className="w-3 h-3 mr-1" />YouTube</>}
                </Badge>
              </div>
              <div className="mt-2.5 space-y-1">
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>{Math.round(currentProgress)}% complete</span>
                  <span>{fmtDuration(current.item.durationSecs)} total</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-red-500 rounded-full transition-all duration-1000" style={{ width: `${currentProgress}%` }} />
                </div>
              </div>
            </div>
            {current.nextItem && (
              <div className="shrink-0 hidden md:block w-32">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
                  <SkipForward className="w-3 h-3" />Up Next
                </p>
                {current.nextItem.thumbnailUrl && (
                  <img src={current.nextItem.thumbnailUrl} alt="" className="w-full h-16 object-cover rounded opacity-60 mb-1" />
                )}
                <p className="text-xs text-muted-foreground line-clamp-2 leading-tight">{current.nextItem.title}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── EPG Program Guide ── */}
      {guide.length > 1 && !hasLiveOverride && (
        <div className="rounded-xl border bg-card">
          <div className="px-4 py-2.5 border-b flex items-center gap-2">
            <Calendar className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Program Guide</h2>
            <span className="text-xs text-muted-foreground ml-1">Next {Math.min(8, guide.length)} programs</span>
          </div>
          <div className="p-3 flex gap-2 overflow-x-auto pb-4 scrollbar-thin">
            {guide.slice(0, 8).map((item, idx) => (
              <div
                key={`${item.id}-${idx}`}
                className={`shrink-0 w-40 rounded-lg border p-2 space-y-1.5 ${item.isCurrent ? "border-red-500/40 bg-red-500/5" : "bg-muted/20"}`}
              >
                <div className="relative">
                  {item.thumbnailUrl ? (
                    <img src={item.thumbnailUrl} alt="" className="w-full h-[72px] object-cover rounded" />
                  ) : (
                    <div className="w-full h-[72px] bg-muted rounded flex items-center justify-center">
                      <Play className="w-5 h-5 text-muted-foreground" />
                    </div>
                  )}
                  {item.isCurrent && (
                    <div className="absolute inset-0 rounded flex items-center justify-center bg-black/40">
                      <div className="flex items-center gap-1 text-white text-[10px] font-bold bg-red-500 px-2 py-0.5 rounded-full">
                        <Radio className="w-2.5 h-2.5" />ON AIR
                      </div>
                    </div>
                  )}
                </div>
                <p className="text-xs font-medium line-clamp-2 leading-tight">{item.title}</p>
                <div className="flex justify-between text-[10px] text-muted-foreground">
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

      {/* ── Broadcast Queue ── */}
      <div className="rounded-xl border bg-card">
        <div className="px-4 py-2.5 border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ListVideo className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Broadcast Queue</h2>
            {totalSecs > 0 && (
              <Badge variant="outline" className="text-xs">
                <Clock className="w-3 h-3 mr-1" />{fmtTotalTime(totalSecs)}
              </Badge>
            )}
          </div>
          <span className="text-xs text-muted-foreground">{queue.length} video{queue.length !== 1 ? "s" : ""} · loops continuously</span>
        </div>

        {loading ? (
          <div className="p-3 space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-lg border">
                <Skeleton className="w-20 h-12 rounded shrink-0" />
                <div className="flex-1 space-y-2"><Skeleton className="h-4 w-48" /><Skeleton className="h-3 w-24" /></div>
              </div>
            ))}
          </div>
        ) : queue.length === 0 ? (
          <div className="p-12 text-center">
            <Radio className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-30" />
            <p className="font-medium text-muted-foreground">No videos in broadcast queue</p>
            <p className="text-sm text-muted-foreground/60 mt-1">Add videos to start the 24/7 automatic broadcast</p>
            <Button className="mt-4" onClick={() => setShowAddDialog(true)}>
              <Plus className="w-4 h-4 mr-1" />Add First Video
            </Button>
          </div>
        ) : (
          <div className="p-3 space-y-1.5">
            {queue.map((item, index) => {
              const isCurrent = current?.item?.id === item.id && !hasLiveOverride;
              return (
                <div
                  key={item.id}
                  className={`rounded-lg border p-3 flex items-center gap-3 transition-all ${isCurrent ? "border-red-500/40 bg-red-500/5 shadow-sm" : "bg-card hover:bg-muted/20"}`}
                >
                  <span className="text-xs text-muted-foreground font-mono w-5 text-center shrink-0">{index + 1}</span>
                  <div className="flex flex-col gap-0.5">
                    <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => move(index, "up")} disabled={index === 0}>
                      <ChevronUp className="w-3 h-3" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => move(index, "down")} disabled={index === queue.length - 1}>
                      <ChevronDown className="w-3 h-3" />
                    </Button>
                  </div>
                  <div className="relative shrink-0">
                    {item.thumbnailUrl ? (
                      <img src={item.thumbnailUrl} alt="" className="w-20 h-12 object-cover rounded" />
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
                        {item.videoSource === "local"
                          ? <><HardDrive className="w-3 h-3 mr-1" />Local</>
                          : <><Youtube className="w-3 h-3 mr-1" />YouTube</>}
                      </Badge>
                      {isCurrent && (
                        <Badge className="text-xs h-5 bg-red-500 text-white border-0">
                          <Radio className="w-3 h-3 mr-1" />ON AIR
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
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
                        <Button variant="default" size="sm" className="h-7 text-xs px-2" onClick={() => saveDuration(item.id)}>✓</Button>
                        <Button variant="ghost" size="sm" className="h-7 text-xs px-2" onClick={() => setEditingDuration(null)}>✕</Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() => { setEditingDuration(item.id); setDurationInput(String(Math.round(item.durationSecs / 60))); }}
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

      {/* ════════════════ GO LIVE DIALOG ════════════════ */}
      <Dialog open={showGoLiveDialog} onOpenChange={(o) => { if (!goingLive) setShowGoLiveDialog(o); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-red-500/15 text-red-500">
                <Signal className="w-4 h-4" />
              </span>
              Start Live Broadcast
            </DialogTitle>
            <DialogDescription>
              This pre-empts the automated queue for all viewers and radio listeners.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            {/* Service type presets */}
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Quick Presets</Label>
              <div className="grid grid-cols-3 gap-1.5">
                {SERVICE_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => {
                      setGlPreset(p.label);
                      setGlTitle(p.label);
                    }}
                    className={`text-left px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                      glPreset === p.label
                        ? "border-red-500 bg-red-500/10 text-red-600 dark:text-red-400"
                        : "border-border bg-muted/30 hover:bg-muted/60 text-foreground"
                    }`}
                  >
                    <span className="mr-1">{p.icon}</span>{p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Title */}
            <div className="space-y-1.5">
              <Label htmlFor="gl-title">Broadcast Title</Label>
              <Input
                id="gl-title"
                value={glTitle}
                onChange={(e) => { setGlTitle(e.target.value); setGlPreset(null); }}
                placeholder="e.g. Sunday Morning Service — Temple TV"
              />
            </div>

            {/* Duration */}
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Duration</Label>
              <div className="flex gap-1.5 flex-wrap">
                {DURATION_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => { setGlDuration(p.value); setGlUseCustom(false); }}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                      !glUseCustom && glDuration === p.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-muted/30 hover:bg-muted/60"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setGlUseCustom(true)}
                  className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                    glUseCustom ? "border-primary bg-primary/10 text-primary" : "border-border bg-muted/30 hover:bg-muted/60"
                  }`}
                >
                  Custom
                </button>
              </div>
              {glUseCustom && (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={5}
                    max={480}
                    placeholder="Minutes"
                    value={glCustomDuration}
                    onChange={(e) => setGlCustomDuration(e.target.value)}
                    className="w-32 h-8 text-sm"
                    autoFocus
                  />
                  <span className="text-sm text-muted-foreground">minutes</span>
                </div>
              )}
            </div>

            {/* End time preview */}
            <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-muted/30 border text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="w-4 h-4" />
                <span>Starts now · ends ~</span>
              </div>
              <span className="font-mono font-semibold text-foreground">{fmtEndPreview(effectiveDuration)}</span>
            </div>

            {/* Notify toggle */}
            <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-muted/20 border">
              <div className="flex items-center gap-2.5">
                {glNotify ? <Bell className="w-4 h-4 text-primary" /> : <BellOff className="w-4 h-4 text-muted-foreground" />}
                <div>
                  <p className="text-sm font-medium">Notify viewers</p>
                  <p className="text-xs text-muted-foreground">
                    Push notification to {liveStatus?.deviceCount ?? 0} registered device{(liveStatus?.deviceCount ?? 0) !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
              <Switch checked={glNotify} onCheckedChange={setGlNotify} />
            </div>

            {/* Warning */}
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-500/8 border border-amber-500/25 text-xs text-amber-700 dark:text-amber-400">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              The automated broadcast queue and radio mirror will pause until you end this live session.
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowGoLiveDialog(false)} disabled={goingLive}>
              Cancel
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white min-w-[120px]"
              onClick={handleGoLive}
              disabled={goingLive || !glTitle.trim()}
            >
              {goingLive
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Starting…</>
                : <><Signal className="w-4 h-4 mr-2" />Go Live Now</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ════════════════ END LIVE CONFIRMATION ════════════════ */}
      <Dialog open={showEndDialog} onOpenChange={(o) => { if (!endingLive) setShowEndDialog(o); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>End Live Broadcast?</DialogTitle>
            <DialogDescription>
              {lo?.title && <><strong>"{lo.title}"</strong> will be stopped.<br /></>}
              The automated broadcast queue will resume immediately for all viewers.
            </DialogDescription>
          </DialogHeader>
          {lo && (
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-muted/30 border text-sm">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
              <div>
                <p className="font-medium">{lo.title}</p>
                <p className="text-xs text-muted-foreground">
                  Started {fmtTime(lo.startedAt)}
                  {lo.elapsedSecs != null ? ` · ${fmtHMS(lo.elapsedSecs)} on air` : ""}
                </p>
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowEndDialog(false)} disabled={endingLive}>Keep Broadcasting</Button>
            <Button variant="destructive" onClick={handleEndLive} disabled={endingLive} className="min-w-[110px]">
              {endingLive
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Ending…</>
                : <><XCircle className="w-4 h-4 mr-2" />End Live</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ════════════════ ADD VIDEO DIALOG ════════════════ */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Add Video to Broadcast Queue</DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search video library..." value={addSearch} onChange={(e) => setAddSearch(e.target.value)} />
          </div>
          <div className="overflow-y-auto flex-1 space-y-2 pr-1">
            {videoLibrary?.videos?.map((video) => {
              const alreadyAdded = queue.some((q) => q.youtubeId === video.youtubeId);
              return (
                <div key={video.id} className="flex items-center gap-3 rounded-lg border bg-card p-2.5">
                  {video.thumbnailUrl ? (
                    <img src={video.thumbnailUrl} alt="" className="w-20 h-12 object-cover rounded shrink-0" />
                  ) : (
                    <div className="w-20 h-12 bg-muted rounded flex items-center justify-center shrink-0">
                      <Play className="w-4 h-4 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{video.title}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Badge variant="secondary" className="text-xs h-4">{video.category}</Badge>
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
                    {addingId === video.id
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : alreadyAdded
                      ? <><CheckCircle2 className="w-3.5 h-3.5 mr-1" />In Queue</>
                      : <><Plus className="w-4 h-4 mr-1" />Add</>}
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
