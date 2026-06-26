import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
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
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  Video, Search, MoreVertical, Pencil, Trash2,
  RefreshCw, Star, StarOff, ChevronLeft, ChevronRight, Film, Eye, EyeOff,
  UploadCloud, X, FileVideo, Layers, Lock, LockOpen, Youtube, HardDrive,
  ArrowUpDown, SlidersHorizontal, Zap, Clapperboard, Globe, AlertTriangle,
  Wrench, CheckCircle2, Play, Loader2, Info, ClipboardList, TriangleAlert,
  CircleCheck, CircleX, RefreshCcw, Inbox, CalendarClock, BookOpen, Plus,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { LiveStatusBadge } from "@/components/live-status-badge";
import { BroadcastReadyBadge, getBroadcastReadiness } from "@/components/shared/broadcast-ready-badge";
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
  tags: string[] | null;
  /**
   * Whether the source video file is still in object storage.
   * true  → retry transcoding is possible.
   * false → source was deleted; re-upload is required.
   * null  → not applicable (YouTube video).
   */
  sourceAvailable: boolean | null;
  /**
   * Machine-readable error code for the most recent transcoding failure.
   * "ASSEMBLY_FAILED" means the upload was interrupted before the file
   * was fully assembled; the upload session may still have intact chunks.
   */
  transcodingErrorCode: string | null;
  /**
   * Human-readable reason for the most recent transcoding failure.
   * null when the video has not failed or was successfully re-queued.
   */
  transcodingErrorMessage: string | null;
  youtubeLiveStatus: "live" | "rebroadcast" | null;
  videoCodec: string | null;
  audioCodec: string | null;
  videoBitrate: number | null;
  videoWidth: number | null;
  videoHeight: number | null;
  transcodingProgress: number | null;
  scheduledPublishAt: string | null;
  scheduledUnpublishAt: string | null;
  chapters: { startSecs: number; title: string }[] | null;
}

interface VideoListResponse {
  videos: AdminVideo[];
  total: number;
  totalPages: number;
  page: number;
  limit: number;
}

interface RecoveryItem {
  videoId: string;
  title: string;
  issueKind: string;
  issueDetail: string;
  actionTaken: string;
  actionDetail: string;
  previousStatus: string;
  previousErrorCode: string | null;
  blobVerified: boolean | null;
  rootCause: string | null;
}

interface RecoveryReport {
  runAt: string;
  durationMs: number;
  totalLocalVideos: number;
  summary: {
    healthy: number;
    recovered: number;
    quarantined: number;
    errors: number;
  };
  actions: {
    retriedFailed: number;
    resetOrphaned: number;
    resetStuck: number;
    enqueuedUnprocessed: number;
    enqueuedBroadcast: number;
    requeuedDlq: number;
    sourceMissingConfirmed: number;
    badUrlCacheCleared: boolean;
    suspendedReEnabled: number;
  };
  items: RecoveryItem[];
  remainingActions: string[];
}

interface EditForm {
  title: string;
  description: string;
  category: string;
  preacher: string;
  featured: boolean;
  metadataLocked: boolean;
  broadcastOnly: boolean;
  scheduledPublishAt: string;
  scheduledUnpublishAt: string;
  tags: string[];
}

interface ChapterDraft {
  startSecs: string;
  title: string;
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
    scheduledPublishAt: f.scheduledPublishAt,
    scheduledUnpublishAt: f.scheduledUnpublishAt,
    tags: [...f.tags].sort(),
  });
}

type PatchDelta = Partial<EditForm> & {
  scheduledPublishAt?: string | null;
  scheduledUnpublishAt?: string | null;
  tags?: string[] | null;
};

function buildEditDelta(original: EditForm, current: EditForm): PatchDelta {
  // Only send fields that actually changed. Avoids unnecessary writes,
  // unnecessary `videos-library-updated` SSE fan-out, and accidental
  // overwrite of fields a parallel admin may have edited in another tab.
  const delta: PatchDelta = {};
  const tTitle = current.title.trim();
  const tPreacher = current.preacher.trim();
  if (tTitle !== original.title.trim()) delta.title = tTitle;
  if (current.description !== original.description) delta.description = current.description;
  if (current.category !== original.category) delta.category = current.category;
  if (tPreacher !== original.preacher.trim()) delta.preacher = tPreacher;
  if (current.featured !== original.featured) delta.featured = current.featured;
  if (current.metadataLocked !== original.metadataLocked) delta.metadataLocked = current.metadataLocked;
  if (current.broadcastOnly !== original.broadcastOnly) delta.broadcastOnly = current.broadcastOnly;
  if (JSON.stringify([...current.tags].sort()) !== JSON.stringify([...original.tags].sort()))
    delta.tags = current.tags;
  if (current.scheduledPublishAt !== original.scheduledPublishAt)
    delta.scheduledPublishAt = current.scheduledPublishAt
      ? new Date(current.scheduledPublishAt).toISOString()
      : null;
  if (current.scheduledUnpublishAt !== original.scheduledUnpublishAt)
    delta.scheduledUnpublishAt = current.scheduledUnpublishAt
      ? new Date(current.scheduledUnpublishAt).toISOString()
      : null;
  return delta;
}

