import { useListAdminVideos, useImportVideo, useUpdateAdminVideo, useDeleteAdminVideo } from "@workspace/api-client-react";
import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Plus, Loader2, MoreVertical, Trash2, Youtube, ExternalLink, Video, Star, Edit, Upload, HardDrive, Play, Pause, X, CheckCircle2, AlertCircle, Zap, RotateCcw, Clock, Activity } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { getListAdminVideosQueryKey } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const CHUNK_SIZE = 10 * 1024 * 1024;
const MAX_CONCURRENT = 4;
const MAX_RETRIES = 5;
const SPEED_SAMPLES = 8;
const UPLOAD_SESSION_KEY = "ttv-upload-session-v2";

type UploadState = "idle" | "initializing" | "uploading" | "paused" | "finalizing" | "done" | "error";

interface ChunkStatus {
  index: number;
  status: "pending" | "uploading" | "done" | "error";
  retries: number;
}

interface StoredSession {
  sessionId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  form: { title: string; category: string; preacher: string; featured: boolean };
}

async function uploadChunk(
  sessionId: string,
  chunkIndex: number,
  data: ArrayBuffer,
  signal: AbortSignal,
  onProgress?: (bytes: number) => void
): Promise<void> {
  const formData = new FormData();
  formData.append("chunk", new Blob([data]));
  formData.append("chunkIndex", String(chunkIndex));
  const res = await fetch(`/api/admin/videos/upload/${sessionId}/chunk`, {
    method: "POST",
    body: formData,
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  onProgress?.(data.byteLength);
}

function exponentialBackoff(attempt: number): number {
  const base = Math.min(500 * Math.pow(2, attempt), 16000);
  const jitter = Math.random() * base * 0.3;
  return base + jitter;
}

const CATEGORIES = ["sermon", "faith", "healing", "deliverance", "worship", "prophecy", "teachings", "special"];

type VideoRow = {
  id: string;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  category: string;
  preacher: string;
  featured: boolean;
  viewCount: number;
  duration: string;
  importedAt: string | Date;
  videoSource?: string;
  localVideoUrl?: string | null;
};

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(bps: number) {
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${(bps / 1024).toFixed(0)} KB/s`;
}

function formatEta(seconds: number) {
  if (!isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s remaining`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s remaining`;
}

export default function Videos() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useListAdminVideos({ search, limit: 50 });
  const [isImporting, setIsImporting] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [editingVideo, setEditingVideo] = useState<VideoRow | null>(null);
  const importVideo = useImportVideo();
  const updateVideo = useUpdateAdminVideo();
  const deleteVideo = useDeleteAdminVideo();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editForm, setEditForm] = useState({ title: "", category: "sermon", preacher: "", featured: false });

  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [uploadForm, setUploadForm] = useState({ title: "", category: "sermon", preacher: "", featured: false });
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadSpeed, setUploadSpeed] = useState(0);
  const [uploadEta, setUploadEta] = useState(0);
  const [bytesUploaded, setBytesUploaded] = useState(0);
  const [chunksTotal, setChunksTotal] = useState(0);
  const [chunksDone, setChunksDone] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingResume, setPendingResume] = useState<StoredSession | null>(null);

  const videoInputRef = useRef<HTMLInputElement>(null);
  const thumbnailInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const uploadStartTimeRef = useRef<number>(0);
  const bytesUploadedRef = useRef<number>(0);
  const speedSamplesRef = useRef<{ time: number; bytes: number }[]>([]);
  const totalFileBytes = useRef<number>(0);

  useEffect(() => {
    const stored = localStorage.getItem(UPLOAD_SESSION_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as StoredSession;
        if (parsed.sessionId && parsed.fileName) {
          setPendingResume(parsed);
        }
      } catch {
        localStorage.removeItem(UPLOAD_SESSION_KEY);
      }
    }
  }, []);

  const saveSession = useCallback((session: StoredSession) => {
    localStorage.setItem(UPLOAD_SESSION_KEY, JSON.stringify(session));
  }, []);

  const clearSession = useCallback(() => {
    localStorage.removeItem(UPLOAD_SESSION_KEY);
    setPendingResume(null);
  }, []);

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importUrl) return;

    let youtubeId = importUrl;
    if (importUrl.includes("youtube.com/watch?v=")) {
      youtubeId = importUrl.split("v=")[1].split("&")[0];
    } else if (importUrl.includes("youtu.be/")) {
      youtubeId = importUrl.split("youtu.be/")[1].split("?")[0];
    }

    setIsImporting(true);
    importVideo.mutate(
      { data: { youtubeId } },
      {
        onSuccess: () => {
          toast({ title: "Video imported successfully" });
          setImportUrl("");
          queryClient.invalidateQueries({ queryKey: getListAdminVideosQueryKey() });
        },
        onError: () => {
          toast({ title: "Failed to import video", variant: "destructive" });
        },
        onSettled: () => setIsImporting(false),
      }
    );
  };

  const handleDelete = (id: string) => {
    if (!confirm("Are you sure you want to delete this video?")) return;
    deleteVideo.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Video deleted" });
          queryClient.invalidateQueries({ queryKey: getListAdminVideosQueryKey() });
        },
        onError: () => toast({ title: "Failed to delete video", variant: "destructive" }),
      }
    );
  };

  const openEdit = (video: VideoRow) => {
    setEditForm({ title: video.title, category: video.category, preacher: video.preacher || "", featured: video.featured ?? false });
    setEditingVideo(video);
  };

  const handleEditSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingVideo) return;
    updateVideo.mutate(
      { id: editingVideo.id, data: editForm },
      {
        onSuccess: () => {
          toast({ title: "Video updated" });
          setEditingVideo(null);
          queryClient.invalidateQueries({ queryKey: getListAdminVideosQueryKey() });
        },
        onError: () => toast({ title: "Failed to update video", variant: "destructive" }),
      }
    );
  };

  const detectVideoDuration = (file: File): Promise<number> =>
    new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        const secs = isFinite(video.duration) ? Math.round(video.duration) : 0;
        URL.revokeObjectURL(url);
        resolve(secs);
      };
      video.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
      video.src = url;
    });

  const resetUploadState = useCallback(() => {
    setUploadState("idle");
    setUploadProgress(0);
    setUploadSpeed(0);
    setUploadEta(0);
    setBytesUploaded(0);
    setChunksTotal(0);
    setChunksDone(0);
    setUploadError(null);
    setSessionId(null);
    abortControllerRef.current = null;
    uploadStartTimeRef.current = 0;
    bytesUploadedRef.current = 0;
    speedSamplesRef.current = [];
    totalFileBytes.current = 0;
  }, []);

  const updateSpeedAndEta = useCallback((newBytes: number) => {
    const now = Date.now();
    bytesUploadedRef.current += newBytes;
    setBytesUploaded(bytesUploadedRef.current);

    const sample = { time: now, bytes: bytesUploadedRef.current };
    speedSamplesRef.current.push(sample);
    if (speedSamplesRef.current.length > SPEED_SAMPLES) {
      speedSamplesRef.current.shift();
    }

    const samples = speedSamplesRef.current;
    if (samples.length >= 2) {
      const oldest = samples[0];
      const newest = samples[samples.length - 1];
      const elapsed = (newest.time - oldest.time) / 1000;
      const bytesDelta = newest.bytes - oldest.bytes;
      const speed = elapsed > 0 ? bytesDelta / elapsed : 0;
      setUploadSpeed(Math.round(speed));

      const remaining = totalFileBytes.current - bytesUploadedRef.current;
      const eta = speed > 0 ? remaining / speed : 0;
      setUploadEta(eta);
    }
  }, []);

  const handlePauseResume = useCallback(() => {
    if (uploadState === "uploading") {
      abortControllerRef.current?.abort();
      setUploadState("paused");
    }
  }, [uploadState]);

  const handleCancelUpload = useCallback(async () => {
    abortControllerRef.current?.abort();
    if (sessionId) {
      await fetch(`/api/admin/videos/upload/${sessionId}`, { method: "DELETE" }).catch(() => {});
    }
    clearSession();
    resetUploadState();
    setVideoFile(null);
    setThumbnailFile(null);
    setUploadForm({ title: "", category: "sermon", preacher: "", featured: false });
    setShowUploadDialog(false);
  }, [sessionId, resetUploadState, clearSession]);

  const runChunkedUpload = useCallback(async (
    sid: string,
    file: File,
    totalChunks: number,
    alreadyUploaded: Set<number> = new Set()
  ) => {
    const chunkStatuses: ChunkStatus[] = Array.from({ length: totalChunks }, (_, i) => ({
      index: i,
      status: alreadyUploaded.has(i) ? "done" : "pending",
      retries: 0,
    }));

    const abortCtrl = new AbortController();
    abortControllerRef.current = abortCtrl;

    if (uploadStartTimeRef.current === 0) {
      uploadStartTimeRef.current = Date.now();
    }

    const doneCount = alreadyUploaded.size;
    setChunksDone(doneCount);
    setUploadProgress(Math.round((doneCount / totalChunks) * 100));

    const uploadSingleChunk = async (chunk: ChunkStatus): Promise<void> => {
      const start = chunk.index * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const sliceBuffer = await file.slice(start, end).arrayBuffer();

      chunk.status = "uploading";
      let attempt = 0;

      while (attempt <= MAX_RETRIES) {
        try {
          await uploadChunk(sid, chunk.index, sliceBuffer, abortCtrl.signal);
          chunk.status = "done";
          updateSpeedAndEta(sliceBuffer.byteLength);

          setChunksDone((prev) => {
            const next = prev + 1;
            setUploadProgress(Math.round((next / totalChunks) * 100));
            return next;
          });
          return;
        } catch (err) {
          if ((err as Error).name === "AbortError") throw err;
          attempt++;
          if (attempt > MAX_RETRIES) {
            chunk.status = "error";
            throw new Error(`Chunk ${chunk.index} failed after ${MAX_RETRIES} retries`);
          }
          await new Promise((r) => setTimeout(r, exponentialBackoff(attempt)));
        }
      }
    };

    const pending = chunkStatuses.filter((c) => c.status === "pending");
    const inFlight: Promise<void>[] = [];

    while (pending.length > 0 || inFlight.length > 0) {
      if (abortCtrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

      while (inFlight.length < MAX_CONCURRENT && pending.length > 0) {
        const chunk = pending.shift()!;
        const promise = uploadSingleChunk(chunk).then(() => {
          inFlight.splice(inFlight.indexOf(promise), 1);
        });
        inFlight.push(promise);
      }

      if (inFlight.length > 0) await Promise.race(inFlight);
    }
  }, [updateSpeedAndEta]);

  const handleUpload = async (e?: React.FormEvent, resumeSession?: { sid: string; uploadedChunks: Set<number> }) => {
    e?.preventDefault();
    if (!videoFile || !uploadForm.title.trim()) return;

    setUploadState("initializing");
    setUploadError(null);

    try {
      const durationSecs = await detectVideoDuration(videoFile);
      const totalChunks = Math.ceil(videoFile.size / CHUNK_SIZE);
      const ext = videoFile.name.includes(".") ? `.${videoFile.name.split(".").pop()}` : ".mp4";
      totalFileBytes.current = videoFile.size;

      setChunksTotal(totalChunks);
      setChunksDone(0);
      setUploadProgress(0);
      setBytesUploaded(0);
      speedSamplesRef.current = [];
      uploadStartTimeRef.current = Date.now();

      let sid = resumeSession?.sid ?? null;
      let alreadyUploaded = resumeSession?.uploadedChunks ?? new Set<number>();

      if (!sid) {
        const initRes = await fetch("/api/admin/videos/upload/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: uploadForm.title.trim(),
            category: uploadForm.category,
            preacher: uploadForm.preacher,
            featured: String(uploadForm.featured),
            durationSecs: durationSecs > 0 ? String(durationSecs) : undefined,
            totalChunks: String(totalChunks),
            totalBytes: String(videoFile.size),
            ext,
          }),
        });

        if (!initRes.ok) {
          const err = await initRes.json() as { error?: string };
          throw new Error(err.error ?? "Failed to initialize upload");
        }

        const { sessionId: newSid } = await initRes.json() as { sessionId: string };
        sid = newSid;

        saveSession({
          sessionId: sid,
          fileName: videoFile.name,
          fileSize: videoFile.size,
          totalChunks,
          form: uploadForm,
        });
      }

      setSessionId(sid);

      if (thumbnailFile && !resumeSession) {
        const thumbForm = new FormData();
        thumbForm.append("thumbnail", thumbnailFile);
        await fetch(`/api/admin/videos/upload/${sid}/thumbnail`, { method: "POST", body: thumbForm });
      }

      setUploadState("uploading");
      await runChunkedUpload(sid, videoFile, totalChunks, alreadyUploaded);

      setUploadState("finalizing");
      const finalRes = await fetch(`/api/admin/videos/upload/${sid}/finalize`, { method: "POST" });
      if (!finalRes.ok) {
        const err = await finalRes.json() as { error?: string };
        throw new Error(err.error ?? "Failed to finalize upload");
      }

      clearSession();
      setUploadState("done");
      toast({ title: "Video uploaded successfully" });

      setTimeout(() => {
        setShowUploadDialog(false);
        setVideoFile(null);
        setThumbnailFile(null);
        setUploadForm({ title: "", category: "sermon", preacher: "", featured: false });
        resetUploadState();
        queryClient.invalidateQueries({ queryKey: getListAdminVideosQueryKey() });
      }, 1500);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const msg = err instanceof Error ? err.message : "Upload failed";
      setUploadError(msg);
      setUploadState("error");
      toast({ title: msg, variant: "destructive" });
    }
  };

  const handleResumeFromStorage = async () => {
    if (!pendingResume || !videoFile) return;
    setUploadState("initializing");
    setUploadError(null);

    try {
      const statusRes = await fetch(`/api/admin/videos/upload/${pendingResume.sessionId}/status`);
      if (!statusRes.ok) {
        clearSession();
        setPendingResume(null);
        toast({ title: "Previous session expired. Starting fresh.", variant: "destructive" });
        return;
      }

      const status = await statusRes.json() as { uploadedChunks: number; totalChunks: number; uploadedChunkIndices?: number[] };
      const uploadedIndices = new Set<number>(status.uploadedChunkIndices ?? []);

      const totalChunks = Math.ceil(videoFile.size / CHUNK_SIZE);
      totalFileBytes.current = videoFile.size;
      setChunksTotal(totalChunks);

      const resumeBytes = uploadedIndices.size * CHUNK_SIZE;
      bytesUploadedRef.current = Math.min(resumeBytes, videoFile.size);
      setBytesUploaded(bytesUploadedRef.current);
      uploadStartTimeRef.current = Date.now();
      speedSamplesRef.current = [];

      setSessionId(pendingResume.sessionId);
      setUploadState("uploading");
      await runChunkedUpload(pendingResume.sessionId, videoFile, totalChunks, uploadedIndices);

      setUploadState("finalizing");
      const finalRes = await fetch(`/api/admin/videos/upload/${pendingResume.sessionId}/finalize`, { method: "POST" });
      if (!finalRes.ok) {
        const err = await finalRes.json() as { error?: string };
        throw new Error(err.error ?? "Failed to finalize upload");
      }

      clearSession();
      setUploadState("done");
      toast({ title: "Video uploaded successfully" });

      setTimeout(() => {
        setShowUploadDialog(false);
        setVideoFile(null);
        setThumbnailFile(null);
        setUploadForm({ title: "", category: "sermon", preacher: "", featured: false });
        resetUploadState();
        queryClient.invalidateQueries({ queryKey: getListAdminVideosQueryKey() });
      }, 1500);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const msg = err instanceof Error ? err.message : "Upload failed";
      setUploadError(msg);
      setUploadState("error");
      toast({ title: msg, variant: "destructive" });
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) {
      setVideoFile(file);
      if (!uploadForm.title) {
        setUploadForm(prev => ({ ...prev, title: file.name.replace(/\.[^/.]+$/, "") }));
      }
    }
  }, [uploadForm.title]);

  const isUploading = uploadState === "uploading" || uploadState === "initializing" || uploadState === "finalizing";
  const showResumeHint = !!pendingResume && !!videoFile && uploadState === "idle";

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Video Library</h1>
          <p className="text-muted-foreground mt-1">Manage sermons, teachings, and content.</p>
        </div>

        <div className="flex flex-col sm:flex-row w-full sm:w-auto gap-2">
          <form onSubmit={handleImport} className="flex items-center gap-2">
            <div className="relative w-full sm:w-56">
              <Youtube className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="YouTube URL or ID..."
                className="pl-9"
                value={importUrl}
                onChange={(e) => setImportUrl(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={isImporting || !importUrl} variant="outline">
              {isImporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
              Import
            </Button>
          </form>
          <Button onClick={() => setShowUploadDialog(true)}>
            <Upload className="h-4 w-4 mr-2" />
            Upload Local
          </Button>
        </div>
      </div>

      {pendingResume && (
        <div className="flex items-center gap-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm">
          <RotateCcw className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="font-medium text-amber-700 dark:text-amber-400">Interrupted upload found:</span>
            {" "}<span className="text-muted-foreground truncate">{pendingResume.fileName}</span>
          </div>
          <Button size="sm" variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10" onClick={() => {
            setUploadForm(pendingResume.form);
            setShowUploadDialog(true);
          }}>
            Resume
          </Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={clearSession}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}

      <div className="bg-card border rounded-lg overflow-hidden">
        <div className="p-4 border-b bg-muted/20 flex gap-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search videos..."
              className="pl-9 bg-background"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {isLoading ? (
          <div className="divide-y">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="p-4 flex gap-4">
                <Skeleton className="w-32 h-20 rounded-md" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-5 w-1/3" />
                  <Skeleton className="h-4 w-1/4" />
                </div>
              </div>
            ))}
          </div>
        ) : data?.videos.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground flex flex-col items-center">
            <Video className="h-12 w-12 mb-4 opacity-20" />
            <p className="text-lg font-medium text-foreground">No videos found</p>
            <p className="text-sm mt-1">Try a different search term or import a new video.</p>
          </div>
        ) : (
          <div className="divide-y">
            {data?.videos.map((video) => {
              const v = video as VideoRow;
              const isLocal = v.videoSource === "local";
              return (
                <div key={v.id} className="p-4 flex gap-4 group hover:bg-muted/30 transition-colors">
                  <div className="relative w-32 h-20 shrink-0 bg-muted rounded-md overflow-hidden border">
                    {v.thumbnailUrl ? (
                      <img src={v.thumbnailUrl} alt={v.title} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <HardDrive className="w-8 h-8 text-muted-foreground opacity-40" />
                      </div>
                    )}
                    {v.duration && (
                      <div className="absolute bottom-1 right-1 bg-black/80 text-white text-[10px] px-1 py-0.5 rounded font-mono">
                        {v.duration}
                      </div>
                    )}
                    {v.featured && (
                      <div className="absolute top-1 left-1 bg-primary text-primary-foreground text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider flex items-center gap-0.5">
                        <Star className="w-2.5 h-2.5 fill-current" /> Featured
                      </div>
                    )}
                    {isLocal && (
                      <div className="absolute bottom-1 left-1 bg-blue-600/90 text-white text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider flex items-center gap-0.5">
                        <HardDrive className="w-2.5 h-2.5" /> Local
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0 flex flex-col justify-center">
                    <h3 className="font-semibold text-base truncate pr-4" title={v.title}>
                      {v.title}
                    </h3>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-sm text-muted-foreground">
                      <span className="font-medium text-foreground/80">{v.preacher || "Unknown"}</span>
                      <span>•</span>
                      <Badge variant="secondary" className="font-normal capitalize">{v.category}</Badge>
                      <span>•</span>
                      {isLocal ? (
                        <span className="flex items-center gap-1 text-blue-500">
                          <HardDrive className="w-3.5 h-3.5" />
                          Local upload
                        </span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <Youtube className="w-3.5 h-3.5" />
                          {v.viewCount?.toLocaleString() || 0} views
                        </span>
                      )}
                      <span>•</span>
                      <span>Imported {new Date(v.importedAt).toLocaleDateString()}</span>
                    </div>
                  </div>

                  <div className="shrink-0 flex items-center">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="opacity-0 group-hover:opacity-100 transition-opacity">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem className="cursor-pointer" onClick={() => openEdit(v)}>
                          <Edit className="h-4 w-4 mr-2" />
                          Edit Details
                        </DropdownMenuItem>
                        {isLocal && v.localVideoUrl ? (
                          <DropdownMenuItem asChild>
                            <a href={v.localVideoUrl} target="_blank" rel="noopener noreferrer" className="cursor-pointer">
                              <Play className="h-4 w-4 mr-2" />
                              Play Local Video
                            </a>
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem asChild>
                            <a href={`https://youtube.com/watch?v=${v.youtubeId}`} target="_blank" rel="noopener noreferrer" className="cursor-pointer">
                              <ExternalLink className="h-4 w-4 mr-2" />
                              View on YouTube
                            </a>
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive focus:bg-destructive/10 focus:text-destructive cursor-pointer" onClick={() => handleDelete(v.id)}>
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={!!editingVideo} onOpenChange={(open) => !open && setEditingVideo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Video</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditSave} className="space-y-4">
            {editingVideo && (
              <div className="flex gap-3 items-center p-3 bg-muted/30 rounded-lg border">
                {editingVideo.thumbnailUrl ? (
                  <img src={editingVideo.thumbnailUrl} className="w-20 h-14 object-cover rounded" alt="" />
                ) : (
                  <div className="w-20 h-14 bg-muted rounded flex items-center justify-center">
                    <HardDrive className="w-6 h-6 text-muted-foreground opacity-40" />
                  </div>
                )}
                <p className="text-sm font-medium line-clamp-2">{editingVideo.title}</p>
              </div>
            )}
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={editForm.title} onChange={e => setEditForm({ ...editForm, title: e.target.value })} required />
            </div>
            <div className="space-y-2">
              <Label>Preacher / Speaker</Label>
              <Input value={editForm.preacher} onChange={e => setEditForm({ ...editForm, preacher: e.target.value })} placeholder="e.g. Pastor John" />
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={editForm.category} onValueChange={v => setEditForm({ ...editForm, category: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map(c => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between p-3 bg-muted/20 rounded-lg border">
              <div>
                <Label>Featured</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Highlights this video on the home screen</p>
              </div>
              <Switch checked={editForm.featured} onCheckedChange={c => setEditForm({ ...editForm, featured: c })} />
            </div>
            <div className="flex gap-2 pt-1">
              <Button type="button" variant="outline" className="flex-1" onClick={() => setEditingVideo(null)}>Cancel</Button>
              <Button type="submit" className="flex-1" disabled={updateVideo.isPending}>
                {updateVideo.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : "Save Changes"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showUploadDialog}
        onOpenChange={(open) => {
          if (uploadState === "idle" || uploadState === "done" || uploadState === "error") {
            setShowUploadDialog(open);
            if (!open) { setVideoFile(null); setThumbnailFile(null); resetUploadState(); }
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HardDrive className="w-5 h-5" />
              Upload Local Video
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleUpload} className="space-y-4">
            <div
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                isDragging
                  ? "border-primary bg-primary/5"
                  : videoFile
                  ? "border-primary/40 bg-primary/5"
                  : "hover:border-primary/60 hover:bg-muted/20"
              }`}
              onClick={() => !isUploading && videoInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <input
                ref={videoInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                disabled={isUploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    setVideoFile(f);
                    if (!uploadForm.title) {
                      setUploadForm(prev => ({ ...prev, title: f.name.replace(/\.[^/.]+$/, "") }));
                    }
                  }
                }}
              />
              {videoFile ? (
                <div className="space-y-1">
                  <Video className="w-8 h-8 mx-auto text-primary" />
                  <p className="text-sm font-medium">{videoFile.name}</p>
                  <p className="text-xs text-muted-foreground">{formatFileSize(videoFile.size)}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload className="w-8 h-8 mx-auto text-muted-foreground opacity-50" />
                  <p className="text-sm font-medium">Drop video here or click to select</p>
                  <p className="text-xs text-muted-foreground">MP4, MOV, AVI, MKV · Up to 5 GB</p>
                </div>
              )}
            </div>

            {showResumeHint && pendingResume && (
              <div className="flex items-center gap-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs">
                <RotateCcw className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                <div className="flex-1">
                  <span className="font-medium text-amber-700 dark:text-amber-400">Resume interrupted upload?</span>
                  <p className="text-muted-foreground mt-0.5">Skip already uploaded chunks and continue where it left off.</p>
                </div>
                <Button size="sm" type="button" variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400 shrink-0" onClick={handleResumeFromStorage}>
                  Resume
                </Button>
              </div>
            )}

            <div
              className="border rounded-lg p-3 flex items-center gap-3 cursor-pointer hover:bg-muted/20 transition-colors"
              onClick={() => !isUploading && thumbnailInputRef.current?.click()}
            >
              <input
                ref={thumbnailInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                disabled={isUploading}
                onChange={(e) => setThumbnailFile(e.target.files?.[0] ?? null)}
              />
              {thumbnailFile ? (
                <img src={URL.createObjectURL(thumbnailFile)} className="w-16 h-10 object-cover rounded" alt="thumbnail" />
              ) : (
                <div className="w-16 h-10 bg-muted rounded flex items-center justify-center shrink-0">
                  <Upload className="w-4 h-4 text-muted-foreground opacity-40" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{thumbnailFile ? thumbnailFile.name : "Add thumbnail (optional)"}</p>
                <p className="text-xs text-muted-foreground">JPG, PNG, WebP</p>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Title <span className="text-destructive">*</span></Label>
              <Input
                value={uploadForm.title}
                onChange={e => setUploadForm({ ...uploadForm, title: e.target.value })}
                placeholder="e.g. Sunday Service — Faith That Moves Mountains"
                disabled={isUploading}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Preacher / Speaker</Label>
              <Input
                value={uploadForm.preacher}
                onChange={e => setUploadForm({ ...uploadForm, preacher: e.target.value })}
                placeholder="e.g. Prophet Amos"
                disabled={isUploading}
              />
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={uploadForm.category} onValueChange={v => setUploadForm({ ...uploadForm, category: v })} disabled={isUploading}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map(c => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between p-3 bg-muted/20 rounded-lg border">
              <div>
                <Label>Featured</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Pin to top of the home screen</p>
              </div>
              <Switch checked={uploadForm.featured} onCheckedChange={c => setUploadForm({ ...uploadForm, featured: c })} disabled={isUploading} />
            </div>

            {(uploadState === "uploading" || uploadState === "paused" || uploadState === "finalizing" || uploadState === "initializing") && (
              <div className="space-y-2.5 p-3 bg-muted/30 rounded-lg border">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 font-medium">
                    {uploadState === "finalizing" ? (
                      <><Loader2 className="w-3 h-3 animate-spin" /> Finalizing…</>
                    ) : uploadState === "initializing" ? (
                      <><Loader2 className="w-3 h-3 animate-spin" /> Preparing…</>
                    ) : uploadState === "paused" ? (
                      <><Pause className="w-3 h-3" /> Paused</>
                    ) : (
                      <><Zap className="w-3 h-3 text-primary animate-pulse" /> Uploading…</>
                    )}
                  </div>
                  <span className="text-muted-foreground font-mono">{uploadProgress}%</span>
                </div>

                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      uploadState === "paused" ? "bg-amber-500" : "bg-primary"
                    }`}
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>

                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <Activity className="w-3 h-3 shrink-0" />
                    <span>{uploadState === "uploading" && uploadSpeed > 0 ? formatSpeed(uploadSpeed) : "—"}</span>
                  </div>
                  <div className="flex items-center gap-1 text-muted-foreground text-center justify-center">
                    <span>{chunksDone}/{chunksTotal} chunks</span>
                  </div>
                  <div className="flex items-center gap-1 text-muted-foreground justify-end">
                    <Clock className="w-3 h-3 shrink-0" />
                    <span>{uploadState === "uploading" && uploadEta > 0 ? formatEta(uploadEta) : "—"}</span>
                  </div>
                </div>

                {videoFile && (
                  <div className="text-[11px] text-muted-foreground">
                    {formatFileSize(bytesUploaded)} / {formatFileSize(videoFile.size)}
                    {uploadState === "uploading" && (
                      <span className="ml-2 text-primary/70">· {Math.min(MAX_CONCURRENT, chunksTotal - chunksDone)} parallel streams</span>
                    )}
                  </div>
                )}
              </div>
            )}

            {uploadState === "done" && (
              <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/30 rounded-lg text-sm text-green-700 dark:text-green-400">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                Video uploaded successfully!
              </div>
            )}

            {uploadState === "error" && uploadError && (
              <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {uploadError}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={handleCancelUpload}
                disabled={uploadState === "finalizing" || uploadState === "done"}
              >
                <X className="w-4 h-4 mr-1.5" />
                Cancel
              </Button>
              {uploadState === "uploading" && (
                <Button type="button" variant="outline" onClick={handlePauseResume} className="flex-1">
                  <Pause className="w-4 h-4 mr-1.5" />
                  Pause
                </Button>
              )}
              {(uploadState === "idle" || uploadState === "error") && (
                <Button type="submit" className="flex-1" disabled={!videoFile || !uploadForm.title.trim()}>
                  <Upload className="w-4 h-4 mr-1.5" />
                  Upload Video
                </Button>
              )}
              {uploadState === "paused" && (
                <Button type="submit" className="flex-1">
                  <RotateCcw className="w-4 h-4 mr-1.5" />
                  Resume Upload
                </Button>
              )}
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
