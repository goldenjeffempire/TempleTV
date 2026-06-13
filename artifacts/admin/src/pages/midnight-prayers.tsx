import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
import { uploadQueue, useUploadQueue, titleFromFilename, formatBytes } from "@/lib/upload-queue";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Moon,
  Clock,
  Film,
  RefreshCw,
  Play,
  Globe,
  Settings,
  AlertCircle,
  CheckCircle2,
  Timer,
  SkipForward,
  UploadCloud,
  Search,
  Edit2,
  Trash2,
  RotateCcw,
  Loader2,
  Activity,
  Archive,
  Zap,
  X,
  ShieldAlert,
  FileVideo,
  Music,
  Info,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface MPConfig {
  enabled: boolean;
  startHour: number;
  endHour: number;
  timezone: string;
  updatedAt: string;
}

interface VideoRow {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  duration: string | null;
  category: string | null;
  preacher: string | null;
  description: string;
  transcodingStatus: string;
  transcodingErrorMessage: string | null;
  transcodingErrorCode: string | null;
  hlsMasterUrl: string | null;
  localVideoUrl: string | null;
  sourceAvailable: boolean | null;
  sizeBytes: number | null;
  importedAt: string;
}

interface LibraryResponse {
  videos: VideoRow[];
  total: number;
  totalPages: number;
  page: number;
  limit: number;
}

interface MPQueueResponse {
  config: MPConfig;
  videos: { id: string; title: string; thumbnailUrl: string | null; durationSecs: number }[];
  totalVideos: number;
  totalDurationSecs: number;
  cycleLengthHours: number;
}

interface MPStateResponse {
  state: {
    mode: string;
    current: { title: string; durationSecs: number; startsAtMs: number; endsAtMs: number } | null;
    next: { title: string; durationSecs: number } | null;
    meta: { totalVideos: number; cycleLengthMs: number };
  };
}

