/**
 * VideoUploadModal — reusable high-speed video upload dialog.
 *
 * Used in:
 *   - Video Library page (storageKey = "ttv-upload-session-v4")
 *   - Broadcast Queue page (storageKey = "ttv-broadcast-upload-v1")
 *
 * After every successful finalize the API server automatically calls
 * upsertBroadcastQueueVideo, so the parent only needs to refresh its list
 * in the onUploadsComplete callback.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  HardDrive,
  Upload,
  Zap,
  X,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  Pause,
  Loader2,
  FileVideo,
  Activity,
  Clock,
  Wifi,
  ShieldCheck,
  Server,
  Minimize2,
  Gauge,
  Radio,
} from "lucide-react";
import {
  isCompressionSupported,
  probeVideo,
  shouldCompress,
  compressVideo,
  type CompressionOptions,
} from "@/lib/videoCompressor";
import {
  MIN_CONCURRENCY,
  MAX_CONCURRENT_FILES,
  RENDER_THROTTLE_MS,
  MAX_RETRIES,
  SPEED_SAMPLES,
  CATEGORIES,
  type FileTask,
  type StoredSession,
  exponentialBackoff,
  computeSha256,
  detectVideoDuration,
  readJsonOrThrow,
  uploadChunk,
  formatFileSize,
  formatSpeed,
  formatEta,
  getAdaptiveNetworkParams,
  emaSpeed,
  networkTypeLabel,
} from "@/lib/uploadEngine";

const DEFAULT_COMPRESSION_OPTS: CompressionOptions = {
  maxHeight: 1080,
  targetBitrate: 4_000_000,
  targetFps: 30,
  hardwareAcceleration: "prefer-hardware",
};

export interface VideoUploadModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once all uploads finish successfully (receives count of uploaded videos). */
  onUploadsComplete?: (count: number) => void;
  /** Storage key for interrupted-session recovery. Must differ per usage site. */
  storageKey?: string;
  /** Optional banner shown below the title when in broadcast context. */
  broadcastMode?: boolean;
}

