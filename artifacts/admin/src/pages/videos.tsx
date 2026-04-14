import { useListAdminVideos, useImportVideo, useUpdateAdminVideo, useDeleteAdminVideo } from "@workspace/api-client-react";
import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Search, Plus, Loader2, MoreVertical, Trash2, Youtube, ExternalLink,
  Video, Star, Edit, Upload, HardDrive, Play, Pause, X, CheckCircle2,
  AlertCircle, Zap, RotateCcw, Clock, Activity, Cpu, Layers,
  FileVideo, ShieldCheck, Wifi, TrendingUp,
} from "lucide-react";
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

// ─── Upload engine constants ───────────────────────────────────────────────────
const CHUNK_SIZE = 32 * 1024 * 1024;        // 32 MB — optimal for large file throughput
const MAX_CONCURRENT_PER_FILE = 12;          // parallel chunk streams per file
const MAX_CONCURRENT_FILES = 5;              // max simultaneous file uploads
const MIN_CONCURRENCY = 4;                   // floor: never starve the pipe
const MAX_CONCURRENCY = 20;                  // ceiling on fast connections
const PREFETCH_AHEAD = 6;                    // pre-read & hash ahead (6×32MB = 192MB max)
const RENDER_THROTTLE_MS = 80;               // max UI refresh rate ~12 fps during upload
const MAX_RETRIES = 5;
const SPEED_SAMPLES = 10;
const UPLOAD_SESSION_KEY = "ttv-upload-session-v3";
const CATEGORIES = ["sermon", "faith", "healing", "deliverance", "worship", "prophecy", "teachings", "special"];

// ─── Types ─────────────────────────────────────────────────────────────────────
type TaskState = "pending" | "initializing" | "uploading" | "paused" | "finalizing" | "done" | "error";

interface FileTask {
  id: string;
  file: File;
  title: string;
  category: string;
  preacher: string;
  featured: boolean;
  sessionId: string | null;
  state: TaskState;
  progress: number;
  bytesUploaded: number;
  speed: number;
  eta: number;
  chunksTotal: number;
  chunksDone: number;
  error: string | null;
  abortController: AbortController | null;
  speedSamples: { time: number; bytes: number }[];
  bytesRef: number;
  startTime: number;
  durationSecs: number;
  concurrency: number;
  checksumOk: number;
  checksumFailed: number;
}

interface StoredSession {
  sessionId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  form: { title: string; category: string; preacher: string; featured: boolean };
}

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
  hlsMasterUrl?: string | null;
  transcodingStatus?: string;
};

// ─── Utility functions ─────────────────────────────────────────────────────────
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
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function exponentialBackoff(attempt: number): number {
  const base = Math.min(500 * Math.pow(2, attempt), 16000);
  return base + Math.random() * base * 0.3;
}

async function computeSha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function detectVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
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
}

// ─── Chunk upload (XHR with checksum + progress) ───────────────────────────────
async function uploadChunk(
  sessionId: string,
  chunkIndex: number,
  data: ArrayBuffer,
  checksum: string,
  signal: AbortSignal,
  onProgress?: (bytes: number) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const formData = new FormData();
    formData.append("chunk", new Blob([data]));
    formData.append("chunkIndex", String(chunkIndex));
    formData.append("checksum", checksum);

    const xhr = new XMLHttpRequest();
    let lastLoaded = 0;

    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) {
        const delta = e.loaded - lastLoaded;
        lastLoaded = e.loaded;
        if (delta > 0) onProgress(delta);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        try {
          const err = JSON.parse(xhr.responseText) as { error?: string };
          reject(new Error(err.error ?? `HTTP ${xhr.status}`));
        } catch {
          reject(new Error(`HTTP ${xhr.status}`));
        }
      }
    };

    xhr.onerror = () => reject(new Error("Network error"));
    xhr.onabort = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });

    xhr.open("POST", `/api/admin/videos/upload/${sessionId}/chunk`);
    xhr.send(formData);
  });
}