interface DiagnosticsResponse {
  total: number;
  playable: number;
  encoding: number;
  failed: number;
  queued: number;
  inRotation: number;
  deadAirRisk: boolean;
  statusCounts: Record<string, number>;
  config: MPConfig;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TIMEZONES = [
  { value: "Africa/Lagos",        label: "Lagos (WAT, UTC+1)" },
  { value: "Africa/Abidjan",      label: "Abidjan (GMT, UTC+0)" },
  { value: "Africa/Accra",        label: "Accra (GMT, UTC+0)" },
  { value: "Africa/Nairobi",      label: "Nairobi (EAT, UTC+3)" },
  { value: "Africa/Johannesburg", label: "Johannesburg (SAST, UTC+2)" },
  { value: "America/New_York",    label: "New York (EST/EDT)" },
  { value: "America/Chicago",     label: "Chicago (CST/CDT)" },
  { value: "America/Los_Angeles", label: "Los Angeles (PST/PDT)" },
  { value: "America/Sao_Paulo",   label: "São Paulo (BRT)" },
  { value: "Europe/London",       label: "London (GMT/BST)" },
  { value: "Europe/Paris",        label: "Paris (CET/CEST)" },
  { value: "Asia/Dubai",          label: "Dubai (GST, UTC+4)" },
  { value: "Asia/Kolkata",        label: "India (IST, UTC+5:30)" },
  { value: "Asia/Singapore",      label: "Singapore (SGT, UTC+8)" },
  { value: "Asia/Tokyo",          label: "Tokyo (JST, UTC+9)" },
  { value: "Australia/Sydney",    label: "Sydney (AEST/AEDT)" },
  { value: "UTC",                 label: "UTC" },
];

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label:
    i === 0  ? "12:00 AM (Midnight)" :
    i < 12   ? `${i}:00 AM` :
    i === 12 ? "12:00 PM (Noon)" :
               `${i - 12}:00 PM`,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function parseDurationSecs(d: string | null | undefined): number {
  if (!d) return 0;
  const n = parseInt(d, 10);
  return isNaN(n) ? 0 : n;
}

function isCurrentlyInWindow(startHour: number, endHour: number): boolean {
  const hour = new Date().getHours();
  if (endHour > startHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function TranscodingBadge({ status, error }: { status: string; error?: string | null }) {
  switch (status) {
    case "hls_ready":
    case "ready":
      return (
        <Badge className="bg-green-500/10 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800 gap-1 shrink-0">
          <Zap className="h-2.5 w-2.5" />HLS Ready
        </Badge>
      );
    case "encoding":
    case "processing":
      return (
        <Badge className="bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800 gap-1 shrink-0">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />Encoding
        </Badge>
      );
    case "queued":
      return (
        <Badge className="bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800 gap-1 shrink-0">
          <Clock className="h-2.5 w-2.5" />Queued
        </Badge>
      );
    case "failed":
      return (
        <Badge
          className="bg-red-500/10 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800 gap-1 shrink-0 cursor-help"
          title={error ?? "Transcoding failed"}
        >
          <AlertCircle className="h-2.5 w-2.5" />Failed
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="shrink-0 text-xs">
          {status || "Pending"}
        </Badge>
      );
  }
}

function UploadStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "uploading":
      return <Badge className="bg-blue-500/10 text-blue-700 border-blue-200 shrink-0">Uploading</Badge>;
    case "finalizing":
      return <Badge className="bg-indigo-500/10 text-indigo-700 border-indigo-200 shrink-0">Processing</Badge>;
    case "paused":
      return <Badge variant="outline" className="shrink-0">Paused</Badge>;
    case "failed":
      return <Badge className="bg-red-500/10 text-red-700 border-red-200 shrink-0">Failed</Badge>;
    case "pending":
      return <Badge variant="outline" className="shrink-0">Pending</Badge>;
    default:
      return <Badge variant="outline" className="shrink-0">{status}</Badge>;
  }
}

function StatCard({
  title,
  value,
  icon: Icon,
  color = "default",
  subtitle,
}: {
  title: string;
  value: number | string;
  icon: React.ElementType;
  color?: "default" | "green" | "blue" | "yellow" | "red";
  subtitle?: string;
}) {
  const colors = {
    default: "text-muted-foreground",
    green:   "text-green-600 dark:text-green-400",
    blue:    "text-blue-600 dark:text-blue-400",
    yellow:  "text-yellow-600 dark:text-yellow-400",
    red:     "text-red-600 dark:text-red-400",
  };
  return (
    <div className="flex flex-col gap-1 p-4 rounded-lg border bg-card">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground font-medium">{title}</p>
        <Icon className={`h-4 w-4 ${colors[color]}`} />
      </div>
      <p className={`text-2xl font-bold ${colors[color]}`}>{value}</p>
      {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function MidnightPrayersPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  // ── Tab + UI state ──────────────────────────────────────────────────────────
  const [tab, setTab] = useState("library");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [localHour, setLocalHour] = useState(() => new Date().getHours());

  // ── Edit modal state ────────────────────────────────────────────────────────
  const [editVideo, setEditVideo] = useState<VideoRow | null>(null);
  const [editForm, setEditForm] = useState({ title: "", preacher: "", description: "" });

  // ── Delete/remove dialog state ──────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  // ── Config state ────────────────────────────────────────────────────────────
  const [pendingConfig, setPendingConfig] = useState<Partial<MPConfig>>({});

  // ── Upload queue integration ────────────────────────────────────────────────
  const { items: allUploadItems } = useUploadQueue();
  const mpUploads = allUploadItems.filter(
    (item) =>
      item.category === "midnight-prayers" &&
      item.status !== "completed" &&
      item.status !== "cancelled",
  );

  // ── Debounce search ─────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  // ── Local clock ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setLocalHour(new Date().getHours()), 15_000);
    return () => clearInterval(t);
  }, []);

  // ── Auto-refresh library when any upload completes ──────────────────────────
  useEffect(() => {
    return uploadQueue.onComplete(() => {
      void qc.invalidateQueries({ queryKey: ["mp-library"] });
      void qc.invalidateQueries({ queryKey: ["midnight-prayers/queue"] });
      void qc.invalidateQueries({ queryKey: ["midnight-prayers/diagnostics"] });
    });
  }, [qc]);

  // SSE-driven invalidation — library-updated events arrive when other tabs
  // upload or transcode videos, keeping this page's library list in sync.
  useSSEEvent("videos-library-updated", () => {
    void qc.invalidateQueries({ queryKey: ["mp-library"] });
  });
  useSSEEvent("transcoding-update", () => {
    void qc.invalidateQueries({ queryKey: ["mp-library"] });
    void qc.invalidateQueries({ queryKey: ["midnight-prayers/queue"] });
  });

  // ── Queries ─────────────────────────────────────────────────────────────────

  const { data: libraryData, isLoading: libraryLoading, refetch: refetchLibrary } = useQuery<LibraryResponse>({
    queryKey: ["mp-library", debouncedSearch],
    queryFn: () => {
      const params = new URLSearchParams({
        category: "midnight-prayers",
        source: "local",
        sort: "newest",
        limit: "200",
      });
      if (debouncedSearch) params.set("search", debouncedSearch);
      return api.get<LibraryResponse>(`/admin/videos?${params.toString()}`);
    },
    staleTime: 30_000,
  });

  const { data: queueData } = useQuery<MPQueueResponse>({
    queryKey: ["midnight-prayers/queue"],
    queryFn: () => api.get<MPQueueResponse>("/midnight-prayers/queue"),
    staleTime: 60_000,
  });

  const { data: stateData } = useQuery<MPStateResponse>({
    queryKey: ["midnight-prayers/state"],
    queryFn: () => api.get<MPStateResponse>("/midnight-prayers/state"),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  const { data: diagnostics, isLoading: diagLoading } = useQuery<DiagnosticsResponse>({
    queryKey: ["midnight-prayers/diagnostics"],
    queryFn: () => api.get<DiagnosticsResponse>("/midnight-prayers/diagnostics"),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const config = queueData?.config;
  const mergedConfig = config ? { ...config, ...pendingConfig } : undefined;
  const inWindow = mergedConfig
    ? isCurrentlyInWindow(mergedConfig.startHour, mergedConfig.endHour)
    : false;
  const hasUnsavedChanges = Object.keys(pendingConfig).length > 0;

  // ── Mutations ────────────────────────────────────────────────────────────────

  const updateConfigMutation = useMutation({
    mutationFn: (patch: Partial<MPConfig>) =>
      api.patch<MPConfig>("/midnight-prayers/config", patch),
    onSuccess: () => {
      setPendingConfig({});
      void qc.invalidateQueries({ queryKey: ["midnight-prayers/queue"] });
      void qc.invalidateQueries({ queryKey: ["midnight-prayers/state"] });
      void qc.invalidateQueries({ queryKey: ["midnight-prayers/diagnostics"] });
      toast({ title: "Schedule saved", description: "Midnight Prayers schedule updated." });
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const refreshQueueMutation = useMutation({
    mutationFn: () => api.post<{ videoCount: number }>("/midnight-prayers/queue/refresh"),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["midnight-prayers/queue"] });
      void qc.invalidateQueries({ queryKey: ["midnight-prayers/state"] });
      void qc.invalidateQueries({ queryKey: ["midnight-prayers/diagnostics"] });
      toast({ title: "Queue refreshed", description: `${data.videoCount} videos loaded.` });
    },
    onError: () => toast({ title: "Refresh failed", variant: "destructive" }),
  });

  const patchVideoMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/admin/videos/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["mp-library"] });
      void qc.invalidateQueries({ queryKey: ["midnight-prayers/queue"] });
      setEditVideo(null);
      toast({ title: "Video updated successfully." });
    },
    onError: () => toast({ title: "Update failed", variant: "destructive" }),
  });

