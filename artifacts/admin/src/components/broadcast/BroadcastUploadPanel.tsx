/**
 * BroadcastUploadPanel — Staging + upload-to-broadcast workflow for Master Control.
 *
 * Flow:
 *   1. Operator drops / picks files → staging area (editable title, speaker,
 *      category, intent; client-side thumbnail preview)
 *   2. "Upload All" / per-file "Start" → files enter the global uploadQueue
 *   3. Upload completes → auto-executes chosen broadcast intent (queue / next-up / play-now)
 *   4. Panel tracks the full pipeline:
 *      Staging → Uploading → Finalizing → Queuing → Faststart → Encoding HLS → Ready → On Air
 *
 * Module-level idempotency guard (_panelExecutedIds) prevents double-execution
 * across React unmount/remount cycles within the same browser session.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  uploadQueue,
  useUploadQueue,
  titleFromFilename,
  formatBytes,
  formatSpeed,
  formatEta,
  type UploadStatus,
} from "@/lib/upload-queue";
import { api, HttpError } from "@/lib/api";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Upload,
  CloudUpload,
  CheckCircle2,
  XCircle,
  Loader2,
  SkipForward,
  AlertTriangle,
  X,
  Zap,
  ListPlus,
  Clock,
  RotateCw,
  Radio,
  Pause,
  Play,
  RefreshCw,
  Wifi,
  Tv2,
  FileVideo,
  ChevronDown,
  ChevronUp,
  User,
  Tag,
} from "lucide-react";

// ── Public types ───────────────────────────────────────────────────────────────

export interface BroadcastQueueRow {
  id: string;
  videoId: string | null;
  title: string;
  thumbnailUrl: string;
  durationSecs: number;
  videoSource: string;
  isActive: boolean;
  sortOrder: number;
  transcodingStatus: string | null;
  hasHls: boolean;
}

export interface BroadcastServerSnapshot {
  current: { id: string; title: string; startsAtMs: number; endsAtMs: number } | null;
  next: { id: string; title: string } | null;
}

export type BroadcastIntent = "queue" | "next-up" | "play-now";

export interface BroadcastUploadPanelProps {
  server: BroadcastServerSnapshot | null;
  queueItems: BroadcastQueueRow[];
}

// ── Internal types ─────────────────────────────────────────────────────────────

interface StagedFile {
  id: string;
  file: File;
  title: string;
  preacher: string;
  category: string;
  intent: BroadcastIntent;
  thumbnail: string | null;
  thumbnailLoading: boolean;
}

interface BroadcastItemState {
  intent: BroadcastIntent;
  queueItemId: string | null;
  executing: boolean;
  executed: boolean;
  error: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const VIDEO_EXTS = /\.(mp4|mov|mkv|avi|webm|m4v|flv|wmv|ts|mts|m2ts)$/i;

const CATEGORIES = [
  { value: "sermon", label: "Sermon" },
  { value: "worship", label: "Worship" },
  { value: "teaching", label: "Teaching" },
  { value: "prayer", label: "Prayer" },
  { value: "broadcast", label: "Live Broadcast" },
  { value: "other", label: "Other" },
];

const INTENT_ICONS: Record<BroadcastIntent, React.ReactNode> = {
  queue: <ListPlus className="h-3 w-3" />,
  "next-up": <SkipForward className="h-3 w-3" />,
  "play-now": <Zap className="h-3 w-3" />,
};
const INTENT_LABELS: Record<BroadcastIntent, string> = {
  queue: "Queue",
  "next-up": "Next Up",
  "play-now": "Play Now",
};
const INTENT_DESCRIPTIONS: Record<BroadcastIntent, string> = {
  queue: "Add to end of rotation",
  "next-up": "Insert after current item",
  "play-now": "Promote to front — goes live when ready",
};

// ── Pipeline stage helpers ─────────────────────────────────────────────────────

type PipelineStage =
  | "pending"
  | "uploading"
  | "finalizing"
  | "executing"
  | "encoding"
  | "hls-queued"
  | "ready"
  | "on-air"
  | "paused"
  | "failed"
  | "cancelled";

function getPipelineStage(params: {
  uploadStatus: UploadStatus;
  broadcastState: BroadcastItemState | undefined;
  queueRow: BroadcastQueueRow | undefined;
  isOnAir: boolean;
}): PipelineStage {
  const { uploadStatus, broadcastState, queueRow, isOnAir } = params;
  if (uploadStatus === "cancelled") return "cancelled";
  if (uploadStatus === "failed" && !broadcastState?.executed) return "failed";
  if (uploadStatus === "paused") return "paused";
  if (uploadStatus === "pending") return "pending";
  if (uploadStatus === "uploading") return "uploading";
  if (uploadStatus === "finalizing") return "finalizing";
  if (broadcastState?.executing) return "executing";
  if (broadcastState?.error && !broadcastState.executed) return "failed";
  if (!broadcastState?.executed || !queueRow) {
    if (uploadStatus === "completed") return "executing";
    return "pending";
  }
  if (isOnAir) return "on-air";
  const ts = queueRow.transcodingStatus;
  if (ts === "encoding") return "encoding";
  if (ts === "queued") return "hls-queued";
  if (ts === "hls_ready" || ts === "ready" || queueRow.hasHls) return "ready";
  return "ready";
}

function StageBadge({ stage }: { stage: PipelineStage }) {
  if (stage === "on-air")
    return (
      <Badge className="gap-1 shrink-0 bg-red-600 hover:bg-red-600 text-white text-[10px] animate-pulse">
        <span className="h-1.5 w-1.5 rounded-full bg-white" />
        On Air
      </Badge>
    );
  if (stage === "ready")
    return (
      <Badge variant="outline" className="gap-1 shrink-0 text-[10px] border-emerald-400 text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-2.5 w-2.5" />
        Broadcast ready
      </Badge>
    );
  if (stage === "encoding")
    return (
      <Badge variant="secondary" className="gap-1 shrink-0 text-[10px]">
        <RotateCw className="h-2.5 w-2.5 animate-spin" />
        Encoding HLS
      </Badge>
    );
  if (stage === "hls-queued")
    return (
      <Badge variant="secondary" className="gap-1 shrink-0 text-[10px]">
        <Clock className="h-2.5 w-2.5" />
        HLS queued
      </Badge>
    );
  if (stage === "executing")
    return (
      <Badge variant="secondary" className="gap-1 shrink-0 text-[10px]">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        Queuing…
      </Badge>
    );
  if (stage === "finalizing")
    return (
      <Badge variant="secondary" className="gap-1 shrink-0 text-[10px]">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        Finalizing…
      </Badge>
    );
  if (stage === "failed")
    return (
      <Badge variant="destructive" className="gap-1 shrink-0 text-[10px]">
        <XCircle className="h-2.5 w-2.5" />
        Failed
      </Badge>
    );
  if (stage === "cancelled")
    return (
      <Badge variant="outline" className="gap-1 shrink-0 text-[10px] text-muted-foreground">
        Cancelled
      </Badge>
    );
  if (stage === "paused")
    return (
      <Badge variant="outline" className="gap-1 shrink-0 text-[10px]">
        <Pause className="h-2.5 w-2.5" />
        Paused
      </Badge>
    );
  return (
    <Badge variant="outline" className="gap-1 shrink-0 text-[10px] text-muted-foreground">
      {stage === "uploading" ? "Uploading" : stage === "pending" ? "Pending" : ""}
    </Badge>
  );
}

// ── Client-side thumbnail generation ─────────────────────────────────────────

async function generateThumbnail(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    let done = false;

    const finish = (result: string | null) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(result);
    };

    const timeout = setTimeout(() => finish(null), 10_000);

    video.onerror = () => { clearTimeout(timeout); finish(null); };

    video.onloadedmetadata = () => {
      video.currentTime = Math.min(Math.max(video.duration * 0.1, 1), 8);
    };

    video.onseeked = () => {
      clearTimeout(timeout);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext("2d");
        if (!ctx) { finish(null); return; }
        ctx.drawImage(video, 0, 0, 320, 180);
        finish(canvas.toDataURL("image/jpeg", 0.75));
      } catch {
        finish(null);
      }
    };

    video.src = url;
  });
}

// ── Module-level idempotency guard ────────────────────────────────────────────
// Survives component unmount/remount so executed intents are never re-triggered
// when the operator navigates away and back to the broadcast console.
const _panelExecutedIds = new Set<string>();

// ── Main component ─────────────────────────────────────────────────────────────

export function BroadcastUploadPanel({ server, queueItems }: BroadcastUploadPanelProps) {
  const qc = useQueryClient();
  const { items } = useUploadQueue();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Staging area ───────────────────────────────────────────────────────────
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [defaultIntent, setDefaultIntent] = useState<BroadcastIntent>("queue");
  const [dropActive, setDropActive] = useState(false);
  const [expandedStaged, setExpandedStaged] = useState<Set<string>>(new Set());

  // ── Upload pipeline tracking ───────────────────────────────────────────────
  const panelItemIds = useRef<Set<string>>(new Set());
  const [broadcastStates, setBroadcastStates] = useState<Map<string, BroadcastItemState>>(new Map());
  const broadcastStatesRef = useRef(broadcastStates);
  useEffect(() => { broadcastStatesRef.current = broadcastStates; }, [broadcastStates]);

  const serverRef = useRef(server);
  useEffect(() => { serverRef.current = server; }, [server]);

  const queueItemsRef = useRef(queueItems);
  useEffect(() => { queueItemsRef.current = queueItems; }, [queueItems]);

  // ── Auto-execute intent when upload completes ──────────────────────────────
  useEffect(() => {
    for (const item of items) {
      if (!panelItemIds.current.has(item.id)) continue;
      if (item.status !== "completed" || !item.videoId) continue;
      if (_panelExecutedIds.has(item.id)) continue;
      const state = broadcastStatesRef.current.get(item.id);
      if (!state || state.executed || state.executing) continue;
      _panelExecutedIds.add(item.id);
      void executeIntent(item.id, item.videoId, state.intent);
    }
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Intent execution ───────────────────────────────────────────────────────

  async function executeIntent(
    uploadId: string,
    videoId: string,
    intent: BroadcastIntent,
  ): Promise<void> {
    setBroadcastStates((prev) => {
      const next = new Map(prev);
      const s = next.get(uploadId);
      if (s) next.set(uploadId, { ...s, executing: true, error: null });
      return next;
    });

    try {
      const queueRow = await api.post<BroadcastQueueRow>("/admin/broadcast", {
        videoId,
        allowPending: true,
      });
      const queueItemId = queueRow.id;

      setBroadcastStates((prev) => {
        const next = new Map(prev);
        const s = next.get(uploadId);
        if (s) next.set(uploadId, { ...s, queueItemId, executed: true });
        return next;
      });

      if (intent === "play-now") {
        await api.post("/broadcast-v2/play-now", {
          queueItemId,
          idempotencyKey: crypto.randomUUID(),
        });
        toast.success("Promoted to front — goes live when broadcast-ready!");
      } else if (intent === "next-up") {
        const currentId = serverRef.current?.current?.id ?? null;
        const existingIds = queueItemsRef.current
          .map((i) => i.id)
          .filter((id) => id !== queueItemId);
        const currentIdx = currentId ? existingIds.indexOf(currentId) : -1;
        const newOrder = [...existingIds];
        newOrder.splice(currentIdx >= 0 ? currentIdx + 1 : 0, 0, queueItemId);
        await api.put("/admin/broadcast/reorder", { itemIds: newOrder });
        toast.success("Upload complete — queued as Next Up!");
      } else {
        toast.success("Upload complete — added to broadcast queue!");
      }

      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue-sync-status"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-live-state"] });
    } catch (e) {
      _panelExecutedIds.delete(uploadId);
      const msg =
        e instanceof HttpError ? e.message
        : e instanceof Error ? e.message
        : "Unknown error";
      setBroadcastStates((prev) => {
        const next = new Map(prev);
        const s = next.get(uploadId);
        if (s) next.set(uploadId, { ...s, executing: false, error: msg });
        return next;
      });
      toast.error(`Queue failed: ${msg}`);
      return;
    }

    setBroadcastStates((prev) => {
      const next = new Map(prev);
      const s = next.get(uploadId);
      if (s) next.set(uploadId, { ...s, executing: false });
      return next;
    });
  }

  // ── Queue retry ────────────────────────────────────────────────────────────

  async function retryQueue(uploadId: string, videoId: string) {
    const state = broadcastStatesRef.current.get(uploadId);
    if (!state || state.executing) return;
    _panelExecutedIds.delete(uploadId);
    setBroadcastStates((prev) => {
      const next = new Map(prev);
      const s = next.get(uploadId);
      if (s) next.set(uploadId, { ...s, error: null, executed: false });
      return next;
    });
    _panelExecutedIds.add(uploadId);
    await executeIntent(uploadId, videoId, state.intent);
  }

  // ── Dismiss pipeline item ─────────────────────────────────────────────────

  function dismissItem(uploadId: string) {
    const item = uploadQueue.getItems().find((i) => i.id === uploadId);
    if (item && (item.status === "uploading" || item.status === "finalizing")) {
      uploadQueue.cancel(uploadId);
    } else {
      uploadQueue.dismiss(uploadId);
    }
    panelItemIds.current.delete(uploadId);
    _panelExecutedIds.delete(uploadId);
    setBroadcastStates((prev) => {
      const next = new Map(prev);
      next.delete(uploadId);
      return next;
    });
  }

  function changeIntent(uploadId: string, intent: BroadcastIntent) {
    setBroadcastStates((prev) => {
      const next = new Map(prev);
      const s = next.get(uploadId);
      if (s && !s.executed && !s.executing) next.set(uploadId, { ...s, intent });
      return next;
    });
  }

  // ── Staging area handlers ─────────────────────────────────────────────────

  function stageFiles(files: File[], intent: BroadcastIntent = defaultIntent) {
    const videoFiles = files.filter(
      (f) => f.type.startsWith("video/") || VIDEO_EXTS.test(f.name),
    );
    if (videoFiles.length === 0) {
      toast.error("No video files found — drop MP4, MOV, MKV, or other video files.");
      return;
    }

    const newStaged: StagedFile[] = videoFiles.map((f) => ({
      id: crypto.randomUUID(),
      file: f,
      title: titleFromFilename(f.name),
      preacher: "",
      category: "sermon",
      intent,
      thumbnail: null,
      thumbnailLoading: true,
    }));

    setStaged((prev) => [...prev, ...newStaged]);

    // Generate thumbnails in the background
    for (const sf of newStaged) {
      void generateThumbnail(sf.file).then((thumb) => {
        setStaged((prev) =>
          prev.map((s) =>
            s.id === sf.id ? { ...s, thumbnail: thumb, thumbnailLoading: false } : s,
          ),
        );
      });
    }

    if (newStaged.length > 0) {
      toast.success(
        `${newStaged.length} file${newStaged.length !== 1 ? "s" : ""} staged — review metadata then upload`,
      );
    }
  }

  function updateStagedMeta(id: string, patch: Partial<Pick<StagedFile, "title" | "preacher" | "category" | "intent">>) {
    setStaged((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function removeStagedFile(id: string) {
    setStaged((prev) => prev.filter((s) => s.id !== id));
    setExpandedStaged((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }

  function startStagedFile(sf: StagedFile) {
    if (!sf.title.trim()) {
      toast.error("Title is required before uploading.");
      return;
    }

    const beforeIds = new Set(uploadQueue.getItems().map((i) => i.id));
    uploadQueue.enqueue([{
      file: sf.file,
      title: sf.title.trim(),
      preacher: sf.preacher.trim(),
      category: sf.category,
      description: "",
      featured: false,
      priority: Date.now() - 1_000_000, // high priority for broadcast
    }]);
    const newItems = uploadQueue.getItems().filter((i) => !beforeIds.has(i.id));

    for (const item of newItems) {
      panelItemIds.current.add(item.id);
      setBroadcastStates((prev) => {
        const next = new Map(prev);
        next.set(item.id, {
          intent: sf.intent,
          queueItemId: null,
          executing: false,
          executed: false,
          error: null,
        });
        return next;
      });
    }

    removeStagedFile(sf.id);
  }

  function startAllStaged() {
    const invalid = staged.filter((s) => !s.title.trim());
    if (invalid.length > 0) {
      toast.error(`${invalid.length} file${invalid.length > 1 ? "s are" : " is"} missing a title.`);
      return;
    }

    const beforeIds = new Set(uploadQueue.getItems().map((i) => i.id));
    uploadQueue.enqueue(
      staged.map((sf) => ({
        file: sf.file,
        title: sf.title.trim(),
        preacher: sf.preacher.trim(),
        category: sf.category,
        description: "",
        featured: false,
        priority: Date.now() - 1_000_000,
      })),
    );
    const newItems = uploadQueue.getItems().filter((i) => !beforeIds.has(i.id));

    // Map new upload IDs back to their staged intents by order
    staged.forEach((sf, idx) => {
      const item = newItems[idx];
      if (!item) return;
      panelItemIds.current.add(item.id);
      setBroadcastStates((prev) => {
        const next = new Map(prev);
        next.set(item.id, {
          intent: sf.intent,
          queueItemId: null,
          executing: false,
          executed: false,
          error: null,
        });
        return next;
      });
    });

    setStaged([]);
    setExpandedStaged(new Set());

    const count = staged.length;
    toast.success(
      `${count} file${count !== 1 ? "s" : ""} uploading — will auto-queue when done`,
    );
  }

  // ── DnD + file input ──────────────────────────────────────────────────────

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropActive(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropActive(false);
      stageFiles(Array.from(e.dataTransfer.files));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [defaultIntent],
  );

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) stageFiles(Array.from(e.target.files));
    e.target.value = "";
  };

  // ── Batch controls ────────────────────────────────────────────────────────

  function pauseAllPanel() {
    for (const item of panelItems) {
      if (item.status === "uploading" || item.status === "finalizing") {
        uploadQueue.pause(item.id);
      }
    }
  }

  function resumeAllPanel() {
    for (const item of panelItems) {
      if (item.status === "paused") {
        uploadQueue.resume(item.id);
      }
    }
  }

  // ── Derived state ──────────────────────────────────────────────────────────

  const panelItems = items
    .filter((i) => panelItemIds.current.has(i.id))
    .sort((a, b) => b.addedAt - a.addedAt);

  const currentOnAirId = server?.current?.id ?? null;

  const videoIdToQueueRow = new Map(
    queueItems.filter((q) => q.videoId).map((q) => [q.videoId!, q]),
  );
  const queueItemIdToRow = new Map(queueItems.map((q) => [q.id, q]));

  const activeUploads = panelItems.filter(
    (i) => i.status === "uploading" || i.status === "finalizing",
  );
  const pausedUploads = panelItems.filter((i) => i.status === "paused");
  const hasActive = activeUploads.length > 0;
  const hasPaused = pausedUploads.length > 0;

  const overallTotalBytes = panelItems
    .filter((i) => i.status !== "completed" && i.status !== "cancelled")
    .reduce((s, i) => s + i.file.size, 0);
  const overallUploadedBytes = panelItems
    .filter((i) => i.status !== "completed" && i.status !== "cancelled")
    .reduce((s, i) => s + i.uploadedBytes, 0);
  const overallProgress =
    overallTotalBytes > 0 ? Math.round((overallUploadedBytes / overallTotalBytes) * 100) : 0;
  const totalSpeed = panelItems.reduce((s, i) => s + i.speed, 0);

  const hasPipelineItems = panelItems.length > 0;
  const hasStagedFiles = staged.length > 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Card className="border-primary/20">
      {/* ── Header ── */}
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Tv2 className="h-4 w-4 text-primary" />
              Broadcast Upload
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Stage and upload video files, then automatically queue them for broadcast.
            </p>
          </div>

          {/* Default intent selector */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground">Default intent:</span>
            {(["queue", "next-up", "play-now"] as const).map((intent) => (
              <Button
                key={intent}
                size="sm"
                variant={defaultIntent === intent ? "default" : "outline"}
                className={[
                  "h-7 px-2.5 text-xs gap-1",
                  intent === "play-now" && defaultIntent === intent
                    ? "bg-red-600 hover:bg-red-700 border-red-600"
                    : "",
                ].join(" ")}
                onClick={() => setDefaultIntent(intent)}
                title={INTENT_DESCRIPTIONS[intent]}
              >
                {INTENT_ICONS[intent]}
                {INTENT_LABELS[intent]}
              </Button>
            ))}
          </div>
        </div>

        {/* Batch progress summary — visible when uploads are active */}
        {hasPipelineItems && (hasActive || hasPaused) && (
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                {activeUploads.length > 0
                  ? `${activeUploads.length} uploading${
                      totalSpeed > 0 ? ` · ${formatSpeed(totalSpeed)}` : ""
                    }`
                  : `${pausedUploads.length} paused`}
              </span>
              <div className="flex items-center gap-2">
                {hasActive && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                    onClick={pauseAllPanel}
                  >
                    Pause all
                  </button>
                )}
                {hasPaused && (
                  <button
                    type="button"
                    className="text-emerald-700 dark:text-emerald-400 hover:underline"
                    onClick={resumeAllPanel}
                  >
                    Resume all
                  </button>
                )}
              </div>
            </div>
            {overallTotalBytes > 0 && (
              <Progress value={overallProgress} className="h-1" />
            )}
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {/* ── Drop Zone ── */}
        <div
          role="region"
          aria-label="Video upload drop zone"
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={[
            "relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed",
            "cursor-pointer transition-all select-none min-h-[90px] px-4 py-4 gap-2",
            dropActive
              ? "border-primary bg-primary/5 scale-[1.01]"
              : "border-border hover:border-primary/50 hover:bg-muted/30",
          ].join(" ")}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,.mkv,.ts,.mts,.m2ts"
            multiple
            className="sr-only"
            onChange={handleFileInput}
          />

          <div className={[
            "flex items-center justify-center rounded-full p-2 transition-colors",
            dropActive ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
          ].join(" ")}>
            <CloudUpload className="h-5 w-5" />
          </div>

          <div className="text-center space-y-0.5">
            <p className="text-sm font-medium">
              {dropActive ? "Drop to stage" : "Drop files or click to browse"}
            </p>
            <p className="text-xs text-muted-foreground">
              MP4, MOV, MKV, AVI, WebM · Multi-file · Large files supported
            </p>
          </div>

          {!dropActive && (
            <div className="flex items-center gap-2 mt-0.5" onClick={(e) => e.stopPropagation()}>
              <Button
                size="sm" variant="outline"
                className="h-7 px-2.5 text-xs gap-1"
                onClick={() => { setDefaultIntent("queue"); fileInputRef.current?.click(); }}
              >
                <ListPlus className="h-3 w-3" />
                Add to Queue
              </Button>
              <Button
                size="sm" variant="outline"
                className="h-7 px-2.5 text-xs gap-1"
                onClick={() => { setDefaultIntent("next-up"); fileInputRef.current?.click(); }}
              >
                <SkipForward className="h-3 w-3" />
                Next Up
              </Button>
              <Button
                size="sm"
                className="h-7 px-2.5 text-xs gap-1 bg-red-600 hover:bg-red-700 text-white border-red-600"
                onClick={() => { setDefaultIntent("play-now"); fileInputRef.current?.click(); }}
              >
                <Zap className="h-3 w-3" />
                Upload &amp; Go Live
              </Button>
            </div>
          )}
        </div>

        {/* ── Staging Area ── */}
        {hasStagedFiles && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Staging ({staged.length})
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => { setStaged([]); setExpandedStaged(new Set()); }}
                  className="text-[10px] text-muted-foreground hover:text-destructive"
                >
                  Clear all
                </button>
                <Button
                  size="sm"
                  className="h-7 px-3 text-xs gap-1"
                  onClick={startAllStaged}
                >
                  <Upload className="h-3 w-3" />
                  Upload All ({staged.length})
                </Button>
              </div>
            </div>

            <ul className="divide-y rounded-md border bg-muted/10">
              {staged.map((sf) => {
                const expanded = expandedStaged.has(sf.id);
                return (
                  <li key={sf.id} className="px-3 py-2.5">
                    {/* Top row: thumbnail + title + controls */}
                    <div className="flex items-center gap-2.5 min-w-0">
                      {/* Thumbnail */}
                      <div className="shrink-0 w-14 h-9 rounded overflow-hidden bg-black border border-border">
                        {sf.thumbnailLoading ? (
                          <div className="w-full h-full flex items-center justify-center">
                            <Loader2 className="h-3 w-3 text-muted-foreground animate-spin" />
                          </div>
                        ) : sf.thumbnail ? (
                          <img src={sf.thumbnail} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <FileVideo className="h-3.5 w-3.5 text-muted-foreground/40" />
                          </div>
                        )}
                      </div>

                      {/* Title (editable inline) */}
                      <div className="flex-1 min-w-0">
                        <Input
                          value={sf.title}
                          onChange={(e) => updateStagedMeta(sf.id, { title: e.target.value })}
                          placeholder="Video title (required)"
                          className="h-7 text-xs border-0 bg-transparent px-0 focus-visible:ring-0 focus-visible:ring-offset-0 font-medium"
                        />
                        <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                          {sf.file.name} · {formatBytes(sf.file.size)}
                        </p>
                      </div>

                      {/* Intent selector (compact) */}
                      <div className="shrink-0 flex items-center gap-1">
                        {(["queue", "next-up", "play-now"] as const).map((intent) => (
                          <button
                            key={intent}
                            type="button"
                            onClick={() => updateStagedMeta(sf.id, { intent })}
                            title={INTENT_DESCRIPTIONS[intent]}
                            className={[
                              "flex items-center justify-center rounded w-6 h-6 transition-colors",
                              sf.intent === intent
                                ? intent === "play-now"
                                  ? "bg-red-600 text-white"
                                  : "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:bg-muted",
                            ].join(" ")}
                          >
                            {INTENT_ICONS[intent]}
                          </button>
                        ))}
                      </div>

                      {/* Expand metadata toggle */}
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedStaged((prev) => {
                            const next = new Set(prev);
                            if (next.has(sf.id)) next.delete(sf.id);
                            else next.add(sf.id);
                            return next;
                          })
                        }
                        className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
                        title="Edit metadata"
                      >
                        {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      </button>

                      {/* Start this file */}
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 h-7 px-2 text-xs"
                        onClick={() => startStagedFile(sf)}
                      >
                        <Upload className="h-3 w-3 mr-1" />
                        Start
                      </Button>

                      {/* Remove from staging */}
                      <button
                        type="button"
                        onClick={() => removeStagedFile(sf.id)}
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        aria-label="Remove from staging"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {/* Expanded metadata form */}
                    {expanded && (
                      <div className="mt-2 pl-16 grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                            <User className="h-2.5 w-2.5" />
                            Speaker / Preacher
                          </Label>
                          <Input
                            value={sf.preacher}
                            onChange={(e) => updateStagedMeta(sf.id, { preacher: e.target.value })}
                            placeholder="Optional"
                            className="h-7 text-xs"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                            <Tag className="h-2.5 w-2.5" />
                            Category
                          </Label>
                          <Select
                            value={sf.category}
                            onValueChange={(v) => updateStagedMeta(sf.id, { category: v })}
                          >
                            <SelectTrigger className="h-7 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {CATEGORIES.map((c) => (
                                <SelectItem key={c.value} value={c.value} className="text-xs">
                                  {c.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* ── Upload Pipeline ── */}
        {hasPipelineItems && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Upload pipeline
              </p>
              {panelItems.some(
                (i) =>
                  i.status === "completed" || i.status === "cancelled" || i.status === "failed",
              ) && (
                <button
                  type="button"
                  onClick={() => {
                    for (const item of panelItems) {
                      if (
                        (item.status === "completed" || item.status === "cancelled") &&
                        broadcastStates.get(item.id)?.executed !== false
                      ) {
                        dismissItem(item.id);
                      }
                    }
                  }}
                  className="text-[10px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                >
                  Clear completed
                </button>
              )}
            </div>

            <ul className="divide-y rounded-md border">
              {panelItems.map((item) => {
                const bState = broadcastStates.get(item.id);
                const queueRow = bState?.queueItemId
                  ? queueItemIdToRow.get(bState.queueItemId)
                  : item.videoId
                  ? videoIdToQueueRow.get(item.videoId)
                  : undefined;
                const isOnAir = !!(queueRow && queueRow.id === currentOnAirId);
                const stage = getPipelineStage({
                  uploadStatus: item.status,
                  broadcastState: bState,
                  queueRow,
                  isOnAir,
                });

                const showProgress = stage === "uploading" || stage === "finalizing";
                const canChangeIntent = bState && !bState.executed && !bState.executing;

                return (
                  <li key={item.id} className="flex flex-col gap-1.5 px-3 py-2.5">
                    {/* Row: icon + title + badge + dismiss */}
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="shrink-0 text-muted-foreground">
                        {stage === "on-air" ? (
                          <span className="h-2 w-2 rounded-full bg-red-500 inline-block animate-pulse" />
                        ) : stage === "uploading" ? (
                          <Upload className="h-3.5 w-3.5 text-blue-500" />
                        ) : stage === "finalizing" || stage === "executing" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
                        ) : stage === "encoding" || stage === "hls-queued" ? (
                          <RotateCw className={`h-3.5 w-3.5 ${stage === "encoding" ? "animate-spin" : ""} text-amber-500`} />
                        ) : stage === "ready" ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                        ) : stage === "failed" ? (
                          <XCircle className="h-3.5 w-3.5 text-red-500" />
                        ) : stage === "paused" ? (
                          <Pause className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </div>

                      <span className="flex-1 min-w-0 truncate text-sm font-medium">
                        {item.title}
                      </span>

                      <StageBadge stage={stage} />

                      <button
                        type="button"
                        onClick={() => dismissItem(item.id)}
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`Dismiss ${item.title}`}
                        title={
                          item.status === "uploading" || item.status === "finalizing"
                            ? "Cancel upload"
                            : "Dismiss"
                        }
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {/* Upload progress */}
                    {showProgress && (
                      <div className="space-y-1 pl-6">
                        <Progress value={item.progress} className="h-1.5" />
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span>
                            {formatBytes(item.uploadedBytes)} / {formatBytes(item.file.size)}
                            {item.speed > 0 && <> · {formatSpeed(item.speed)}</>}
                          </span>
                          {item.eta > 0 && <span>{formatEta(item.eta)} remaining</span>}
                        </div>
                      </div>
                    )}

                    {/* Stage hints */}
                    {stage === "encoding" && (
                      <p className="pl-6 text-[10px] text-amber-600 dark:text-amber-400">
                        HLS transcoding in progress — video airs as MP4 until encoding completes.
                      </p>
                    )}

                    {/* Queue error + retry */}
                    {bState?.error && !bState.executed && (
                      <div className="pl-6 flex items-center gap-2">
                        <p className="flex-1 text-[10px] text-red-600 dark:text-red-400 truncate">
                          {bState.error}
                        </p>
                        {item.videoId && (
                          <button
                            type="button"
                            onClick={() => void retryQueue(item.id, item.videoId!)}
                            className="shrink-0 flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium text-blue-700 ring-1 ring-blue-300 hover:bg-blue-50 dark:text-blue-400 dark:ring-blue-700 dark:hover:bg-blue-950/30"
                          >
                            <RefreshCw className="h-2.5 w-2.5" />
                            Retry queue
                          </button>
                        )}
                      </div>
                    )}

                    {/* Upload error + retry */}
                    {item.status === "failed" && !bState?.executed && (
                      <div className="pl-6 flex items-center gap-2">
                        <p className="flex-1 text-[10px] text-red-600 dark:text-red-400 truncate">
                          {item.error ?? "Upload failed"}
                        </p>
                        <button
                          type="button"
                          onClick={() => uploadQueue.retry(item.id)}
                          className="shrink-0 flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium text-blue-700 ring-1 ring-blue-300 hover:bg-blue-50 dark:text-blue-400 dark:ring-blue-700 dark:hover:bg-blue-950/30"
                        >
                          <RefreshCw className="h-2.5 w-2.5" />
                          Retry
                        </button>
                      </div>
                    )}

                    {/* Paused — resume */}
                    {item.status === "paused" && (
                      <div className="pl-6 flex items-center gap-2">
                        <p className="text-[10px] text-muted-foreground">Upload paused</p>
                        <button
                          type="button"
                          onClick={() => uploadQueue.resume(item.id)}
                          className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-300 hover:bg-emerald-50 dark:text-emerald-400 dark:ring-emerald-700 dark:hover:bg-emerald-950/30"
                        >
                          <Play className="h-2.5 w-2.5" />
                          Resume
                        </button>
                      </div>
                    )}

                    {/* Intent selector (pre-execution) */}
                    {canChangeIntent && item.status !== "cancelled" && item.status !== "failed" && (
                      <div className="pl-6 flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] text-muted-foreground">When ready:</span>
                        {(["queue", "next-up", "play-now"] as const).map((intent) => (
                          <button
                            key={intent}
                            type="button"
                            onClick={() => changeIntent(item.id, intent)}
                            title={INTENT_DESCRIPTIONS[intent]}
                            className={[
                              "flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
                              bState!.intent === intent
                                ? intent === "play-now"
                                  ? "bg-red-600 text-white"
                                  : "bg-primary text-primary-foreground"
                                : "text-muted-foreground ring-1 ring-border hover:ring-primary/50 hover:text-foreground",
                            ].join(" ")}
                          >
                            {INTENT_ICONS[intent]}
                            {INTENT_LABELS[intent]}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Post-execution queue status */}
                    {bState?.executed && queueRow && stage !== "on-air" && (
                      <div className="pl-6 text-[10px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
                        <span>
                          {bState.intent === "play-now"
                            ? "Promoted to front"
                            : bState.intent === "next-up"
                            ? "Inserted as Next Up"
                            : "Added to queue"}
                        </span>
                        {queueRow.transcodingStatus === "processing" && (
                          <span className="text-blue-500">· Optimizing for streaming…</span>
                        )}
                        {queueRow.transcodingStatus === "encoding" && (
                          <span className="text-amber-500">· HLS encoding in progress</span>
                        )}
                        {(queueRow.hasHls || queueRow.transcodingStatus === "ready") && (
                          <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-0.5">
                            <CheckCircle2 className="h-2.5 w-2.5" />
                            HLS adaptive streaming ready
                          </span>
                        )}
                      </div>
                    )}

                    {/* On Air indicator */}
                    {stage === "on-air" && (
                      <div className="pl-6 flex items-center gap-1.5 text-[10px] text-red-600 dark:text-red-400 font-medium">
                        <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse inline-block" />
                        Now broadcasting live
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Network offline warning */}
        {typeof navigator !== "undefined" && !navigator.onLine && (hasActive || hasPaused) && (
          <div className="flex items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200">
            <Wifi className="h-3.5 w-3.5 shrink-0" />
            Network offline — active uploads are paused and will resume automatically when connectivity is restored.
          </div>
        )}

        {/* Empty-state legend */}
        {!hasStagedFiles && !hasPipelineItems && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 text-[10px] text-muted-foreground border rounded-md px-3 py-2.5 bg-muted/20">
            <span className="flex items-center gap-1.5"><Upload className="h-2.5 w-2.5" /> Chunked SHA-256 uploads</span>
            <span className="flex items-center gap-1.5"><Loader2 className="h-2.5 w-2.5" /> Faststart optimization</span>
            <span className="flex items-center gap-1.5"><RotateCw className="h-2.5 w-2.5" /> HLS adaptive bitrate</span>
            <span className="flex items-center gap-1.5"><CheckCircle2 className="h-2.5 w-2.5" /> Broadcast validated</span>
            <span className="flex items-center gap-1.5"><AlertTriangle className="h-2.5 w-2.5" /> Transcoding guards queue</span>
            <span className="flex items-center gap-1.5"><Radio className="h-2.5 w-2.5" /> Auto-airs when ready</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