// ─── Main component ────────────────────────────────────────────────────────────
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

  // ── Upload dialog state ─────────────────────────────────────────────────────
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingResume, setPendingResume] = useState<StoredSession | null>(null);
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);

  // Global metadata defaults (applied per-file on upload start)
  const [defaultForm, setDefaultForm] = useState({ title: "", category: "sermon", preacher: "", featured: false });

  // Per-file task state (mutable ref + revision counter for re-renders)
  const tasksRef = useRef<Map<string, FileTask>>(new Map());
  const [revision, setRevision] = useState(0);
  const forceUpdate = useCallback(() => setRevision((r) => r + 1), []);

  const videoInputRef = useRef<HTMLInputElement>(null);
  const thumbnailInputRef = useRef<HTMLInputElement>(null);

  // ── Derived UI state ────────────────────────────────────────────────────────
  const tasks = Array.from(tasksRef.current.values());
  const hasFiles = tasks.length > 0;
  const isAnyUploading = tasks.some((t) => t.state === "uploading" || t.state === "initializing" || t.state === "finalizing");
  const isAllDone = hasFiles && tasks.every((t) => t.state === "done");
  const isAllFinished = hasFiles && tasks.every((t) => t.state === "done" || t.state === "error");
  const activeCount = tasks.filter((t) => t.state === "uploading" || t.state === "initializing" || t.state === "finalizing").length;
  const doneCount = tasks.filter((t) => t.state === "done").length;
  const errorCount = tasks.filter((t) => t.state === "error").length;

  // Aggregate speed across all active uploads
  const totalSpeed = tasks.reduce((sum, t) => sum + (t.state === "uploading" ? t.speed : 0), 0);
  const totalBytes = tasks.reduce((sum, t) => sum + t.file.size, 0);
  const totalUploaded = tasks.reduce((sum, t) => sum + t.bytesUploaded, 0);
  const overallProgress = totalBytes > 0 ? Math.round((totalUploaded / totalBytes) * 100) : 0;

  // ── Session recovery ────────────────────────────────────────────────────────
  useEffect(() => {
    const stored = localStorage.getItem(UPLOAD_SESSION_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as StoredSession;
        if (parsed.sessionId && parsed.fileName) setPendingResume(parsed);
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

  // ── Task helpers ────────────────────────────────────────────────────────────
  const updateTask = useCallback((id: string, patch: Partial<FileTask>) => {
    const task = tasksRef.current.get(id);
    if (task) {
      Object.assign(task, patch);
      forceUpdate();
    }
  }, [forceUpdate]);

  const addFiles = useCallback((files: File[]) => {
    const videos = files.filter((f) => f.type.startsWith("video/"));
    if (videos.length === 0) return;
    tasksRef.current.clear();
    for (const file of videos) {
      const id = crypto.randomUUID();
      const task: FileTask = {
        id, file,
        title: file.name.replace(/\.[^/.]+$/, ""),
        category: "sermon",
        preacher: "",
        featured: false,
        sessionId: null,
        state: "pending",
        progress: 0,
        bytesUploaded: 0,
        speed: 0,
        eta: 0,
        chunksTotal: 0,
        chunksDone: 0,
        error: null,
        abortController: null,
        speedSamples: [],
        bytesRef: 0,
        startTime: 0,
        durationSecs: 0,
        concurrency: MAX_CONCURRENT_PER_FILE,
        checksumOk: 0,
        checksumFailed: 0,
      };
      tasksRef.current.set(id, task);
    }
    // Pre-fill title if single file
    if (videos.length === 1) {
      setDefaultForm((prev) => ({ ...prev, title: videos[0]!.name.replace(/\.[^/.]+$/, "") }));
    } else {
      setDefaultForm((prev) => ({ ...prev, title: "" }));
    }
    forceUpdate();
  }, [forceUpdate]);

  // ── Upload engine for a single file ────────────────────────────────────────
  const runFileUpload = useCallback(async (taskId: string, resumeSession?: { sid: string; uploadedChunks: Set<number> }) => {
    const task = tasksRef.current.get(taskId);
    if (!task) return;

    updateTask(taskId, { state: "initializing", error: null });

    try {
      // Detect duration
      const durationSecs = await detectVideoDuration(task.file);
      const totalChunks = Math.ceil(task.file.size / CHUNK_SIZE);
      const ext = task.file.name.includes(".") ? `.${task.file.name.split(".").pop()}` : ".mp4";

      updateTask(taskId, {
        durationSecs,
        chunksTotal: totalChunks,
        chunksDone: 0,
        progress: 0,
        bytesRef: 0,
        bytesUploaded: 0,
        speedSamples: [],
        startTime: Date.now(),
      });

      let sid = resumeSession?.sid ?? null;
      let alreadyUploaded = resumeSession?.uploadedChunks ?? new Set<number>();
      const title = task.title || task.file.name.replace(/\.[^/.]+$/, "");

      if (!sid) {
        const initRes = await fetch("/api/admin/videos/upload/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            category: task.category,
            preacher: task.preacher,
            featured: String(task.featured),
            durationSecs: durationSecs > 0 ? String(durationSecs) : undefined,
            totalChunks: String(totalChunks),
            totalBytes: String(task.file.size),
            ext,
          }),
        });

        if (!initRes.ok) {
          const err = (await initRes.json()) as { error?: string };
          throw new Error(err.error ?? "Failed to initialize upload");
        }

        const { sessionId: newSid } = (await initRes.json()) as { sessionId: string };
        sid = newSid;

        // Save session for single-file recovery
        if (tasksRef.current.size === 1) {
          saveSession({ sessionId: sid, fileName: task.file.name, fileSize: task.file.size, totalChunks, form: { title, category: task.category, preacher: task.preacher, featured: task.featured } });
        }
      }

      updateTask(taskId, { sessionId: sid, state: "uploading" });

      // Upload thumbnail for first file
      if (thumbnailFile && !resumeSession) {
        const thumbForm = new FormData();
        thumbForm.append("thumbnail", thumbnailFile);
        await fetch(`/api/admin/videos/upload/${sid}/thumbnail`, { method: "POST", body: thumbForm });
      }

      // ── Prefetch pipeline + adaptive-concurrency chunk upload ──────────────
      const abortCtrl = new AbortController();
      updateTask(taskId, { abortController: abortCtrl });

      const queue: number[] = [];
      for (let i = 0; i < totalChunks; i++) {
        if (!alreadyUploaded.has(i)) queue.push(i);
      }

      let chunksDoneLocal = alreadyUploaded.size;
      updateTask(taskId, { chunksDone: chunksDoneLocal, progress: Math.round((chunksDoneLocal / totalChunks) * 100) });

      // ── Prefetch pool: read & hash chunks BEFORE their slot opens ──────────
      // Key optimisation: when a concurrent slot becomes free, the next chunk is
      // already prepared in memory — zero idle time on the critical path.
      interface PreparedChunk { buffer: ArrayBuffer; checksum: string; }
      const prefetchPool = new Map<number, Promise<PreparedChunk>>();

      const prepareChunk = (chunkIdx: number): Promise<PreparedChunk> => {
        if (!prefetchPool.has(chunkIdx)) {
          prefetchPool.set(chunkIdx, (async () => {
            const start = chunkIdx * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, task.file.size);
            const buffer = await task.file.slice(start, end).arrayBuffer();
            const checksum = await computeSha256(buffer);
            return { buffer, checksum };
          })());
        }
        return prefetchPool.get(chunkIdx)!;
      };

      // Eagerly pre-warm the first PREFETCH_AHEAD chunks
      queue.slice(0, PREFETCH_AHEAD).forEach(prepareChunk);

      // ── Progress / speed tracking ─────────────────────────────────────────
      // Throttled: on a fast connection XHR fires progress events hundreds of
      // times per second. We update internal state on every event but only
      // trigger a React render at most once per RENDER_THROTTLE_MS.
      let lastRenderMs = 0;
      const onChunkProgress = (incrementalBytes: number) => {
        const t = tasksRef.current.get(taskId);
        if (!t) return;
        t.bytesRef += incrementalBytes;
        t.bytesUploaded = Math.min(t.bytesRef, task.file.size);

        const now = Date.now();
        t.speedSamples.push({ time: now, bytes: t.bytesRef });
        if (t.speedSamples.length > SPEED_SAMPLES) t.speedSamples.shift();

        if (t.speedSamples.length >= 2) {
          const oldest = t.speedSamples[0]!;
          const newest = t.speedSamples[t.speedSamples.length - 1]!;
          const elapsed = (newest.time - oldest.time) / 1000;
          const bytesDelta = newest.bytes - oldest.bytes;
          t.speed = elapsed > 0 ? Math.round(bytesDelta / elapsed) : 0;
          const remaining = task.file.size - t.bytesRef;
          t.eta = t.speed > 0 ? remaining / t.speed : 0;
        }
        // Throttle React renders — internal state is always current
        if (now - lastRenderMs >= RENDER_THROTTLE_MS) {
          lastRenderMs = now;
          forceUpdate();
        }
      };

      // ── Upload a single chunk (data already in prefetch pool) ─────────────
      const uploadOneChunk = async (chunkIdx: number, queueCursor: number): Promise<void> => {
        if (abortCtrl.signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });

        // The prepared data is already in memory — no blocking wait here
        const { buffer, checksum } = await prepareChunk(chunkIdx);

        // Immediately warm up the next chunk to keep the pipeline full
        const nextPrefetch = queueCursor + PREFETCH_AHEAD;
        if (nextPrefetch < queue.length) prepareChunk(queue[nextPrefetch]!);

        let attempt = 0;
        while (attempt <= MAX_RETRIES) {
          try {
            await uploadChunk(sid!, chunkIdx, buffer, checksum, abortCtrl.signal, onChunkProgress);

            // Free memory — the buffer is no longer needed
            prefetchPool.delete(chunkIdx);

            chunksDoneLocal++;
            const t = tasksRef.current.get(taskId);
            if (t) {
              t.chunksDone = chunksDoneLocal;
              t.progress = Math.round((chunksDoneLocal / totalChunks) * 100);
              t.checksumOk++;

              // Adaptive concurrency: scale up on fast links, scale down on slow
              if (t.speed > 15 * 1024 * 1024 && t.concurrency < MAX_CONCURRENCY) {
                t.concurrency = Math.min(t.concurrency + 2, MAX_CONCURRENCY);
              } else if (t.speed > 5 * 1024 * 1024 && t.concurrency < MAX_CONCURRENCY) {
                t.concurrency = Math.min(t.concurrency + 1, MAX_CONCURRENCY);
              } else if (t.speed < 512 * 1024 && t.speed > 0 && t.concurrency > MIN_CONCURRENCY) {
                t.concurrency = Math.max(t.concurrency - 1, MIN_CONCURRENCY);
              }
            }
            forceUpdate();
            return;
          } catch (err) {
            if ((err as Error).name === "AbortError") throw err;
            const errMsg = (err as Error).message || "";
            if (errMsg.includes("checksum")) {
              // Checksum mismatch: discard the cached chunk and recompute on retry
              prefetchPool.delete(chunkIdx);
              const t = tasksRef.current.get(taskId);
              if (t) { t.checksumFailed++; forceUpdate(); }
            }
            attempt++;
            if (attempt > MAX_RETRIES) throw new Error(`Chunk ${chunkIdx} failed after ${MAX_RETRIES} retries`);
            await new Promise((r) => setTimeout(r, exponentialBackoff(attempt)));
          }
        }
      };

      // ── Semaphore dispatch loop ────────────────────────────────────────────
      // Tracks queue cursor so prefetch can look ahead correctly
      const inFlight = new Set<Promise<void>>();
      let queueHead = 0;

      const dispatch = (): void => {
        const t = tasksRef.current.get(taskId);
        if (!t || queueHead >= queue.length) return;
        const chunkIdx = queue[queueHead]!;
        const cursor = queueHead++;
        const p = uploadOneChunk(chunkIdx, cursor).finally(() => inFlight.delete(p));
        inFlight.add(p);
      };

      // Seed initial concurrency slots
      const t0 = tasksRef.current.get(taskId)!;
      for (let i = 0; i < Math.min(t0.concurrency, queue.length); i++) dispatch();

      while (inFlight.size > 0) {
        if (abortCtrl.signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
        await Promise.race(Array.from(inFlight));
        // Refill slots up to adaptive concurrency target
        const tNow = tasksRef.current.get(taskId);
        if (tNow) {
          while (inFlight.size < tNow.concurrency && queueHead < queue.length) dispatch();
        }
      }

      // ── Finalize ──────────────────────────────────────────────────────────────
      updateTask(taskId, { state: "finalizing" });
      const finalRes = await fetch(`/api/admin/videos/upload/${sid}/finalize`, { method: "POST" });
      if (!finalRes.ok) {
        const err = (await finalRes.json()) as { error?: string };
        throw new Error(err.error ?? "Finalization failed");
      }

      updateTask(taskId, { state: "done", progress: 100 });
      if (tasksRef.current.size === 1) clearSession();
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        updateTask(taskId, { state: "paused" });
        return;
      }
      const msg = err instanceof Error ? err.message : "Upload failed";
      updateTask(taskId, { state: "error", error: msg });
    }
  }, [thumbnailFile, saveSession, clearSession, updateTask, forceUpdate]);

  // ── Start all uploads (parallel, capped at MAX_CONCURRENT_FILES) ────────────
  const handleUploadAll = useCallback(async () => {
    const pending = Array.from(tasksRef.current.values()).filter((t) => t.state === "pending" || t.state === "error");
    if (pending.length === 0) return;

    // Apply default metadata
    for (const task of tasksRef.current.values()) {
      if (task.state !== "done") {
        if (defaultForm.title && tasksRef.current.size === 1) task.title = defaultForm.title;
        task.category = defaultForm.category;
        task.preacher = defaultForm.preacher;
        task.featured = defaultForm.featured;
      }
    }

    // Process in batches of MAX_CONCURRENT_FILES
    const queue = [...pending];
    const running = new Set<Promise<void>>();

    const launchNext = () => {
      if (queue.length === 0) return;
      const task = queue.shift()!;
      const p = runFileUpload(task.id).finally(() => running.delete(p));
      running.add(p);
    };

    // Seed initial batch
    for (let i = 0; i < Math.min(MAX_CONCURRENT_FILES, queue.length + running.size); i++) {
      launchNext();
    }

    // As each finishes, launch more
    while (running.size > 0) {
      await Promise.race(Array.from(running));
      while (running.size < MAX_CONCURRENT_FILES && queue.length > 0) {
        launchNext();
      }
    }

    // Post-completion
    const completedCount = Array.from(tasksRef.current.values()).filter((t) => t.state === "done").length;
    const failedCount = Array.from(tasksRef.current.values()).filter((t) => t.state === "error").length;

    if (completedCount > 0) {
      toast({
        title: `${completedCount} video${completedCount > 1 ? "s" : ""} uploaded successfully`,
        description: failedCount > 0
          ? `${failedCount} file${failedCount > 1 ? "s" : ""} failed — check errors and retry.`
          : "All content was automatically added to the broadcast queue.",
      });
      queryClient.invalidateQueries({ queryKey: getListAdminVideosQueryKey() });
    }

    // Auto-close if all succeeded
    if (failedCount === 0 && completedCount > 0) {
      setTimeout(() => {
        setShowUploadDialog(false);
        tasksRef.current.clear();
        setDefaultForm({ title: "", category: "sermon", preacher: "", featured: false });
        setThumbnailFile(null);
        forceUpdate();
        clearSession();
      }, 1500);
    }
  }, [defaultForm, runFileUpload, toast, queryClient, clearSession, forceUpdate]);

  // ── Pause a single file ─────────────────────────────────────────────────────
  const pauseTask = useCallback((id: string) => {
    const task = tasksRef.current.get(id);
    if (task?.abortController) {
      task.abortController.abort();
    }
  }, []);

  // ── Resume a single file ────────────────────────────────────────────────────
  const resumeTask = useCallback(async (id: string) => {
    const task = tasksRef.current.get(id);
    if (!task || task.state !== "paused" || !task.sessionId) return;

    updateTask(id, { state: "initializing", error: null });

    try {
      const statusRes = await fetch(`/api/admin/videos/upload/${task.sessionId}/status`);
      if (!statusRes.ok) {
        updateTask(id, { state: "pending", sessionId: null });
        return;
      }
      const status = (await statusRes.json()) as { uploadedChunkIndices?: number[] };
      const uploadedSet = new Set<number>(status.uploadedChunkIndices ?? []);
      runFileUpload(id, { sid: task.sessionId, uploadedChunks: uploadedSet });
    } catch {
      updateTask(id, { state: "error", error: "Failed to resume — try restarting" });
    }
  }, [updateTask, runFileUpload]);

  // ── Cancel a single file ────────────────────────────────────────────────────
  const cancelTask = useCallback(async (id: string) => {
    const task = tasksRef.current.get(id);
    if (!task) return;
    task.abortController?.abort();
    if (task.sessionId) {
      await fetch(`/api/admin/videos/upload/${task.sessionId}`, { method: "DELETE" }).catch(() => {});
    }
    tasksRef.current.delete(id);
    if (tasksRef.current.size === 0) clearSession();
    forceUpdate();
  }, [clearSession, forceUpdate]);

  // ── Cancel all ──────────────────────────────────────────────────────────────
  const cancelAll = useCallback(async () => {
    for (const task of tasksRef.current.values()) {
      task.abortController?.abort();
      if (task.sessionId) {
        await fetch(`/api/admin/videos/upload/${task.sessionId}`, { method: "DELETE" }).catch(() => {});
      }
    }
    tasksRef.current.clear();
    clearSession();
    setDefaultForm({ title: "", category: "sermon", preacher: "", featured: false });
    setThumbnailFile(null);
    setShowUploadDialog(false);
    forceUpdate();
  }, [clearSession, forceUpdate]);

  // ── Resume from localStorage ────────────────────────────────────────────────
  const handleResumeFromStorage = useCallback(async (file: File) => {
    if (!pendingResume) return;

    const id = crypto.randomUUID();
    const task: FileTask = {
      id, file,
      title: pendingResume.form.title,
      category: pendingResume.form.category,
      preacher: pendingResume.form.preacher,
      featured: pendingResume.form.featured,
      sessionId: pendingResume.sessionId,
      state: "initializing",
      progress: 0, bytesUploaded: 0, speed: 0, eta: 0,
      chunksTotal: pendingResume.totalChunks, chunksDone: 0,
      error: null, abortController: null,
      speedSamples: [], bytesRef: 0, startTime: Date.now(),
      durationSecs: 0, concurrency: MAX_CONCURRENT_PER_FILE,
      checksumOk: 0, checksumFailed: 0,
    };
    tasksRef.current.clear();
    tasksRef.current.set(id, task);
    forceUpdate();

    try {
      const statusRes = await fetch(`/api/admin/videos/upload/${pendingResume.sessionId}/status`);
      if (!statusRes.ok) {
        clearSession();
        tasksRef.current.clear();
        forceUpdate();
        toast({ title: "Previous session expired. Please upload again.", variant: "destructive" });
        return;
      }
      const status = (await statusRes.json()) as { uploadedChunkIndices?: number[] };
      const uploadedSet = new Set<number>(status.uploadedChunkIndices ?? []);
      runFileUpload(id, { sid: pendingResume.sessionId, uploadedChunks: uploadedSet });
    } catch {
      clearSession();
      tasksRef.current.clear();
      forceUpdate();
    }
  }, [pendingResume, clearSession, runFileUpload, toast, forceUpdate]);

  // ── Drag & drop ─────────────────────────────────────────────────────────────
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    addFiles(files);
  }, [addFiles]);

  // ── Render helpers ──────────────────────────────────────────────────────────
  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importUrl) return;

    let youtubeId = importUrl;
    if (importUrl.includes("youtube.com/watch?v=")) {
      youtubeId = importUrl.split("v=")[1]!.split("&")[0]!;
    } else if (importUrl.includes("youtu.be/")) {
      youtubeId = importUrl.split("youtu.be/")[1]!.split("?")[0]!;
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
        onError: () => toast({ title: "Failed to import video", variant: "destructive" }),
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

  // ── Render ──────────────────────────────────────────────────────────────────
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
            <span className="font-medium text-amber-700 dark:text-amber-400">Interrupted upload:</span>
            {" "}<span className="text-muted-foreground truncate">{pendingResume.fileName}</span>
          </div>
          <Button size="sm" variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400" onClick={() => setShowUploadDialog(true)}>
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
            {[1, 2, 3, 4, 5].map((i) => (
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
            {data?.videos.map((video: VideoRow) => {
              const v = video;
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
                      {isLocal && v.transcodingStatus && v.transcodingStatus !== "none" && (
                        <>
                          <span>•</span>
                          {v.transcodingStatus === "done" ? (
                            <span className="flex items-center gap-1 text-green-600 font-medium">
                              <Layers className="w-3.5 h-3.5" /> HLS Ready
                            </span>
                          ) : v.transcodingStatus === "processing" ? (
                            <span className="flex items-center gap-1 text-blue-600">
                              <Cpu className="w-3.5 h-3.5 animate-pulse" /> Encoding…
                            </span>
                          ) : v.transcodingStatus === "queued" ? (
                            <span className="flex items-center gap-1 text-amber-600">
                              <Clock className="w-3.5 h-3.5" /> In queue
                            </span>
                          ) : v.transcodingStatus === "failed" ? (
                            <span className="flex items-center gap-1 text-red-500">
                              <AlertCircle className="w-3.5 h-3.5" /> Encode failed
                            </span>
                          ) : null}
                        </>
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
                          <Edit className="h-4 w-4 mr-2" /> Edit Details
                        </DropdownMenuItem>
                        {isLocal && v.localVideoUrl ? (
                          <>
                            <DropdownMenuItem asChild>
                              <a href={v.localVideoUrl} target="_blank" rel="noopener noreferrer" className="cursor-pointer">
                                <Play className="h-4 w-4 mr-2" /> Play Local Video
                              </a>
                            </DropdownMenuItem>
                            {(v.transcodingStatus === "failed" || v.transcodingStatus === "none") && (
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={async () => {
                                  await fetch(`/api/admin/transcoding/requeue/${v.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ priority: 1 }) });
                                  toast({ title: "Video queued for re-encoding" });
                                }}
                              >
                                <Cpu className="h-4 w-4 mr-2" /> Re-encode (HLS)
                              </DropdownMenuItem>
                            )}
                          </>
                        ) : (
                          <DropdownMenuItem asChild>
                            <a href={`https://youtube.com/watch?v=${v.youtubeId}`} target="_blank" rel="noopener noreferrer" className="cursor-pointer">
                              <ExternalLink className="h-4 w-4 mr-2" /> View on YouTube
                            </a>
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive focus:bg-destructive/10 focus:text-destructive cursor-pointer" onClick={() => handleDelete(v.id)}>
                          <Trash2 className="h-4 w-4 mr-2" /> Delete
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

      {/* ── Edit Video Dialog ──────────────────────────────────────────────────── */}
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
              <Input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} required />
            </div>
            <div className="space-y-2">
              <Label>Preacher / Speaker</Label>
              <Input value={editForm.preacher} onChange={(e) => setEditForm({ ...editForm, preacher: e.target.value })} placeholder="e.g. Pastor John" />
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={editForm.category} onValueChange={(v) => setEditForm({ ...editForm, category: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between p-3 bg-muted/20 rounded-lg border">
              <div>
                <Label>Featured</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Highlights this video on the home screen</p>
              </div>
              <Switch checked={editForm.featured} onCheckedChange={(c) => setEditForm({ ...editForm, featured: c })} />
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

      {/* ── Upload Dialog ──────────────────────────────────────────────────────── */}
      <Dialog
        open={showUploadDialog}
        onOpenChange={(open) => {
          if (isAnyUploading) return;
          setShowUploadDialog(open);
          if (!open) {
            tasksRef.current.clear();
            setDefaultForm({ title: "", category: "sermon", preacher: "", featured: false });
            setThumbnailFile(null);
            forceUpdate();
          }
        }}
      >
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HardDrive className="w-5 h-5" />
              High-Speed Video Upload
              {hasFiles && (
                <span className="ml-auto text-xs font-normal text-muted-foreground">
                  {tasks.length} file{tasks.length > 1 ? "s" : ""} · {formatFileSize(totalBytes)}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* ── Drop zone ──────────────────────────────────────────────────── */}
            {!isAnyUploading && (
              <div
                className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-colors ${
                  isDragging ? "border-primary bg-primary/5" : hasFiles ? "border-primary/40 bg-primary/5" : "hover:border-primary/60 hover:bg-muted/20"
                }`}
                onClick={() => videoInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
              >
                <input
                  ref={videoInputRef}
                  type="file"
                  accept="video/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    addFiles(files);
                  }}
                />
                {hasFiles ? (
                  <div className="flex items-center justify-center gap-3">
                    <FileVideo className="w-6 h-6 text-primary shrink-0" />
                    <div className="text-left">
                      <p className="text-sm font-medium">
                        {tasks.length} video{tasks.length > 1 ? "s" : ""} selected
                      </p>
                      <p className="text-xs text-muted-foreground">{formatFileSize(totalBytes)} total · Click to change</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Upload className="w-8 h-8 mx-auto text-muted-foreground opacity-50" />
                    <p className="text-sm font-medium">Drop video files here or click to select</p>
                    <p className="text-xs text-muted-foreground">MP4, MOV, AVI, MKV · Multiple files supported · Up to 5 GB each</p>
                    <div className="flex items-center justify-center gap-4 mt-3 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1"><Zap className="w-3 h-3" /> 32 MB chunks</span>
                      <span className="flex items-center gap-1"><Wifi className="w-3 h-3" /> 12 parallel streams</span>
                      <span className="flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> SHA-256 verified</span>
                      <span className="flex items-center gap-1"><TrendingUp className="w-3 h-3" /> Prefetch pipeline</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Pending resume banner ──────────────────────────────────────── */}
            {pendingResume && !hasFiles && !isAnyUploading && (
              <div className="flex items-center gap-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs">
                <RotateCcw className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                <div className="flex-1">
                  <span className="font-medium text-amber-700 dark:text-amber-400">Interrupted upload found</span>
                  <p className="text-muted-foreground mt-0.5">{pendingResume.fileName} — select the same file and resume.</p>
                </div>
                {tasks.length === 1 && tasks[0]!.file.name === pendingResume.fileName && (
                  <Button size="sm" type="button" variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400 shrink-0" onClick={() => handleResumeFromStorage(tasks[0]!.file)}>
                    Resume
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="text-muted-foreground shrink-0" onClick={clearSession}>
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}

            {/* ── File list with per-file progress cards ─────────────────────── */}
            {hasFiles && (
              <div className="space-y-2">
                {tasks.map((task) => (
                  <FileTaskCard
                    key={task.id}
                    task={task}
                    onPause={() => pauseTask(task.id)}
                    onResume={() => resumeTask(task.id)}
                    onCancel={() => cancelTask(task.id)}
                    onRetry={() => runFileUpload(task.id)}
                  />
                ))}
              </div>
            )}

            {/* ── Aggregate stats (during upload) ──────────────────────────── */}
            {isAnyUploading && (
              <div className="p-3 bg-muted/30 rounded-lg border space-y-2">
                <div className="flex items-center justify-between text-xs font-medium">
                  <span className="flex items-center gap-1.5">
                    <Zap className="w-3 h-3 text-primary animate-pulse" />
                    {activeCount} active · {doneCount} done{errorCount > 0 ? ` · ${errorCount} failed` : ""}
                  </span>
                  <span className="font-mono">{overallProgress}% overall</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${overallProgress}%` }} />
                </div>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1"><Activity className="w-3 h-3" /> {totalSpeed > 0 ? formatSpeed(totalSpeed) : "—"} aggregate</span>
                  <span>{formatFileSize(totalUploaded)} / {formatFileSize(totalBytes)}</span>
                </div>
              </div>
            )}

            {/* ── Metadata form ────────────────────────────────────────────── */}
            {hasFiles && !isAnyUploading && !isAllDone && (
              <div className="space-y-3 pt-1 border-t">
                <p className="text-xs text-muted-foreground font-medium pt-1">
                  {tasks.length > 1 ? "Metadata applied to all files (titles default to filename)" : "Video details"}
                </p>

                {/* Thumbnail */}
                <div
                  className="border rounded-lg p-3 flex items-center gap-3 cursor-pointer hover:bg-muted/20 transition-colors"
                  onClick={() => thumbnailInputRef.current?.click()}
                >
                  <input
                    ref={thumbnailInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => setThumbnailFile(e.target.files?.[0] ?? null)}
                  />
                  {thumbnailFile ? (
                    <img src={URL.createObjectURL(thumbnailFile)} className="w-14 h-9 object-cover rounded" alt="thumbnail" />
                  ) : (
                    <div className="w-14 h-9 bg-muted rounded flex items-center justify-center shrink-0">
                      <Upload className="w-3.5 h-3.5 text-muted-foreground opacity-40" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{thumbnailFile ? thumbnailFile.name : "Add thumbnail (optional)"}</p>
                    <p className="text-xs text-muted-foreground">JPG, PNG, WebP</p>
                  </div>
                </div>

                {tasks.length === 1 && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Title <span className="text-destructive">*</span></Label>
                    <Input
                      value={defaultForm.title}
                      onChange={(e) => setDefaultForm({ ...defaultForm, title: e.target.value })}
                      placeholder="e.g. Sunday Service — Faith That Moves Mountains"
                    />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Preacher</Label>
                    <Input
                      value={defaultForm.preacher}
                      onChange={(e) => setDefaultForm({ ...defaultForm, preacher: e.target.value })}
                      placeholder="e.g. Prophet Amos"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Category</Label>
                    <Select value={defaultForm.category} onValueChange={(v) => setDefaultForm({ ...defaultForm, category: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CATEGORIES.map((c) => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex items-center justify-between p-2.5 bg-muted/20 rounded-lg border">
                  <div>
                    <Label className="text-xs">Featured</Label>
                    <p className="text-[11px] text-muted-foreground">Pin to top of home screen</p>
                  </div>
                  <Switch checked={defaultForm.featured} onCheckedChange={(c) => setDefaultForm({ ...defaultForm, featured: c })} />
                </div>
              </div>
            )}

            {/* ── Success banner ────────────────────────────────────────────── */}
            {isAllDone && (
              <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/30 rounded-lg text-sm text-green-700 dark:text-green-400">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                All videos uploaded and queued for broadcast!
              </div>
            )}

            {/* ── Action buttons ────────────────────────────────────────────── */}
            <div className="flex gap-2 pt-1">
              {!isAnyUploading && !isAllDone && (
                <Button type="button" variant="outline" className="flex-1" onClick={cancelAll}>
                  <X className="w-4 h-4 mr-1.5" />
                  {hasFiles ? "Cancel" : "Close"}
                </Button>
              )}
              {isAnyUploading && (
                <Button type="button" variant="outline" className="flex-1" onClick={cancelAll}>
                  <X className="w-4 h-4 mr-1.5" />
                  Cancel All
                </Button>
              )}
              {!isAnyUploading && !isAllDone && hasFiles && (
                <Button
                  type="button"
                  className="flex-1"
                  disabled={tasks.length === 1 && !defaultForm.title.trim()}
                  onClick={handleUploadAll}
                >
                  <Zap className="w-4 h-4 mr-1.5" />
                  {isAllFinished && errorCount > 0 ? `Retry ${errorCount} Failed` : tasks.length > 1 ? `Upload ${tasks.length} Videos` : "Upload Video"}
                </Button>
              )}
              {isAllFinished && !isAnyUploading && !isAllDone && errorCount > 0 && doneCount > 0 && (
                <Button type="button" variant="outline" className="flex-1" onClick={() => {
                  setShowUploadDialog(false);
                  tasksRef.current.clear();
                  forceUpdate();
                }}>
                  Close
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Per-file upload card component ─────────────────────────────────────────────
function FileTaskCard({
  task,
  onPause,
  onResume,
  onCancel,
  onRetry,
}: {
  task: FileTask;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const isActive = task.state === "uploading" || task.state === "initializing" || task.state === "finalizing";
  const isPaused = task.state === "paused";
  const isDone = task.state === "done";
  const isError = task.state === "error";
  const isPending = task.state === "pending";

  return (
    <div className={`rounded-lg border p-3 space-y-2 transition-colors ${
      isDone ? "bg-green-500/5 border-green-500/30" :
      isError ? "bg-destructive/5 border-destructive/30" :
      isPaused ? "bg-amber-500/5 border-amber-500/30" :
      isActive ? "bg-primary/5 border-primary/30" :
      "bg-muted/20"
    }`}>
      <div className="flex items-start gap-2">
        <div className="shrink-0 mt-0.5">
          {isDone ? <CheckCircle2 className="w-4 h-4 text-green-500" /> :
           isError ? <AlertCircle className="w-4 h-4 text-destructive" /> :
           isPaused ? <Pause className="w-4 h-4 text-amber-500" /> :
           isActive ? <Zap className="w-4 h-4 text-primary animate-pulse" /> :
           <FileVideo className="w-4 h-4 text-muted-foreground" />}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium truncate" title={task.file.name}>{task.file.name}</p>
            <span className="text-[10px] text-muted-foreground shrink-0">{formatFileSize(task.file.size)}</span>
          </div>

          {/* Status line */}
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
            {isDone && <span className="text-green-600 font-medium">Done · added to broadcast queue</span>}
            {isError && <span className="text-destructive">{task.error ?? "Upload failed"}</span>}
            {isPending && <span>Pending</span>}
            {isActive && (
              <>
                {task.state === "initializing" && <span>Initializing…</span>}
                {task.state === "finalizing" && <span className="flex items-center gap-1"><Loader2 className="w-2.5 h-2.5 animate-spin" />Finalizing…</span>}
                {task.state === "uploading" && (
                  <>
                    <span className="flex items-center gap-1"><Activity className="w-2.5 h-2.5" />{task.speed > 0 ? formatSpeed(task.speed) : "—"}</span>
                    <span>·</span>
                    <span>{task.chunksDone}/{task.chunksTotal} chunks</span>
                    <span>·</span>
                    <span className="flex items-center gap-1"><Wifi className="w-2.5 h-2.5" />{task.concurrency} streams</span>
                    {task.eta > 0 && <><span>·</span><span className="flex items-center gap-1"><Clock className="w-2.5 h-2.5" />{formatEta(task.eta)}</span></>}
                    {task.checksumOk > 0 && <><span>·</span><span className="flex items-center gap-1 text-green-600"><ShieldCheck className="w-2.5 h-2.5" />{task.checksumOk}</span></>}
                  </>
                )}
              </>
            )}
            {isPaused && <span className="text-amber-600">Paused · {task.progress}% done</span>}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {task.state === "uploading" && (
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onPause} title="Pause">
              <Pause className="w-3 h-3" />
            </Button>
          )}
          {isPaused && (
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onResume} title="Resume">
              <Zap className="w-3 h-3" />
            </Button>
          )}
          {isError && (
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onRetry} title="Retry">
              <RotateCcw className="w-3 h-3" />
            </Button>
          )}
          {!isDone && (
            <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={onCancel} title="Cancel">
              <X className="w-3 h-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {(isActive || isPaused) && task.chunksTotal > 0 && (
        <div className="space-y-1">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${isPaused ? "bg-amber-500" : "bg-primary"}`}
              style={{ width: `${task.progress}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{formatFileSize(task.bytesUploaded)} / {formatFileSize(task.file.size)}</span>
            <span className="font-mono">{task.progress}%</span>
          </div>
        </div>
      )}
    </div>
  );
}