export function VideoUploadModal({
  open,
  onOpenChange,
  onUploadsComplete,
  storageKey = "ttv-upload-session-v4",
  broadcastMode = false,
}: VideoUploadModalProps) {
  const { toast } = useToast();

  // ── Upload task registry ────────────────────────────────────────────────────
  const tasksRef = useRef<Map<string, FileTask>>(new Map());
  const [revision, setRevision] = useState(0);
  const forceUpdate = useCallback(() => setRevision((r) => r + 1), []);

  // ── UI state ────────────────────────────────────────────────────────────────
  const [isDragging, setIsDragging] = useState(false);
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [compressionEnabled, setCompressionEnabled] = useState(isCompressionSupported());
  const [defaultForm, setDefaultForm] = useState({
    title: "",
    category: "sermon",
    preacher: "",
    featured: false,
  });
  const [pendingResume, setPendingResume] = useState<StoredSession | null>(null);

  const videoInputRef = useRef<HTMLInputElement>(null);
  const thumbnailInputRef = useRef<HTMLInputElement>(null);

  // ── Derived UI state ────────────────────────────────────────────────────────
  const tasks = Array.from(tasksRef.current.values());
  const hasFiles = tasks.length > 0;
  const isAnyUploading = tasks.some(
    (t) =>
      t.state === "uploading" ||
      t.state === "initializing" ||
      t.state === "finalizing" ||
      t.state === "compressing",
  );
  const isAllDone = hasFiles && tasks.every((t) => t.state === "done");
  const isAllFinished =
    hasFiles && tasks.every((t) => t.state === "done" || t.state === "error");
  const activeCount = tasks.filter(
    (t) =>
      t.state === "uploading" ||
      t.state === "initializing" ||
      t.state === "finalizing" ||
      t.state === "compressing",
  ).length;
  const doneCount = tasks.filter((t) => t.state === "done").length;
  const errorCount = tasks.filter((t) => t.state === "error").length;
  const totalBytes = tasks.reduce((s, t) => s + t.file.size, 0);
  const totalUploaded = tasks.reduce((s, t) => s + t.bytesUploaded, 0);
  const overallProgress = totalBytes > 0 ? Math.round((totalUploaded / totalBytes) * 100) : 0;
  const totalSpeed = tasks.reduce(
    (s, t) => s + (t.state === "uploading" ? t.speed : 0),
    0,
  );

  // ── Session recovery (localStorage) ────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as StoredSession;
        if (parsed.sessionId && parsed.fileName) setPendingResume(parsed);
      } catch {
        localStorage.removeItem(storageKey);
      }
    }
  }, [open, storageKey]);

  const saveSession = useCallback(
    (session: StoredSession) => {
      localStorage.setItem(storageKey, JSON.stringify(session));
    },
    [storageKey],
  );

  const clearSession = useCallback(() => {
    localStorage.removeItem(storageKey);
    setPendingResume(null);
  }, [storageKey]);

  // ── Task helpers ────────────────────────────────────────────────────────────
  const updateTask = useCallback(
    (id: string, patch: Partial<FileTask>) => {
      const task = tasksRef.current.get(id);
      if (task) {
        Object.assign(task, patch);
        forceUpdate();
      }
    },
    [forceUpdate],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      const videos = files.filter((f) => f.type.startsWith("video/"));
      if (videos.length === 0) return;
      tasksRef.current.clear();
      const netParams = getAdaptiveNetworkParams();
      for (const file of videos) {
        const id = crypto.randomUUID();
        const task: FileTask = {
          id,
          file,
          title: file.name.replace(/\.[^/.]+$/, ""),
          category: "sermon",
          preacher: "",
          featured: false,
          sessionId: null,
          state: "pending",
          progress: 0,
          bytesUploaded: 0,
          speed: 0,
          speedRaw: 0,
          eta: 0,
          chunksTotal: 0,
          chunksDone: 0,
          error: null,
          abortController: null,
          speedSamples: [],
          bytesRef: 0,
          startTime: 0,
          durationSecs: 0,
          concurrency: netParams.maxConcurrency,
          checksumOk: 0,
          checksumFailed: 0,
          stallCount: 0,
          skipCompression: false,
          compressionProgress: null,
          compressedBlob: null,
          probe: null,
          // ── Adaptive network params ──────────────────────────────────────
          chunkSize: netParams.chunkSize,
          maxConcurrency: netParams.maxConcurrency,
          prefetchAhead: netParams.prefetchAhead,
          stallTimeoutMs: netParams.stallTimeoutMs,
          networkType: netParams.networkType,
          tier: netParams.tier,
        };
        tasksRef.current.set(id, task);
      }
      if (videos.length === 1) {
        setDefaultForm((prev) => ({
          ...prev,
          title: videos[0]!.name.replace(/\.[^/.]+$/, ""),
        }));
      } else {
        setDefaultForm((prev) => ({ ...prev, title: "" }));
      }
      forceUpdate();
    },
    [forceUpdate],
  );

  // ── Upload engine for a single file ────────────────────────────────────────
  const runFileUpload = useCallback(
    async (
      taskId: string,
      resumeSession?: { sid: string; uploadedChunks: Set<number> },
    ) => {
      const task = tasksRef.current.get(taskId);
      if (!task) return;

      updateTask(taskId, { state: "initializing", error: null });

      try {
        // Phase 0: client-side compression (optional)
        let uploadFile = task.file;
        if (compressionEnabled && !task.skipCompression && !resumeSession) {
          const probe = await probeVideo(task.file);
          updateTask(taskId, { probe });

          if (shouldCompress(probe, DEFAULT_COMPRESSION_OPTS, task.file.size)) {
            updateTask(taskId, {
              state: "compressing",
              compressionProgress: {
                phase: "analyzing",
                progress: 0,
                eta: 0,
                inputSize: task.file.size,
                outputSize: task.file.size,
                compressionRatio: 1,
                fps: 0,
              },
            });

            const abortCtrl = new AbortController();
            updateTask(taskId, { abortController: abortCtrl });

            const compressed = await compressVideo(
              task.file,
              DEFAULT_COMPRESSION_OPTS,
              probe,
              (cp) => {
                const t = tasksRef.current.get(taskId);
                if (t) {
                  t.compressionProgress = cp;
                  forceUpdate();
                }
              },
              abortCtrl.signal,
            );

            uploadFile = new File(
              [compressed],
              task.file.name.replace(/\.[^.]+$/, ".mp4"),
              { type: "video/mp4" },
            );
            updateTask(taskId, {
              compressedBlob: compressed,
              compressionProgress: null,
              abortController: null,
            });
          }
        }

        const durationSecs = await detectVideoDuration(uploadFile);
        // Use this task's adaptive chunk size (determined at task creation from network)
        const chunkSize = tasksRef.current.get(taskId)?.chunkSize ?? 8 * 1024 * 1024;
        const totalChunks = Math.ceil(uploadFile.size / chunkSize);
        const ext = uploadFile.name.includes(".")
          ? `.${uploadFile.name.split(".").pop()}`
          : ".mp4";

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
        const alreadyUploaded = resumeSession?.uploadedChunks ?? new Set<number>();
        const currentTask = tasksRef.current.get(taskId)!;
        const title = currentTask.title || task.file.name.replace(/\.[^/.]+$/, "");

        if (!sid) {
          const newSid = crypto.randomUUID();
          const initBody = JSON.stringify({
            sessionId: newSid,
            title,
            category: currentTask.category,
            preacher: currentTask.preacher,
            featured: String(currentTask.featured),
            durationSecs: durationSecs > 0 ? String(durationSecs) : undefined,
            totalChunks: String(totalChunks),
            totalBytes: String(uploadFile.size),
            ext,
            originalFilename: uploadFile.name,
          });

          let lastInitError: Error | null = null;
          for (let attempt = 0; ; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
            let initRes: Response;
            try {
              initRes = await fetch("/api/admin/videos/upload/init", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: initBody,
              });
            } catch (e) {
              lastInitError = e instanceof Error ? e : new Error(String(e));
              if (attempt >= 2)
                throw new Error(
                  `Upload init network error after 3 attempts: ${lastInitError.message}`,
                );
              continue;
            }

            if (initRes.ok) break;

            if (initRes.status >= 400 && initRes.status < 500) {
              const text = await initRes.text().catch(() => "");
              const parsed = (() => {
                try {
                  return JSON.parse(text) as { error?: string };
                } catch {
                  return null;
                }
              })();
              throw new Error(
                parsed?.error ??
                  `Upload init rejected (HTTP ${initRes.status}): ${text.slice(0, 120)}`,
              );
            }

            lastInitError = new Error(`Upload init HTTP ${initRes.status}`);
            if (attempt >= 2)
              throw new Error(
                `Upload init failed after 3 attempts: ${lastInitError.message}`,
              );
          }

          sid = newSid;

          if (tasksRef.current.size === 1) {
            saveSession({
              sessionId: sid,
              fileName: task.file.name,
              fileSize: task.file.size,
              totalChunks,
              chunkSize,
              form: {
                title,
                category: currentTask.category,
                preacher: currentTask.preacher,
                featured: currentTask.featured,
              },
            });
          }
        }

        updateTask(taskId, { sessionId: sid, state: "uploading" });

        // Upload thumbnail for first file
        if (thumbnailFile && !resumeSession) {
          const thumbForm = new FormData();
          thumbForm.append("thumbnail", thumbnailFile);
          await fetch(`/api/admin/videos/upload/${sid}/thumbnail`, {
            method: "POST",
            body: thumbForm,
          });
        }

        // Prefetch pool
        interface PreparedChunk {
          buffer: ArrayBuffer;
          checksum: string;
        }
        const prefetchPool = new Map<number, Promise<PreparedChunk>>();

        // Snapshot the task's adaptive params once (they don't change mid-upload)
        const taskSnap = tasksRef.current.get(taskId)!;
        const prefetchAhead = taskSnap.prefetchAhead;
        const taskStallMs = taskSnap.stallTimeoutMs;

        const prepareChunk = (chunkIdx: number): Promise<PreparedChunk> => {
          if (!prefetchPool.has(chunkIdx)) {
            prefetchPool.set(
              chunkIdx,
              (async () => {
                const start = chunkIdx * chunkSize;
                const end = Math.min(start + chunkSize, uploadFile.size);
                const buffer = await uploadFile.slice(start, end).arrayBuffer();
                const checksum = await computeSha256(buffer);
                return { buffer, checksum };
              })(),
            );
          }
          return prefetchPool.get(chunkIdx)!;
        };

        const queue: number[] = [];
        for (let i = 0; i < totalChunks; i++) {
          if (!alreadyUploaded.has(i)) queue.push(i);
        }
        queue.slice(0, prefetchAhead).forEach(prepareChunk);

        let chunksDoneLocal = alreadyUploaded.size;
        updateTask(taskId, {
          chunksDone: chunksDoneLocal,
          progress: Math.round((chunksDoneLocal / totalChunks) * 100),
        });

        let lastRenderMs = 0;
        const onChunkProgress = (incrementalBytes: number) => {
          const t = tasksRef.current.get(taskId);
          if (!t) return;
          t.bytesRef += incrementalBytes;
          t.bytesUploaded = Math.min(t.bytesRef, uploadFile.size);
          const now = Date.now();
          t.speedSamples.push({ time: now, bytes: t.bytesRef });
          if (t.speedSamples.length > SPEED_SAMPLES) t.speedSamples.shift();
          if (t.speedSamples.length >= 2) {
            // Raw speed from the sliding window
            const oldest = t.speedSamples[0]!;
            const newest = t.speedSamples[t.speedSamples.length - 1]!;
            const elapsed = (newest.time - oldest.time) / 1000;
            const bytesDelta = newest.bytes - oldest.bytes;
            const rawSpeed = elapsed > 0 ? Math.round(bytesDelta / elapsed) : 0;
            // EMA smoothing — reduces jitter from TCP bursts / network variance
            t.speedRaw = rawSpeed;
            t.speed = Math.round(emaSpeed(t.speed, rawSpeed));
            const remaining = uploadFile.size - t.bytesRef;
            t.eta = t.speed > 0 ? remaining / t.speed : 0;
          }
          if (now - lastRenderMs >= RENDER_THROTTLE_MS) {
            lastRenderMs = now;
            forceUpdate();
          }
        };

        const abortCtrl = new AbortController();
        updateTask(taskId, { abortController: abortCtrl });

        const uploadOneChunk = async (
          chunkIdx: number,
          queueCursor: number,
        ): Promise<void> => {
          if (abortCtrl.signal.aborted)
            throw Object.assign(new Error("Aborted"), { name: "AbortError" });
          const { buffer, checksum } = await prepareChunk(chunkIdx);
          const nextPrefetch = queueCursor + prefetchAhead;
          if (nextPrefetch < queue.length) prepareChunk(queue[nextPrefetch]!);

          let attempt = 0;
          while (attempt <= MAX_RETRIES) {
            try {
              await uploadChunk(
                sid!,
                chunkIdx,
                buffer,
                checksum,
                abortCtrl.signal,
                onChunkProgress,
                taskStallMs,
              );
              prefetchPool.delete(chunkIdx);
              chunksDoneLocal++;
              const t = tasksRef.current.get(taskId);
              if (t) {
                t.chunksDone = chunksDoneLocal;
                t.progress = Math.round((chunksDoneLocal / totalChunks) * 100);
                t.checksumOk++;
                // Speed-adaptive concurrency scaling.
                // Ramp up aggressively on fast networks, ramp down on congestion.
                const spd = t.speed;
                const MB = 1024 * 1024;
                const cap = t.maxConcurrency;
                if (spd > 100 * MB && t.concurrency < cap)
                  t.concurrency = Math.min(t.concurrency + 8, cap);   // 5G ultra-fast
                else if (spd > 50 * MB && t.concurrency < cap)
                  t.concurrency = Math.min(t.concurrency + 6, cap);   // 5G
                else if (spd > 20 * MB && t.concurrency < cap)
                  t.concurrency = Math.min(t.concurrency + 4, cap);   // fast Wi-Fi
                else if (spd > 10 * MB && t.concurrency < cap)
                  t.concurrency = Math.min(t.concurrency + 3, cap);   // 4G+
                else if (spd > 3 * MB && t.concurrency < cap)
                  t.concurrency = Math.min(t.concurrency + 1, cap);   // 4G
                else if (spd < 256 * 1024 && spd > 0 && t.concurrency > MIN_CONCURRENCY)
                  t.concurrency = Math.max(t.concurrency - 3, MIN_CONCURRENCY);
                else if (spd < 768 * 1024 && spd > 0 && t.concurrency > MIN_CONCURRENCY)
                  t.concurrency = Math.max(t.concurrency - 2, MIN_CONCURRENCY);
                else if (spd < 2 * MB && spd > 0 && t.concurrency > MIN_CONCURRENCY + 1)
                  t.concurrency = Math.max(t.concurrency - 1, MIN_CONCURRENCY);
              }
              forceUpdate();
              return;
            } catch (err) {
              const errName = (err as Error).name;
              if (errName === "AbortError") throw err;
              const errMsg = (err as Error).message || "";

              // Stall recovery: reset EMA on the task so it recalibrates
              if (errName === "StallError") {
                const t = tasksRef.current.get(taskId);
                if (t) {
                  t.stallCount = (t.stallCount ?? 0) + 1;
                  t.speed = 0; // force EMA reset so new measurement is clean
                  t.speedSamples = [];
                  // Reduce concurrency — stall implies network pressure
                  t.concurrency = Math.max(Math.floor(t.concurrency * 0.6), MIN_CONCURRENCY);
                  forceUpdate();
                }
              }

              if (errMsg.includes("checksum")) {
                prefetchPool.delete(chunkIdx);
                const t = tasksRef.current.get(taskId);
                if (t) {
                  t.checksumFailed++;
                  forceUpdate();
                }
              }
              attempt++;
              if (attempt > MAX_RETRIES)
                throw new Error(`Chunk ${chunkIdx} failed after ${MAX_RETRIES} retries`);
              await new Promise((r) => setTimeout(r, exponentialBackoff(attempt)));
            }
          }
        };

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

        const t0 = tasksRef.current.get(taskId)!;
        for (let i = 0; i < Math.min(t0.concurrency, queue.length); i++) dispatch();

        while (inFlight.size > 0) {
          if (abortCtrl.signal.aborted)
            throw Object.assign(new Error("Aborted"), { name: "AbortError" });
          await Promise.race(Array.from(inFlight));
          const tNow = tasksRef.current.get(taskId);
          if (tNow) {
            while (inFlight.size < tNow.concurrency && queueHead < queue.length)
              dispatch();
          }
        }

        // Finalize
        updateTask(taskId, { state: "finalizing" });
        const finalRes = await fetch(
          `/api/admin/videos/upload/${sid}/finalize`,
          { method: "POST" },
        );
        if (!finalRes.ok) {
          const err = await readJsonOrThrow<{ error?: string }>(
            finalRes,
            "Finalize failed",
          ).catch((e) => {
            throw new Error(e instanceof Error ? e.message : String(e));
          });
          throw new Error(err.error ?? `Finalization failed (HTTP ${finalRes.status})`);
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
    },
    [
      thumbnailFile,
      compressionEnabled,
      saveSession,
      clearSession,
      updateTask,
      forceUpdate,
    ],
  );

  // ── Start all uploads ───────────────────────────────────────────────────────
  const handleUploadAll = useCallback(async () => {
    const pending = Array.from(tasksRef.current.values()).filter(
      (t) => t.state === "pending" || t.state === "error",
    );
    if (pending.length === 0) return;

    for (const task of tasksRef.current.values()) {
      if (task.state !== "done") {
        if (defaultForm.title && tasksRef.current.size === 1)
          task.title = defaultForm.title;
        task.category = defaultForm.category;
        task.preacher = defaultForm.preacher;
        task.featured = defaultForm.featured;
      }
    }

    const queue = [...pending];
    const running = new Set<Promise<void>>();
    const launchNext = () => {
      if (queue.length === 0) return;
      const task = queue.shift()!;
      const p = runFileUpload(task.id).finally(() => running.delete(p));
      running.add(p);
    };
    for (let i = 0; i < Math.min(MAX_CONCURRENT_FILES, queue.length + running.size); i++)
      launchNext();
    while (running.size > 0) {
      await Promise.race(Array.from(running));
      while (running.size < MAX_CONCURRENT_FILES && queue.length > 0) launchNext();
    }

    const completedCount = Array.from(tasksRef.current.values()).filter(
      (t) => t.state === "done",
    ).length;
    const failedCount = Array.from(tasksRef.current.values()).filter(
      (t) => t.state === "error",
    ).length;

    if (completedCount > 0) {
      toast({
        title: `${completedCount} video${completedCount > 1 ? "s" : ""} uploaded successfully`,
        description:
          failedCount > 0
            ? `${failedCount} file${failedCount > 1 ? "s" : ""} failed — check errors and retry.`
            : broadcastMode
              ? "Videos added to the broadcast queue and ready to air."
              : "All content was automatically added to the broadcast queue.",
      });
      onUploadsComplete?.(completedCount);
    }

    if (failedCount === 0 && completedCount > 0) {
      setTimeout(() => {
        onOpenChange(false);
        tasksRef.current.clear();
        setDefaultForm({ title: "", category: "sermon", preacher: "", featured: false });
        setThumbnailFile(null);
        forceUpdate();
        clearSession();
        onUploadsComplete?.(completedCount);
      }, 1500);
    }
  }, [
    defaultForm,
    runFileUpload,
    toast,
    clearSession,
    forceUpdate,
    onUploadsComplete,
    onOpenChange,
    broadcastMode,
  ]);

  const pauseTask = useCallback(
    (id: string) => {
      const task = tasksRef.current.get(id);
      task?.abortController?.abort();
    },
    [],
  );

  const resumeTask = useCallback(
    async (id: string) => {
      const task = tasksRef.current.get(id);
      if (!task || task.state !== "paused" || !task.sessionId) return;
      updateTask(id, { state: "initializing", error: null });
      try {
        const statusRes = await fetch(
          `/api/admin/videos/upload/${task.sessionId}/status`,
        );
        if (!statusRes.ok) {
          updateTask(id, { state: "pending", sessionId: null });
          return;
        }
        const status = await readJsonOrThrow<{ uploadedChunkIndices?: number[] }>(
          statusRes,
          "Status check",
        );
        const uploadedSet = new Set<number>(status.uploadedChunkIndices ?? []);
        runFileUpload(id, { sid: task.sessionId, uploadedChunks: uploadedSet });
      } catch {
        updateTask(id, { state: "error", error: "Failed to resume — try restarting" });
      }
    },
    [updateTask, runFileUpload],
  );

  const cancelTask = useCallback(
    async (id: string) => {
      const task = tasksRef.current.get(id);
      if (!task) return;
      task.abortController?.abort();
      if (task.sessionId) {
        await fetch(`/api/admin/videos/upload/${task.sessionId}`, {
          method: "DELETE",
        }).catch(() => {});
      }
      tasksRef.current.delete(id);
      if (tasksRef.current.size === 0) clearSession();
      forceUpdate();
    },
    [clearSession, forceUpdate],
  );

  const cancelAll = useCallback(async () => {
    for (const task of tasksRef.current.values()) {
      task.abortController?.abort();
      if (task.sessionId) {
        await fetch(`/api/admin/videos/upload/${task.sessionId}`, {
          method: "DELETE",
        }).catch(() => {});
      }
    }
    tasksRef.current.clear();
    clearSession();
    setDefaultForm({ title: "", category: "sermon", preacher: "", featured: false });
    setThumbnailFile(null);
    onOpenChange(false);
    forceUpdate();
  }, [clearSession, forceUpdate, onOpenChange]);

  const handleResumeFromStorage = useCallback(
    async (file: File) => {
      if (!pendingResume) return;
      const id = crypto.randomUUID();
      // Re-detect network params for this resume; use stored chunkSize to
      // preserve the chunk boundaries the server already has on disk.
      const netParams = getAdaptiveNetworkParams();
      const resumedChunkSize = pendingResume.chunkSize ?? netParams.chunkSize;
      const task: FileTask = {
        id,
        file,
        title: pendingResume.form.title,
        category: pendingResume.form.category,
        preacher: pendingResume.form.preacher,
        featured: pendingResume.form.featured,
        sessionId: pendingResume.sessionId,
        state: "initializing",
        progress: 0,
        bytesUploaded: 0,
        speed: 0,
        eta: 0,
        chunksTotal: pendingResume.totalChunks,
        chunksDone: 0,
        error: null,
        abortController: null,
        speedSamples: [],
        bytesRef: 0,
        startTime: Date.now(),
        durationSecs: 0,
        concurrency: netParams.maxConcurrency,
        checksumOk: 0,
        checksumFailed: 0,
        stallCount: 0,
        speedRaw: 0,
        skipCompression: true,
        compressionProgress: null,
        compressedBlob: null,
        probe: null,
        // Adaptive network params — chunkSize MUST match what was originally sent
        chunkSize: resumedChunkSize,
        maxConcurrency: netParams.maxConcurrency,
        prefetchAhead: netParams.prefetchAhead,
        stallTimeoutMs: netParams.stallTimeoutMs,
        networkType: netParams.networkType,
        tier: netParams.tier,
      };
      tasksRef.current.clear();
      tasksRef.current.set(id, task);
      forceUpdate();

      try {
        const statusRes = await fetch(
          `/api/admin/videos/upload/${pendingResume.sessionId}/status`,
        );
        if (!statusRes.ok) {
          clearSession();
          tasksRef.current.clear();
          forceUpdate();
          toast({
            title: "Previous session expired. Please upload again.",
            variant: "destructive",
          });
          return;
        }
        const status = await readJsonOrThrow<{ uploadedChunkIndices?: number[] }>(
          statusRes,
          "Resume status",
        );
        const uploadedSet = new Set<number>(status.uploadedChunkIndices ?? []);
        runFileUpload(id, { sid: pendingResume.sessionId, uploadedChunks: uploadedSet });
      } catch {
        clearSession();
        tasksRef.current.clear();
        forceUpdate();
      }
    },
    [pendingResume, clearSession, runFileUpload, toast, forceUpdate],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      addFiles(Array.from(e.dataTransfer.files));
    },
    [addFiles],
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (isAnyUploading) return;
        onOpenChange(o);
        if (!o) {
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
            {broadcastMode ? "Upload Video to Broadcast Queue" : "High-Speed Video Upload"}
            {hasFiles && (
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                {tasks.length} file{tasks.length > 1 ? "s" : ""} ·{" "}
                {formatFileSize(totalBytes)}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Broadcast context notice */}
          {broadcastMode && (
            <div className="flex items-center gap-2 p-2.5 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-700 dark:text-red-400">
              <Radio className="w-3.5 h-3.5 shrink-0" />
              Uploaded videos are added to the broadcast queue immediately and ready to air.
            </div>
          )}

          {/* Drop zone */}
          {!isAnyUploading && (
            <div
              className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-colors ${
                isDragging
                  ? "border-primary bg-primary/5"
                  : hasFiles
                    ? "border-primary/40 bg-primary/5"
                    : "hover:border-primary/60 hover:bg-muted/20"
              }`}
              onClick={() => videoInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <input
                ref={videoInputRef}
                type="file"
                accept="video/*"
                multiple
                className="hidden"
                onChange={(e) => addFiles(Array.from(e.target.files ?? []))}
              />
              {hasFiles ? (
                <div className="flex items-center justify-center gap-3">
                  <FileVideo className="w-6 h-6 text-primary shrink-0" />
                  <div className="text-left">
                    <p className="text-sm font-medium">
                      {tasks.length} video{tasks.length > 1 ? "s" : ""} selected
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatFileSize(totalBytes)} total · Click to change
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload className="w-8 h-8 mx-auto text-muted-foreground opacity-50" />
                  <p className="text-sm font-medium">
                    Drop video files here or click to select
                  </p>
                  <p className="text-xs text-muted-foreground">
                    MP4, MOV, AVI, MKV · Multiple files supported · Up to 5 GB each
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-3 mt-3 text-[11px] text-muted-foreground">
                    {isCompressionSupported() && (
                      <span className="flex items-center gap-1 text-primary">
                        <Minimize2 className="w-3 h-3" /> H.264 compress
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Zap className="w-3 h-3" /> 8 MB chunks
                    </span>
                    <span className="flex items-center gap-1">
                      <Wifi className="w-3 h-3" /> Adaptive streams
                    </span>
                    <span className="flex items-center gap-1">
                      <ShieldCheck className="w-3 h-3" /> SHA-256
                    </span>
                    <span className="flex items-center gap-1">
                      <Server className="w-3 h-3" /> 5-level HLS ABR
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Pending resume banner */}
          {pendingResume && !hasFiles && !isAnyUploading && (
            <div className="flex items-center gap-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs">
              <RotateCcw className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <div className="flex-1">
                <span className="font-medium text-amber-700 dark:text-amber-400">
                  Interrupted upload found
                </span>
                <p className="text-muted-foreground mt-0.5">
                  {pendingResume.fileName} — select the same file and resume.
                </p>
              </div>
              {tasks.length === 1 &&
                tasks[0]!.file.name === pendingResume.fileName && (
                  <Button
                    size="sm"
                    type="button"
                    variant="outline"
                    className="border-amber-500/50 text-amber-700 dark:text-amber-400 shrink-0"
                    onClick={() => handleResumeFromStorage(tasks[0]!.file)}
                  >
                    Resume
                  </Button>
                )}
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground shrink-0"
                onClick={clearSession}
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}

          {/* File list */}
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

          {/* Aggregate stats */}
          {isAnyUploading && (
            <div className="p-3 bg-muted/30 rounded-lg border space-y-2">
              <div className="flex items-center justify-between text-xs font-medium">
                <span className="flex items-center gap-1.5">
                  <Zap className="w-3 h-3 text-primary animate-pulse" />
                  {activeCount} active · {doneCount} done
                  {errorCount > 0 ? ` · ${errorCount} failed` : ""}
                </span>
                <span className="font-mono">{overallProgress}% overall</span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-500"
                  style={{ width: `${overallProgress}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Activity className="w-3 h-3" />{" "}
                  {totalSpeed > 0 ? formatSpeed(totalSpeed) : "—"} aggregate
                </span>
                <span>
                  {formatFileSize(totalUploaded)} / {formatFileSize(totalBytes)}
                </span>
              </div>
            </div>
          )}

          {/* Metadata form */}
          {hasFiles && !isAnyUploading && !isAllDone && (
            <div className="space-y-3 pt-1 border-t">
              <p className="text-xs text-muted-foreground font-medium pt-1">
                {tasks.length > 1
                  ? "Metadata applied to all files (titles default to filename)"
                  : "Video details"}
              </p>

              {isCompressionSupported() && (
                <div className="flex items-center justify-between p-2.5 bg-primary/5 border border-primary/20 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Minimize2 className="w-3.5 h-3.5 text-primary shrink-0" />
                    <div>
                      <Label className="text-xs font-medium">H.264 client compression</Label>
                      <p className="text-[11px] text-muted-foreground">
                        30–60% smaller · hardware-accelerated · before upload
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={compressionEnabled}
                    onCheckedChange={setCompressionEnabled}
                  />
                </div>
              )}

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
                  <img
                    src={URL.createObjectURL(thumbnailFile)}
                    className="w-14 h-9 object-cover rounded"
                    alt="thumbnail"
                  />
                ) : (
                  <div className="w-14 h-9 bg-muted rounded flex items-center justify-center shrink-0">
                    <Upload className="w-3.5 h-3.5 text-muted-foreground opacity-40" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">
                    {thumbnailFile ? thumbnailFile.name : "Add thumbnail (optional)"}
                  </p>
                  <p className="text-xs text-muted-foreground">JPG, PNG, WebP</p>
                </div>
              </div>

              {tasks.length === 1 && (
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Title <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    value={defaultForm.title}
                    onChange={(e) =>
                      setDefaultForm({ ...defaultForm, title: e.target.value })
                    }
                    placeholder="e.g. Sunday Service — Faith That Moves Mountains"
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Preacher</Label>
                  <Input
                    value={defaultForm.preacher}
                    onChange={(e) =>
                      setDefaultForm({ ...defaultForm, preacher: e.target.value })
                    }
                    placeholder="e.g. Prophet Amos"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Category</Label>
                  <Select
                    value={defaultForm.category}
                    onValueChange={(v) => setDefaultForm({ ...defaultForm, category: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c} className="capitalize">
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center justify-between p-2.5 bg-muted/20 rounded-lg border">
                <div>
                  <Label className="text-xs">Featured</Label>
                  <p className="text-[11px] text-muted-foreground">Pin to top of home screen</p>
                </div>
                <Switch
                  checked={defaultForm.featured}
                  onCheckedChange={(c) => setDefaultForm({ ...defaultForm, featured: c })}
                />
              </div>
            </div>
          )}

          {/* Success banner */}
          {isAllDone && (
            <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/30 rounded-lg text-sm text-green-700 dark:text-green-400">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              {broadcastMode
                ? "All videos uploaded and added to the broadcast queue!"
                : "All videos uploaded and queued for broadcast!"}
            </div>
          )}

          {/* Action buttons */}
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
                {isAllFinished && errorCount > 0
                  ? `Retry ${errorCount} Failed`
                  : tasks.length > 1
                    ? `Upload ${tasks.length} Videos`
                    : "Upload Video"}
              </Button>
            )}
            {isAllFinished && !isAnyUploading && !isAllDone && errorCount > 0 && doneCount > 0 && (
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => {
                  onOpenChange(false);
                  tasksRef.current.clear();
                  forceUpdate();
                }}
              >
                Close
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Per-file upload card ────────────────────────────────────────────────────────
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
  const isCompressing = task.state === "compressing";
  const isActive =
    task.state === "uploading" ||
    task.state === "initializing" ||
    task.state === "finalizing";
  const isPaused = task.state === "paused";
  const isDone = task.state === "done";
  const isError = task.state === "error";

  const cp = task.compressionProgress;
  const uploadSize = task.compressedBlob ? task.compressedBlob.size : task.file.size;

  return (
    <div
      className={`rounded-lg border p-3 space-y-2 transition-colors ${
        isDone
          ? "bg-green-500/5 border-green-500/30"
          : isError
            ? "bg-destructive/5 border-destructive/30"
            : isPaused
              ? "bg-amber-500/5 border-amber-500/30"
              : isCompressing
                ? "bg-violet-500/5 border-violet-500/30"
                : isActive
                  ? "bg-primary/5 border-primary/30"
                  : "bg-muted/20"
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="shrink-0 mt-0.5">
          {isDone ? (
            <CheckCircle2 className="w-4 h-4 text-green-500" />
          ) : isError ? (
            <AlertCircle className="w-4 h-4 text-destructive" />
          ) : isPaused ? (
            <Pause className="w-4 h-4 text-amber-500" />
          ) : isCompressing ? (
            <Minimize2 className="w-4 h-4 text-violet-500 animate-pulse" />
          ) : isActive ? (
            <Zap className="w-4 h-4 text-primary animate-pulse" />
          ) : (
            <FileVideo className="w-4 h-4 text-muted-foreground" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium truncate" title={task.file.name}>
              {task.file.name}
            </p>
            <span className="text-[10px] text-muted-foreground shrink-0">
              {task.compressedBlob ? (
                <span className="text-green-600">
                  {formatFileSize(task.compressedBlob.size)}{" "}
                  <span className="text-muted-foreground line-through">
                    {formatFileSize(task.file.size)}
                  </span>
                </span>
              ) : (
                formatFileSize(task.file.size)
              )}
            </span>
          </div>

          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
            {isDone && (
              <span className="text-green-600 font-medium flex items-center gap-1">
                <CheckCircle2 className="w-2.5 h-2.5" />
                Done · broadcast queued
                {task.compressedBlob && (
                  <span className="text-violet-500 ml-1">
                    ·{" "}
                    {Math.round((1 - task.compressedBlob.size / task.file.size) * 100)}%
                    smaller
                  </span>
                )}
              </span>
            )}
            {isError && (
              <span className="text-destructive">{task.error ?? "Upload failed"}</span>
            )}
            {task.state === "pending" && <span>Pending</span>}
            {isCompressing && cp && (
              <>
                {cp.phase === "analyzing" && (
                  <span className="text-violet-500 flex items-center gap-1">
                    <Gauge className="w-2.5 h-2.5" />
                    Analyzing…
                  </span>
                )}
                {cp.phase === "compressing" && (
                  <>
                    <span className="flex items-center gap-1 text-violet-500">
                      <Minimize2 className="w-2.5 h-2.5" />
                      Compressing
                    </span>
                    <span>·</span>
                    <span>{cp.fps > 0 ? `${cp.fps} fps` : "—"}</span>
                    {cp.eta > 0 && (
                      <>
                        <span>·</span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-2.5 h-2.5" />
                          {formatEta(cp.eta)}
                        </span>
                      </>
                    )}
                    <span>·</span>
                    <span>{Math.round(cp.compressionRatio * 100)}% of original</span>
                  </>
                )}
              </>
            )}
            {isActive && (
              <>
                {task.state === "initializing" && <span>Initializing…</span>}
                {task.state === "finalizing" && (
                  <span className="flex items-center gap-1">
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    Finalizing…
                  </span>
                )}
                {task.state === "uploading" && (
                  <>
                    <span className="flex items-center gap-1">
                      <Activity className="w-2.5 h-2.5" />
                      {task.speed > 0 ? formatSpeed(task.speed) : "—"}
                    </span>
                    <span>·</span>
                    <span>
                      {task.chunksDone}/{task.chunksTotal} chunks
                    </span>
                    <span>·</span>
                    <span className="flex items-center gap-1">
                      <Wifi className="w-2.5 h-2.5" />
                      {task.concurrency} streams
                    </span>
                    {task.eta > 0 && (
                      <>
                        <span>·</span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-2.5 h-2.5" />
                          {formatEta(task.eta)}
                        </span>
                      </>
                    )}
                    {task.checksumOk > 0 && (
                      <>
                        <span>·</span>
                        <span className="flex items-center gap-1 text-green-600">
                          <ShieldCheck className="w-2.5 h-2.5" />
                          {task.checksumOk}
                        </span>
                      </>
                    )}
                    {(task.stallCount ?? 0) > 0 && (
                      <>
                        <span>·</span>
                        <span
                          className="flex items-center gap-1 text-amber-600"
                          title={`${task.stallCount} stalled chunk(s) auto-recovered`}
                        >
                          <Activity className="w-2.5 h-2.5" />
                          {task.stallCount}↺
                        </span>
                      </>
                    )}
                    {networkTypeLabel(task.networkType ?? "", task.tier) && (
                      <>
                        <span>·</span>
                        <span className="text-slate-400">
                          {networkTypeLabel(task.networkType ?? "", task.tier)}
                        </span>
                      </>
                    )}
                  </>
                )}
              </>
            )}
            {isPaused && (
              <span className="text-amber-600">Paused · {task.progress}% done</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {task.state === "uploading" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={onPause}
              title="Pause"
            >
              <Pause className="w-3 h-3" />
            </Button>
          )}
          {isPaused && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={onResume}
              title="Resume"
            >
              <Zap className="w-3 h-3" />
            </Button>
          )}
          {isError && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={onRetry}
              title="Retry"
            >
              <RotateCcw className="w-3 h-3" />
            </Button>
          )}
          {!isDone && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-muted-foreground hover:text-destructive"
              onClick={onCancel}
              title="Cancel"
            >
              <X className="w-3 h-3" />
            </Button>
          )}
        </div>
      </div>

      {isCompressing && cp && cp.phase === "compressing" && (
        <div className="space-y-1">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-violet-500 transition-all duration-300"
              style={{ width: `${cp.progress}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span className="text-violet-500">
              H.264 · {formatFileSize(cp.inputSize)} → ~{formatFileSize(cp.outputSize)}
            </span>
            <span className="font-mono">{cp.progress}%</span>
          </div>
        </div>
      )}

      {(isActive || isPaused) && task.chunksTotal > 0 && (
        <div className="space-y-1">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${isPaused ? "bg-amber-500" : "bg-primary"}`}
              style={{ width: `${task.progress}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>
              {formatFileSize(task.bytesUploaded)} / {formatFileSize(uploadSize)}
            </span>
            <span className="font-mono">{task.progress}%</span>
          </div>
        </div>
      )}
    </div>
  );
}
