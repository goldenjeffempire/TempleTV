import { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, isTransientError} from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import {
  Youtube, RefreshCw, Search, Clock, CheckCircle2, XCircle,
  AlertCircle, ChevronLeft, ChevronRight, Eye, Film, Calendar,
  TrendingUp, Database, Loader2, WifiOff, History, UploadCloud,
  MoreVertical, Pencil, Star, StarOff, Lock, LockOpen, Trash2,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { useSSEEvent } from "@/contexts/sse-context";
import { uploadQueue } from "@/lib/upload-queue";
import { LiveStatusBadge } from "@/components/live-status-badge";

const CHANNEL_URL = "https://www.youtube.com/@TEMPLETVJCTM";

interface SyncStatus {
  lastSyncId: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncSource: string | null;
  videosFound: number | null;
  videosInserted: number | null;
  videosUpdated: number | null;
  videosSkipped: number | null;
  videosDeleted: number | null;
  errorMessage: string | null;
  totalYoutubeVideos: number;
  nextSyncAt: string | null;
  syncInProgress: boolean;
  contentWindowDays: number;
}

interface SyncResult {
  syncId: string;
  inserted: number;
  updated: number;
  total: number;
  skipped: number;
  deleted: number;
  durationMs: number;
  source: string;
}

interface SyncHistoryItem {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  videosFound: number | null;
  videosInserted: number | null;
  videosUpdated: number | null;
  errorMessage: string | null;
  triggeredBy: string;
  source: string | null;
}

interface VideoRow {
  id: string;
  youtubeId: string | null;
  title: string;
  description: string;
  thumbnailUrl: string;
  duration: string | null;
  category: string | null;
  preacher: string | null;
  publishedAt: string | null;
  importedAt: string;
  viewCount: number;
  featured: boolean;
  metadataLocked: boolean;
  videoSource: string;
  transcodingStatus?: string | null;
  transcodingErrorCode?: string | null;
  transcodingErrorMessage?: string | null;
  youtubeLiveStatus?: "live" | "rebroadcast" | null;
}

interface VideosResponse {
  videos: VideoRow[];
  total: number;
  totalPages: number;
  page: number;
  limit: number;
}

const CATEGORIES: { value: string; label: string }[] = [
  { value: "faith",       label: "Faith" },
  { value: "deliverance", label: "Deliverance" },
  { value: "worship",     label: "Worship" },
  { value: "prophecy",    label: "Prophecy" },
  { value: "teaching",    label: "Teaching" },
  { value: "special",     label: "Special Programs" },
  { value: "sermon",      label: "Sermon" },
];

const SORT_OPTIONS = [
  { value: "published", label: "Date Published" },
  { value: "newest",    label: "Date Added" },
  { value: "views",     label: "Most Viewed" },
  { value: "title",     label: "Title A–Z" },
];

function formatDurationSecs(secs: string | null | undefined): string {
  if (!secs) return "—";
  const n = parseInt(secs, 10);
  if (isNaN(n) || n <= 0) return "—";
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function StatusIcon({ status }: { status: string | null }) {
  if (!status) return <AlertCircle size={14} className="text-muted-foreground" />;
  if (status === "completed") return <CheckCircle2 size={14} className="text-green-500" />;
  if (status === "failed") return <XCircle size={14} className="text-red-500" />;
  if (status === "running") return <Loader2 size={14} className="text-blue-500 animate-spin" />;
  return <AlertCircle size={14} className="text-muted-foreground" />;
}

function SourceBadge({ source }: { source: string | null }) {
  if (!source) return null;
  if (source === "youtube_api") {return (
    <Badge variant="outline" className="text-[10px] border-red-200 text-red-600 bg-red-50">API</Badge>
  );}
  return (
    <Badge variant="outline" className="text-[10px] border-orange-200 text-orange-600 bg-orange-50">RSS</Badge>
  );
}

export default function LibraryPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [sort, setSort] = useState<string>("published");
  const [showHistory, setShowHistory] = useState(false);
  const LIMIT = 24;

  // Debounce search — use a ref so the pending timer is always cleared on
  // unmount and never calls setDebouncedSearch on an unmounted component.
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (searchTimerRef.current !== null) clearTimeout(searchTimerRef.current);
    };
  }, []);

  const handleSearchChange = useCallback((val: string) => {
    setSearch(val);
    setPage(1);
    if (searchTimerRef.current !== null) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      searchTimerRef.current = null;
      setDebouncedSearch(val);
    }, 350);
  }, []);

  const { data: status, isLoading: statusLoading, error: statusError } = useQuery({
    queryKey: ["youtube-sync-status"],
    queryFn: () => api.get<SyncStatus>("/admin/youtube/sync/status"),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ["youtube-sync-history"],
    queryFn: () => api.get<{ items: SyncHistoryItem[] }>("/admin/youtube/sync/history"),
    enabled: showHistory,
    staleTime: 30_000,
  });

  const { data: videos, isLoading: videosLoading, error: videosError } = useQuery({
    queryKey: ["youtube-library-videos", page, debouncedSearch, category, sort],
    queryFn: () => {
      const params = new URLSearchParams({
        source: "youtube",
        page: String(page),
        limit: String(LIMIT),
        sort,
      });
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (category && category !== "all") params.set("category", category);
      return api.get<VideosResponse>(`/admin/videos?${params}`);
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const syncMutation = useMutation({
    mutationFn: () => api.post<SyncResult>("/admin/youtube/sync", {}),
    onSuccess: (result) => {
      const parts = [`${result.total} videos synced`, `${result.inserted} new`, `${result.updated} updated`];
      if (result.deleted > 0) parts.push(`${result.deleted} expired removed`);
      toast.success(`Sync complete — ${parts.join(" · ")}`, { duration: 6000 });
      setPage(1);
      void qc.invalidateQueries({ queryKey: ["youtube-sync-status"] });
      void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      void qc.invalidateQueries({ queryKey: ["youtube-sync-history"] });
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      // A YouTube sync can resolve "missing video" remediation warnings — refresh
      // the report panel so resolved items disappear without waiting for SSE.
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
    },
    onError: (err) => {
      const msg = (err as Error).message ?? "Sync failed";
      toast.error(msg.includes("already in progress") ? "Sync already in progress" : `Sync failed: ${msg}`);
    },
  });

  // Refresh library when a sync completes via SSE
  useSSEEvent("videos-library-updated", () => {
    void qc.invalidateQueries({ queryKey: ["youtube-sync-status"] });
    void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
    void qc.invalidateQueries({ queryKey: ["admin-stats"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
  });

  // Refresh live-status badges in real time without a full page reload
  useSSEEvent("youtube-live-status-changed", () => {
    void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
  });

  const isSyncing = syncMutation.isPending || (status?.syncInProgress ?? false);
  const totalPages = videos?.totalPages ?? 0;

  // Format next sync time
  const nextSync = status?.nextSyncAt
    ? formatDistanceToNow(new Date(status.nextSyncAt), { addSuffix: true })
    : null;

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="YouTube Library"
        description={
          <span className="flex items-center gap-2 flex-wrap">
            Auto-synced from{" "}
            <a
              href={CHANNEL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            >
              @TEMPLETVJCTM
            </a>
            {status?.contentWindowDays && (
              <Badge variant="secondary" className="text-[10px] gap-1">
                <Clock size={9} />
                Last {Math.round(status.contentWindowDays / 365)} years only
              </Badge>
            )}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-xs"
              onClick={() => setShowHistory((v) => !v)}
            >
              <History size={13} />
              History
            </Button>
            <Button
              size="sm"
              className="gap-2"
              onClick={() => syncMutation.mutate()}
              disabled={isSyncing}
            >
              {isSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {isSyncing ? "Syncing…" : "Sync Now"}
            </Button>
          </div>
        }
      />

      {statusError && (
        <ErrorAlert message="Could not load sync status." />
      )}

      {/* ── Sync Status Panel ────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 mb-1 text-primary"><Database size={15} /></div>
            {statusLoading ? (
              <Skeleton className="h-7 w-16 mb-1" />
            ) : (
              <p className="text-2xl font-bold">{(status?.totalYoutubeVideos ?? 0).toLocaleString()}</p>
            )}
            <p className="text-xs text-muted-foreground">Videos in library</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 mb-1">
              <StatusIcon status={status?.lastSyncStatus ?? null} />
              <span className="text-xs font-medium capitalize">
                {status?.lastSyncStatus ?? "Never synced"}
              </span>
            </div>
            {statusLoading ? (
              <Skeleton className="h-5 w-24" />
            ) : (
              <p className="text-sm text-muted-foreground">
                {status?.lastSyncAt
                  ? formatDistanceToNow(new Date(status.lastSyncAt), { addSuffix: true })
                  : "—"}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">Last sync</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 mb-1">
              <Clock size={14} className="text-muted-foreground" />
              <span className="text-xs font-medium">Next sync</span>
            </div>
            {statusLoading ? (
              <Skeleton className="h-5 w-24" />
            ) : (
              <p className="text-sm text-muted-foreground">{nextSync ?? "Pending boot"}</p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">
              <SourceBadge source={status?.lastSyncSource ?? null} />
              {" "}
              {status?.lastSyncSource === "rss"
                ? "RSS (set YOUTUBE_API_KEY for full sync)"
                : status?.lastSyncSource === "youtube_api"
                ? "YouTube Data API v3"
                : ""}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 mb-1 text-primary"><TrendingUp size={15} /></div>
            {statusLoading ? (
              <Skeleton className="h-7 w-16 mb-1" />
            ) : (
              <p className="text-2xl font-bold">
                {status?.videosFound != null ? status.videosFound.toLocaleString() : "—"}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {status?.videosInserted != null
                ? `${status.videosInserted} new · ${status.videosUpdated ?? 0} updated${status.videosDeleted ? ` · ${status.videosDeleted} expired` : ""}`
                : "Last sync stats"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── RSS Warning ───────────────────────────────────────────────── */}
      {!statusLoading && status?.lastSyncSource === "rss" && (
        <Card className="border-orange-200 bg-orange-50/50">
          <CardContent className="pt-3 pb-3">
            <div className="flex items-start gap-3">
              <WifiOff size={16} className="text-orange-500 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-orange-800">Limited sync mode (RSS only)</p>
                <p className="text-orange-700 text-xs mt-0.5">
                  Only the last ~15 videos are visible without a YouTube Data API key.
                  Set <code className="bg-orange-100 px-1 rounded">YOUTUBE_API_KEY</code> in
                  Replit Secrets to sync the full channel library with durations and view counts.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Sync error ────────────────────────────────────────────────── */}
      {status?.lastSyncStatus === "failed" && status.errorMessage && (
        <Card className="border-red-200 bg-red-50/50">
          <CardContent className="pt-3 pb-3">
            <div className="flex items-start gap-3">
              <XCircle size={15} className="text-red-500 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-red-800">Last sync failed</p>
                <p className="text-red-600 text-xs mt-0.5 font-mono">{status.errorMessage}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Sync History ─────────────────────────────────────────────── */}
      {showHistory && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <History size={14} /> Sync History
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {historyLoading ? (
              <div className="divide-y">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-4 px-4 py-3">
                    <Skeleton className="h-4 w-4 rounded-full flex-shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-48" />
                    </div>
                    <Skeleton className="h-3 w-20 flex-shrink-0" />
                  </div>
                ))}
              </div>
            ) : (
            <div className="divide-y">
              {(history?.items ?? []).map((item) => (
                <div key={item.id} className="flex items-center gap-4 px-4 py-3 text-sm">
                  <StatusIcon status={item.status} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium capitalize">{item.status}</span>
                      <SourceBadge source={item.source} />
                      {item.triggeredBy === "manual" && (
                        <Badge variant="secondary" className="text-[10px]">Manual</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(item.startedAt), "MMM d, yyyy · h:mm a")}
                      {item.videosFound != null && ` · ${item.videosFound} videos found`}
                      {item.videosInserted != null && `, ${item.videosInserted} new`}
                    </p>
                    {item.errorMessage && (
                      <p className="text-xs text-red-500 mt-0.5 font-mono truncate">{item.errorMessage}</p>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    {item.completedAt
                      ? formatDistanceToNow(new Date(item.completedAt), { addSuffix: true })
                      : "in progress"}
                  </span>
                </div>
              ))}
              {(!history?.items || history.items.length === 0) && (
                <p className="text-sm text-muted-foreground text-center py-6">No sync history yet</p>
              )}
            </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Filters Row ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search videos…"
            className="pl-8 h-9 text-sm"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </div>
        <Select value={category} onValueChange={(v) => { setCategory(v); setPage(1); }}>
          <SelectTrigger className="h-9 w-[140px] text-sm">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => { setSort(v); setPage(1); }}>
          <SelectTrigger className="h-9 w-[160px] text-sm">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(debouncedSearch || (category && category !== "all")) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 text-xs"
            onClick={() => { setSearch(""); setDebouncedSearch(""); setCategory("all"); setPage(1); }}
          >
            Clear filters
          </Button>
        )}
        <span className="text-xs text-muted-foreground ml-auto">
          {videos ? `${videos.total.toLocaleString()} video${videos.total !== 1 ? "s" : ""}` : ""}
        </span>
      </div>

      {/* ── Video errors ─────────────────────────────────────────────── */}
      {videosError && (
        <ErrorAlert
          message={(videosError as Error).message}
          transient={isTransientError(videosError)}
        />
      )}

      {/* ── Video Grid ───────────────────────────────────────────────── */}
      {videosLoading && !videos ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <Card key={i}>
              <Skeleton className="aspect-video w-full rounded-t-lg" />
              <CardContent className="pt-2 pb-3">
                <Skeleton className="h-4 w-full mb-1.5" />
                <Skeleton className="h-3 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (videos?.videos ?? []).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Youtube size={36} className="text-muted-foreground/30" />
            <div>
              <p className="font-medium text-sm">
                {debouncedSearch || category !== "all"
                  ? "No videos match your filters"
                  : "No YouTube videos synced yet"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {debouncedSearch || category !== "all"
                  ? "Try adjusting your search or filters."
                  : "Click \"Sync Now\" to fetch the full channel library from @TEMPLETVJCTM."}
              </p>
            </div>
            {!(debouncedSearch || category !== "all") && (
              <Button
                size="sm"
                onClick={() => syncMutation.mutate()}
                disabled={isSyncing}
                className="gap-2 mt-1"
              >
                {isSyncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                Sync Now
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {(videos?.videos ?? []).map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
      )}

      {/* ── Pagination ───────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft size={14} />
          </Button>
          {/* Show compact page range */}
          {Array.from({ length: Math.min(7, totalPages) }).map((_, i) => {
            let pageNum: number;
            if (totalPages <= 7) {
              pageNum = i + 1;
            } else if (page <= 4) {
              pageNum = i + 1;
            } else if (page >= totalPages - 3) {
              pageNum = totalPages - 6 + i;
            } else {
              pageNum = page - 3 + i;
            }
            return (
              <Button
                key={pageNum}
                variant={pageNum === page ? "default" : "outline"}
                size="sm"
                className="h-8 w-8 p-0 text-xs"
                onClick={() => setPage(pageNum)}
              >
                {pageNum}
              </Button>
            );
          })}
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            <ChevronRight size={14} />
          </Button>
        </div>
      )}
    </div>
  );
}

interface YtEditForm {
  title: string;
  description: string;
  category: string;
  preacher: string;
  metadataLocked: boolean;
  featured: boolean;
}

function snapshotYt(f: YtEditForm) {
  return JSON.stringify({ ...f, title: f.title.trim(), preacher: f.preacher.trim() });
}

const TITLE_MAX = 200;
const DESC_MAX = 5000;
const PREACHER_MAX = 100;

function VideoCard({ video: initialVideo }: { video: VideoRow }) {
  // Use local copy so optimistic updates feel instant even before refetch.
  const [video, setVideo] = useState(initialVideo);
  const ytUrl = video.youtubeId
    ? `https://www.youtube.com/watch?v=${video.youtubeId}`
    : null;

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editForm, setEditForm] = useState<YtEditForm>({
    title: "", description: "", category: "", preacher: "", metadataLocked: false, featured: false,
  });
  const [editOriginalSnap, setEditOriginalSnap] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();

  const invalidateLibrary = () => {
    void queryClient.invalidateQueries({ queryKey: ["youtube-library-videos"] });
    void queryClient.invalidateQueries({ queryKey: ["admin-stats"] });
    void queryClient.invalidateQueries({ queryKey: ["broadcast-queue"] });
    void queryClient.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
  };

  const resetMutation = useMutation({
    mutationFn: () =>
      api.post(`/admin/videos/${video.id}/reset-for-reupload`) as Promise<{
        ok: boolean; videoId: string; title: string;
        category: string | null; preacher: string | null; description: string;
      }>,
    onSuccess: () => {
      // Refresh the library and broadcast views so the reset state (transcodingStatus
      // cleared, video now accepts a fresh upload) is immediately visible without
      // waiting for the next poll interval.
      invalidateLibrary();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Failed to reset video — try again.");
    },
  });

  const updateMutation = useMutation({
    mutationFn: (body: Partial<YtEditForm>) =>
      api.patch<VideoRow>(`/admin/videos/${video.id}`, body),
    onSuccess: (updated) => {
      setVideo(updated);
      toast.success("Saved");
      setEditOpen(false);
      invalidateLibrary();
    },
    onError: (err: unknown) => {
      setEditError(err instanceof Error ? err.message : "Save failed — please try again.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/admin/videos/${video.id}`),
    onSuccess: () => {
      toast.success(`"${video.title}" deleted`);
      setDeleteOpen(false);
      invalidateLibrary();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Delete failed — please try again.");
    },
  });

  const featureMutation = useMutation({
    mutationFn: (featured: boolean) => api.patch<VideoRow>(`/admin/videos/${video.id}`, { featured }),
    onSuccess: (updated) => {
      setVideo(updated);
      toast.success(updated.featured ? "Marked as featured" : "Removed from featured");
      invalidateLibrary();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Action failed");
    },
  });

  const lockMutation = useMutation({
    mutationFn: (metadataLocked: boolean) =>
      api.patch<VideoRow>(`/admin/videos/${video.id}`, { metadataLocked }),
    onSuccess: (updated) => {
      setVideo(updated);
      toast.success(updated.metadataLocked ? "Metadata locked" : "Metadata unlocked");
      invalidateLibrary();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Action failed");
    },
  });

  function openEdit() {
    const form: YtEditForm = {
      title: video.title,
      description: video.description ?? "",
      category: video.category ?? "",
      preacher: video.preacher ?? "",
      metadataLocked: video.metadataLocked ?? false,
      featured: video.featured,
    };
    setEditForm(form);
    setEditOriginalSnap(snapshotYt(form));
    setEditError(null);
    setEditOpen(true);
  }

  function handleReuploadClick() { fileInputRef.current?.click(); }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!e.target) return;
    (e.target as HTMLInputElement).value = "";
    if (!file) return;
    try {
      const meta = await resetMutation.mutateAsync();
      uploadQueue.enqueue([{
        file, title: meta.title, category: meta.category ?? "",
        preacher: meta.preacher ?? "", description: meta.description,
        featured: false, priority: 0,
      }]);
      toast.success(`"${meta.title}" queued for upload. You can delete this entry once the new upload completes.`, { duration: 6000 });
    } catch {
      // resetMutation.onError already surfaced the toast
    }
  }

  const titleTrimmed = editForm.title.trim();
  const dirty = snapshotYt(editForm) !== editOriginalSnap;
  const titleInvalid = titleTrimmed.length === 0 || titleTrimmed.length > TITLE_MAX;
  const descOver = editForm.description.length > DESC_MAX;
  const preacherOver = editForm.preacher.trim().length > PREACHER_MAX;
  const canSave = dirty && !titleInvalid && !descOver && !preacherOver && !updateMutation.isPending;

  function submitEdit() {
    if (!canSave) return;
    setEditError(null);
    const delta: Partial<YtEditForm> = {};
    const cur = editForm;
    if (cur.title.trim() !== (video.title ?? "")) delta.title = cur.title.trim();
    if (cur.description !== (video.description ?? "")) delta.description = cur.description;
    if (cur.category !== (video.category ?? "")) delta.category = cur.category;
    if (cur.preacher.trim() !== (video.preacher ?? "")) delta.preacher = cur.preacher.trim();
    if (cur.metadataLocked !== (video.metadataLocked ?? false)) delta.metadataLocked = cur.metadataLocked;
    if (cur.featured !== video.featured) delta.featured = cur.featured;
    if (Object.keys(delta).length === 0) { setEditOpen(false); return; }
    updateMutation.mutate(delta);
  }

  return (
    <>
      <Card className="overflow-hidden group hover:border-primary/40 transition-colors flex flex-col">
        {/* Hidden file input for re-upload */}
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={handleFileSelected}
        />
        {/* Thumbnail */}
        <div className="relative aspect-video bg-black overflow-hidden">
          {video.thumbnailUrl ? (
            <img
              src={video.thumbnailUrl}
              alt={video.title}
              className="w-full h-full object-contain transition-transform duration-300"
              loading="lazy"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Film size={24} className="text-muted-foreground/20" />
            </div>
          )}
          {/* Duration badge */}
          {video.duration && parseInt(video.duration, 10) > 0 && (
            <span className="absolute bottom-1.5 right-1.5 bg-black/80 text-white text-[10px] px-1.5 py-0.5 rounded font-mono">
              {formatDurationSecs(video.duration)}
            </span>
          )}
          {/* Featured star */}
          {video.featured && (
            <span className="absolute top-1.5 left-1.5 bg-amber-500/90 text-white p-0.5 rounded">
              <Star size={10} className="fill-white" />
            </span>
          )}
          {/* Live / Rebroadcast status badge */}
          {video.youtubeLiveStatus && (
            <span className="absolute bottom-6 left-1.5">
              <LiveStatusBadge status={video.youtubeLiveStatus} size="sm" />
            </span>
          )}
          {/* Metadata-locked indicator */}
          {video.metadataLocked && (
            <span className="absolute top-1.5 right-1.5 bg-blue-600/80 text-white p-0.5 rounded" title="Metadata locked — YouTube sync won't overwrite">
              <Lock size={10} />
            </span>
          )}
          {/* Corrupt-source badge */}
          {video.transcodingErrorCode === "CORRUPT_SOURCE" && (
            <button
              type="button"
              onClick={handleReuploadClick}
              disabled={resetMutation.isPending}
              title={resetMutation.isPending ? "Resetting…" : (video.transcodingErrorMessage ?? "Moov atom absent — click to upload a replacement file")}
              className="absolute top-1.5 left-1.5 flex items-center gap-1 bg-red-600/90 hover:bg-red-500/95 active:bg-red-700 text-white text-[10px] font-medium px-1.5 py-0.5 rounded transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {resetMutation.isPending ? <Loader2 size={10} className="animate-spin" /> : <UploadCloud size={10} />}
              {resetMutation.isPending ? "Resetting…" : "Re-upload required"}
            </button>
          )}
          {/* YouTube link overlay */}
          {ytUrl && (
            <a
              href={ytUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/30 transition-opacity"
              aria-label="Watch on YouTube"
            >
              <div className="bg-red-600 rounded-full p-2.5">
                <Youtube size={18} className="text-white" />
              </div>
            </a>
          )}
          {/* Actions menu — top-right, only visible on hover */}
          <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.preventDefault()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 bg-black/60 hover:bg-black/80 text-white rounded"
                  aria-label={`Actions for ${video.title}`}
                >
                  <MoreVertical size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={openEdit}>
                  <Pencil size={13} className="mr-2" /> Edit metadata
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => featureMutation.mutate(!video.featured)} disabled={featureMutation.isPending}>
                  {video.featured
                    ? <><StarOff size={13} className="mr-2" /> Unfeature</>
                    : <><Star size={13} className="mr-2" /> Feature</>}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => lockMutation.mutate(!video.metadataLocked)} disabled={lockMutation.isPending}>
                  {video.metadataLocked
                    ? <><LockOpen size={13} className="mr-2" /> Unlock metadata</>
                    : <><Lock size={13} className="mr-2" /> Lock metadata</>}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-red-600 focus:text-red-600"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 size={13} className="mr-2" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Metadata */}
        <CardContent className="pt-2.5 pb-3 flex flex-col gap-1 flex-1">
          <p className="text-sm font-medium leading-snug line-clamp-2">{video.title}</p>
          <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
            {video.category && (
              <Badge variant="secondary" className="text-[10px] capitalize px-1.5 py-0">
                {video.category}
              </Badge>
            )}
            {video.preacher && (
              <span className="text-[11px] text-muted-foreground truncate">{video.preacher}</span>
            )}
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-auto pt-1.5">
            {video.publishedAt && (
              <span className="flex items-center gap-1">
                <Calendar size={10} />
                {format(new Date(video.publishedAt), "MMM d, yyyy")}
              </span>
            )}
            {video.viewCount > 0 && (
              <span className="flex items-center gap-1">
                <Eye size={10} />
                {video.viewCount.toLocaleString()}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Edit Dialog ─────────────────────────────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={(o) => { if (!o && updateMutation.isPending) return; setEditOpen(o); if (!o) setEditError(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center gap-2"><Pencil size={15} /> Edit YouTube video</DialogTitle>
            <DialogDescription>
              Changes are applied to the local library record. Lock metadata to prevent the next YouTube sync from overwriting category &amp; preacher.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4 min-h-0 pr-1" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submitEdit(); } }}>
            {/* Title */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="yt-edit-title">Title <span className="text-red-500">*</span></Label>
                <span className={`text-[11px] tabular-nums ${titleTrimmed.length > TITLE_MAX ? "text-red-600" : "text-muted-foreground/60"}`}>
                  {titleTrimmed.length}/{TITLE_MAX}
                </span>
              </div>
              <input
                id="yt-edit-title"
                autoFocus
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={editForm.title}
                maxLength={TITLE_MAX + 50}
                onChange={(e) => setEditForm(f => ({ ...f, title: e.target.value }))}
              />
              {titleInvalid && (
                <p className="text-[11px] text-red-600">
                  {titleTrimmed.length === 0 ? "Title is required." : `Title must be ${TITLE_MAX} characters or fewer.`}
                </p>
              )}
            </div>
            {/* Description */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="yt-edit-desc">Description</Label>
                <span className={`text-[11px] tabular-nums ${descOver ? "text-red-600" : "text-muted-foreground/60"}`}>
                  {editForm.description.length}/{DESC_MAX}
                </span>
              </div>
              <Textarea
                id="yt-edit-desc"
                rows={4}
                className="resize-y"
                value={editForm.description}
                placeholder="Optional description"
                onChange={(e) => setEditForm(f => ({ ...f, description: e.target.value }))}
              />
            </div>
            {/* Category + Preacher */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={editForm.category === "" ? "__none__" : editForm.category} onValueChange={(v) => setEditForm(f => ({ ...f, category: v === "__none__" ? "" : v }))}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__"><span className="text-muted-foreground">None</span></SelectItem>
                    {CATEGORIES.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>Preacher</Label>
                  <span className={`text-[11px] tabular-nums ${preacherOver ? "text-red-600" : "text-muted-foreground/60"}`}>
                    {editForm.preacher.length}/{PREACHER_MAX}
                  </span>
                </div>
                <input
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={editForm.preacher}
                  maxLength={PREACHER_MAX + 25}
                  placeholder="Speaker name"
                  onChange={(e) => setEditForm(f => ({ ...f, preacher: e.target.value }))}
                />
              </div>
            </div>
            {/* Featured */}
            <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/20">
              <div>
                <Label className="text-sm font-medium">Featured</Label>
                <p className="text-xs text-muted-foreground">Show in home-screen hero rotation</p>
              </div>
              <Switch checked={editForm.featured} onCheckedChange={(v) => setEditForm(f => ({ ...f, featured: v }))} />
            </div>
            {/* Metadata lock */}
            <div className="flex items-center justify-between rounded-lg border p-3 bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800">
              <div className="flex items-start gap-2">
                {editForm.metadataLocked
                  ? <Lock size={15} className="text-blue-600 mt-0.5 flex-shrink-0" />
                  : <LockOpen size={15} className="text-muted-foreground mt-0.5 flex-shrink-0" />}
                <div>
                  <Label className="text-sm font-medium">Lock metadata</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Prevent the next YouTube sync from overwriting category &amp; preacher.
                  </p>
                </div>
              </div>
              <Switch checked={editForm.metadataLocked} onCheckedChange={(v) => setEditForm(f => ({ ...f, metadataLocked: v }))} />
            </div>
            {editError && (
              <div className="rounded-md border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {editError}
              </div>
            )}
          </div>
          <DialogFooter className="flex-shrink-0 border-t border-border pt-4 mt-2 gap-2 sm:gap-0">
            <span className="text-[11px] text-muted-foreground mr-auto self-center hidden sm:block">
              {dirty ? "Unsaved changes — ⌘/Ctrl+Enter to save" : "No changes"}
            </span>
            <Button variant="ghost" onClick={() => setEditOpen(false)} disabled={updateMutation.isPending}>Cancel</Button>
            <Button onClick={submitEdit} disabled={!canSave}>
              {updateMutation.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirm Dialog ──────────────────────────────────────────── */}
      <AlertDialog open={deleteOpen} onOpenChange={(o) => { if (!o && deleteMutation.isPending) return; setDeleteOpen(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete YouTube video?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove <strong>{video.title}</strong> from the library record.
              The video remains on YouTube but won't appear in the admin library unless re-synced.
              {" "}This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteMutation.isError && (
            <div className="rounded-md border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {deleteMutation.error instanceof Error ? deleteMutation.error.message : "Delete failed — please try again."}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white"
              disabled={deleteMutation.isPending}
              onClick={() => { if (!deleteMutation.isPending) deleteMutation.mutate(); }}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