  const deleteVideoMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/videos/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["mp-library"] });
      void qc.invalidateQueries({ queryKey: ["midnight-prayers/queue"] });
      void qc.invalidateQueries({ queryKey: ["midnight-prayers/diagnostics"] });
      setDeleteTarget(null);
      toast({ title: "Video deleted permanently." });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  const removeFromRotationMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/admin/videos/${id}`, { category: "" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["mp-library"] });
      void qc.invalidateQueries({ queryKey: ["midnight-prayers/queue"] });
      void qc.invalidateQueries({ queryKey: ["midnight-prayers/diagnostics"] });
      setDeleteTarget(null);
      toast({ title: "Removed from Midnight Prayers", description: "Video remains in the library." });
    },
    onError: () => toast({ title: "Operation failed", variant: "destructive" }),
  });

  const retryTranscodeMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/videos/${id}/transcode`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["mp-library"] });
      void qc.invalidateQueries({ queryKey: ["midnight-prayers/diagnostics"] });
      toast({ title: "Re-queued for encoding", description: "HLS transcoding will begin shortly." });
    },
    onError: () => toast({ title: "Retry failed", variant: "destructive" }),
  });

  // ── Upload handlers ──────────────────────────────────────────────────────────

  const enqueueFiles = useCallback(
    (files: File[]) => {
      const supported = files.filter(
        (f) => f.type.startsWith("video/") || f.type.startsWith("audio/"),
      );
      if (supported.length === 0) {
        toast({
          title: "No supported files",
          description: "Please select video or audio files.",
          variant: "destructive",
        });
        return;
      }
      uploadQueue.enqueue(
        supported.map((f) => ({
          file: f,
          title: titleFromFilename(f.name),
          category: "midnight-prayers",
          preacher: "",
          description: "",
          featured: false,
        })),
      );
      toast({
        title: `${supported.length} file${supported.length > 1 ? "s" : ""} queued`,
        description: "Auto-tagged as Midnight Prayers. Transcoding will start automatically.",
      });
    },
    [toast],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      enqueueFiles(Array.from(e.dataTransfer.files));
    },
    [enqueueFiles],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) enqueueFiles(files);
      e.target.value = "";
    },
    [enqueueFiles],
  );

  // ── Computed values ──────────────────────────────────────────────────────────

  const current = stateData?.state?.current;
  const next = stateData?.state?.next;
  const nowMs = Date.now();
  const progressPct = current
    ? Math.min(
        100,
        Math.max(
          0,
          ((nowMs - current.startsAtMs) / ((current.endsAtMs - current.startsAtMs) || 1)) * 100,
        ),
      )
    : 0;

  const libVideos = libraryData?.videos ?? [];
  const playableCount = libVideos.filter(
    (v) => v.transcodingStatus === "hls_ready" || v.transcodingStatus === "ready",
  ).length;
  const failedVideos = libVideos.filter((v) => v.transcodingStatus === "failed");

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 p-6">
      {/* ── Header ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Moon className="h-6 w-6 text-indigo-500" />
            Midnight Prayers
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Automated prayer broadcast active for every viewer at their local midnight.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {diagnostics?.deadAirRisk && (
            <Badge className="bg-red-500/10 text-red-700 dark:text-red-400 border-red-300 gap-1">
              <ShieldAlert className="h-3 w-3" /> Dead Air Risk
            </Badge>
          )}
          <Badge
            variant={mergedConfig?.enabled ? (inWindow ? "default" : "secondary") : "outline"}
            className={mergedConfig?.enabled && inWindow ? "bg-indigo-600 text-white animate-pulse" : ""}
          >
            {mergedConfig?.enabled
              ? inWindow
                ? "● Broadcasting Now"
                : "Scheduled"
              : "Disabled"}
          </Badge>
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────────────── */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="library" className="gap-1.5">
            <Film className="h-3.5 w-3.5" />
            Library
            {libVideos.length > 0 && (
              <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none">
                {libVideos.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="live" className="gap-1.5">
            <Play className="h-3.5 w-3.5" />
            Live
          </TabsTrigger>
          <TabsTrigger value="settings" className="gap-1.5">
            <Settings className="h-3.5 w-3.5" />
            Settings
          </TabsTrigger>
          <TabsTrigger value="diagnostics" className="gap-1.5">
            <Activity className="h-3.5 w-3.5" />
            Diagnostics
            {(diagnostics?.failed ?? 0) > 0 && (
              <span className="ml-1 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
                {diagnostics!.failed}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ══════════════════════ LIBRARY TAB ════════════════════════════════ */}
        <TabsContent value="library" className="space-y-4 mt-4">
          {/* Upload zone */}
          <Card>
            <CardContent className="pt-4">
              <div
                className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer select-none ${
                  dragOver
                    ? "border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/30"
                    : "border-muted hover:border-indigo-300 dark:hover:border-indigo-700"
                }`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
                }}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="video/*,audio/*,.mp4,.mov,.mkv,.avi,.webm,.mp3,.m4a,.aac,.wav"
                  className="hidden"
                  onChange={handleFileInput}
                />
                <div className="flex flex-col items-center gap-3">
                  <div className="h-14 w-14 rounded-full bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center">
                    <UploadCloud className="h-7 w-7 text-indigo-500" />
                  </div>
                  <div>
                    <p className="font-semibold text-base">
                      {dragOver ? "Drop to upload" : "Upload Midnight Prayers Content"}
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Drag & drop video or audio files, or click to browse
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><FileVideo className="h-3 w-3" /> MP4, MOV, MKV, AVI, WebM</span>
                    <span>·</span>
                    <span className="flex items-center gap-1"><Music className="h-3 w-3" /> MP3, AAC, WAV</span>
                    <span>·</span>
                    <span>Up to 100 GB</span>
                  </div>
                  <p className="text-xs text-indigo-600 dark:text-indigo-400">
                    Automatically tagged as Midnight Prayers · HLS transcoded · Added to rotation
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Active uploads */}
          {mpUploads.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
                  Uploading ({mpUploads.length})
                </CardTitle>
                <CardDescription className="text-xs">
                  Files are chunked and resumable. The global upload panel (bottom-right) shows full controls.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {mpUploads.map((item) => (
                  <div key={item.id} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium truncate flex-1">{item.title}</p>
                      <UploadStatusBadge status={item.status} />
                    </div>
                    <Progress
                      value={item.status === "finalizing" ? (item.assemblyPercent ?? item.progress) : item.progress}
                      className="h-1.5"
                    />
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {item.status === "uploading" && item.speedLabel
                          ? `${item.speedLabel} · ${Math.round(item.progress)}%`
                          : item.status === "finalizing"
                          ? "Assembling on server…"
                          : item.status === "paused"
                          ? "Paused — will resume automatically"
                          : item.status === "failed"
                          ? item.error ?? "Upload failed"
                          : `${Math.round(item.progress)}%`}
                      </span>
                      <span>{formatBytes(item.uploadedBytes)} / {formatBytes(item.file.size)}</span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Library list */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Film className="h-4 w-4 text-indigo-500" />
                  Content Library
                  <span className="text-sm font-normal text-muted-foreground">
                    ({libraryData?.total ?? 0} videos · {playableCount} playable)
                  </span>
                </CardTitle>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void refetchLibrary();
                      refreshQueueMutation.mutate();
                    }}
                    disabled={refreshQueueMutation.isPending}
                  >
                    <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshQueueMutation.isPending ? "animate-spin" : ""}`} />
                    Refresh
                  </Button>
                </div>
              </div>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  className="pl-8 h-8 text-sm"
                  placeholder="Search by title, preacher…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setSearch("")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {libraryLoading ? (
                <div className="space-y-2">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="h-14 rounded-md bg-muted animate-pulse" />
                  ))}
                </div>
              ) : libVideos.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground gap-3">
                  <Moon className="h-10 w-10 opacity-20" />
                  <div>
                    <p className="font-medium">
                      {debouncedSearch ? "No videos match your search" : "No Midnight Prayers content yet"}
                    </p>
                    <p className="text-sm mt-1 max-w-xs">
                      {debouncedSearch
                        ? "Try a different search term."
                        : "Upload videos above. They will be tagged, transcoded, and added to the rotation automatically."}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-1 max-h-[600px] overflow-y-auto pr-1">
                  {libVideos.map((video, idx) => (
                    <VideoListRow
                      key={video.id}
                      video={video}
                      index={idx}
                      isRetrying={retryTranscodeMutation.isPending}
                      onEdit={() => {
                        setEditVideo(video);
                        setEditForm({
                          title: video.title,
                          preacher: video.preacher ?? "",
                          description: video.description,
                        });
                      }}
                      onRetry={() => retryTranscodeMutation.mutate(video.id)}
                      onRemove={() => setDeleteTarget({ id: video.id, title: video.title })}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Failed videos callout */}
          {failedVideos.length > 0 && (
            <Card className="border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-red-700 dark:text-red-400 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4" />
                  {failedVideos.length} Video{failedVideos.length > 1 ? "s" : ""} Failed Encoding
                </CardTitle>
                <CardDescription className="text-xs text-red-600/80 dark:text-red-400/80">
                  These videos are excluded from the midnight prayers rotation until encoding succeeds.
                  Click "Retry" to re-queue each one.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {failedVideos.map((v) => (
                    <div key={v.id} className="flex items-center justify-between gap-2 p-2 rounded bg-white/60 dark:bg-black/20">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{v.title}</p>
                        {v.transcodingErrorMessage && (
                          <p className="text-xs text-red-600 dark:text-red-400 mt-0.5 truncate">
                            {v.transcodingErrorMessage}
                          </p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 shrink-0"
                        onClick={() => retryTranscodeMutation.mutate(v.id)}
                        disabled={retryTranscodeMutation.isPending}
                      >
                        <RotateCcw className="h-3 w-3 mr-1" />
                        Retry
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ══════════════════════ LIVE STATUS TAB ════════════════════════════ */}
        <TabsContent value="live" className="space-y-4 mt-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-4">
              {/* Now playing */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Play className="h-4 w-4 text-indigo-500" />
                    Live Playback Status
                  </CardTitle>
                  <CardDescription>
                    {inWindow
                      ? "Midnight Prayers is active for your local timezone right now."
                      : `Currently ${localHour}:00 local — window opens at ${mergedConfig?.startHour ?? 0}:00.`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {stateData?.state?.mode === "offline_hold" || !current ? (
                    <div className="flex items-center gap-3 p-4 rounded-lg bg-muted text-muted-foreground">
                      <AlertCircle className="h-5 w-5 shrink-0" />
                      <div>
                        <p className="font-medium text-sm">No content in rotation</p>
                        <p className="text-xs mt-0.5">
                          Upload videos in the Library tab to populate the queue.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Now Playing</p>
                        <div className="flex items-start gap-3">
                          <div className="mt-1 h-2 w-2 rounded-full bg-indigo-500 animate-pulse shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold truncate">{current.title}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatDuration(current.durationSecs)} · {Math.round(progressPct)}% complete
                            </p>
                            <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-full rounded-full bg-indigo-500 transition-all duration-1000"
                                style={{ width: `${progressPct}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      </div>

                      {next && (
                        <div className="flex items-start gap-3 opacity-60">
                          <SkipForward className="h-3.5 w-3.5 mt-1 shrink-0 text-muted-foreground" />
                          <div>
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Up Next</p>
                            <p className="text-sm truncate">{next.title}</p>
                            <p className="text-xs text-muted-foreground">{formatDuration(next.durationSecs)}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  <Separator />

                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <p className="text-2xl font-bold text-indigo-600">{queueData?.totalVideos ?? "—"}</p>
                      <p className="text-xs text-muted-foreground">In Rotation</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-indigo-600">
                        {queueData?.totalDurationSecs ? formatDuration(queueData.totalDurationSecs) : "—"}
                      </p>
                      <p className="text-xs text-muted-foreground">Total Duration</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-indigo-600">
                        {queueData?.cycleLengthHours ? `${queueData.cycleLengthHours}h` : "—"}
                      </p>
                      <p className="text-xs text-muted-foreground">Cycle</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Queue preview */}
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Film className="h-4 w-4 text-indigo-500" />
                      Rotation Order ({queueData?.totalVideos ?? 0} videos)
                    </CardTitle>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => refreshQueueMutation.mutate()}
                      disabled={refreshQueueMutation.isPending}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${refreshQueueMutation.isPending ? "animate-spin" : ""}`} />
                    </Button>
                  </div>
                  <CardDescription>
                    Videos loop continuously during the broadcast window. Order is fixed (newest first by import date).
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {!queueData?.videos?.length ? (
                    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
                      <Moon className="h-8 w-8 opacity-20" />
                      <p className="text-sm">No videos in rotation</p>
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                      {queueData.videos.map((v, idx) => (
                        <div key={v.id} className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/50">
                          <span className="text-xs text-muted-foreground w-5 text-right font-mono shrink-0">{idx + 1}</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{v.title}</p>
                            <p className="text-xs text-muted-foreground">{formatDuration(v.durationSecs)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Schedule sidebar */}
            <ScheduleCard
              mergedConfig={mergedConfig}
              config={config}
              hasUnsavedChanges={hasUnsavedChanges}
              saving={updateConfigMutation.isPending}
              patchLocal={(key, value) => setPendingConfig((p) => ({ ...p, [key]: value }))}
              onSave={() => updateConfigMutation.mutate(pendingConfig)}
            />
          </div>
        </TabsContent>

        {/* ══════════════════════ SETTINGS TAB ═══════════════════════════════ */}
        <TabsContent value="settings" className="mt-4">
          <div className="max-w-lg">
            <ScheduleCard
              mergedConfig={mergedConfig}
              config={config}
              hasUnsavedChanges={hasUnsavedChanges}
              saving={updateConfigMutation.isPending}
              patchLocal={(key, value) => setPendingConfig((p) => ({ ...p, [key]: value }))}
              onSave={() => updateConfigMutation.mutate(pendingConfig)}
              standalone
            />
          </div>
        </TabsContent>

        {/* ══════════════════════ DIAGNOSTICS TAB ════════════════════════════ */}
        <TabsContent value="diagnostics" className="space-y-4 mt-4">
          {/* Stats grid */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard title="Total Videos" value={diagLoading ? "…" : diagnostics?.total ?? 0} icon={Film} />
            <StatCard
              title="Playable (HLS)"
              value={diagLoading ? "…" : diagnostics?.playable ?? 0}
              icon={Zap}
              color="green"
              subtitle="In rotation"
            />
            <StatCard
              title="Queued / Encoding"
              value={diagLoading ? "…" : (diagnostics?.queued ?? 0) + (diagnostics?.encoding ?? 0)}
              icon={Loader2}
              color="blue"
              subtitle="Processing now"
            />
            <StatCard
              title="Failed"
              value={diagLoading ? "…" : diagnostics?.failed ?? 0}
              icon={AlertCircle}
              color={(diagnostics?.failed ?? 0) > 0 ? "red" : "default"}
              subtitle="Need retry"
            />
            <StatCard
              title="In Service"
              value={diagLoading ? "…" : diagnostics?.inRotation ?? 0}
              icon={Activity}
              color="green"
              subtitle="Live in memory"
            />
          </div>

          {/* Alerts */}
          {diagnostics?.deadAirRisk && (
            <div className="flex items-start gap-3 p-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-400">
              <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-sm">Dead Air Risk Detected</p>
                <p className="text-xs mt-1">
                  Midnight Prayers is enabled but no playable content is in rotation. Upload and transcode
                  videos to prevent a blank screen during the broadcast window.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 h-7 border-red-300 text-red-700 hover:bg-red-100 dark:hover:bg-red-900/20"
                  onClick={() => setTab("library")}
                >
                  Go to Library → Upload
                </Button>
              </div>
            </div>
          )}

          {(diagnostics?.failed ?? 0) > 0 && !diagnostics?.deadAirRisk && (
            <div className="flex items-start gap-3 p-4 rounded-lg border border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950/20 text-yellow-700 dark:text-yellow-400">
              <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-sm">{diagnostics!.failed} Encoding Failure{diagnostics!.failed > 1 ? "s" : ""}</p>
                <p className="text-xs mt-1">
                  Some videos failed to transcode and are excluded from rotation.
                  Go to the Library tab to retry them.
                </p>
              </div>
            </div>
          )}

          {!diagnostics?.deadAirRisk && (diagnostics?.playable ?? 0) > 0 && (
            <div className="flex items-start gap-3 p-4 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/20 text-green-700 dark:text-green-400">
              <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-sm">All Systems Healthy</p>
                <p className="text-xs mt-1">
                  {diagnostics!.playable} playable video{diagnostics!.playable > 1 ? "s" : ""} in
                  rotation. Queue reloads every 5 minutes and on any library update.
                </p>
              </div>
            </div>
          )}

          {/* Status breakdown table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Status Breakdown</CardTitle>
              <CardDescription className="text-xs">
                All midnight-prayers videos by transcoding state. Queue auto-refreshes when status changes.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {diagLoading ? (
                <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-8 rounded bg-muted animate-pulse" />)}</div>
              ) : !diagnostics || Object.keys(diagnostics.statusCounts).length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No videos found.</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(diagnostics.statusCounts)
                    .sort(([a], [b]) => {
                      const order = ["hls_ready", "ready", "encoding", "processing", "queued", "failed", "none"];
                      return (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b));
                    })
                    .map(([status, count]) => (
                      <div key={status} className="flex items-center gap-3">
                        <TranscodingBadge status={status} />
                        <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-indigo-400 dark:bg-indigo-600 transition-all"
                            style={{ width: `${diagnostics.total > 0 ? (count / diagnostics.total) * 100 : 0}%` }}
                          />
                        </div>
                        <span className="text-sm font-medium w-8 text-right">{count}</span>
                      </div>
                    ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Self-healing info */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Info className="h-4 w-4 text-indigo-500" />
                Self-Healing Mechanisms
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-500" />
                  <span><strong className="text-foreground">Auto-reload:</strong> Queue refreshes every 5 minutes and immediately when any video is uploaded, updated, or deleted.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-500" />
                  <span><strong className="text-foreground">Resumable uploads:</strong> Uploads persist across page reloads and browser restarts. Network outages auto-pause and auto-resume.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-500" />
                  <span><strong className="text-foreground">Transcoding retry:</strong> Failed encoding jobs can be manually re-queued from the Library tab without re-uploading.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-500" />
                  <span><strong className="text-foreground">Source preservation:</strong> Original uploaded files are retained for re-transcoding. Assembly blobs persist through server restarts.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-500" />
                  <span><strong className="text-foreground">HLS upgrade:</strong> Videos start playing as MP4 immediately after upload (faststart). HLS stream is seamlessly substituted once encoding completes.</span>
                </li>
              </ul>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Edit video dialog ─────────────────────────────────────────────────── */}
      <Dialog open={!!editVideo} onOpenChange={(open) => { if (!open) setEditVideo(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Video</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-title">Title <span className="text-destructive">*</span></Label>
              <Input
                id="edit-title"
                value={editForm.title}
                onChange={(e) => setEditForm((p) => ({ ...p, title: e.target.value }))}
                placeholder="e.g. Midnight Intercession — Week 1"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-preacher">Preacher / Speaker</Label>
              <Input
                id="edit-preacher"
                value={editForm.preacher}
                onChange={(e) => setEditForm((p) => ({ ...p, preacher: e.target.value }))}
                placeholder="e.g. Pastor Johnson"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                value={editForm.description}
                onChange={(e) => setEditForm((p) => ({ ...p, description: e.target.value }))}
                placeholder="Optional description…"
                rows={3}
                className="resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditVideo(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => patchVideoMutation.mutate({ id: editVideo!.id, body: editForm })}
              disabled={patchVideoMutation.isPending || !editForm.title.trim()}
              className="bg-indigo-600 hover:bg-indigo-700"
            >
              {patchVideoMutation.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving…</>
              ) : (
                "Save Changes"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete / remove dialog ────────────────────────────────────────────── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove "{deleteTarget?.title}"</AlertDialogTitle>
            <AlertDialogDescription>
              Choose how to remove this video from the Midnight Prayers channel.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-3 py-2">
            <button
              className="flex items-start gap-3 p-3 rounded-lg border hover:bg-muted/50 text-left transition-colors"
              onClick={() => removeFromRotationMutation.mutate(deleteTarget!.id)}
              disabled={removeFromRotationMutation.isPending || deleteVideoMutation.isPending}
            >
              <Archive className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-sm">Remove from Midnight Prayers</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Keeps the video in the general library. You can re-add it by changing its category back to "Midnight Prayers" in the Videos page.
                </p>
              </div>
              {removeFromRotationMutation.isPending && <Loader2 className="h-4 w-4 animate-spin ml-auto shrink-0 mt-0.5" />}
            </button>

            <button
              className="flex items-start gap-3 p-3 rounded-lg border border-red-200 dark:border-red-800 hover:bg-red-50/50 dark:hover:bg-red-950/20 text-left transition-colors"
              onClick={() => deleteVideoMutation.mutate(deleteTarget!.id)}
              disabled={removeFromRotationMutation.isPending || deleteVideoMutation.isPending}
            >
              <Trash2 className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-sm text-red-700 dark:text-red-400">Delete Permanently</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Removes the video, all HLS segments, and stored source file. This cannot be undone.
                </p>
              </div>
              {deleteVideoMutation.isPending && <Loader2 className="h-4 w-4 animate-spin ml-auto shrink-0 mt-0.5 text-red-600" />}
            </button>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── VideoListRow ───────────────────────────────────────────────────────────────

function VideoListRow({
  video,
  index,
  isRetrying,
  onEdit,
  onRetry,
  onRemove,
}: {
  video: VideoRow;
  index: number;
  isRetrying: boolean;
  onEdit: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const durationSecs = parseDurationSecs(video.duration);
  const isPlayable = video.transcodingStatus === "hls_ready" || video.transcodingStatus === "ready";
  const isFailed = video.transcodingStatus === "failed";

  return (
    <div className="group flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/50 transition-colors">
      {/* Index */}
      <span className="text-xs text-muted-foreground w-5 text-right font-mono shrink-0">
        {index + 1}
      </span>

      {/* Thumbnail */}
      <div className="w-14 h-9 rounded bg-muted overflow-hidden shrink-0 flex items-center justify-center">
        {video.thumbnailUrl ? (
          <img
            src={video.thumbnailUrl}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <Film className="h-4 w-4 text-muted-foreground/50" />
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{video.title}</p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {video.preacher && (
            <span className="text-xs text-muted-foreground truncate max-w-[140px]">{video.preacher}</span>
          )}
          {durationSecs > 0 && (
            <span className="text-xs text-muted-foreground">{formatDuration(durationSecs)}</span>
          )}
          {video.sizeBytes && (
            <span className="text-xs text-muted-foreground">{formatBytes(video.sizeBytes)}</span>
          )}
          <TranscodingBadge status={video.transcodingStatus} error={video.transcodingErrorMessage} />
          {isPlayable && video.hlsMasterUrl && (
            <span className="text-[10px] text-green-600 dark:text-green-400 font-medium">HLS</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Edit metadata"
          onClick={onEdit}
        >
          <Edit2 className="h-3.5 w-3.5" />
        </Button>
        {isFailed && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-yellow-600 hover:text-yellow-700 hover:bg-yellow-50 dark:hover:bg-yellow-950/20"
            title="Retry transcoding"
            onClick={onRetry}
            disabled={isRetrying}
          >
            <RotateCcw className={`h-3.5 w-3.5 ${isRetrying ? "animate-spin" : ""}`} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
          title="Remove or delete"
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ── ScheduleCard ───────────────────────────────────────────────────────────────

function ScheduleCard({
  mergedConfig,
  config,
  hasUnsavedChanges,
  saving,
  patchLocal,
  onSave,
  standalone = false,
}: {
  mergedConfig: MPConfig | undefined;
  config: MPConfig | undefined;
  hasUnsavedChanges: boolean;
  saving: boolean;
  patchLocal: (key: keyof MPConfig, value: unknown) => void;
  onSave: () => void;
  standalone?: boolean;
}) {
  return (
    <div className={standalone ? "space-y-4" : "space-y-4"}>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Settings className="h-4 w-4 text-indigo-500" />
            Schedule Configuration
          </CardTitle>
          <CardDescription>
            Controls when Midnight Prayers activates for each viewer based on their local clock.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="mp-enabled" className="font-medium">Enable Midnight Prayers</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                When off, all devices stay on the main broadcast.
              </p>
            </div>
            <Switch
              id="mp-enabled"
              checked={mergedConfig?.enabled ?? true}
              onCheckedChange={(v) => patchLocal("enabled", v)}
              disabled={!config}
            />
          </div>

          <Separator />

          {/* Start hour */}
          <div className="space-y-1.5">
            <Label className="font-medium flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" /> Start Hour
            </Label>
            <Select
              value={String(mergedConfig?.startHour ?? 0)}
              onValueChange={(v) => patchLocal("startHour", Number(v))}
              disabled={!config}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOURS.map((h) => (
                  <SelectItem key={h.value} value={h.value}>{h.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* End hour */}
          <div className="space-y-1.5">
            <Label className="font-medium flex items-center gap-1.5">
              <Timer className="h-3.5 w-3.5" /> End Hour
            </Label>
            <Select
              value={String(mergedConfig?.endHour ?? 3)}
              onValueChange={(v) => patchLocal("endHour", Number(v))}
              disabled={!config}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOURS.filter((h) => Number(h.value) >= 1).map((h) => (
                  <SelectItem key={h.value} value={h.value}>{h.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Timezone */}
          <div className="space-y-1.5">
            <Label className="font-medium flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5" /> Reference Timezone
            </Label>
            <p className="text-xs text-muted-foreground">
              Used to anchor the cycle epoch. Each viewer uses their own local clock for the window.
            </p>
            <Select
              value={mergedConfig?.timezone ?? "Africa/Lagos"}
              onValueChange={(v) => patchLocal("timezone", v)}
              disabled={!config}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {hasUnsavedChanges && (
            <Button
              className="w-full bg-indigo-600 hover:bg-indigo-700"
              onClick={onSave}
              disabled={saving}
            >
              {saving ? (
                <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Saving…</>
              ) : (
                <><CheckCircle2 className="h-4 w-4 mr-2" />Save Changes</>
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* How it works */}
      <Card className="bg-indigo-50 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-800">
        <CardContent className="pt-5 text-sm text-indigo-800 dark:text-indigo-200 space-y-2">
          <p className="font-semibold flex items-center gap-1.5">
            <Moon className="h-4 w-4" /> How it works
          </p>
          <ul className="space-y-1.5 text-xs leading-relaxed text-indigo-700 dark:text-indigo-300">
            <li>• Each viewer's device checks their local clock against the configured window.</li>
            <li>• During the window, the player switches automatically to Midnight Prayers.</li>
            <li>• All videos loop continuously until the window ends.</li>
            <li>• At end time, the main broadcast resumes seamlessly.</li>
            <li>• Viewers in different timezones each get Midnight Prayers at their local midnight.</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
