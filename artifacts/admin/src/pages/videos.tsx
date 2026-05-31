import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, HttpError } from "@/lib/api";
import { useSSEEvent } from "@/contexts/sse-context";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  Video, Search, MoreVertical, Pencil, Trash2,
  RefreshCw, Star, StarOff, ChevronLeft, ChevronRight, Film, Eye, EyeOff,
  UploadCloud, X, FileVideo, Layers, Lock, LockOpen, Youtube, HardDrive,
  ArrowUpDown, SlidersHorizontal, Zap, Clapperboard, Globe, AlertTriangle,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { uploadQueue, useUploadQueue, formatBytes, titleFromFilename } from "@/lib/upload-queue";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdminVideo {
  id: string;
  youtubeId: string | null;
  title: string;
  description: string;
  thumbnailUrl: string;
  hlsMasterUrl: string | null;
  localVideoUrl: string | null;
  duration: string | null;
  category: string | null;
  preacher: string | null;
  featured: boolean;
  metadataLocked: boolean;
  broadcastOnly: boolean;
  transcodingStatus: string;
  videoSource: string;
  importedAt: string;
  viewCount: number;
  sizeBytes: number | null;
  mimeType: string | null;
  originalFilename: string | null;
  /**
   * Whether the source video file is still in object storage.
   * true  → retry transcoding is possible.
   * false → source was deleted; re-upload is required.
   * null  → not applicable (YouTube video).
   */
  sourceAvailable: boolean | null;
}

interface VideoListResponse {
  videos: AdminVideo[];
  total: number;
  totalPages: number;
  page: number;
  limit: number;
}

interface EditForm {
  title: string;
  description: string;
  category: string;
  preacher: string;
  featured: boolean;
  metadataLocked: boolean;
  broadcastOnly: boolean;
}

// Server-enforced limits — keep client in sync with PatchBodySchema in
// artifacts/api-server/src/modules/admin-videos/admin-videos.routes.ts.
const TITLE_MAX = 500;
const DESC_MAX = 5000;
const PREACHER_MAX = 255;

function snapshotForCompare(f: EditForm): string {
  // Stable key for "is the form different from the saved video?" used to
  // disable the Save button and to compute the delta payload below.
  return JSON.stringify({
    title: f.title.trim(),
    description: f.description,
    category: f.category,
    preacher: f.preacher.trim(),
    featured: f.featured,
    metadataLocked: f.metadataLocked,
    broadcastOnly: f.broadcastOnly,
  });
}