/** Format an ISO string to the local datetime-local input value (YYYY-MM-DDTHH:mm). */
function isoToDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Format seconds to MM:SS or HH:MM:SS. */
function secsToTimecode(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Parse timecode (HH:MM:SS, MM:SS, or bare seconds) → seconds or null. */
function timecodeToSecs(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const parts = trimmed.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES: { value: string; label: string }[] = [
  { value: "midnight-prayers", label: "Midnight Prayers" },
  { value: "live_service",     label: "Live Service" },
  { value: "sermon",           label: "Sermons" },
  { value: "deliverance",      label: "Deliverance" },
  { value: "prayer",           label: "Prayers" },
  { value: "crusade",          label: "Crusades" },
  { value: "conference",       label: "Conferences" },
  { value: "testimony",        label: "Testimonies" },
];
const PAGE_SIZES = [20, 50, 100] as const;

/**
 * Build a pagination slot array for a sliding-window pagination bar.
 * Returns numbers for page buttons and the string "…" for ellipsis gaps.
 * Always shows first, last, and up to `wing` pages on each side of `current`.
 */
function buildPageSlots(total: number, current: number, wing = 2): (number | "…")[] {
  if (total <= 1) return [];
  const set = new Set<number>();
  set.add(1);
  set.add(total);
  for (let i = Math.max(1, current - wing); i <= Math.min(total, current + wing); i++) set.add(i);
  const sorted = Array.from(set).sort((a, b) => a - b);
  const slots: (number | "…")[] = [];
  let prev = 0;
  for (const n of sorted) {
    if (n - prev > 1) slots.push("…");
    slots.push(n);
    prev = n;
  }
  return slots;
}

const STATUS_COLORS: Record<string, string> = {
  hls_ready: "default", ready: "default",
  encoding: "secondary", processing: "secondary",
  queued: "secondary", failed: "destructive",
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

// ── VideoPreviewPlayer ────────────────────────────────────────────────────────
// HLS-first preview player for the video library. Uses hls.js when an
// hlsMasterUrl is available (same path real viewers receive), falls back to
// the raw MP4 upload with a non-blocking advisory when HLS isn't ready yet.
// Never sends stall reports; never affects the broadcast queue.

function VideoPreviewPlayer({ video }: { video: AdminVideo }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [playerReady, setPlayerReady] = useState(false);

  const previewUrl = video.hlsMasterUrl ?? video.localVideoUrl ?? null;
  const isHls = !!video.hlsMasterUrl;

  useEffect(() => {
    setPlayerError(null);
    setPlayerReady(false);
    const el = videoRef.current;
    if (!el || !previewUrl) return;

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({
        debug: false,
        enableWorker: true,
        maxBufferLength: 30,
        startLevel: -1,
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setPlayerReady(true);
        void el.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          setPlayerError("HLS stream failed to load — the manifest may be unreachable or expired.");
          try { hls.destroy(); } catch { /* ignore */ }
        }
      });
      hls.loadSource(previewUrl);
      hls.attachMedia(el);
      return () => { try { hls.destroy(); } catch { /* ignore */ } };
    }

    // Native HLS (Safari) or raw MP4 — set src and let the browser handle it.
    const onMeta = () => setPlayerReady(true);
    const onErr = () => setPlayerError(
      isHls
        ? "HLS stream failed to load in this browser. Try Chrome or Firefox."
        : "This MP4 could not load. The moov atom may not yet be at the start of the file (faststart not yet applied). If HLS transcoding is not yet complete, the broadcast queue may serve viewers this same raw MP4.",
    );
    el.src = previewUrl;
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("error", onErr);
    return () => {
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("error", onErr);
      el.removeAttribute("src");
      el.load();
    };
  }, [previewUrl, isHls]);

  // No playable source
  if (!previewUrl) {
    const inProgress =
      video.transcodingStatus === "queued" ||
      video.transcodingStatus === "encoding" ||
      video.transcodingStatus === "processing";
    const isCorrupt =
      video.transcodingStatus === "failed" &&
      (video.transcodingErrorCode === "CORRUPT_SOURCE" ||
        video.transcodingErrorCode === "SOURCE_MISSING" ||
        video.sourceAvailable === false);
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        {inProgress ? (
          <>
            <Loader2 size={28} className="animate-spin text-amber-500" />
            <div>
              <p className="font-medium text-sm">HLS transcoding in progress</p>
              <p className="text-xs text-muted-foreground mt-1">Preview will be available once transcoding completes.</p>
            </div>
          </>
        ) : isCorrupt ? (
          <>
            <AlertTriangle size={28} className="text-red-500" />
            <div>
              <p className="font-medium text-sm">Source unavailable</p>
              <p className="text-xs text-muted-foreground mt-1">
                {video.sourceAvailable === false
                  ? "Source file was deleted. Re-upload the original to recover."
                  : "File is corrupt or unreadable. Re-upload the original."}
              </p>
            </div>
          </>
        ) : (
          <>
            <Film size={28} className="text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No playable source available yet.</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative bg-black rounded-md overflow-hidden" style={{ aspectRatio: "16/9" }}>
        {!playerReady && !playerError && (
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <Loader2 size={24} className="animate-spin text-white/40" />
          </div>
        )}
        {playerError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-6 text-center z-10">
            <AlertTriangle size={20} className="text-amber-400 shrink-0" />
            <p className="text-white/70 text-xs leading-relaxed max-w-xs">{playerError}</p>
          </div>
        )}
        <video
          ref={videoRef}
          className={`w-full h-full ${playerError ? "invisible" : "visible"}`}
          controls
          playsInline
        />
      </div>

      <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
        {isHls ? (
          <>
            <CheckCircle2 size={11} className="text-emerald-500 shrink-0 mt-0.5" />
            <span>Previewing via HLS — same delivery path as TV and mobile viewers.</span>
          </>
        ) : (
          <>
            <Info size={11} className="text-amber-500 shrink-0 mt-0.5" />
            <span>
              Previewing raw MP4 upload.
              {video.transcodingStatus === "hls_ready" || video.transcodingStatus === "ready"
                ? " HLS is ready — reload the preview to use it."
                : " HLS transcoding is not yet complete."}
              {" "}Browser MP4 playback can fail if the moov atom hasn't been relocated via faststart.
              {video.transcodingStatus !== "hls_ready" && video.transcodingStatus !== "ready"
                ? " Until HLS is ready, the broadcast queue may serve viewers this raw MP4."
                : " Real viewers receive the optimized HLS stream."}
            </span>
          </>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground/50 italic">
        Admin-only preview — never sends stall reports or affects the broadcast queue.
      </p>
    </div>
  );
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
  const [pageSize, setPageSize] = useState<typeof PAGE_SIZES[number]>(20);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [broadcastFilter, setBroadcastFilter] = useState("all");
  // Source is always "local" — YouTube content lives in the YouTube Library page.
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState("newest");
  const [editVideo, setEditVideo] = useState<AdminVideo | null>(null);
  const [deleteVideo, setDeleteVideo] = useState<AdminVideo | null>(null);
  const [previewVideo, setPreviewVideo] = useState<AdminVideo | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    title: "", description: "", category: "", preacher: "", featured: false, metadataLocked: false, broadcastOnly: false,
    scheduledPublishAt: "", scheduledUnpublishAt: "", tags: [],
  });
  // Original form values captured when the dialog opened — used to compute
  // a delta payload and to enable/disable the Save button.
  const [editOriginal, setEditOriginal] = useState<EditForm | null>(null);
  // Inline error surfaced inside the edit dialog (in addition to the toast)
  // so the user sees exactly which field/limit the server rejected.
  const [editError, setEditError] = useState<string | null>(null);
  // Chapter editor state
  const [editChapters, setEditChapters] = useState<ChapterDraft[]>([]);
  const [chapterDraft, setChapterDraft] = useState<ChapterDraft>({ startSecs: "", title: "" });
  // Tag editor state
  const [tagInput, setTagInput] = useState("");
  // Tag filter for the library listing
  const [tagFilter, setTagFilter] = useState("");
  // Bulk scheduling state
  const [bulkScheduleOpen, setBulkScheduleOpen] = useState(false);
  const [bulkSchedulePublishAt, setBulkSchedulePublishAt] = useState("");
  const [bulkScheduleUnpublishAt, setBulkScheduleUnpublishAt] = useState("");

  // Drag-over state for the page-level drop zone
  const [pageDragOver, setPageDragOver] = useState(false);

  // Deep recovery report state
  const [recoveryReport, setRecoveryReport] = useState<RecoveryReport | null>(null);
  const [recoveryReportOpen, setRecoveryReportOpen] = useState(false);

  // Bulk selection state — cleared on page/filter change so stale IDs don't
  // linger when the visible video list changes.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkTranscodeOpen, setBulkTranscodeOpen] = useState(false);

  // Batch upload dialog state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dialogFiles, setDialogFiles] = useState<DialogFile[]>([]);
  const [bulkCategory, setBulkCategory] = useState("sermon");
  const [bulkPreacher, setBulkPreacher] = useState("");
  const [bulkFeatured, setBulkFeatured] = useState(false);
  const [bulkPublishToLibrary, setBulkPublishToLibrary] = useState(false);
  const [dialogDragOver, setDialogDragOver] = useState(false);
  const [titleErrors, setTitleErrors] = useState<Set<string>>(new Set());

  // Upload queue — used only to show active count in the button
  const { summary } = useUploadQueue();

  // ── Data fetching ──────────────────────────────────────────────────────────

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-videos", page, pageSize, search, statusFilter, categoryFilter, sortOrder, tagFilter],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(pageSize), sort: sortOrder, source: "local" });
      if (search) params.set("search", search);
      if (statusFilter !== "all") params.set("transcodingStatus", statusFilter);
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      if (tagFilter) params.set("tag", tagFilter);
      return api.get<VideoListResponse>(`/admin/videos?${params}`);
    },
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    // Use the global retry/retryDelay policy (up to 5 retries for cold-start errors).
    // Auto-refetch every 15 s while in error state so the page self-heals once the
    // API server finishes its cold start without requiring a manual "Retry" click.
    refetchInterval: (query) => query.state.status === "error" ? 15_000 : false,
  });

  useSSEEvent("youtube-live-status-changed", () => {
    void qc.invalidateQueries({ queryKey: ["admin-videos"] });
  });
  useSSEEvent("videos-library-updated", (payload) => {
    void qc.invalidateQueries({ queryKey: ["admin-videos"] });
    // Keep the Dashboard "Total Videos" count accurate on every library change
    // (pre-committed uploads, assembly completion, thumbnail generation, etc.).
    void qc.invalidateQueries({ queryKey: ["admin-stats"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
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
  useSSEEvent("transcoding-progress", () => {
    void qc.invalidateQueries({ queryKey: ["admin-videos"] });
  });
  useSSEEvent("transcoding-update", () => {
    void qc.invalidateQueries({ queryKey: ["admin-videos"] });
    // When HLS transcoding completes the broadcast_queue row gains a
    // hlsMasterUrl; the queue UI must also refresh to reflect the upgrade.
    void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
    // Keep the Transcoding dashboard tab in sync with status changes observed
    // via SSE — without these, a status badge update on the Videos page still
    // shows stale data in the dedicated Transcoding tab until manual refresh.
    void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
    void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
    void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
  });

  // Belt-and-suspenders: when any upload completes, force-invalidate all
  // affected query caches so the newly uploaded video appears immediately
  // across the library, broadcast queue, and transcoding dashboard —
  // even if the SSE events were missed (connection drop between finalize
  // and event delivery). Also reset to page 1 with no status filter so the
  // new video (transcodingStatus='queued') is always visible regardless of
  // what filter/page the operator had active before the upload.
  useEffect(() => {
    return uploadQueue.onComplete(() => {
      // Navigate back to page 1 and clear any active status filter so the
      // newly uploaded video (always starts as 'queued') is not hidden by
      // a filter like 'hls_ready' or a page number higher than page 1.
      setPage(1);
      setStatusFilter("all");
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
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

  // Clear selection whenever the user navigates to a different page.
  // Without this, items selected on page 1 persist invisibly while the
  // user is on page 2, causing a cross-page bulk delete if they then
  // click "Delete Selected" — they'd delete page-1 items they can't see.
  // Filter/search handlers already pass setSelectedIds(new Set()) explicitly;
  // this useEffect only fires for the pagination prev/next buttons.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [page]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }: PatchDelta & { id: string }) =>
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
      // If the title, category, or preacher changed, the broadcast queue
      // panel still shows the old values until the next SSE push. Invalidate
      // immediately so operators see accurate metadata in the queue view.
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      // Metadata changes (title, category, preacher) can resolve or expose
      // remediation-report warnings — refresh the panel so it reflects the
      // current state without waiting for the next SSE-triggered invalidation.
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      // If a title/category changes while a transcoding job is in-flight, the
      // Transcoding dashboard would show the old title. Invalidate so operators
      // always see accurate metadata in the queue without a manual refresh.
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      // Playlists display video titles in their item lists — refresh so the
      // updated title is visible without a full page reload.
      void qc.invalidateQueries({ queryKey: ["playlists"] });
      // Series episode panels also display video titles — invalidate so the
      // updated title appears immediately without waiting for the next reload.
      void qc.invalidateQueries({ queryKey: ["series"] });
      void qc.invalidateQueries({ queryKey: ["series-episodes"] });
      // Broadcast engine-health and diagnostics can reflect stale metadata until
      // invalidated — a title/category change to an on-air item is a common case.
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
    },
    onError: (e) => {
      const msg = e instanceof HttpError ? e.message : "Update failed";
      setEditError(msg);
      toast.error(msg);
    },
  });

  const chaptersMutation = useMutation({
    mutationFn: ({ id, chapters }: { id: string; chapters: { startSecs: number; title: string }[] }) =>
      api.put<AdminVideo>(`/admin/videos/${id}/chapters`, { chapters }),
    onSuccess: (updatedRow) => {
      qc.setQueriesData<VideoListResponse>(
        { queryKey: ["admin-videos"] },
        (prev) => prev
          ? { ...prev, videos: prev.videos.map((v) => v.id === updatedRow.id ? { ...v, ...updatedRow } : v) }
          : prev,
      );
      setEditVideo((v) => v ? { ...v, chapters: updatedRow.chapters } : v);
      toast.success("Chapters saved");
    },
    onError: () => toast.error("Failed to save chapters"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/videos/${id}`),
    onSuccess: () => {
      toast.success("Video deleted");
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      // Keep the Dashboard "Total Videos" count accurate after deletion.
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      // Also refresh the broadcast queue so any orphan references to this
      // video are cleared from the queue panel immediately — without this,
      // the queue UI shows stale items with broken source URLs until the
      // next natural SSE-triggered invalidation.
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      // A video may appear as an episode in one or more series, or as an
      // item in a playlist. Invalidate those caches so those pages don't show
      // ghost "deleted video" entries until the user manually refreshes.
      void qc.invalidateQueries({ queryKey: ["series"] });
      void qc.invalidateQueries({ queryKey: ["series-episodes"] });
      void qc.invalidateQueries({ queryKey: ["playlists"] });
      // If the deleted video was imported from YouTube, remove it from the
      // Library tab immediately instead of waiting for stale time to expire.
      void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      // A video may be a scheduled entry (contentType="video", contentId=id).
      // Invalidate schedule so the operator sees the orphaned slot immediately.
      void qc.invalidateQueries({ queryKey: ["schedule"] });
      // Deletion may resolve remediation-report warnings (e.g. dead entries in
      // the queue that referenced this video) — refresh the panel immediately.
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      // If a video is deleted while a transcoding job is in-flight, the
      // Transcoding dashboard will show a ghost job until the next poll unless
      // we invalidate it here. The ghost job row will fail any interaction, so
      // showing it at all is confusing and misleading to operators.
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
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
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      // Featured status can affect how video appears in the broadcast queue
      // diagnostics panel — refresh so the flag is current.
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      // Featured/unfeatured state can surface or resolve remediation items.
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      // Featured flag may affect ordering/filtering in the YouTube library view.
      void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
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
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      // Metadata-lock state affects YouTube sync behavior which can produce
      // broadcast-queue drift — refresh remediation report to reflect current state.
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      // Lock status is displayed in the YouTube library view.
      void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
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
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      // Visibility change can affect which items appear in the broadcast queue
      // remediation report (e.g. hidden videos with queue entries).
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      // broadcastOnly controls whether the video appears in the public/YouTube library view.
      void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
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
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      // Broadcast queue shows "Missing HLS" warnings — invalidate so the
      // orchestrator panel reflects the new queued status immediately.
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      // Queueing for transcoding directly addresses "Missing HLS" entries in
      // the remediation report — refresh so operators see the status change.
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Transcoding request failed"),
  });

  const faststartMutation = useMutation({
    mutationFn: (id: string) =>
      api.post<{ ok: boolean; videoId: string }>(`/admin/videos/${id}/faststart`),
    onSuccess: () => {
      toast.success("Faststart started — status will update to 'ready' in ~30–90 seconds");
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      // Broadcast queue shows source URL status — invalidate so the Broadcast
      // panel reflects the faststart-in-progress state without waiting for SSE.
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      // Faststart creates a transcoding-type job visible in the Transcoding
      // dashboard — invalidate so the new in-progress row appears immediately.
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      // Faststart directly addresses "UNSTARTED_FASTSTART" remediation items —
      // refresh the report so the panel reflects the in-progress state.
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Faststart request failed"),
  });

  const thumbnailMutation = useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      api.post<{ videoId: string; thumbnailUrl: string; generated: boolean; message: string }>(
        `/admin/videos/${id}/generate-thumbnail`,
        { force: force ?? false },
      ),
    onSuccess: (res) => {
      if (res.generated) {
        toast.success("Thumbnail generated successfully");
        void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      } else {
        toast.info(res.message ?? "Thumbnail already exists");
      }
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Thumbnail generation failed"),
  });

  const retryAssemblyMutation = useMutation({
    mutationFn: (id: string) =>
      api.post<{ canRetry: boolean; message: string }>(`/admin/videos/upload/retry-assembly/${id}`),
    onSuccess: (res) => {
      if (res.canRetry) {
        toast.success("Assembly retry started — the video will update automatically once complete.");
      } else {
        toast.error(`Cannot retry: ${res.message}`);
      }
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Retry request failed"),
  });

  const batchRetryMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; retried: number }>("/admin/transcoding/retry-failed"),
    onSuccess: (res) => {
      if (res.retried === 0) {
        toast.info("No failed transcoding jobs found to retry.");
      } else {
        toast.success(`Re-queued ${res.retried} failed job${res.retried !== 1 ? "s" : ""} — they will encode shortly.`);
        void qc.invalidateQueries({ queryKey: ["admin-videos"] });
        void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
        void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
        void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      }
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Batch retry failed"),
  });

  // One-click quick repair: re-arm failed jobs, reset orphaned encoding
  // videos, and enqueue hls_ready videos missing from the broadcast queue.
  // Used by the inline pipeline health banner "Fix now" button.
  const repairAllMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; retriedFailed: number; resetOrphaned: number; enqueuedMissing: number }>(
        "/admin/transcoding/repair-all",
      ),
    onSuccess: (res) => {
      const parts: string[] = [];
      if (res.retriedFailed > 0) parts.push(`${res.retriedFailed} failed job${res.retriedFailed !== 1 ? "s" : ""} re-queued`);
      if (res.resetOrphaned > 0) parts.push(`${res.resetOrphaned} orphaned video${res.resetOrphaned !== 1 ? "s" : ""} reset`);
      if (res.enqueuedMissing > 0) parts.push(`${res.enqueuedMissing} ready video${res.enqueuedMissing !== 1 ? "s" : ""} added to broadcast queue`);
      if (parts.length === 0) {
        toast.info("Pipeline is healthy — nothing needed repair.");
      } else {
        toast.success(`Pipeline repaired: ${parts.join(", ")}.`);
      }
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-audit"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Repair failed"),
  });

  // Production-grade deep recovery: full audit of every local video, blob
  // verification, per-video root-cause classification, and structured report.
  const deepRecoverMutation = useMutation({
    mutationFn: () => api.post<RecoveryReport>("/admin/videos/deep-recover"),
    onSuccess: (report) => {
      const { summary } = report;
      const totalActions = summary.recovered + summary.quarantined + summary.errors;
      if (totalActions === 0 && summary.healthy === report.totalLocalVideos) {
        toast.success(`All ${report.totalLocalVideos} local videos are healthy — nothing to recover.`);
      } else {
        const parts: string[] = [];
        if (summary.recovered > 0) parts.push(`${summary.recovered} recovered`);
        if (summary.quarantined > 0) parts.push(`${summary.quarantined} quarantined`);
        if (summary.errors > 0) parts.push(`${summary.errors} errors`);
        toast.success(`Deep recovery complete: ${parts.join(", ")}. ${summary.healthy} healthy.`);
      }
      setRecoveryReport(report);
      setRecoveryReportOpen(true);
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-audit"] });
    },
    onError: (e) => toast.error(e instanceof HttpError ? e.message : "Deep recovery failed"),
  });

  // ── Pipeline audit query ─────────────────────────────────────────────────
  // Lightweight poll (every 60 s) — informs the repair banner. Stale data
  // is fine here; we only need it to surface actionable warning counts.
  const { data: auditData } = useQuery({
    queryKey: ["transcoding-audit"],
    queryFn: () =>
      api.get<{
        ok: boolean;
        statusCounts: Record<string, number>;
        queueDepth: number;
        stuckJobCount: number;
        orphanedEncodingCount: number;
        hlsReadyNotInQueueCount: number;
        estimatedDrainMinutes: number | null;
      }>("/admin/transcoding/audit"),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  // Bulk transcode — enqueues each selected video for HLS transcoding.
  // Fires requests in batches of 5 (browser connection limit per origin is 6)
  // so selecting 100+ videos doesn't flood the connection pool. Failures are
  // silent per-item so a single bad video doesn't block the rest; the final
  // toast reports the success/failure counts.
  const bulkTranscodeMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const BATCH = 5;
      let succeeded = 0;
      for (let i = 0; i < ids.length; i += BATCH) {
        const chunk = ids.slice(i, i + BATCH);
        const results = await Promise.all(
          chunk.map((id) =>
            api.post<{ jobId: string; reused: boolean }>(`/admin/videos/${id}/transcode`)
              .then(() => true)
              .catch(() => false)
          )
        );
        succeeded += results.filter(Boolean).length;
      }
      return succeeded;
    },
    onSuccess: (count, ids) => {
      const failed = ids.length - count;
      if (count > 0) toast.success(`Queued ${count} video${count !== 1 ? "s" : ""} for HLS transcoding`);
      if (failed > 0) toast.warning(`${failed} video${failed !== 1 ? "s" : ""} could not be queued (already encoding or YouTube source)`);
      setSelectedIds(new Set());
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
      void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      // Keep the Transcoding Pipeline tab in sync — jobs appear there the moment
      // they are enqueued, so a cross-invalidation here avoids the operator
      // switching tabs and seeing a stale "no jobs" state.
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      // Bulk-queuing directly addresses "Missing HLS" remediation entries.
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
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
      // A video may appear as an episode in one or more series, or as an
      // entry in one or more playlists — bulk delete must invalidate these
      // caches just as the single-delete mutation already does (lines above).
      void qc.invalidateQueries({ queryKey: ["series"] });
      void qc.invalidateQueries({ queryKey: ["series-episodes"] });
      void qc.invalidateQueries({ queryKey: ["playlists"] });
      void qc.invalidateQueries({ queryKey: ["admin-stats"] });
      // Match single-delete: evict YouTube Library tab so deleted YouTube
      // videos don't linger there until stale time expires.
      void qc.invalidateQueries({ queryKey: ["youtube-library-videos"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-jobs"] });
      void qc.invalidateQueries({ queryKey: ["transcoding-queue"] });
      // Bulk deletion can resolve orphaned-queue remediation entries — refresh
      // the panel so the report reflects the post-delete state immediately.
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-diagnostics"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] });
      void qc.invalidateQueries({ queryKey: ["schedule"] });
    },
    onError: () => toast.error("Bulk delete failed"),
  });

  const bulkScheduleMutation = useMutation({
    mutationFn: async ({ ids, publishAt, unpublishAt }: { ids: string[]; publishAt: string; unpublishAt: string }) => {
      const patch: Record<string, string | null> = {};
      if (publishAt) patch.scheduledPublishAt = new Date(publishAt).toISOString();
      else patch.scheduledPublishAt = null;
      if (unpublishAt) patch.scheduledUnpublishAt = new Date(unpublishAt).toISOString();
      else patch.scheduledUnpublishAt = null;
      return Promise.all(ids.map(id => api.patch(`/admin/videos/${id}`, patch)));
    },
    onSuccess: () => {
      toast.success(`Scheduled ${selectedIds.size} video${selectedIds.size !== 1 ? "s" : ""}`);
      setBulkScheduleOpen(false);
      setBulkSchedulePublishAt("");
      setBulkScheduleUnpublishAt("");
      void qc.invalidateQueries({ queryKey: ["admin-videos"] });
    },
    onError: () => toast.error("Bulk schedule failed"),
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
      scheduledPublishAt: isoToDatetimeLocal(v.scheduledPublishAt),
      scheduledUnpublishAt: isoToDatetimeLocal(v.scheduledUnpublishAt),
      tags: v.tags ?? [],
    };
    setEditForm(initial);
    setEditOriginal(initial);
    setEditError(null);
    setEditChapters((v.chapters ?? []).map(c => ({ startSecs: String(c.startSecs), title: c.title })));
    setChapterDraft({ startSecs: "", title: "" });
    setTagInput("");
    setEditVideo(v);
  };

  // ── Bulk selection helpers ─────────────────────────────────────────────────

  const toggleSelection = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });

  // Client-side broadcast-readiness filter applied after the server page is fetched.
  // Operates on at most PAGE_SIZE (20) items so no performance concern.
  const displayVideos = broadcastFilter === "all"
    ? (data?.videos ?? [])
    : (data?.videos ?? []).filter(
        (v) => getBroadcastReadiness(v.videoSource, v.localVideoUrl, v.hlsMasterUrl) === broadcastFilter,
      );

  const currentPageIds = displayVideos.map((v) => v.id);
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
  // Commit the current searchInput immediately (e.g. on Enter key press).
  const commitSearch = (value: string) => {
    setSearch(value);
    setPage(1);
    setSelectedIds(new Set());
  };

  // Debounce: auto-commit searchInput 350 ms after the user stops typing.
  // Also clears any pending timer when the component unmounts.
  useEffect(() => {
    const timer = setTimeout(() => {
      commitSearch(searchInput);
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const resetFilters = () => {
    setSearch(""); setSearchInput(""); setStatusFilter("all"); setBroadcastFilter("all");
    setCategoryFilter("all"); setSortOrder("newest"); setTagFilter(""); setPage(1);
    setSelectedIds(new Set());
  };
  const hasActiveFilters = search || statusFilter !== "all" || broadcastFilter !== "all" || categoryFilter !== "all" || sortOrder !== "newest" || tagFilter;

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
      broadcastOnly: !bulkPublishToLibrary,
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
        description={`${data?.total ?? 0} locally uploaded video${(data?.total ?? 0) !== 1 ? "s" : ""}`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void refetch()} className="gap-1.5">
              <RefreshCw size={13} /> Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={deepRecoverMutation.isPending}
              onClick={() => deepRecoverMutation.mutate()}
              className="gap-1.5"
              title="Full audit of every local video: verifies source blobs, classifies root causes, retries recoverable failures, fixes broadcast queue — returns a detailed per-video report"
            >
              {deepRecoverMutation.isPending
                ? <><RefreshCw size={13} className="animate-spin" /> Scanning…</>
                : <><ClipboardList size={13} /> Deep Recovery</>}
            </Button>
            {recoveryReport && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRecoveryReportOpen(true)}
                className="gap-1.5 text-muted-foreground"
                title="View last recovery report"
              >
                <ClipboardList size={13} />
                Last Report
              </Button>
            )}
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

      {/* Pipeline health banner — only shown when the audit detects issues */}
      {(() => {
        if (!auditData) return null;
        const { stuckJobCount, orphanedEncodingCount, hlsReadyNotInQueueCount, queueDepth, estimatedDrainMinutes } = auditData;
        const issueCount = stuckJobCount + orphanedEncodingCount + hlsReadyNotInQueueCount;
        if (issueCount === 0) return null;
        return (
          <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50/60 dark:border-blue-900/40 dark:bg-blue-950/20 px-4 py-3">
            <AlertTriangle size={16} className="text-blue-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-blue-700 dark:text-blue-400">
                Pipeline needs attention
              </p>
              <p className="text-xs text-blue-600/70 dark:text-blue-400/70 mt-0.5 space-y-0.5">
                {stuckJobCount > 0 && <span className="block">{stuckJobCount} job{stuckJobCount !== 1 ? "s" : ""} stuck processing for &gt;90 min</span>}
                {orphanedEncodingCount > 0 && <span className="block">{orphanedEncodingCount} video{orphanedEncodingCount !== 1 ? "s" : ""} orphaned in "encoding" state with no active job</span>}
                {hlsReadyNotInQueueCount > 0 && <span className="block">{hlsReadyNotInQueueCount} ready video{hlsReadyNotInQueueCount !== 1 ? "s" : ""} not yet in the broadcast queue</span>}
                {queueDepth > 0 && estimatedDrainMinutes != null && <span className="block">{queueDepth} video{queueDepth !== 1 ? "s" : ""} queued — est. {estimatedDrainMinutes >= 60 ? `${Math.round(estimatedDrainMinutes / 60)} h` : `${estimatedDrainMinutes} min`} to drain</span>}
              </p>
            </div>
            <Button
              size="sm"
              disabled={repairAllMutation.isPending}
              onClick={() => repairAllMutation.mutate()}
              className="h-7 text-xs flex-shrink-0 gap-1.5 bg-blue-600 hover:bg-blue-700 text-white"
            >
              {repairAllMutation.isPending
                ? <><RefreshCw size={11} className="animate-spin" /> Repairing…</>
                : <><Wrench size={11} /> Fix now</>}
            </Button>
          </div>
        );
      })()}

      {/* Healthy pipeline confirmation — shown briefly after repair succeeds */}
      {auditData && auditData.stuckJobCount === 0 && auditData.orphanedEncodingCount === 0
        && auditData.hlsReadyNotInQueueCount === 0 && repairAllMutation.isSuccess && (
        <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50/60 dark:border-green-900/40 dark:bg-green-950/20 px-4 py-2.5">
          <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />
          <p className="text-sm text-green-700 dark:text-green-400">Pipeline is healthy — all videos are queued and ready.</p>
        </div>
      )}

      {/* Filters row */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Search — debounced, results update 350 ms after typing stops */}
        <div className="relative flex-1 min-w-0 max-w-sm">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search title, preacher…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // Immediately commit on Enter — skip the 350 ms wait.
                clearTimeout(undefined); // the debounce useEffect handles its own timer
                commitSearch(searchInput);
              }
              if (e.key === "Escape") {
                setSearchInput("");
                commitSearch("");
              }
            }}
            className="pl-8 pr-8 h-8 text-sm"
            aria-label="Search videos"
          />
          {/* Right-side adornment: spinner while debounce is in-flight, clear × when idle */}
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center">
            {searchInput !== search ? (
              <Loader2 size={13} className="animate-spin text-muted-foreground" aria-label="Searching…" />
            ) : searchInput ? (
              <button
                type="button"
                onClick={() => { setSearchInput(""); commitSearch(""); }}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Clear search"
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
        </div>

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

        {/* Tag filter */}
        {tagFilter ? (
          <Button
            size="sm"
            variant="secondary"
            className="h-8 gap-1 text-xs px-2.5 bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20"
            onClick={() => { setTagFilter(""); setPage(1); setSelectedIds(new Set()); }}
          >
            #{tagFilter} <X size={10} />
          </Button>
        ) : null}

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

        {/* Broadcast readiness — client-side filter on current page */}
        <Select value={broadcastFilter} onValueChange={(v) => { setBroadcastFilter(v); setSelectedIds(new Set()); }}>
          <SelectTrigger className="h-8 text-sm w-44">
            <SelectValue placeholder="Broadcast readiness" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All readiness</SelectItem>
            <SelectItem value="mp4_and_hls">MP4 + HLS</SelectItem>
            <SelectItem value="mp4_only">MP4 only</SelectItem>
            <SelectItem value="hls_only">HLS only</SelectItem>
            <SelectItem value="library_only">Library only (YouTube)</SelectItem>
            <SelectItem value="not_ready">Not ready</SelectItem>
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
                onClick={() => { setStatusFilter("failed"); setPage(1); setSelectedIds(new Set()); }}
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
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <Button
              size="sm"
              variant="outline"
              disabled={bulkTranscodeMutation.isPending}
              onClick={() => setBulkTranscodeOpen(true)}
              className="h-7 px-2.5 text-xs gap-1"
              title="Queue all selected local videos for HLS transcoding. YouTube videos are skipped."
            >
              <Zap size={11} className="text-amber-500" />
              {bulkTranscodeMutation.isPending ? "Queuing…" : "Transcode selected"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setBulkScheduleOpen((o) => !o)}
              className="h-7 px-2.5 text-xs gap-1"
            >
              <CalendarClock size={11} className="text-blue-500" />
              Schedule selected
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

      {/* Bulk schedule inline panel */}
      {bulkScheduleOpen && selectedIds.size > 0 && (
        <div className="rounded-lg border border-blue-200 dark:border-blue-900/40 bg-blue-50/60 dark:bg-blue-950/20 px-4 py-3 space-y-3">
          <div className="flex items-center gap-2">
            <CalendarClock size={14} className="text-blue-500" />
            <span className="text-sm font-medium">Schedule {selectedIds.size} video{selectedIds.size !== 1 ? "s" : ""}</span>
            <button type="button" className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setBulkScheduleOpen(false)} aria-label="Close schedule panel"><X size={14} /></button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Publish at (leave blank to clear)</Label>
              <Input type="datetime-local" className="h-8 text-xs" value={bulkSchedulePublishAt} onChange={(e) => setBulkSchedulePublishAt(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Unpublish at (leave blank to clear)</Label>
              <Input type="datetime-local" className="h-8 text-xs" value={bulkScheduleUnpublishAt} onChange={(e) => setBulkScheduleUnpublishAt(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 text-xs gap-1"
              disabled={bulkScheduleMutation.isPending || (!bulkSchedulePublishAt && !bulkScheduleUnpublishAt)}
              onClick={() => bulkScheduleMutation.mutate({ ids: [...selectedIds], publishAt: bulkSchedulePublishAt, unpublishAt: bulkScheduleUnpublishAt })}
            >
              {bulkScheduleMutation.isPending ? <Loader2 size={11} className="animate-spin" /> : <CalendarClock size={11} />}
              Apply schedule
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => { setBulkSchedulePublishAt(""); setBulkScheduleUnpublishAt(""); bulkScheduleMutation.mutate({ ids: [...selectedIds], publishAt: "", unpublishAt: "" }); }}>
              Clear all schedules
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
          ) : displayVideos.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <Film size={36} className="text-muted-foreground/20" />
              <p className="font-medium">No videos found</p>
              <p className="text-sm text-muted-foreground">
                {broadcastFilter !== "all"
                  ? "No videos on this page match the selected broadcast readiness. Try a different filter or page."
                  : hasActiveFilters
                  ? "Try adjusting your filters."
                  : "Upload a video or drag files here to get started."}
              </p>
              {!hasActiveFilters && (
                <Button size="sm" onClick={() => setUploadOpen(true)} className="gap-1.5 mt-1">
                  <UploadCloud size={14} /> Upload Video
                </Button>
              )}
              {broadcastFilter !== "all" && (
                <Button size="sm" variant="ghost" onClick={() => setBroadcastFilter("all")} className="gap-1 text-muted-foreground">
                  Clear readiness filter
                </Button>
              )}
            </div>
          ) : (
            <div className="divide-y">
              {/* Select-all row header — shows only while data is present */}
              {displayVideos.length > 0 && (
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
                  {broadcastFilter !== "all" && (data?.videos?.length ?? 0) > displayVideos.length && (
                    <span className="text-xs text-muted-foreground ml-auto">
                      {displayVideos.length} of {data!.videos.length} on this page
                    </span>
                  )}
                </div>
              )}
              {displayVideos.map((v) => (
                <div key={v.id} className={`flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors group ${selectedIds.has(v.id) ? "bg-primary/5" : ""}`}>
                  {/* Row checkbox */}
                  <Checkbox
                    checked={selectedIds.has(v.id)}
                    onCheckedChange={() => toggleSelection(v.id)}
                    aria-label={`Select ${v.title}`}
                    className="shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  />
                  {/* Thumbnail — placeholder icon sits permanently in the
                      background; the img covers it and self-hides on a
                      broken/404 src so the icon is always visible as
                      fallback without any React state per row. */}
                  <div className="flex-shrink-0 w-20 h-12 rounded overflow-hidden bg-black relative">
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Video size={18} className="text-muted-foreground/30" />
                    </div>
                    {v.thumbnailUrl && (
                      <img src={v.thumbnailUrl} alt={`Thumbnail for ${v.title}`} className="absolute inset-0 w-full h-full object-contain" loading="lazy" decoding="async" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="font-medium text-sm truncate">{v.title || "Untitled"}</p>
                      {v.youtubeLiveStatus && (
                        <LiveStatusBadge status={v.youtubeLiveStatus} size="sm" />
                      )}
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
                      {(v.scheduledPublishAt || v.scheduledUnpublishAt) && (
                        <span title={v.scheduledPublishAt ? `Publishes ${new Date(v.scheduledPublishAt).toLocaleString()}` : `Unpublishes ${new Date(v.scheduledUnpublishAt!).toLocaleString()}`}>
                          <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 border-blue-400 text-blue-500 gap-0.5">
                            <CalendarClock size={8} />
                            {v.scheduledPublishAt ? "Sched. publish" : "Sched. unpublish"}
                          </Badge>
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      <span className="text-[10px] text-muted-foreground/60 flex items-center gap-0.5"><HardDrive size={9} />Uploaded</span>
                      {v.preacher && <span className="text-xs text-muted-foreground">{v.preacher}</span>}
                      {v.category && <span className="text-xs text-muted-foreground capitalize">{v.category}</span>}
                      {v.duration && <span className="text-xs text-muted-foreground">{formatDuration(v.duration)}</span>}
                      {v.sizeBytes != null && <span className="text-xs text-muted-foreground">{formatBytes(v.sizeBytes)}</span>}
                      {v.tags && v.tags.length > 0 && v.tags.slice(0, 3).map(tag => (
                        <button key={tag} type="button" onClick={(e) => { e.stopPropagation(); setTagFilter(tag); setPage(1); setSelectedIds(new Set()); }} className="text-[10px] text-primary/70 hover:text-primary border border-primary/20 rounded px-1 py-0 leading-4 transition-colors" title={`Filter by tag: ${tag}`}>
                          #{tag}
                        </button>
                      ))}
                      {v.viewCount > 0 && (
                        <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                          <Eye size={10} /> {v.viewCount.toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Status badge */}
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    {/* Broadcast-ready badge — shows whether this video can air right now */}
                    <BroadcastReadyBadge
                      videoSource={v.videoSource}
                      localVideoUrl={v.localVideoUrl}
                      hlsMasterUrl={v.hlsMasterUrl}
                    />
                    <Badge
                      variant={(STATUS_COLORS[v.transcodingStatus] ?? "outline") as "default" | "secondary" | "outline" | "destructive"}
                      className="capitalize text-[11px]"
                      title={
                        v.transcodingStatus === "hls_ready" || v.transcodingStatus === "ready"
                          ? "HLS stream ready — video is live in the broadcast queue"
                          : v.transcodingStatus === "queued"
                          ? "HLS transcoding queued — video is already live in the broadcast queue via MP4"
                          : v.transcodingStatus === "encoding" || v.transcodingStatus === "processing"
                          ? "Converting to HLS — video is already live in the broadcast queue via MP4"
                          : v.transcodingStatus === "none"
                          ? "Uploaded — video is in the broadcast queue via MP4; HLS transcoding pending"
                          : v.transcodingStatus === "failed"
                          ? "HLS conversion failed — video remains in broadcast queue via MP4 (retry to get HLS quality)"
                          : undefined
                      }
                    >
                      {v.transcodingStatus === "hls_ready" || v.transcodingStatus === "ready"
                        ? "HLS Ready"
                        : v.transcodingStatus === "queued"
                        ? "HLS Queued"
                        : v.transcodingStatus === "encoding" || v.transcodingStatus === "processing"
                        ? "Converting"
                        : v.transcodingStatus === "none"
                        ? "MP4 Ready"
                        : v.transcodingStatus || "—"}
                    </Badge>
                    {v.videoSource === "local" && !v.hlsMasterUrl && v.transcodingStatus !== "failed" && (
                      <span className="text-[9px] text-emerald-600 dark:text-emerald-400 flex items-center gap-0.5" title="Video is live in the broadcast queue via MP4. HLS upgrade in progress for adaptive quality.">
                        <Loader2 size={8} className={v.transcodingStatus === "encoding" || v.transcodingStatus === "processing" || v.transcodingStatus === "queued" ? "animate-spin" : ""} />
                        {v.transcodingStatus === "encoding" || v.transcodingStatus === "processing" || v.transcodingStatus === "queued" ? "In queue • HLS upgrading" : "In queue (MP4)"}
                      </span>
                    )}
                    {(v.transcodingStatus === "encoding" || v.transcodingStatus === "processing") && v.transcodingProgress !== null && (
                      <div className="w-24 flex flex-col items-end gap-0.5">
                        <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 transition-all duration-500 rounded-full"
                            style={{ width: `${v.transcodingProgress}%` }}
                          />
                        </div>
                        <span className="text-[9px] text-muted-foreground tabular-nums">{v.transcodingProgress}%</span>
                      </div>
                    )}
                    {v.transcodingStatus === "failed" && v.videoSource === "local" && (
                      <>
                        {v.sourceAvailable === false ? (
                          v.transcodingErrorCode === "ASSEMBLY_FAILED" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-5 text-[10px] px-1.5 border-blue-400 text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 flex items-center gap-0.5"
                              title="The upload was interrupted mid-assembly. Click to attempt automatic recovery — no re-upload needed if all chunks are still stored."
                              disabled={retryAssemblyMutation.isPending}
                              onClick={(e) => { e.stopPropagation(); retryAssemblyMutation.mutate(v.id); }}
                            >
                              <RefreshCw size={9} className={`flex-shrink-0${retryAssemblyMutation.isPending ? " animate-spin" : ""}`} />
                              Retry Assembly
                            </Button>
                          ) : (
                          <span title="Source file was deleted — delete this video and re-upload a fresh copy to recover.">
                            <Badge
                              variant="outline"
                              className="text-[10px] px-1.5 h-4 border-red-400 text-red-600 dark:text-red-400 flex items-center gap-0.5 cursor-default"
                            >
                              <UploadCloud size={9} className="flex-shrink-0" />
                              Re-upload required
                            </Badge>
                          </span>
                          )
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
                        )}
                        {v.transcodingErrorMessage && (
                          <span
                            title={v.transcodingErrorMessage}
                            className="max-w-[160px] truncate text-[10px] leading-tight text-red-600 dark:text-red-400 cursor-help"
                          >
                            <AlertTriangle size={9} className="inline mr-0.5 flex-shrink-0" />
                            {v.transcodingErrorMessage}
                          </span>
                        )}
                      </>
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
                      <DropdownMenuItem onClick={() => setPreviewVideo(v)}>
                        <Play size={13} className="mr-2" /> Preview
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
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
                      {v.videoSource === "local" && v.localVideoUrl && (
                        <DropdownMenuItem
                          onClick={() => thumbnailMutation.mutate({ id: v.id, force: !!v.thumbnailUrl })}
                          disabled={thumbnailMutation.isPending && thumbnailMutation.variables?.id === v.id}
                          title={v.thumbnailUrl ? "Regenerate thumbnail from video using ffmpeg" : "Extract thumbnail frame from video using ffmpeg"}
                        >
                          <Film size={13} className="mr-2 text-violet-500" />
                          {v.thumbnailUrl ? "Regenerate thumbnail" : "Generate thumbnail"}
                        </DropdownMenuItem>
                      )}
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
      {data && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 py-1">
          {/* Left: result summary */}
          <p className="text-xs text-muted-foreground shrink-0 order-2 sm:order-1">
            {(() => {
              const first = Math.min((page - 1) * pageSize + 1, data.total);
              const last  = Math.min(page * pageSize, data.total);
              return data.total === 0
                ? "No videos found"
                : `Showing ${first}–${last} of ${data.total.toLocaleString()} video${data.total !== 1 ? "s" : ""}`;
            })()}
          </p>

          {/* Right: controls */}
          <div className="flex items-center gap-3 order-1 sm:order-2">
            {/* Items per page selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground whitespace-nowrap">Per page:</span>
              <Select
                value={String(pageSize)}
                onValueChange={(v) => {
                  setPageSize(Number(v) as typeof PAGE_SIZES[number]);
                  setPage(1);
                  setSelectedIds(new Set());
                }}
              >
                <SelectTrigger className="h-7 w-16 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map((s) => (
                    <SelectItem key={s} value={String(s)} className="text-xs">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Page navigation — only render when there is more than one page */}
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                {/* Previous */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => setPage(p => p - 1)}
                  className="h-7 px-2"
                  aria-label="Previous page"
                >
                  <ChevronLeft size={13} />
                </Button>

                {/* Page slots: numbers + ellipsis */}
                {buildPageSlots(totalPages, page).map((slot, idx) =>
                  slot === "…" ? (
                    <span
                      key={`ellipsis-${idx}`}
                      className="h-7 w-7 flex items-center justify-center text-xs text-muted-foreground select-none"
                      aria-hidden
                    >
                      …
                    </span>
                  ) : (
                    <Button
                      key={slot}
                      size="sm"
                      variant={slot === page ? "default" : "outline"}
                      className="h-7 w-7 text-xs"
                      onClick={() => setPage(slot)}
                      aria-label={`Page ${slot}`}
                      aria-current={slot === page ? "page" : undefined}
                    >
                      {slot}
                    </Button>
                  )
                )}

                {/* Next */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page >= totalPages}
                  onClick={() => setPage(p => p + 1)}
                  className="h-7 px-2"
                  aria-label="Next page"
                >
                  <ChevronRight size={13} />
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Video Preview Dialog ────────────────────────────────────────────── */}
      <Dialog
        open={previewVideo !== null}
        onOpenChange={(open) => { if (!open) setPreviewVideo(null); }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 min-w-0">
              <Film size={16} className="shrink-0" />
              <span className="truncate">{previewVideo?.title || "Preview"}</span>
            </DialogTitle>
            <DialogDescription>
              Admin preview — does not affect broadcast health or viewer sessions.
            </DialogDescription>
          </DialogHeader>
          {previewVideo && <VideoPreviewPlayer video={previewVideo} />}
        </DialogContent>
      </Dialog>

      {/* ── Batch Upload Dialog ─────────────────────────────────────────────── */}
      <Dialog
        open={uploadOpen}
        onOpenChange={(open) => {
          setUploadOpen(open);
          if (!open) { setDialogFiles([]); setDialogDragOver(false); setBulkFeatured(false); setBulkPublishToLibrary(false); }
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
                  <div className="flex items-center justify-between pt-1 border-t border-border/40 mt-1">
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Publish to library</Label>
                      <p className="text-[10px] text-muted-foreground/70">
                        {bulkPublishToLibrary
                          ? "Visible in the public catalog immediately after upload"
                          : "Broadcast only — hide from public catalog until you publish manually"}
                      </p>
                    </div>
                    <Switch checked={bulkPublishToLibrary} onCheckedChange={setBulkPublishToLibrary} />
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
                              aria-label={`Remove ${df.file.name} from selection`}
                              title="Remove"
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
                      {editVideo.videoWidth && editVideo.videoHeight && (
                        <><span className="opacity-50">·</span><span>{editVideo.videoWidth}×{editVideo.videoHeight}</span></>
                      )}
                      {editVideo.videoCodec && (
                        <><span className="opacity-50">·</span><span className="uppercase">{editVideo.videoCodec}{editVideo.audioCodec ? `+${editVideo.audioCodec}` : ""}</span></>
                      )}
                      {editVideo.videoBitrate && (
                        <><span className="opacity-50">·</span><span>{editVideo.videoBitrate.toLocaleString()} kbps</span></>
                      )}
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

                  {/* Tags */}
                  <div className="rounded-lg border p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <BookOpen size={14} className="text-muted-foreground" />
                      <span className="text-sm font-medium">Tags</span>
                      <span className="text-[10px] text-muted-foreground ml-auto">Filterable labels</span>
                    </div>
                    {editForm.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {editForm.tags.map(tag => (
                          <span key={tag} className="inline-flex items-center gap-0.5 text-xs bg-primary/10 text-primary border border-primary/20 rounded px-1.5 py-0.5">
                            #{tag}
                            <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => setEditForm(f => ({ ...f, tags: f.tags.filter(t => t !== tag) }))} className="ml-0.5 hover:text-destructive">
                              <X size={10} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="Add tag (press Enter)"
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, ""))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            const t = tagInput.trim();
                            if (t && !editForm.tags.includes(t) && editForm.tags.length < 20) {
                              setEditForm(f => ({ ...f, tags: [...f.tags, t] }));
                              setTagInput("");
                            }
                          }
                        }}
                        className="h-7 text-xs flex-1"
                        aria-label="Add tag"
                      />
                      <Button type="button" size="icon" variant="outline" className="h-7 w-7 flex-shrink-0" aria-label="Add tag"
                        onClick={() => {
                          const t = tagInput.trim();
                          if (t && !editForm.tags.includes(t) && editForm.tags.length < 20) {
                            setEditForm(f => ({ ...f, tags: [...f.tags, t] }));
                            setTagInput("");
                          }
                        }}
                      >
                        <Plus size={11} />
                      </Button>
                    </div>
                  </div>

                  {/* Content Scheduling */}
                  <div className="rounded-lg border p-3 space-y-3">
                    <div className="flex items-center gap-2">
                      <CalendarClock size={14} className="text-muted-foreground" />
                      <span className="text-sm font-medium">Content Scheduling</span>
                      <span className="text-[10px] text-muted-foreground ml-auto">Auto-publish / unpublish by time</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="edit-scheduled-publish" className="text-xs text-muted-foreground">Publish at</Label>
                        <Input
                          id="edit-scheduled-publish"
                          type="datetime-local"
                          className="h-8 text-xs"
                          value={editForm.scheduledPublishAt}
                          onChange={(e) => setEditForm(f => ({ ...f, scheduledPublishAt: e.target.value }))}
                        />
                        {editForm.scheduledPublishAt && (
                          <button
                            type="button"
                            onClick={() => setEditForm(f => ({ ...f, scheduledPublishAt: "" }))}
                            className="text-[10px] text-muted-foreground hover:text-foreground"
                          >
                            ✕ Clear
                          </button>
                        )}
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="edit-scheduled-unpublish" className="text-xs text-muted-foreground">Unpublish at</Label>
                        <Input
                          id="edit-scheduled-unpublish"
                          type="datetime-local"
                          className="h-8 text-xs"
                          value={editForm.scheduledUnpublishAt}
                          onChange={(e) => setEditForm(f => ({ ...f, scheduledUnpublishAt: e.target.value }))}
                        />
                        {editForm.scheduledUnpublishAt && (
                          <button
                            type="button"
                            onClick={() => setEditForm(f => ({ ...f, scheduledUnpublishAt: "" }))}
                            className="text-[10px] text-muted-foreground hover:text-foreground"
                          >
                            ✕ Clear
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Chapter Markers */}
                  <div className="rounded-lg border p-3 space-y-3">
                    <div className="flex items-center gap-2">
                      <BookOpen size={14} className="text-muted-foreground" />
                      <span className="text-sm font-medium">Chapter Markers</span>
                      <Badge variant="secondary" className="text-[10px] h-4 px-1.5 ml-auto">
                        {editChapters.length}
                      </Badge>
                    </div>

                    {/* Existing chapters */}
                    {editChapters.length > 0 && (
                      <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                        {editChapters.map((ch, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs bg-muted/30 rounded px-2 py-1.5">
                            <span className="font-mono text-muted-foreground w-12 flex-shrink-0">
                              {secsToTimecode(parseFloat(ch.startSecs) || 0)}
                            </span>
                            <span className="flex-1 truncate">{ch.title}</span>
                            <button
                              type="button"
                              onClick={() => setEditChapters((prev) => prev.filter((_, j) => j !== i))}
                              className="text-muted-foreground hover:text-destructive flex-shrink-0"
                              aria-label={`Remove chapter: ${ch.title}`}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Add new chapter */}
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="0:00"
                        value={chapterDraft.startSecs}
                        onChange={(e) => setChapterDraft(d => ({ ...d, startSecs: e.target.value }))}
                        className="h-7 text-xs font-mono w-20 flex-shrink-0"
                        aria-label="Chapter start time (MM:SS)"
                      />
                      <Input
                        placeholder="Chapter title"
                        value={chapterDraft.title}
                        onChange={(e) => setChapterDraft(d => ({ ...d, title: e.target.value }))}
                        className="h-7 text-xs flex-1"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            const secs = timecodeToSecs(chapterDraft.startSecs);
                            if (secs === null || !chapterDraft.title.trim()) return;
                            setEditChapters((prev) => [...prev, { startSecs: String(secs), title: chapterDraft.title.trim() }]);
                            setChapterDraft({ startSecs: "", title: "" });
                          }
                        }}
                        aria-label="Chapter title"
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="h-7 w-7 flex-shrink-0"
                        aria-label="Add chapter"
                        onClick={() => {
                          const secs = timecodeToSecs(chapterDraft.startSecs);
                          if (secs === null || !chapterDraft.title.trim()) return;
                          setEditChapters((prev) => [...prev, { startSecs: String(secs), title: chapterDraft.title.trim() }]);
                          setChapterDraft({ startSecs: "", title: "" });
                        }}
                      >
                        <Plus size={12} />
                      </Button>
                    </div>

                    {/* Save chapters button */}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="w-full h-7 text-xs gap-1"
                      disabled={chaptersMutation.isPending || !editVideo}
                      onClick={() => {
                        if (!editVideo) return;
                        const chapters = editChapters
                          .map(c => ({ startSecs: parseFloat(c.startSecs), title: c.title }))
                          .filter(c => !isNaN(c.startSecs) && c.title);
                        chaptersMutation.mutate({ id: editVideo.id, chapters });
                      }}
                    >
                      {chaptersMutation.isPending ? <Loader2 size={11} className="animate-spin" /> : <BookOpen size={11} />}
                      Save chapters
                    </Button>
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

      {/* ── Bulk Transcode Confirm Dialog ──────────────────────────────────── */}
      <AlertDialog open={bulkTranscodeOpen} onOpenChange={setBulkTranscodeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Transcode {selectedIds.size} video{selectedIds.size !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will queue {selectedIds.size} video{selectedIds.size !== 1 ? "s" : ""} for HLS transcoding.
              Transcoding is CPU-intensive — large batches will take time and may delay individual completions.
              Videos already at HLS-ready status are skipped automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { bulkTranscodeMutation.mutate([...selectedIds]); setBulkTranscodeOpen(false); }}
            >
              Queue {selectedIds.size} for transcoding
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Deep Recovery Report Dialog ────────────────────────────────────── */}
      <Dialog open={recoveryReportOpen} onOpenChange={setRecoveryReportOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <ClipboardList size={18} className="text-primary" />
              Deep Recovery Report
            </DialogTitle>
            <DialogDescription>
              {recoveryReport && (
                <span>
                  {new Date(recoveryReport.runAt).toLocaleString()} · {recoveryReport.totalLocalVideos} local video{recoveryReport.totalLocalVideos !== 1 ? "s" : ""} scanned · {recoveryReport.durationMs}ms
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          {recoveryReport && (
            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              {/* Summary cards */}
              <div className="grid grid-cols-4 gap-2">
                {[
                  { label: "Healthy", value: recoveryReport.summary.healthy, icon: CircleCheck, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900/40" },
                  { label: "Recovered", value: recoveryReport.summary.recovered, icon: RefreshCcw, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-900/40" },
                  { label: "Quarantined", value: recoveryReport.summary.quarantined, icon: TriangleAlert, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900/40" },
                  { label: "Errors", value: recoveryReport.summary.errors, icon: CircleX, color: "text-red-600 dark:text-red-400", bg: "bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-900/40" },
                ].map(({ label, value, icon: Icon, color, bg }) => (
                  <div key={label} className={`rounded-lg border px-3 py-2.5 ${bg}`}>
                    <div className={`flex items-center gap-1.5 text-xs font-medium mb-0.5 ${color}`}>
                      <Icon size={12} />
                      {label}
                    </div>
                    <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Action counts */}
              {(() => {
                const a = recoveryReport.actions;
                const actionRows = [
                  { label: "Failed jobs retried", value: a.retriedFailed },
                  { label: "Orphaned encoding videos reset", value: a.resetOrphaned },
                  { label: "Stuck queued videos reset", value: a.resetStuck },
                  { label: "Never-processed videos enqueued", value: a.enqueuedUnprocessed },
                  { label: "Added to broadcast queue", value: a.enqueuedBroadcast },
                  { label: "Dead-letter jobs requeued", value: a.requeuedDlq },
                  { label: "Source-missing videos confirmed", value: a.sourceMissingConfirmed },
                  { label: "Suspended queue items re-enabled", value: a.suspendedReEnabled },
                ].filter((r) => r.value > 0);
                if (actionRows.length === 0) return null;
                return (
                  <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
                    <p className="text-xs font-semibold mb-2 text-muted-foreground uppercase tracking-wide">Actions taken</p>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                      {actionRows.map((r) => (
                        <div key={r.label} className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">{r.label}</span>
                          <span className="font-semibold tabular-nums ml-2">{r.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Remaining actions */}
              {recoveryReport.remainingActions.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50/50 dark:border-amber-900/40 dark:bg-amber-950/10 px-3 py-2.5 space-y-1">
                  <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                    <TriangleAlert size={12} />
                    Manual action required
                  </p>
                  {recoveryReport.remainingActions.map((msg, i) => (
                    <p key={i} className="text-xs text-amber-700/80 dark:text-amber-400/70 pl-4">{msg}</p>
                  ))}
                </div>
              )}

              {/* Per-video table */}
              {recoveryReport.items.length > 0 ? (
                <div className="rounded-lg border overflow-hidden">
                  <div className="px-3 py-2 border-b bg-muted/20">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Per-video results</p>
                  </div>
                  <div className="divide-y max-h-80 overflow-y-auto">
                    {recoveryReport.items.map((item) => {
                      const isHealthy = item.actionTaken === "skipped_healthy";
                      const isQuarantined = item.actionTaken === "quarantined_source_gone";
                      const isError = item.actionTaken === "error";
                      const rowBg = isHealthy ? "" : isQuarantined ? "bg-amber-50/50 dark:bg-amber-950/10" : isError ? "bg-red-50/50 dark:bg-red-950/10" : "bg-blue-50/30 dark:bg-blue-950/10";
                      return (
                        <div key={item.videoId} className={`px-3 py-2 ${rowBg}`}>
                          <div className="flex items-start gap-2">
                            <div className="flex-shrink-0 mt-0.5">
                              {isHealthy ? (
                                <CircleCheck size={13} className="text-emerald-500" />
                              ) : isQuarantined ? (
                                <TriangleAlert size={13} className="text-amber-500" />
                              ) : isError ? (
                                <CircleX size={13} className="text-red-500" />
                              ) : (
                                <RefreshCcw size={13} className="text-blue-500" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium truncate" title={item.title}>{item.title}</p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">{item.issueDetail}</p>
                              {!isHealthy && (
                                <p className="text-[10px] mt-0.5">
                                  <span className="font-medium">Action: </span>
                                  <span className="text-muted-foreground">{item.actionDetail}</span>
                                </p>
                              )}
                              {item.rootCause && (
                                <p className="text-[10px] text-red-600/70 dark:text-red-400/60 mt-0.5 italic">{item.rootCause}</p>
                              )}
                            </div>
                            <div className="flex-shrink-0 text-right">
                              <Badge variant="outline" className={`text-[9px] px-1 h-4 ${
                                isHealthy ? "border-emerald-400 text-emerald-700 dark:text-emerald-400" :
                                isQuarantined ? "border-amber-400 text-amber-700 dark:text-amber-400" :
                                isError ? "border-red-400 text-red-700 dark:text-red-400" :
                                "border-blue-400 text-blue-700 dark:text-blue-400"
                              }`}>
                                {item.previousStatus}
                              </Badge>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <Inbox size={28} className="text-muted-foreground/20" />
                  <p className="text-sm text-muted-foreground">No local videos found in this environment.</p>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="flex-shrink-0 mt-4">
            <Button variant="outline" size="sm" onClick={() => setRecoveryReportOpen(false)}>
              Close
            </Button>
            <Button
              size="sm"
              disabled={deepRecoverMutation.isPending}
              onClick={() => { setRecoveryReportOpen(false); deepRecoverMutation.mutate(); }}
              className="gap-1.5"
            >
              {deepRecoverMutation.isPending
                ? <><RefreshCw size={12} className="animate-spin" /> Scanning…</>
                : <><RefreshCcw size={12} /> Run again</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              {" "}The stored video file will also be deleted. This action cannot be undone.
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
