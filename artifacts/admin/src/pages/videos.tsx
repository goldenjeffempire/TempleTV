import {
  useListAdminVideos,
  useImportVideo,
  useUpdateAdminVideo,
  useDeleteAdminVideo,
  useListPlaylists,
  useAddVideoToPlaylist,
  getListAdminVideosQueryKey,
} from "@workspace/api-client-react";
import { useState, useRef, useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { VideoUploadModal } from "@/components/VideoUploadModal";
import { fetchWithTransientRetry } from "@/services/adminApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  Search, RefreshCw, Upload, Youtube, HardDrive, MoreVertical,
  Trash2, Edit2, Radio, Play, ChevronLeft, ChevronRight,
  Clapperboard, Star, StarOff, Zap, AlertCircle, CheckCircle2,
  Clock, Loader2, Filter, X, Plus, ExternalLink, Video, ListVideo,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
type VideoRow = {
  id: string;
  youtubeId: string | null;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  duration: string | null;
  category: string | null;
  preacher: string | null;
  publishedAt: string | null;
  importedAt: string;
  viewCount: number;
  featured: boolean;
  videoSource: "youtube" | "local";
  localVideoUrl: string | null;
  hlsMasterUrl: string | null;
  transcodingStatus: string | null;
  originalFilename: string | null;
  sizeBytes: number | null;
};

type EditForm = {
  title: string;
  preacher: string;
  category: string;
  featured: boolean;
};

// ─── Constants ────────────────────────────────────────────────────────────────
const ITEMS_PER_PAGE = 50;
const CATEGORIES = [
  "sermon", "faith", "healing", "deliverance",
  "worship", "prophecy", "teachings", "special",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
  const parts = dur.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function formatDuration(dur: string | null): string {
  const secs = parseDurationSecs(dur);
  if (!secs) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

async function adminFetch(url: string, opts?: RequestInit): Promise<Response> {
  const token = window.localStorage.getItem("temple-tv-admin-token")?.trim();
  const headers: Record<string, string> = { ...(opts?.headers as Record<string, string>) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  // Round 4l: idempotent reads route through the shared retry wrapper so
  // workflow-restart races don't surface as page errors. Mutating requests
  // (POST/PUT/PATCH/DELETE) bypass the retry to avoid double-mutation.
  const method = (opts?.method ?? "GET").toUpperCase();
  const isIdempotent = method === "GET" || method === "HEAD";
  const factory = () => fetch(url, { ...opts, headers });
  return isIdempotent
    ? fetchWithTransientRetry(factory, opts?.signal ?? undefined)
    : factory();
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function TranscodingBadge({ status, source }: { status: string | null; source: string }) {
  if (source !== "local") return null;
  switch (status) {
    case "hls_ready":
      return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-[10px] py-0"><CheckCircle2 className="w-2.5 h-2.5 mr-1" />HLS Ready</Badge>;
    case "queued":
      return <Badge variant="outline" className="text-[10px] py-0"><Clock className="w-2.5 h-2.5 mr-1" />Queued</Badge>;
    case "encoding":
      return <Badge className="bg-blue-500/15 text-blue-600 border-blue-500/30 text-[10px] py-0"><Loader2 className="w-2.5 h-2.5 mr-1 animate-spin" />Encoding</Badge>;
    case "failed":
      return <Badge className="bg-red-500/15 text-red-600 border-red-500/30 text-[10px] py-0"><AlertCircle className="w-2.5 h-2.5 mr-1" />Failed</Badge>;
    default:
      return <Badge variant="outline" className="text-[10px] py-0 text-muted-foreground">Raw MP4</Badge>;
  }
}

function SourceBadge({ source }: { source: string }) {
  if (source === "youtube") {
    return <Badge className="bg-red-500/10 text-red-600 border-red-500/20 text-[10px] py-0"><Youtube className="w-2.5 h-2.5 mr-1" />YouTube</Badge>;
  }
  return <Badge className="bg-indigo-500/10 text-indigo-600 border-indigo-500/20 text-[10px] py-0"><HardDrive className="w-2.5 h-2.5 mr-1" />Local</Badge>;
}

// ─── Edit Dialog ──────────────────────────────────────────────────────────────
function EditDialog({
  video,
  onClose,
  onSave,
}: {
  video: VideoRow | null;
  onClose: () => void;
  onSave: (id: string, data: EditForm) => void;
}) {
  const [form, setForm] = useState<EditForm>({
    title: "",
    preacher: "",
    category: "sermon",
    featured: false,
  });
  const [saving, setSaving] = useState(false);

  const open = !!video;

  // Reset form whenever the target video changes
  useEffect(() => {
    if (video) {
      setForm({
        title: video.title,
        preacher: video.preacher ?? "",
        category: video.category ?? "sermon",
        featured: video.featured,
      });
    } else {
      setTimeout(() => setForm({ title: "", preacher: "", category: "sermon", featured: false }), 200);
    }
  }, [video]);

  function handleOpen(isOpen: boolean) {
    if (!isOpen) onClose();
  }

  async function handleSave() {
    if (!video) return;
    setSaving(true);
    try {
      await onSave(video.id, form);
      onClose();
      setTimeout(() => setForm({ title: "", preacher: "", category: "sermon", featured: false }), 200);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Video</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="edit-title">Title</Label>
            <Input
              id="edit-title"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Video title"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-preacher">Preacher / Speaker</Label>
            <Input
              id="edit-preacher"
              value={form.preacher}
              onChange={(e) => setForm((f) => ({ ...f, preacher: e.target.value }))}
              placeholder="Speaker name"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>{capitalize(c)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="edit-featured">Featured</Label>
            <Switch
              id="edit-featured"
              checked={form.featured}
              onCheckedChange={(v) => setForm((f) => ({ ...f, featured: v }))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !form.title.trim()}>
            {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Import YouTube Dialog ────────────────────────────────────────────────────
function ImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onImported: () => void;
}) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { mutateAsync: importVideo } = useImportVideo();
  const { toast } = useToast();

  function extractYoutubeId(input: string): string {
    const trimmed = input.trim();
    // Full URL: https://youtu.be/VIDEO_ID or https://youtube.com/watch?v=VIDEO_ID
    const urlMatch = trimmed.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/);
    if (urlMatch) return urlMatch[1];
    // Already an 11-char video ID
    if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
    return trimmed;
  }

  async function handleImport() {
    const raw = url.trim();
    if (!raw) return;
    const youtubeId = extractYoutubeId(raw);
    setLoading(true);
    setError(null);
    try {
      await importVideo({ data: { youtubeId } });
      toast({ title: "Video imported", description: "The YouTube video has been added to your library." });
      setUrl("");
      onOpenChange(false);
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  function handleClose(isOpen: boolean) {
    if (!isOpen) { setUrl(""); setError(null); }
    onOpenChange(isOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Youtube className="w-5 h-5 text-red-500" />
            Import from YouTube
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="yt-url">YouTube URL or Video ID</Label>
            <Input
              id="yt-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://youtube.com/watch?v=... or video ID"
              onKeyDown={(e) => e.key === "Enter" && handleImport()}
            />
          </div>
          {error && (
            <p className="text-sm text-destructive flex items-center gap-1.5">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>Cancel</Button>
          <Button onClick={handleImport} disabled={loading || !url.trim()}>
            {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Skeleton Row ─────────────────────────────────────────────────────────────
function VideoRowSkeleton() {
  return (
    <tr className="border-b">
      <td className="py-3 px-4 w-8"><Skeleton className="h-4 w-4 rounded" /></td>
      <td className="py-3 px-4"><Skeleton className="h-10 w-[72px] rounded" /></td>
      <td className="py-3 px-4"><div className="space-y-1.5"><Skeleton className="h-4 w-48" /><Skeleton className="h-3 w-32" /></div></td>
      <td className="py-3 px-4"><Skeleton className="h-5 w-20 rounded-full" /></td>
      <td className="py-3 px-4"><Skeleton className="h-4 w-14" /></td>
      <td className="py-3 px-4"><Skeleton className="h-5 w-20 rounded-full" /></td>
      <td className="py-3 px-4"><Skeleton className="h-5 w-20 rounded-full" /></td>
      <td className="py-3 px-4"><Skeleton className="h-4 w-24" /></td>
      <td className="py-3 px-4"><Skeleton className="h-8 w-8 rounded" /></td>
    </tr>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function VideoLibrary() {
  // ── search / filter state ──────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState("");
  const [querySearch, setQuerySearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // ── dialog state ───────────────────────────────────────────────────────────
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [editingVideo, setEditingVideo] = useState<VideoRow | null>(null);
  const [deletingVideo, setDeletingVideo] = useState<VideoRow | null>(null);

  // ── selection ──────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkPlaylistOpen, setBulkPlaylistOpen] = useState(false);
  const [bulkPlaylistId, setBulkPlaylistId] = useState<string>("");
  const [bulkAddingToPlaylist, setBulkAddingToPlaylist] = useState(false);

  // ── misc state ─────────────────────────────────────────────────────────────
  const [addingToQueue, setAddingToQueue] = useState<string | null>(null);
  const [reencoding, setReencoding] = useState<string | null>(null);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: playlistsForBulk } = useListPlaylists();
  const { mutateAsync: addToPlaylist } = useAddVideoToPlaylist();

  // ── build query params ────────────────────────────────────────────────────
  const queryParams: Record<string, string | number | undefined> = {
    page,
    limit: ITEMS_PER_PAGE,
    search: querySearch || undefined,
    category: categoryFilter !== "all" ? categoryFilter : undefined,
  };
  // source and transcodingStatus go via the generated hook's extra params field;
  // the backend reads them from req.query directly so they just need to be in the URL.
  if (sourceFilter !== "all") (queryParams as Record<string, string | number | undefined>).source = sourceFilter;
  if (statusFilter !== "all") (queryParams as Record<string, string | number | undefined>).transcodingStatus = statusFilter;

  const { data, isLoading, isError, refetch } = useListAdminVideos(queryParams as Parameters<typeof useListAdminVideos>[0]);

  const { mutateAsync: updateVideo } = useUpdateAdminVideo();
  const { mutateAsync: deleteVideo } = useDeleteAdminVideo();

  // Defensive: ensure we always end up with an array even if the API contract
  // drifts and `videos` is missing or returned as a non-array shape.
  const videos: VideoRow[] = Array.isArray(data?.videos) ? (data.videos as VideoRow[]) : [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  // ── handlers ───────────────────────────────────────────────────────────────
  const handleSearch = useCallback((value: string) => {
    setSearchInput(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setQuerySearch(value);
      setPage(1);
    }, 350);
  }, []);

  // Cancel the debounce timer on unmount so we never call setState on a gone tree.
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  // If filters or a bulk delete shrink the result set below the current page,
  // snap back to a valid page instead of leaving the operator on a blank "Page 5 of 2".
  useEffect(() => {
    if (!isLoading && totalPages > 0 && page > totalPages) {
      setPage(totalPages);
    }
  }, [isLoading, page, totalPages]);

  const handleFilterChange = useCallback((type: "category" | "source" | "status", value: string) => {
    if (type === "category") setCategoryFilter(value);
    if (type === "source") setSourceFilter(value);
    if (type === "status") setStatusFilter(value);
    setPage(1);
  }, []);

  const clearFilters = useCallback(() => {
    setSearchInput("");
    setQuerySearch("");
    setCategoryFilter("all");
    setSourceFilter("all");
    setStatusFilter("all");
    setPage(1);
  }, []);

  const invalidateAndRefetch = useCallback(() => {
    setPage(1);
    queryClient.invalidateQueries({ queryKey: getListAdminVideosQueryKey() });
    refetch();
  }, [queryClient, refetch]);

  const handleUploadComplete = useCallback(() => {
    // The transcoder kicks off asynchronously after upload finalize. The video
    // row is created immediately, so a single invalidate covers the listing.
    // Status fields (transcodingStatus, hlsMasterUrl) update on the SSE
    // `transcoding-job-updated` channel, so we don't need a polling timer.
    invalidateAndRefetch();
  }, [invalidateAndRefetch]);

  const handleImported = useCallback(() => {
    invalidateAndRefetch();
  }, [invalidateAndRefetch]);

  const handleSaveEdit = useCallback(async (id: string, form: EditForm) => {
    try {
      await updateVideo({ id, data: form });
      toast({ title: "Video updated" });
      queryClient.invalidateQueries({ queryKey: getListAdminVideosQueryKey() });
      refetch();
    } catch (e) {
      toast({ title: "Update failed", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
      throw e;
    }
  }, [updateVideo, toast, queryClient, refetch]);

  const handleDelete = useCallback(async (video: VideoRow) => {
    try {
      await deleteVideo({ id: video.id });
      toast({ title: "Video deleted" });
      setDeletingVideo(null);
      setSelected((s) => { const n = new Set(s); n.delete(video.id); return n; });
      queryClient.invalidateQueries({ queryKey: getListAdminVideosQueryKey() });
      refetch();
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    }
  }, [deleteVideo, toast, queryClient, refetch]);

  const handleBulkDelete = useCallback(async () => {
    setBulkDeleting(true);
    let success = 0;
    let fail = 0;
    // Bounded concurrency: parallelize but cap at 5 to avoid overwhelming the
    // API (each delete also kicks off cache invalidation + SSE broadcasts on
    // the server). Sequential N+1 was painfully slow for large selections.
    const ids = Array.from(selected);
    const CONCURRENCY = 5;
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = ids.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map((id) => deleteVideo({ id })));
      for (const r of results) {
        if (r.status === "fulfilled") success++;
        else fail++;
      }
    }
    setBulkDeleting(false);
    setSelected(new Set());
    queryClient.invalidateQueries({ queryKey: getListAdminVideosQueryKey() });
    refetch();
    toast({
      title: `Deleted ${success} video${success !== 1 ? "s" : ""}`,
      description: fail > 0 ? `${fail} failed` : undefined,
      variant: fail > 0 ? "destructive" : undefined,
    });
  }, [selected, deleteVideo, queryClient, refetch, toast]);

  const handleBulkAddToPlaylist = useCallback(async () => {
    if (!bulkPlaylistId) return;
    const playlistName = (Array.isArray(playlistsForBulk) ? playlistsForBulk : []).find((p) => p.id === bulkPlaylistId)?.name ?? "playlist";
    setBulkAddingToPlaylist(true);
    let success = 0;
    let fail = 0;
    const ids = Array.from(selected);
    const CONCURRENCY = 4;
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = ids.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((videoId) => addToPlaylist({ id: bulkPlaylistId, data: { videoId } })),
      );
      for (const r of results) {
        if (r.status === "fulfilled") success++;
        else fail++;
      }
    }
    setBulkAddingToPlaylist(false);
    setBulkPlaylistOpen(false);
    setBulkPlaylistId("");
    setSelected(new Set());
    toast({
      title: `Added ${success} video${success !== 1 ? "s" : ""} to ${playlistName}`,
      description: fail > 0 ? `${fail} failed (likely already on the playlist)` : undefined,
      variant: fail > 0 && success === 0 ? "destructive" : undefined,
    });
  }, [bulkPlaylistId, selected, addToPlaylist, toast, playlistsForBulk]);

  const handleAddToQueue = useCallback(async (video: VideoRow) => {
    setAddingToQueue(video.id);
    try {
      const res = await adminFetch("/api/admin/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: video.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast({ title: "Added to broadcast queue", description: video.title });
    } catch (e) {
      toast({ title: "Failed to add to queue", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    } finally {
      setAddingToQueue(null);
    }
  }, [toast]);

  const handleReencode = useCallback(async (video: VideoRow) => {
    setReencoding(video.id);
    try {
      const res = await adminFetch(`/api/admin/transcoding/requeue/${video.id}`, { method: "POST" });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let msg = `HTTP ${res.status}`;
        try { const j = JSON.parse(text); if (j.error) msg = j.error; } catch {}
        throw new Error(msg);
      }
      toast({ title: "Re-encode queued", description: "HLS transcoding will start shortly." });
      queryClient.invalidateQueries({ queryKey: getListAdminVideosQueryKey() });
      refetch();
    } catch (e) {
      toast({ title: "Failed to re-encode", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    } finally {
      setReencoding(null);
    }
  }, [toast, queryClient, refetch]);

  const handleToggleFeatured = useCallback(async (video: VideoRow) => {
    try {
      await updateVideo({ id: video.id, data: { featured: !video.featured } });
      queryClient.invalidateQueries({ queryKey: getListAdminVideosQueryKey() });
      refetch();
    } catch (e) {
      toast({ title: "Update failed", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    }
  }, [updateVideo, queryClient, refetch, toast]);

  // ── selection helpers ──────────────────────────────────────────────────────
  const allSelected = videos.length > 0 && videos.every((v) => selected.has(v.id));
  const someSelected = selected.size > 0;

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(videos.map((v) => v.id)));
    }
  }, [allSelected, videos]);

  const toggleOne = useCallback((id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);

  const hasActiveFilters = querySearch || categoryFilter !== "all" || sourceFilter !== "all" || statusFilter !== "all";

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full gap-0">

      {/* ── Page Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b bg-background sticky top-0 z-10">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Video className="w-5 h-5 text-primary" />
            Video Library
          </h1>
          {data && (
            <p className="text-sm text-muted-foreground mt-0.5">
              {total.toLocaleString()} video{total !== 1 ? "s" : ""}
              {hasActiveFilters ? " matching filters" : " total"}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowImportDialog(true)}>
            <Youtube className="w-4 h-4 mr-2 text-red-500" />
            Import YouTube
          </Button>
          <Button size="sm" onClick={() => setShowUploadModal(true)}>
            <Upload className="w-4 h-4 mr-2" />
            Upload Local
          </Button>
        </div>
      </div>

      {/* ── Filter Bar ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 px-6 py-3 border-b bg-muted/30">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input
            className="pl-9 h-8 text-sm"
            placeholder="Search title or preacher…"
            value={searchInput}
            onChange={(e) => handleSearch(e.target.value)}
          />
          {searchInput && (
            <button
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => handleSearch("")}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <Select value={categoryFilter} onValueChange={(v) => handleFilterChange("category", v)}>
          <SelectTrigger className="h-8 w-36 text-sm">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>{capitalize(c)}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={sourceFilter} onValueChange={(v) => handleFilterChange("source", v)}>
          <SelectTrigger className="h-8 w-32 text-sm">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="youtube"><span className="flex items-center gap-1.5"><Youtube className="w-3.5 h-3.5 text-red-500" />YouTube</span></SelectItem>
            <SelectItem value="local"><span className="flex items-center gap-1.5"><HardDrive className="w-3.5 h-3.5 text-indigo-500" />Local</span></SelectItem>
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={(v) => handleFilterChange("status", v)}>
          <SelectTrigger className="h-8 w-36 text-sm">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="none">Raw MP4</SelectItem>
            <SelectItem value="queued">Queued</SelectItem>
            <SelectItem value="encoding">Encoding</SelectItem>
            <SelectItem value="hls_ready">HLS Ready</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={clearFilters}>
            <X className="w-3.5 h-3.5 mr-1" />
            Clear
          </Button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {someSelected && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setBulkPlaylistOpen(true)}
                disabled={bulkAddingToPlaylist}
              >
                <ListVideo className="w-3.5 h-3.5 mr-1.5" />
                Add to playlist…
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-8"
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
              >
                {bulkDeleting ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5 mr-1.5" />}
                Delete {selected.size}
              </Button>
            </>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => refetch()}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <Dialog open={bulkPlaylistOpen} onOpenChange={(open) => { if (!bulkAddingToPlaylist) setBulkPlaylistOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add {selected.size} video{selected.size !== 1 ? "s" : ""} to a playlist</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label>Choose playlist</Label>
            {Array.isArray(playlistsForBulk) && playlistsForBulk.length > 0 ? (
              <Select value={bulkPlaylistId} onValueChange={setBulkPlaylistId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a playlist…" />
                </SelectTrigger>
                <SelectContent>
                  {playlistsForBulk.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-muted-foreground">
                No playlists yet. Create one in the Playlists page first.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Videos already on the chosen playlist will be skipped.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBulkPlaylistOpen(false)} disabled={bulkAddingToPlaylist}>
              Cancel
            </Button>
            <Button
              onClick={handleBulkAddToPlaylist}
              disabled={!bulkPlaylistId || bulkAddingToPlaylist}
            >
              {bulkAddingToPlaylist
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Adding…</>
                : <>Add to playlist</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Table ────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-separate border-spacing-0">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur z-[1]">
            <tr className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              <th className="py-2.5 px-4 w-8 text-left font-medium">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Select all"
                />
              </th>
              <th className="py-2.5 px-4 w-20 text-left font-medium">Thumb</th>
              <th className="py-2.5 px-4 text-left font-medium">Title</th>
              <th className="py-2.5 px-4 w-28 text-left font-medium">Category</th>
              <th className="py-2.5 px-4 w-20 text-left font-medium">Duration</th>
              <th className="py-2.5 px-4 w-24 text-left font-medium">Source</th>
              <th className="py-2.5 px-4 w-28 text-left font-medium">Encoding</th>
              <th className="py-2.5 px-4 w-28 text-left font-medium">Imported</th>
              <th className="py-2.5 px-4 w-12" />
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 10 }).map((_, i) => <VideoRowSkeleton key={i} />)
            ) : isError ? (
              <tr>
                <td colSpan={9} className="py-20 text-center">
                  <div className="flex flex-col items-center gap-3 text-muted-foreground">
                    <AlertCircle className="w-8 h-8 text-destructive/60" />
                    <p className="font-medium text-foreground">Failed to load videos</p>
                    <Button variant="outline" size="sm" onClick={() => refetch()}>
                      <RefreshCw className="w-4 h-4 mr-2" />
                      Retry
                    </Button>
                  </div>
                </td>
              </tr>
            ) : videos.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-20 text-center">
                  <div className="flex flex-col items-center gap-3 text-muted-foreground">
                    <Clapperboard className="w-10 h-10 opacity-30" />
                    {hasActiveFilters ? (
                      <>
                        <p className="font-medium text-foreground">No videos match your filters</p>
                        <Button variant="outline" size="sm" onClick={clearFilters}>
                          <Filter className="w-4 h-4 mr-2" />
                          Clear Filters
                        </Button>
                      </>
                    ) : (
                      <>
                        <p className="font-medium text-foreground">No videos yet</p>
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => setShowUploadModal(true)}>
                            <Upload className="w-4 h-4 mr-2" />
                            Upload Local
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => setShowImportDialog(true)}>
                            <Youtube className="w-4 h-4 mr-2" />
                            Import YouTube
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              videos.map((video) => (
                <tr
                  key={video.id}
                  className={`border-b transition-colors hover:bg-muted/40 ${selected.has(video.id) ? "bg-primary/5" : ""}`}
                >
                  {/* Checkbox */}
                  <td className="py-2.5 px-4">
                    <Checkbox
                      checked={selected.has(video.id)}
                      onCheckedChange={() => toggleOne(video.id)}
                      aria-label={`Select ${video.title}`}
                    />
                  </td>

                  {/* Thumbnail */}
                  <td className="py-2.5 px-4">
                    {video.thumbnailUrl ? (
                      <img
                        src={video.thumbnailUrl}
                        alt=""
                        className="w-[72px] h-10 object-cover rounded border border-border bg-muted"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-[72px] h-10 rounded border border-border bg-muted flex items-center justify-center">
                        <Video className="w-4 h-4 text-muted-foreground/40" />
                      </div>
                    )}
                  </td>

                  {/* Title + preacher */}
                  <td className="py-2.5 px-4 max-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-medium truncate block" title={video.title}>
                        {video.title}
                      </span>
                      {video.featured && (
                        <Star className="w-3.5 h-3.5 shrink-0 text-amber-500 fill-amber-500" />
                      )}
                    </div>
                    {video.preacher && (
                      <span className="text-xs text-muted-foreground truncate block">{video.preacher}</span>
                    )}
                    {video.sizeBytes != null && video.sizeBytes > 0 && (
                      <span className="text-[10px] text-muted-foreground/60">{formatBytes(video.sizeBytes)}</span>
                    )}
                  </td>

                  {/* Category */}
                  <td className="py-2.5 px-4">
                    {video.category && (
                      <Badge variant="secondary" className="text-[10px] py-0">{capitalize(video.category)}</Badge>
                    )}
                  </td>

                  {/* Duration */}
                  <td className="py-2.5 px-4 font-mono text-xs text-muted-foreground tabular-nums">
                    {formatDuration(video.duration) || "—"}
                  </td>

                  {/* Source */}
                  <td className="py-2.5 px-4">
                    <SourceBadge source={video.videoSource} />
                  </td>

                  {/* Transcoding */}
                  <td className="py-2.5 px-4">
                    <TranscodingBadge status={video.transcodingStatus} source={video.videoSource} />
                  </td>

                  {/* Imported date */}
                  <td className="py-2.5 px-4 text-xs text-muted-foreground whitespace-nowrap">
                    {fmtDate(video.importedAt)}
                  </td>

                  {/* Actions */}
                  <td className="py-2.5 px-4">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <MoreVertical className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onClick={() => setEditingVideo(video)}>
                          <Edit2 className="w-4 h-4 mr-2" />
                          Edit Metadata
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleAddToQueue(video)}
                          disabled={addingToQueue === video.id}
                        >
                          {addingToQueue === video.id
                            ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            : <Radio className="w-4 h-4 mr-2" />
                          }
                          Add to Broadcast Queue
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleToggleFeatured(video)}>
                          {video.featured
                            ? <><StarOff className="w-4 h-4 mr-2" />Remove from Featured</>
                            : <><Star className="w-4 h-4 mr-2" />Mark as Featured</>
                          }
                        </DropdownMenuItem>
                        {video.videoSource === "youtube" && video.youtubeId && (
                          <DropdownMenuItem asChild>
                            <a
                              href={`https://youtube.com/watch?v=${video.youtubeId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <ExternalLink className="w-4 h-4 mr-2" />
                              View on YouTube
                            </a>
                          </DropdownMenuItem>
                        )}
                        {video.videoSource === "local" && (
                          <>
                            {video.localVideoUrl && (
                              <DropdownMenuItem asChild>
                                <a href={video.localVideoUrl} target="_blank" rel="noopener noreferrer">
                                  <Play className="w-4 h-4 mr-2" />
                                  Play Video
                                </a>
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onClick={() => handleReencode(video)}
                              disabled={reencoding === video.id || video.transcodingStatus === "encoding"}
                            >
                              {reencoding === video.id
                                ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                : <Zap className="w-4 h-4 mr-2" />
                              }
                              Re-encode to HLS
                            </DropdownMenuItem>
                          </>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeletingVideo(video)}
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {!isLoading && !isError && totalPages > 1 && (
        <div className="flex items-center justify-between px-6 py-3 border-t bg-background">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages} · {total.toLocaleString()} videos
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let p: number;
              if (totalPages <= 5) {
                p = i + 1;
              } else if (page <= 3) {
                p = i + 1;
              } else if (page >= totalPages - 2) {
                p = totalPages - 4 + i;
              } else {
                p = page - 2 + i;
              }
              return (
                <Button
                  key={p}
                  variant={p === page ? "default" : "outline"}
                  size="icon"
                  className="h-8 w-8 text-xs"
                  onClick={() => setPage(p)}
                >
                  {p}
                </Button>
              );
            })}
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* ── Modals / Dialogs ─────────────────────────────────────────────── */}
      <VideoUploadModal
        open={showUploadModal}
        onOpenChange={setShowUploadModal}
        storageKey="ttv-library-upload-v1"
        onUploadsComplete={handleUploadComplete}
      />

      <ImportDialog
        open={showImportDialog}
        onOpenChange={setShowImportDialog}
        onImported={handleImported}
      />

      <EditDialog
        video={editingVideo}
        onClose={() => setEditingVideo(null)}
        onSave={handleSaveEdit}
      />

      <AlertDialog open={!!deletingVideo} onOpenChange={(o) => !o && setDeletingVideo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete video?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deletingVideo?.title}</strong> will be permanently removed from the library.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deletingVideo && handleDelete(deletingVideo)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