function buildEditDelta(original: EditForm, current: EditForm): Partial<EditForm> {
  // Only send fields that actually changed. Avoids unnecessary writes,
  // unnecessary `videos-library-updated` SSE fan-out, and accidental
  // overwrite of fields a parallel admin may have edited in another tab.
  const delta: Partial<EditForm> = {};
  const tTitle = current.title.trim();
  const tPreacher = current.preacher.trim();
  if (tTitle !== original.title.trim()) delta.title = tTitle;
  if (current.description !== original.description) delta.description = current.description;
  if (current.category !== original.category) delta.category = current.category;
  if (tPreacher !== original.preacher.trim()) delta.preacher = tPreacher;
  if (current.featured !== original.featured) delta.featured = current.featured;
  if (current.metadataLocked !== original.metadataLocked) delta.metadataLocked = current.metadataLocked;
  if (current.broadcastOnly !== original.broadcastOnly) delta.broadcastOnly = current.broadcastOnly;
  return delta;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES: { value: string; label: string }[] = [
  { value: "midnight-prayers", label: "Midnight Prayers" },
  { value: "sermon",           label: "Sermons" },
  { value: "deliverance",      label: "Deliverance" },
  { value: "prayer",           label: "Prayers" },
  { value: "crusade",          label: "Crusades" },
  { value: "conference",       label: "Conferences" },
  { value: "testimony",        label: "Testimonies" },
];
const PAGE_SIZE = 20;

const STATUS_COLORS: Record<string, string> = {
  hls_ready: "default", ready: "default",
  encoding: "secondary", processing: "secondary",
  queued: "outline", failed: "destructive",
  uploaded: "outline", pending: "outline", none: "outline",
};

// ── Format helpers ─────────────────────────────────────────────────────────────

function formatDuration(secs: number | string | null | undefined): string {
  const n = typeof secs === "string" ? parseInt(secs, 10) : (secs ?? 0);
  if (!n || isNaN(n)) return "—";
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── Multi-file upload dialog types ────────────────────────────────────────────

interface DialogFile {
  id: string;
  file: File;
  title: string;
  description: string;
}

// ── Page component ────────────────────────────────────────────────────────────

export default function VideosPage() {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Video list state
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState("newest");
  const [editVideo, setEditVideo] = useState<AdminVideo | null>(null);
  const [deleteVideo, setDeleteVideo] = useState<AdminVideo | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    title: "", description: "", category: "", preacher: "", featured: false, metadataLocked: false, broadcastOnly: false,
  });
  // Original form values captured when the dialog opened — used to compute
  // a delta payload and to enable/disable the Save button.
  const [editOriginal, setEditOriginal] = useState<EditForm | null>(null);
  // Inline error surfaced inside the edit dialog (in addition to the toast)
  // so the user sees exactly which field/limit the server rejected.
  const [editError, setEditError] = useState<string | null>(null);

  // Drag-over state for the page-level drop zone
  const [pageDragOver, setPageDragOver] = useState(false);

  // Bulk selection state — cleared on page/filter change so stale IDs don't
  // linger when the visible video list changes.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // Batch upload dialog state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dialogFiles, setDialogFiles] = useState<DialogFile[]>([]);
  const [bulkCategory, setBulkCategory] = useState("sermon");
  const [bulkPreacher, setBulkPreacher] = useState("");
  const [bulkFeatured, setBulkFeatured] = useState(false);
  const [dialogDragOver, setDialogDragOver] = useState(false);
  const [titleErrors, setTitleErrors] = useState<Set<string>>(new Set());

  // Upload queue — used only to show active count in the button
  const { summary } = useUploadQueue();

  // ── Data fetching ──────────────────────────────────────────────────────────

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-videos", page, search, statusFilter, sourceFilter, categoryFilter, sortOrder],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), sort: sortOrder });
      if (search) params.set("search", search);
      if (statusFilter !== "all") params.set("transcodingStatus", statusFilter);
      if (sourceFilter !== "all") params.set("source", sourceFilter);
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      return api.get<VideoListResponse>(`/admin/videos?${params}`);
    },
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    // Use the global retry/retryDelay policy (up to 5 retries for cold-start errors).
    // Auto-refetch every 15 s while in error state so the page self-heals once the
    // API server finishes its cold start without requiring a manual "Retry" click.
    refetchInterval: (query) => query.state.status === "error" ? 15_000 : false,
  });

  useSSEEvent("videos-library-updated", (payload) => {
    void qc.invalidateQueries({ queryKey: ["admin-videos"] });
    const p = payload as { reason?: string } | null;
    if (p?.reason === "corrupt-upload-failed") {
      toast.error(
        "Upload rejected — file is corrupt or unreadable. Delete the video and re-upload a valid copy.",
        { duration: 10_000 },
      );
    }
  });
  // Transcoding status changes (queued → encoding → hls_ready) must refresh
  // immediately so the badge in the video list reflects reality. refetchType
  // defaults to "active" — only re-fetches the currently-mounted query (avoids
  // skeleton flash on background pages while still updating the visible list).
  useSSEEvent("transcoding-update", () => {
    void qc.invalidateQueries({ queryKey: ["admin-videos"] });
  });

  // Belt-and-suspenders: when any upload completes, force-invalidate the
  // admin-videos query so the newly uploaded video appears immediately —
  // even if the SSE "videos-library-updated" event was missed because the
  // SSE connection dropped between finalize and event delivery.
  useEffect(() => {
    return uploadQueue.onComplete(() => {
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      // Keep the Dashboard "Total Videos" count in sync after uploads complete.
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
    });
  }, [qc]);

  // Clamp page to totalPages when bulk deletions or filter changes shrink
  // the result set below the current page — otherwise the user sees an
  // empty list with no way to navigate back unless they manually change page.
  useEffect(() => {
    if (data && data.totalPages > 0 && page > data.totalPages) {
      setPage(data.totalPages);
    }
  }, [data, page]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }: Partial<EditForm> & { id: string }) =>
      api.patch<AdminVideo>(`/admin/videos/${id}`, body),
    onSuccess: (updatedRow) => {
      // Patch every cached page in place so the row updates without a
      // skeleton flash. The SSE invalidate-on-`videos-library-updated`
      // handler still refreshes other clients; this is purely a local
      // smoothness fix for the admin who just saved.
      qc.setQueriesData<VideoListResponse>(
        { queryKey: ["admin-videos"] },
        (prev) => prev
          ? { ...prev, videos: prev.videos.map((v) => v.id === updatedRow.id ? { ...v, ...updatedRow } : v) }
          : prev,
      );
      toast.success("Video updated");
      setEditVideo(null);
      setEditOriginal(null);
      setEditError(null);
    },
    onError: (e) => {
      const msg = e instanceof HttpError ? e.message : "Update failed";
      setEditError(msg);
      toast.error(msg);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/videos/${id}`),
    onSuccess: () => {
      toast.success("Video deleted");
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      // Also refresh the broadcast queue so any orphan references to this
      // video are cleared from the queue panel immediately — without this,
      // the queue UI shows stale items with broken source URLs until the
      // next natural SSE-triggered invalidation.
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      setDeleteVideo(null);
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Delete failed"),
  });

  const featureMutation = useMutation({
    mutationFn: ({ id, featured }: { id: string; featured: boolean }) =>
      api.patch(`/admin/videos/${id}`, { featured }),
    onMutate: async ({ id, featured }) => {
      await qc.cancelQueries({ queryKey: ["admin-videos"] });
      const prev = qc.getQueriesData<VideoListResponse>({ queryKey: ["admin-videos"] });
      qc.setQueriesData<VideoListResponse>(
        { queryKey: ["admin-videos"] },
        (old) => old ? { ...old, videos: old.videos.map((v) => v.id === id ? { ...v, featured } : v) } : old,
      );
      return { prev };
    },
    onSuccess: (_data, { featured }) => {
      toast.success(featured ? "Video featured" : "Video unfeatured");
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) ctx.prev.forEach(([key, data]) => qc.setQueryData(key, data));
      toast.error("Failed");
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["admin-videos"] }),
  });

  const lockMutation = useMutation({
    mutationFn: ({ id, metadataLocked }: { id: string; metadataLocked: boolean }) =>
      api.patch(`/admin/videos/${id}`, { metadataLocked }),
    onMutate: async ({ id, metadataLocked }) => {
      await qc.cancelQueries({ queryKey: ["admin-videos"] });
      const prev = qc.getQueriesData<VideoListResponse>({ queryKey: ["admin-videos"] });
      qc.setQueriesData<VideoListResponse>(
        { queryKey: ["admin-videos"] },
        (old) => old ? { ...old, videos: old.videos.map((v) => v.id === id ? { ...v, metadataLocked } : v) } : old,
      );
      return { prev };
    },
    onSuccess: (_data, { metadataLocked }) => {
      toast.success(metadataLocked ? "Metadata locked — YouTube sync won't overwrite" : "Metadata unlocked");
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) ctx.prev.forEach(([key, data]) => qc.setQueryData(key, data));
      toast.error("Failed");
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["admin-videos"] }),
  });

  const publishMutation = useMutation({
    mutationFn: ({ id, broadcastOnly }: { id: string; broadcastOnly: boolean }) =>
      api.patch(`/admin/videos/${id}`, { broadcastOnly }),
    onMutate: async ({ id, broadcastOnly }) => {
      await qc.cancelQueries({ queryKey: ["admin-videos"] });
      const prev = qc.getQueriesData<VideoListResponse>({ queryKey: ["admin-videos"] });
      qc.setQueriesData<VideoListResponse>(
        { queryKey: ["admin-videos"] },
        (old) => old ? { ...old, videos: old.videos.map((v) => v.id === id ? { ...v, broadcastOnly } : v) } : old,
      );
      return { prev };
    },
    onSuccess: (_data, { broadcastOnly }) => {
      toast.success(broadcastOnly ? "Hidden from public library" : "Published to public library");
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) ctx.prev.forEach(([key, data]) => qc.setQueryData(key, data));
      toast.error("Failed");
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["admin-videos"] }),
  });

  const transcodeMutation = useMutation({
    mutationFn: (id: string) =>
      api.post<{ jobId: string; reused: boolean }>(`/admin/videos/${id}/transcode`),
    onSuccess: (res) => {
      toast.success(res.reused ? "HLS job re-queued" : "Queued for HLS transcoding — check the Transcoding tab");
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Transcoding request failed"),
  });

  const faststartMutation = useMutation({
    mutationFn: (id: string) =>
      api.post<{ ok: boolean; videoId: string }>(`/admin/videos/${id}/faststart`),
    onSuccess: () => {
      toast.success("Faststart started — status will update to 'ready' in ~30–90 seconds");
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Faststart request failed"),
  });

  const batchRetryMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; retried: number }>("/admin/ops/transcoding/retry-failed"),
    onSuccess: (res) => {
      if (res.retried === 0) {
        toast.info("No failed transcoding jobs found to retry.");
      } else {
        toast.success(`Re-queued ${res.retried} failed job${res.retried !== 1 ? "s" : ""} — they will encode shortly.`);
        void qc.invalidateQueries({ queryKey: ["admin-videos"] });
        void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      }
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Batch retry failed"),
  });

  // Bulk transcode — fires individual transcode requests for each selected ID
  // in parallel. Failures are silent per-item so a single bad video doesn't
  // block the rest; the final toast reports the success count.
  const bulkTranscodeMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.all(
        ids.map((id) =>
          api.post<{ jobId: string; reused: boolean }>(`/admin/videos/${id}/transcode`)
            .then(() => true)
            .catch(() => false)
        )
      );
      return results.filter(Boolean).length;
    },
    onSuccess: (count, ids) => {
      const failed = ids.length - count;
      if (count > 0) toast.success(`Queued ${count} video${count !== 1 ? "s" : ""} for HLS transcoding`);
      if (failed > 0) toast.warning(`${failed} video${failed !== 1 ? "s" : ""} could not be queued (already encoding or YouTube source)`);
      setSelectedIds(new Set());
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
    },
    onError: () => toast.error("Bulk transcode request failed"),
  });

  // Bulk delete — runs sequentially to avoid hammering the DB with concurrent
  // DELETEs on a large selection. Reports success count on completion.
  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      let count = 0;
      for (const id of ids) {
        try { await api.delete(`/admin/videos/${id}`); count++; } catch { /* skip — already deleted or foreign key */ }
      }
      return count;
    },
    onSuccess: (count) => {
      toast.success(`Deleted ${count} video${count !== 1 ? "s" : ""}`);
      setSelectedIds(new Set());
      setBulkDeleteOpen(false);
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
    },
    onError: () => toast.error("Bulk delete failed"),
  });

  const openEdit = (v: AdminVideo) => {
    const initial: EditForm = {
      title: v.title,
      description: v.description,
      category: v.category ?? "",
      preacher: v.preacher ?? "",
      featured: v.featured,
      metadataLocked: v.metadataLocked,
      broadcastOnly: v.broadcastOnly,
    };
    setEditForm(initial);
    setEditOriginal(initial);
    setEditError(null);
    setEditVideo(v);
  };

  // ── Bulk selection helpers ─────────────────────────────────────────────────

  const toggleSelection = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });

  const currentPageIds = data?.videos?.map((v) => v.id) ?? [];
  const allOnPageSelected =
    currentPageIds.length > 0 && currentPageIds.every((id) => selectedIds.has(id));
  const someOnPageSelected = currentPageIds.some((id) => selectedIds.has(id));

  const toggleSelectPage = () => {
    if (allOnPageSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        currentPageIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds((prev) => new Set([...prev, ...currentPageIds]));
    }
  };

  // Auto-clear selection when filters or page change so stale IDs don't linger.
  const handleSearch = () => { setSearch(searchInput); setPage(1); setSelectedIds(new Set()); };

  const resetFilters = () => {
    setSearch(""); setSearchInput(""); setStatusFilter("all");
    setSourceFilter("all"); setCategoryFilter("all"); setSortOrder("newest"); setPage(1);
    setSelectedIds(new Set());
  };
  const hasActiveFilters = search || statusFilter !== "all" || sourceFilter !== "all" || categoryFilter !== "all" || sortOrder !== "newest";

  // ── Multi-file upload helpers ──────────────────────────────────────────────

  // Warn (but don't block) if any file exceeds this size — very large files
  // take a long time and may hit timeout or memory limits in fallback mode.
  const LARGE_FILE_WARN_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

  const addFilesToDialog = useCallback((rawFiles: File[]) => {
    const vids = rawFiles.filter((f) => f.type.startsWith("video/") || /\.(mp4|mov|mkv|avi|webm|m4v|flv|wmv|ts|mts|m2ts)$/i.test(f.name));
    if (vids.length === 0) {
      toast.error("Please select video files (MP4, MOV, MKV, etc.)");
      return;
    }
    if (rawFiles.length > vids.length) {
      toast.warning(`${rawFiles.length - vids.length} non-video file(s) were skipped`);
    }
    const largeFiles = vids.filter((f) => f.size > LARGE_FILE_WARN_BYTES);
    if (largeFiles.length > 0) {
      toast.warning(
        `${largeFiles.length} file${largeFiles.length > 1 ? "s are" : " is"} over 5 GB — uploads may take a long time`,
        { duration: 6000 }
      );
    }
    const newDialogFiles: DialogFile[] = vids.map((f) => ({
      id: crypto.randomUUID(), file: f, title: titleFromFilename(f.name), description: "",
    }));
    setDialogFiles((prev) => {
      // Deduplicate by name + size to allow different files with the same name from different folders
      const existing = new Set(prev.map((df) => `${df.file.name}::${df.file.size}`));
      return [...prev, ...newDialogFiles.filter((df) => !existing.has(`${df.file.name}::${df.file.size}`))];
    });
    setUploadOpen(true);
  }, []);

  const handlePageDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setPageDragOver(false);
    addFilesToDialog(Array.from(e.dataTransfer.files));
  }, [addFilesToDialog]);

  const handleDialogDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDialogDragOver(false);
    addFilesToDialog(Array.from(e.dataTransfer.files));
  }, [addFilesToDialog]);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) addFilesToDialog(files);
    e.target.value = "";
  };

  const removeDialogFile = (id: string) => {
    setDialogFiles((prev) => prev.filter((f) => f.id !== id));
    setTitleErrors((prev) => { const next = new Set(prev); next.delete(id); return next; });
  };

  const updateDialogTitle = (id: string, title: string) => {
    setDialogFiles((prev) => prev.map((f) => f.id === id ? { ...f, title } : f));
    if (title.trim()) setTitleErrors((prev) => { const next = new Set(prev); next.delete(id); return next; });
  };

  const updateDialogDescription = (id: string, description: string) =>
    setDialogFiles((prev) => prev.map((f) => f.id === id ? { ...f, description } : f));

  const handleStartUploads = () => {
    if (dialogFiles.length === 0) return;
    const emptyIds = dialogFiles.filter((df) => !df.title.trim()).map((df) => df.id);
    if (emptyIds.length > 0) {
      setTitleErrors(new Set(emptyIds));
      toast.error(
        `${emptyIds.length} file${emptyIds.length > 1 ? "s are" : " is"} missing a title — please fill in the required fields`,
        { duration: 5000 },
      );
      return;
    }
    uploadQueue.enqueue(dialogFiles.map((df) => ({
      file: df.file,
      title: df.title.trim(),
      description: df.description.trim(),
      category: bulkCategory || "sermon",
      preacher: bulkPreacher.trim(),
      featured: bulkFeatured,
    })));
    toast.success(`${dialogFiles.length} file${dialogFiles.length > 1 ? "s" : ""} added to upload queue`);
    setUploadOpen(false);
    setDialogFiles([]);
    setTitleErrors(new Set());
    setBulkCategory("sermon");
    setBulkPreacher("");
    setBulkFeatured(false);
  };

  const totalPages = data?.totalPages ?? 1;
  const activeUploads = summary.active + summary.pending;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6 relative"
      onDragOver={(e) => { e.preventDefault(); setPageDragOver(true); }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setPageDragOver(false);
      }}
      onDrop={handlePageDrop}
    >
      {/* Page-level drag overlay */}
      {pageDragOver && (
        <div className="absolute inset-0 z-20 bg-primary/5 border-2 border-dashed border-primary rounded-xl flex items-center justify-center pointer-events-none">
          <div className="text-center bg-background/90 rounded-xl px-10 py-8 shadow-lg">
            <UploadCloud size={48} className="mx-auto text-primary mb-3" />
            <p className="text-lg font-semibold">Drop videos to upload</p>
            <p className="text-sm text-muted-foreground mt-1">Multiple files supported</p>
          </div>
        </div>
      )}

      <PageHeader
        title="Videos"
        description={`${data?.total ?? 0} videos in library`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
              <RefreshCw size={13} /> Refresh
            </Button>
            <Button size="sm" onClick={() => setUploadOpen(true)} className="gap-1.5 relative">
              <UploadCloud size={14} />
              Upload Video
              {activeUploads > 0 && (
                <span className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center">
                  {activeUploads > 9 ? "9+" : activeUploads}
                </span>
              )}
            </Button>
          </div>
        }
      />

      {error && (
        <ErrorAlert
          message={(error as Error).message}
          onRetry={() => void refetch()}
          transient={
            error instanceof HttpError &&
            (error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504)
          }
        />
      )}

      {/* Filters row */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Search */}
        <div className="flex gap-1.5 flex-1 min-w-0 max-w-sm">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search title, preacher…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="pl-8 h-8 text-sm"
            />
          </div>
          <Button size="sm" variant="secondary" className="h-8" onClick={handleSearch}>Search</Button>
        </div>

        {/* Source */}
        <Select value={sourceFilter} onValueChange={(v) => { setSourceFilter(v); setPage(1); setSelectedIds(new Set()); }}>
          <SelectTrigger className="h-8 text-sm w-36">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="youtube"><span className="flex items-center gap-1.5"><Youtube size={11} />YouTube</span></SelectItem>
            <SelectItem value="local"><span className="flex items-center gap-1.5"><HardDrive size={11} />Uploaded</span></SelectItem>
          </SelectContent>
        </Select>

        {/* Category */}
        <Select value={categoryFilter} onValueChange={(v) => { setCategoryFilter(v); setPage(1); setSelectedIds(new Set()); }}>
          <SelectTrigger className="h-8 text-sm w-36">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Status */}
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); setSelectedIds(new Set()); }}>
          <SelectTrigger className="h-8 text-sm w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="hls_ready">Ready</SelectItem>
            <SelectItem value="encoding">Encoding</SelectItem>
            <SelectItem value="queued">Queued</SelectItem>
            <SelectItem value="none">Not transcoded</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>

        {/* Sort */}
        <Select value={sortOrder} onValueChange={(v) => { setSortOrder(v); setPage(1); setSelectedIds(new Set()); }}>
          <SelectTrigger className="h-8 text-sm w-40">
            <ArrowUpDown size={12} className="mr-1 text-muted-foreground" />
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest imported</SelectItem>
            <SelectItem value="oldest">Oldest imported</SelectItem>
            <SelectItem value="published">Published date</SelectItem>
            <SelectItem value="views">Most viewed</SelectItem>
            <SelectItem value="title">Title A–Z</SelectItem>
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <Button size="sm" variant="ghost" onClick={resetFilters} className="h-8 gap-1 text-muted-foreground hover:text-foreground">
            <SlidersHorizontal size={12} /> Clear
          </Button>
        )}
      </div>

      {/* Failed-upload alert banner — shown when failed local videos exist on
          the current page and the user hasn't already filtered to the failed view.
          Two flavours:
          • retryableCount > 0 → source still in storage; can retry transcoding.
          • noSourceCount  > 0 → source was deleted; re-upload genuinely required. */}
      {(() => {
        const failedLocal = data?.videos.filter(
          (v) => v.transcodingStatus === "failed" && v.videoSource === "local",
        ) ?? [];
        if (failedLocal.length === 0 || statusFilter === "failed") return null;
        const retryableCount = failedLocal.filter((v) => v.sourceAvailable !== false).length;
        const noSourceCount  = failedLocal.filter((v) => v.sourceAvailable === false).length;
        return (
          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20 px-4 py-3">
            <AlertTriangle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                {failedLocal.length} video{failedLocal.length !== 1 ? "s" : ""} failed transcoding
              </p>
              <p className="text-xs text-amber-600/70 dark:text-amber-400/70 mt-0.5">
                {retryableCount > 0 && noSourceCount === 0 &&
                  `${retryableCount} file${retryableCount !== 1 ? "s have" : " has"} their source still available — use "Retry Transcoding" to re-process without re-uploading.`}
                {noSourceCount > 0 && retryableCount === 0 &&
                  `Source file${noSourceCount !== 1 ? "s were" : " was"} deleted — delete each video and re-upload a fresh copy to recover.`}
                {retryableCount > 0 && noSourceCount > 0 &&
                  `${retryableCount} can be retried directly; ${noSourceCount} require a fresh upload (source deleted).`}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {retryableCount > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={batchRetryMutation.isPending}
                  className="h-7 text-xs border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-400 dark:hover:bg-amber-950/50"
                  onClick={() => batchRetryMutation.mutate()}
                >
                  {batchRetryMutation.isPending
                    ? <><RefreshCw size={11} className="animate-spin mr-1" />Retrying…</>
                    : <><RefreshCw size={11} className="mr-1" />Retry All Failed</>}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-950/40"
                onClick={() => { setStatusFilter("failed"); setSourceFilter("local"); setPage(1); }}
              >
                Show failed
              </Button>
            </div>
          </div>
        );
      })()}

      {/* Bulk-action toolbar — appears when ≥1 video is selected */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-2.5">
          <Checkbox
            id="select-all-page"
            checked={allOnPageSelected ? true : someOnPageSelected ? "indeterminate" : false}
            onCheckedChange={toggleSelectPage}
            aria-label="Toggle select all on this page"
          />
          <span className="text-sm font-medium">
            {selectedIds.size} video{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex items-center gap-2 ml-auto">
            <Button
              size="sm"
              variant="outline"
              disabled={bulkTranscodeMutation.isPending}
              onClick={() => bulkTranscodeMutation.mutate([...selectedIds])}
              className="h-7 px-2.5 text-xs gap-1"
              title="Queue all selected local videos for HLS transcoding. YouTube videos are skipped."
            >
              <Zap size={11} className="text-amber-500" />
              {bulkTranscodeMutation.isPending ? "Queuing…" : "Transcode selected"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={bulkDeleteMutation.isPending}
              onClick={() => setBulkDeleteOpen(true)}
              className="h-7 px-2.5 text-xs gap-1 text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-800 dark:hover:bg-red-950/20"
            >
              <Trash2 size={11} />
              {bulkDeleteMutation.isPending ? "Deleting…" : "Delete selected"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelectedIds(new Set())}
              className="h-7 px-2 text-xs text-muted-foreground"
            >
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* Video Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="divide-y">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="flex items-center gap-3 p-3">
                  <Skeleton className="h-12 w-20 rounded flex-shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-64" />
                    <Skeleton className="h-3 w-40" />
                  </div>
                  <Skeleton className="h-5 w-16" />
                </div>
              ))}
            </div>
          ) : (data?.videos?.length ?? 0) === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <Film size={36} className="text-muted-foreground/20" />
              <p className="font-medium">No videos found</p>
              <p className="text-sm text-muted-foreground">
                {hasActiveFilters ? "Try adjusting your filters." : "Upload a video or drag files here to get started."}
              </p>
              {!hasActiveFilters && (
                <Button size="sm" onClick={() => setUploadOpen(true)} className="gap-1.5 mt-1">
                  <UploadCloud size={14} /> Upload Video
                </Button>
              )}
            </div>
          ) : (
            <div className="divide-y">
              {/* Select-all row header — shows only while data is present */}
              {(data?.videos?.length ?? 0) > 0 && (
                <div className="flex items-center gap-3 px-4 py-2 bg-muted/20 border-b">
                  <Checkbox
                    checked={allOnPageSelected ? true : someOnPageSelected ? "indeterminate" : false}
                    onCheckedChange={toggleSelectPage}
                    aria-label="Select all videos on this page"
                    className="shrink-0"
                  />
                  <span className="text-xs text-muted-foreground">
                    {allOnPageSelected
                      ? `All ${currentPageIds.length} on this page selected`
                      : someOnPageSelected
                      ? `${selectedIds.size} selected`
                      : "Select all on this page"}
                  </span>
                </div>
              )}
              {data!.videos.map((v) => (
                <div key={v.id} className={`flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors group ${selectedIds.has(v.id) ? "bg-primary/5" : ""}`}>
                  {/* Row checkbox */}
                  <Checkbox
                    checked={selectedIds.has(v.id)}
                    onCheckedChange={() => toggleSelection(v.id)}
                    aria-label={`Select ${v.title}`}
                    className="shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  />
                  {/* Thumbnail */}
                  <div className="flex-shrink-0 w-20 h-12 rounded overflow-hidden bg-black">
                    {v.thumbnailUrl ? (
                      <img src={v.thumbnailUrl} alt={`Thumbnail for ${v.title}`} className="w-full h-full object-contain" loading="lazy" decoding="async" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Video size={18} className="text-muted-foreground/30" />
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="font-medium text-sm truncate">{v.title || "Untitled"}</p>
                      {v.featured && <Star size={11} className="text-amber-500 fill-amber-500 flex-shrink-0" />}
                      {v.metadataLocked && (
                        <span title="Metadata locked — YouTube sync won't overwrite">
                          <Lock size={10} className="text-blue-500 flex-shrink-0" />
                        </span>
                      )}
                      {v.broadcastOnly && (
                        <span title="Broadcast only — hidden from public library. Click ⋮ → Publish to library to make it visible.">
                          <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 border-orange-400 text-orange-500">Broadcast only</Badge>
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      {v.videoSource === "youtube"
                        ? <span className="text-[10px] text-muted-foreground/60 flex items-center gap-0.5"><Youtube size={9} />YouTube</span>
                        : <span className="text-[10px] text-muted-foreground/60 flex items-center gap-0.5"><HardDrive size={9} />Uploaded</span>
                      }
                      {v.preacher && <span className="text-xs text-muted-foreground">{v.preacher}</span>}
                      {v.category && <span className="text-xs text-muted-foreground capitalize">{v.category}</span>}
                      {v.duration && <span className="text-xs text-muted-foreground">{formatDuration(v.duration)}</span>}
                      {v.sizeBytes != null && <span className="text-xs text-muted-foreground">{formatBytes(v.sizeBytes)}</span>}
                      {v.viewCount > 0 && (
                        <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                          <Eye size={10} /> {v.viewCount.toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Status badge */}
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <Badge
                      variant={(STATUS_COLORS[v.transcodingStatus] ?? "outline") as "default" | "secondary" | "outline" | "destructive"}
                      className="capitalize text-[11px]"
                    >
                      {v.transcodingStatus === "hls_ready" || v.transcodingStatus === "ready"
                        ? "Ready"
                        : v.transcodingStatus || "—"}
                    </Badge>
                    {v.transcodingStatus === "failed" && v.videoSource === "local" && (
                      v.sourceAvailable === false ? (
                        <span title="Source file was deleted — delete this video and re-upload a fresh copy to recover.">
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 h-4 border-red-400 text-red-600 dark:text-red-400 flex items-center gap-0.5 cursor-default"
                          >
                            <UploadCloud size={9} className="flex-shrink-0" />
                            Re-upload required
                          </Badge>
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-5 text-[10px] px-1.5 border-amber-400 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 flex items-center gap-0.5"
                          title="Source file is still available — click to retry HLS transcoding without re-uploading"
                          disabled={transcodeMutation.isPending}
                          onClick={(e) => { e.stopPropagation(); transcodeMutation.mutate(v.id); }}
                        >
                          <RefreshCw size={9} className="flex-shrink-0" />
                          Retry Transcoding
                        </Button>
                      )
                    )}
                  </div>

                  {/* Actions — always visible on touch, hover-only on pointer devices */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button aria-label={`Actions for ${v.title}`} variant="ghost" size="icon" className="h-7 w-7 flex-shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100">
                        <MoreVertical size={14} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(v)}>
                        <Pencil size={13} className="mr-2" /> Edit metadata
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => featureMutation.mutate({ id: v.id, featured: !v.featured })}>
                        {v.featured
                          ? <><StarOff size={13} className="mr-2" /> Unfeature</>
                          : <><Star size={13} className="mr-2" /> Feature</>}
                      </DropdownMenuItem>
                      {/* Metadata lock only affects YouTube sync — hide it for
                          uploaded/HLS videos where it would be a confusing no-op. */}
                      {v.videoSource === "youtube" && (
                        <DropdownMenuItem onClick={() => lockMutation.mutate({ id: v.id, metadataLocked: !v.metadataLocked })}>
                          {v.metadataLocked
                            ? <><LockOpen size={13} className="mr-2" /> Unlock metadata</>
                            : <><Lock size={13} className="mr-2" /> Lock metadata</>}
                        </DropdownMenuItem>
                      )}
                      {v.videoSource === "local" && v.transcodingStatus !== "hls_ready" && (
                        <DropdownMenuItem
                          onClick={() => transcodeMutation.mutate(v.id)}
                          disabled={transcodeMutation.isPending}
                        >
                          <Zap size={13} className="mr-2 text-amber-500" />
                          {v.transcodingStatus === "queued" || v.transcodingStatus === "encoding" || v.transcodingStatus === "processing"
                            ? "Re-queue HLS"
                            : v.transcodingStatus === "failed"
                              ? "Retry Transcoding"
                              : "Convert to HLS"}
                        </DropdownMenuItem>
                      )}
                      {v.videoSource === "local" && (v.transcodingStatus === "queued" || v.transcodingStatus === "failed" || v.transcodingStatus === "none") && (
                        <DropdownMenuItem
                          onClick={() => faststartMutation.mutate(v.id)}
                          disabled={faststartMutation.isPending}
                          title="Relocate the moov atom to the front of the MP4 file so it can play from byte 0 — takes 30–90 seconds"
                        >
                          <Clapperboard size={13} className="mr-2 text-orange-500" />
                          Re-apply faststart
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() => publishMutation.mutate({ id: v.id, broadcastOnly: !v.broadcastOnly })}
                        disabled={publishMutation.isPending}
                        title={v.broadcastOnly ? "Make this video visible in the public library" : "Hide from public library (still available in broadcast queue)"}
                      >
                        {v.broadcastOnly
                          ? <><Globe size={13} className="mr-2 text-green-600" /> Publish to library</>
                          : <><EyeOff size={13} className="mr-2 text-orange-500" /> Hide from library</>}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-red-600 focus:text-red-600"
                        onClick={() => setDeleteVideo(v)}
                      >
                        <Trash2 size={13} className="mr-2" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {data ? `Page ${page} of ${totalPages} · ${data.total.toLocaleString()} total` : ""}
        </p>
        {totalPages > 1 && (
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="h-7">
              <ChevronLeft size={13} />
            </Button>
            {/* Page number pills — show up to 5 */}
            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
              const mid = Math.min(Math.max(page, 3), totalPages - 2);
              const start = Math.max(1, totalPages <= 5 ? 1 : mid - 2);
              const n = start + i;
              if (n > totalPages) return null;
              return (
                <Button
                  key={n}
                  size="sm"
                  variant={n === page ? "default" : "outline"}
                  className="h-7 w-7 text-xs"
                  onClick={() => setPage(n)}
                >
                  {n}
                </Button>
              );
            })}
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="h-7">
              <ChevronRight size={13} />
            </Button>
          </div>
        )}
      </div>

      {/* ── Batch Upload Dialog ─────────────────────────────────────────────── */}
      <Dialog
        open={uploadOpen}
        onOpenChange={(open) => {
          setUploadOpen(open);
          if (!open) { setDialogFiles([]); setDialogDragOver(false); setBulkFeatured(false); }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UploadCloud size={18} />
              Upload Videos
              {dialogFiles.length > 0 && (
                <Badge variant="secondary" className="ml-1 text-xs">
                  {dialogFiles.length} file{dialogFiles.length !== 1 ? "s" : ""}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              Select or drop multiple video files. They upload in parallel with real-time progress. Supports any size.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-4 min-h-0">
            {/* Drop zone */}
            <div
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                dialogDragOver ? "border-primary bg-primary/5" : "hover:border-primary/50 hover:bg-muted/30"
              }`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDialogDragOver(true); }}
              onDragLeave={() => setDialogDragOver(false)}
              onDrop={handleDialogDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*,.mp4,.mov,.mkv,.avi,.webm,.m4v,.flv,.wmv,.ts,.mts"
                multiple
                className="hidden"
                onChange={handleFileInputChange}
              />
              <UploadCloud size={28} className={`mx-auto mb-2 ${dialogDragOver ? "text-primary" : "text-muted-foreground/40"}`} />
              {dialogFiles.length === 0 ? (
                <>
                  <p className="text-sm font-medium">Drop video files here or click to browse</p>
                  <p className="text-xs text-muted-foreground mt-1">MP4, MOV, MKV, AVI, WebM · multiple files · 200 MB–5 GB+</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-primary">Drop more files to add them</p>
                  <p className="text-xs text-muted-foreground mt-1">Or click to open file picker</p>
                </>
              )}
            </div>

            {/* Bulk settings */}
            {dialogFiles.length > 0 && (
              <>
                <div className="space-y-2 p-3 bg-muted/30 rounded-lg">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs font-medium text-muted-foreground">Category (all files)</Label>
                      <Select value={bulkCategory} onValueChange={setBulkCategory}>
                        <SelectTrigger className="h-8 text-sm">
                          <SelectValue placeholder="Select…" />
                        </SelectTrigger>
                        <SelectContent>
                          {CATEGORIES.map(c => (
                            <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs font-medium text-muted-foreground">Preacher (all files)</Label>
                      <Input
                        value={bulkPreacher}
                        onChange={(e) => setBulkPreacher(e.target.value)}
                        placeholder="Speaker name"
                        className="h-8 text-sm"
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Featured (all files)</Label>
                      <p className="text-[10px] text-muted-foreground/70">Show on home screen hero</p>
                    </div>
                    <Switch checked={bulkFeatured} onCheckedChange={setBulkFeatured} />
                  </div>
                </div>

                {/* Per-file list */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Files ({dialogFiles.length})
                    </Label>
                    <span className="text-xs text-muted-foreground">
                      Total: {formatBytes(dialogFiles.reduce((s, f) => s + f.file.size, 0))}
                    </span>
                  </div>
                  <div className="space-y-2 max-h-[22rem] overflow-y-auto pr-0.5">
                    {dialogFiles.map((df) => {
                      const hasError = titleErrors.has(df.id);
                      return (
                        <div
                          key={df.id}
                          className={`p-2.5 rounded-lg border transition-colors ${
                            hasError
                              ? "border-red-400 bg-red-50/40 dark:bg-red-950/10"
                              : "border-border/50 bg-muted/20"
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <FileVideo size={15} className="text-muted-foreground flex-shrink-0 mt-2.5" />
                            <div className="flex-1 min-w-0 space-y-2">
                              {/* Title (required) */}
                              <div>
                                <div className="flex items-center gap-1 mb-1">
                                  <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                                    Title <span className="text-red-500">*</span>
                                  </Label>
                                  {hasError && (
                                    <span className="text-[10px] text-red-500 font-medium">Required</span>
                                  )}
                                </div>
                                <Input
                                  value={df.title}
                                  onChange={(e) => updateDialogTitle(df.id, e.target.value)}
                                  placeholder="Enter video title…"
                                  className={`h-7 text-sm ${
                                    hasError ? "border-red-400 focus-visible:ring-red-400/50" : ""
                                  }`}
                                />
                              </div>
                              {/* Description (optional) */}
                              <div>
                                <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">
                                  Description
                                </Label>
                                <Input
                                  value={df.description}
                                  onChange={(e) => updateDialogDescription(df.id, e.target.value)}
                                  placeholder="Optional short description"
                                  className="h-7 text-sm"
                                />
                              </div>
                              <p className="text-[10px] text-muted-foreground truncate">
                                {df.file.name} · {formatBytes(df.file.size)}
                              </p>
                            </div>
                            <Button
                              variant="ghost" size="icon"
                              className="h-6 w-6 flex-shrink-0 text-muted-foreground hover:text-red-500 mt-1"
                              onClick={() => removeDialogFile(df.id)}
                            >
                              <X size={12} />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>

          <DialogFooter className="flex-shrink-0 border-t border-border pt-4 mt-2">
            <Button variant="ghost" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button onClick={handleStartUploads} disabled={dialogFiles.length === 0} className="gap-2">
              <Layers size={14} />
              {dialogFiles.length === 0
                ? "Add files to upload"
                : `Add ${dialogFiles.length} file${dialogFiles.length !== 1 ? "s" : ""} to Queue`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Dialog ────────────────────────────────────────────────────── */}
      <Dialog
        open={!!editVideo}
        onOpenChange={(o) => {
          // Block dismiss while a save is in flight so the user can see the
          // outcome (success toast / inline error) without the dialog
          // unmounting underneath them.
          if (!o && updateMutation.isPending) return;
          if (!o) {
            setEditVideo(null);
            setEditOriginal(null);
            setEditError(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Pencil size={16} /> Edit metadata
            </DialogTitle>
            <DialogDescription>
              {editVideo?.videoSource === "youtube"
                ? "Update the library record for this YouTube video. Lock metadata to prevent YouTube sync from overwriting your edits."
                : "Update the library record for this uploaded video."}
            </DialogDescription>
          </DialogHeader>

          {(() => {
            // Derived flags — recomputed on every render so they always
            // reflect the latest form state without extra useMemos.
            const titleTrimmed = editForm.title.trim();
            const titleInvalid = titleTrimmed.length === 0 || titleTrimmed.length > TITLE_MAX;
            const descOver = editForm.description.length > DESC_MAX;
            const preacherOver = editForm.preacher.trim().length > PREACHER_MAX;
            const dirty = editOriginal
              ? snapshotForCompare(editForm) !== snapshotForCompare(editOriginal)
              : false;
            const canSave = !updateMutation.isPending && dirty && !titleInvalid && !descOver && !preacherOver;

            const submit = () => {
              if (!editVideo || !editOriginal || !canSave) return;
              const delta = buildEditDelta(editOriginal, editForm);
              if (Object.keys(delta).length === 0) { setEditVideo(null); return; }
              setEditError(null);
              updateMutation.mutate({ id: editVideo.id, ...delta });
            };

            // Cmd/Ctrl+Enter from any input/textarea inside the form submits.
            const onKeyDown = (e: React.KeyboardEvent) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            };

            return (
              <>
                <div className="flex-1 overflow-y-auto space-y-4 min-h-0 pr-1" onKeyDown={onKeyDown}>
                  {/* Read-only context strip so the editor knows what they're touching */}
                  {editVideo && (
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground border rounded-md px-3 py-2 bg-muted/20">
                      {editVideo.videoSource === "youtube"
                        ? <span className="flex items-center gap-1"><Youtube size={11} /> YouTube</span>
                        : <span className="flex items-center gap-1"><HardDrive size={11} /> Uploaded</span>}
                      <span className="opacity-50">·</span>
                      <span className="capitalize">{editVideo.transcodingStatus || "—"}</span>
                      {editVideo.duration && <><span className="opacity-50">·</span><span>{formatDuration(editVideo.duration)}</span></>}
                      {editVideo.viewCount > 0 && <><span className="opacity-50">·</span><span className="flex items-center gap-1"><Eye size={10} /> {editVideo.viewCount.toLocaleString()}</span></>}
                      {editVideo.sizeBytes != null && <><span className="opacity-50">·</span><span>{formatBytes(editVideo.sizeBytes)}</span></>}
                      {editVideo.originalFilename && (
                        <>
                          <span className="opacity-50">·</span>
                          <span className="truncate max-w-[220px]" title={editVideo.originalFilename}>{editVideo.originalFilename}</span>
                        </>
                      )}
                    </div>
                  )}

                  {/* Title — required */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="edit-title">Title <span className="text-red-500">*</span></Label>
                      <span className={`text-[11px] tabular-nums ${titleTrimmed.length > TITLE_MAX ? "text-red-600" : "text-muted-foreground/60"}`}>
                        {titleTrimmed.length}/{TITLE_MAX}
                      </span>
                    </div>
                    <Input
                      id="edit-title"
                      autoFocus
                      value={editForm.title}
                      maxLength={TITLE_MAX + 50 /* let user paste long, validate on save */}
                      aria-invalid={titleInvalid}
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
                      <Label htmlFor="edit-desc">Description</Label>
                      <span className={`text-[11px] tabular-nums ${descOver ? "text-red-600" : "text-muted-foreground/60"}`}>
                        {editForm.description.length}/{DESC_MAX}
                      </span>
                    </div>
                    <Textarea
                      id="edit-desc"
                      rows={6}
                      className="resize-y"
                      value={editForm.description}
                      placeholder="What is this sermon / message about? Shown on the watch page and in shares."
                      onChange={(e) => setEditForm(f => ({ ...f, description: e.target.value }))}
                    />
                    {descOver && (
                      <p className="text-[11px] text-red-600">Description must be {DESC_MAX} characters or fewer.</p>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* Category — clearable */}
                    <div className="space-y-1.5">
                      <Label htmlFor="edit-category">Category</Label>
                      <Select
                        value={editForm.category === "" ? "__none__" : editForm.category}
                        onValueChange={(v) => setEditForm(f => ({ ...f, category: v === "__none__" ? "" : v }))}
                      >
                        <SelectTrigger id="edit-category"><SelectValue placeholder="Select…" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__"><span className="text-muted-foreground">None</span></SelectItem>
                          {CATEGORIES.map(c => (
                            <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Preacher */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="edit-preacher">Preacher</Label>
                        <span className={`text-[11px] tabular-nums ${preacherOver ? "text-red-600" : "text-muted-foreground/60"}`}>
                          {editForm.preacher.length}/{PREACHER_MAX}
                        </span>
                      </div>
                      <Input
                        id="edit-preacher"
                        value={editForm.preacher}
                        maxLength={PREACHER_MAX + 25}
                        placeholder="Speaker name"
                        aria-invalid={preacherOver}
                        onChange={(e) => setEditForm(f => ({ ...f, preacher: e.target.value }))}
                      />
                    </div>
                  </div>

                  {/* Featured */}
                  <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/20">
                    <div>
                      <Label className="text-sm font-medium">Featured</Label>
                      <p className="text-xs text-muted-foreground">Eligible for the home-screen hero rotation</p>
                    </div>
                    <Switch
                      checked={editForm.featured}
                      onCheckedChange={(v) => setEditForm(f => ({ ...f, featured: v }))}
                    />
                  </div>

                  {/* Library visibility — only relevant for locally-uploaded videos */}
                  {editVideo?.videoSource === "local" && (
                    <div className="flex items-center justify-between rounded-lg border p-3 bg-orange-50 dark:bg-orange-950/20 border-orange-200 dark:border-orange-800">
                      <div className="flex items-start gap-2">
                        {editForm.broadcastOnly
                          ? <EyeOff size={15} className="text-orange-500 mt-0.5 flex-shrink-0" />
                          : <Globe size={15} className="text-green-600 mt-0.5 flex-shrink-0" />}
                        <div>
                          <Label className="text-sm font-medium">Broadcast only</Label>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {editForm.broadcastOnly
                              ? "Hidden from the public library. Toggle off to publish it for viewers to browse."
                              : "Visible in the public library. Toggle on to hide it from browsing (still airs in broadcasts)."}
                          </p>
                        </div>
                      </div>
                      <Switch
                        checked={editForm.broadcastOnly}
                        onCheckedChange={(v) => setEditForm(f => ({ ...f, broadcastOnly: v }))}
                      />
                    </div>
                  )}

                  {/* Metadata lock — only meaningful for YouTube-sourced rows */}
                  {editVideo?.videoSource === "youtube" && (
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
                      <Switch
                        checked={editForm.metadataLocked}
                        onCheckedChange={(v) => setEditForm(f => ({ ...f, metadataLocked: v }))}
                      />
                    </div>
                  )}

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
                  <Button
                    variant="ghost"
                    onClick={() => { setEditVideo(null); setEditOriginal(null); setEditError(null); }}
                    disabled={updateMutation.isPending}
                  >
                    Cancel
                  </Button>
                  <Button onClick={submit} disabled={!canSave}>
                    {updateMutation.isPending ? "Saving…" : "Save changes"}
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ── Bulk Delete Confirm Dialog ────────────────────────────────────── */}
      <AlertDialog
        open={bulkDeleteOpen}
        onOpenChange={(o) => {
          if (!o && bulkDeleteMutation.isPending) return;
          if (!o) {
            setBulkDeleteOpen(false);
            bulkDeleteMutation.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} video{selectedIds.size !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove {selectedIds.size} video{selectedIds.size !== 1 ? "s" : ""} from the library.
              Stored video files will also be deleted for uploaded (non-YouTube) videos.
              {" "}This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {bulkDeleteMutation.isError && (
            <div className="rounded-md border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              Bulk delete encountered errors — some videos may not have been deleted.
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleteMutation.isPending}>Cancel</AlertDialogCancel>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white"
              disabled={bulkDeleteMutation.isPending}
              onClick={() => {
                if (!bulkDeleteMutation.isPending) {
                  bulkDeleteMutation.mutate([...selectedIds]);
                }
              }}
            >
              {bulkDeleteMutation.isPending ? "Deleting…" : `Delete ${selectedIds.size} video${selectedIds.size !== 1 ? "s" : ""}`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete Confirm Dialog ──────────────────────────────────────────── */}
      <AlertDialog
        open={!!deleteVideo}
        onOpenChange={(o) => {
          // Block Escape / outside-click while the delete is in flight so the
          // user sees the "Deleting…" state and can't accidentally dismiss.
          if (!o && deleteMutation.isPending) return;
          if (!o) {
            setDeleteVideo(null);
            deleteMutation.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete video?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove <strong>{deleteVideo?.title}</strong> from the library.
              {deleteVideo?.videoSource !== "youtube" && " The stored video file will also be deleted."}
              {" "}This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteMutation.isError && (
            <div className="rounded-md border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {deleteMutation.error instanceof HttpError
                ? deleteMutation.error.message
                : "Delete failed — please try again."}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            {/* Use a plain Button (not AlertDialogAction) so Radix does not
                auto-close the dialog on click — we close it ourselves only
                after the server confirms the delete. */}
            <Button
              className="bg-red-600 hover:bg-red-700 text-white"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteVideo && !deleteMutation.isPending) {
                  deleteMutation.mutate(deleteVideo.id);
                }
              }}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
