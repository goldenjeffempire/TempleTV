/**
 * BroadcastUploadPanel — embedded upload-to-broadcast workflow for Master Control.
 *
 * Allows admins to drop video files directly onto the broadcast console and
 * immediately queue them with a chosen intent:
 *   Queue       → add at end of rotation
 *   Next Up     → insert right after the current on-air item
 *   Play Now    → queue + promote to front + skip to it
 *
 * After upload the video enters the transcoding pipeline. The panel tracks
 * the full status journey:
 *   Uploading → Finalizing → Queuing → Faststart → Transcoding → Ready → On Air
 *
 * Uses the global uploadQueue singleton (survives page navigation), but only
 * renders items added through this panel so the broadcast console stays clean.
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
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

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

interface BroadcastItemState {
  intent: BroadcastIntent;
  queueItemId: string | null;
  executing: boolean;
  executed: boolean;
  error: string | null;
}

export interface BroadcastUploadPanelProps {
  server: BroadcastServerSnapshot | null;
  queueItems: BroadcastQueueRow[];
}

// ── Accepted video extensions ─────────────────────────────────────────────────

const VIDEO_EXTS = /\.(mp4|mov|mkv|avi|webm|m4v|flv|wmv|ts|mts|m2ts)$/i;

function isVideoFile(f: File) {
  return f.type.startsWith("video/") || VIDEO_EXTS.test(f.name);
}

// ── Pipeline status helpers ───────────────────────────────────────────────────

type PipelineStage =
  | "pending"
  | "uploading"
  | "finalizing"
  | "executing"
  | "faststart"
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

  // Upload completed
  if (broadcastState?.executing) return "executing";
  if (broadcastState?.error && !broadcastState.executed) return "failed";

  if (!broadcastState?.executed || !queueRow) {
    if (uploadStatus === "completed") return "executing"; // waiting to auto-queue
    return "pending";
  }

  if (isOnAir) return "on-air";

  const ts = queueRow.transcodingStatus;
  if (ts === "processing") return "faststart";
  if (ts === "encoding") return "encoding";
  if (ts === "queued") return "hls-queued";
  if (ts === "hls_ready" || ts === "ready" || queueRow.hasHls) return "ready";

  return "ready";
}

const STAGE_LABELS: Record<PipelineStage, string> = {
  pending: "Pending",
  uploading: "Uploading",
  finalizing: "Finalizing…",
  executing: "Queuing…",
  faststart: "Optimizing…",
  encoding: "Encoding HLS",
  "hls-queued": "HLS queued",
  ready: "Broadcast ready",
  "on-air": "On Air",
  paused: "Paused",
  failed: "Failed",
  cancelled: "Cancelled",
};

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
  if (stage === "faststart")
    return (
      <Badge variant="secondary" className="gap-1 shrink-0 text-[10px] text-blue-600 border-blue-200 dark:border-blue-800">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        Optimizing…
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
  // pending / uploading
  return (
    <Badge variant="outline" className="gap-1 shrink-0 text-[10px] text-muted-foreground">
      {STAGE_LABELS[stage]}
    </Badge>
  );
}

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

// ── Module-level idempotency guard ─────────────────────────────────────────────
//
// Persists across component unmount/remount cycles so completed upload intents
// are never re-triggered when the operator navigates away and back to the
// broadcast console within the same browser session.
//
// A useRef<Set<string>> would reset to an empty Set on every unmount, causing
// already-executed items to re-enqueue their broadcast intent on re-mount.
// A module-level Set avoids this without requiring any external state store.
const _panelExecutedIds = new Set<string>();

// ── Main component ─────────────────────────────────────────────────────────────

export function BroadcastUploadPanel({ server, queueItems }: BroadcastUploadPanelProps) {
  const qc = useQueryClient();
  const { items } = useUploadQueue();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dropActive, setDropActive] = useState(false);
  const [defaultIntent, setDefaultIntent] = useState<BroadcastIntent>("queue");

  // Track which upload IDs were added through this panel (vs other pages)
  const panelItemIds = useRef<Set<string>>(new Set());

  // Per-item broadcast pipeline state
  const [broadcastStates, setBroadcastStates] = useState<Map<string, BroadcastItemState>>(
    new Map(),
  );
  const broadcastStatesRef = useRef(broadcastStates);
  useEffect(() => {
    broadcastStatesRef.current = broadcastStates;
  }, [broadcastStates]);

  // Stable refs to avoid stale closure in auto-execute effect
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

      // Guard: mark as triggered before the async call so concurrent
      // renders don't fire the same execution twice.
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
      // 1. Add to broadcast queue (idempotent — returns existing row if already present)
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

      // 2. Intent-specific actions
      if (intent === "play-now") {
        await api.post("/broadcast-v2/play-now", {
          queueItemId,
          idempotencyKey: crypto.randomUUID(),
        });
        toast.success("Upload complete — promoted to front, goes live when ready!");
      } else if (intent === "next-up") {
        // Place the new item right after the current on-air item in queue order.
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

      // Refresh the queue and sync-status so parent reflects the change
      void qc.invalidateQueries({ queryKey: ["broadcast-queue"] });
      void qc.invalidateQueries({ queryKey: ["broadcast-v2-queue-sync-status"] });
    } catch (e) {
      // Allow retry by removing from the idempotency guard
      _panelExecutedIds.delete(uploadId);
      const msg =
        e instanceof HttpError
          ? e.message
          : e instanceof Error
          ? e.message
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

  // ── Manual queue retry ─────────────────────────────────────────────────────

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

  // ── File ingestion ─────────────────────────────────────────────────────────

  function handleFiles(files: File[], intent: BroadcastIntent = defaultIntent) {
    const videoFiles = files.filter(isVideoFile);
    if (videoFiles.length === 0) {
      toast.error("No video files found. Drop MP4, MOV, MKV, or other video files.");
      return;
    }

    const params = videoFiles.map((f) => ({
      file: f,
      title: titleFromFilename(f.name),
      category: "sermon",
      preacher: "",
      description: "",
      featured: false,
      // High priority so broadcast uploads run before library uploads
      priority: Date.now() - 1_000_000,
    }));

    // Snapshot IDs before enqueue to identify the new items
    const beforeIds = new Set(uploadQueue.getItems().map((i) => i.id));
    uploadQueue.enqueue(params);
    const newItems = uploadQueue.getItems().filter((i) => !beforeIds.has(i.id));

    for (const item of newItems) {
      panelItemIds.current.add(item.id);
      setBroadcastStates((prev) => {
        const next = new Map(prev);
        next.set(item.id, {
          intent,
          queueItemId: null,
          executing: false,
          executed: false,
          error: null,
        });
        return next;
      });
    }

    if (newItems.length > 0) {
      const intentLabel = intent === "play-now" ? "Upload & Go Live" : intent === "next-up" ? "Queue as Next Up" : "Queue";
      toast.success(
        `${newItems.length} file${newItems.length !== 1 ? "s" : ""} added — ${intentLabel}`,
      );
    }
  }

  // ── Intent change (before execution) ──────────────────────────────────────

  function changeIntent(uploadId: string, intent: BroadcastIntent) {
    setBroadcastStates((prev) => {
      const next = new Map(prev);
      const s = next.get(uploadId);
      if (s && !s.executed && !s.executing) next.set(uploadId, { ...s, intent });
      return next;
    });
  }

  // ── Dismiss item ───────────────────────────────────────────────────────────

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

  // ── Drag-and-drop handlers ─────────────────────────────────────────────────

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropActive(false);
      handleFiles(Array.from(e.dataTransfer.files));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [defaultIntent],
  );

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(Array.from(e.target.files));
    e.target.value = "";
  };

  // ── Derived state ─────────────────────────────────────────────────────────

  const panelItems = items
    .filter((i) => panelItemIds.current.has(i.id))
    .sort((a, b) => b.addedAt - a.addedAt);

  const currentOnAirId = server?.current?.id ?? null;

  // Build a map from videoId → queueRow for quick lookups
  const videoIdToQueueRow = new Map(
    queueItems.filter((q) => q.videoId).map((q) => [q.videoId!, q]),
  );
  const queueItemIdToRow = new Map(queueItems.map((q) => [q.id, q]));

  const hasActiveUploads = panelItems.some(
    (i) => i.status === "uploading" || i.status === "finalizing" || i.status === "pending",
  );

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-base">
            <Tv2 className="h-4 w-4 text-primary" />
            Broadcast Upload
          </CardTitle>
          <div className="flex items-center gap-2 shrink-0">
            {/* Default intent selector */}
            <span className="text-xs text-muted-foreground hidden sm:inline">Default:</span>
            {(["queue", "next-up", "play-now"] as const).map((intent) => (
              <Button
                key={intent}
                size="sm"
                variant={defaultIntent === intent ? "default" : "outline"}
                className="h-7 px-2.5 text-xs gap-1"
                onClick={() => setDefaultIntent(intent)}
                title={
                  intent === "queue"
                    ? "Add uploaded videos to end of queue"
                    : intent === "next-up"
                    ? "Insert uploaded videos right after current on-air item"
                    : "Queue and immediately promote uploaded videos to front — goes live when ready"
                }
              >
                {INTENT_ICONS[intent]}
                {INTENT_LABELS[intent]}
              </Button>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Drop video files here to upload and queue them for broadcast. Files are processed automatically —
          no page navigation needed.
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* ── Drop Zone ──────────────────────────────────────────────────── */}
        <div
          role="region"
          aria-label="Video upload drop zone"
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={[
            "relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed cursor-pointer transition-all select-none",
            "min-h-[100px] px-4 py-5 gap-2.5",
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
            onChange={handleFileInputChange}
          />
          <div className={[
            "flex items-center justify-center rounded-full p-2.5 transition-colors",
            dropActive ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
          ].join(" ")}>
            <CloudUpload className="h-6 w-6" />
          </div>

          <div className="text-center space-y-0.5">
            <p className="text-sm font-medium">
              {dropActive ? "Drop to upload" : "Drop video files or click to browse"}
            </p>
            <p className="text-xs text-muted-foreground">
              MP4, MOV, MKV, AVI, WebM · Large files supported · Multi-file · Resumable
            </p>
          </div>

          {/* Quick intent buttons inside drop zone */}
          {!dropActive && (
            <div
              className="flex items-center gap-2 mt-1"
              onClick={(e) => e.stopPropagation()}
            >
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-3 text-xs gap-1"
                onClick={() => {
                  setDefaultIntent("queue");
                  fileInputRef.current?.click();
                }}
              >
                <ListPlus className="h-3 w-3" />
                Add to Queue
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-3 text-xs gap-1"
                onClick={() => {
                  setDefaultIntent("next-up");
                  fileInputRef.current?.click();
                }}
              >
                <SkipForward className="h-3 w-3" />
                Next Up
              </Button>
              <Button
                size="sm"
                className="h-7 px-3 text-xs gap-1 bg-red-600 hover:bg-red-700 text-white"
                onClick={() => {
                  setDefaultIntent("play-now");
                  fileInputRef.current?.click();
                }}
              >
                <Zap className="h-3 w-3" />
                Upload &amp; Go Live
              </Button>
            </div>
          )}
        </div>

        {/* ── Upload Items List ─────────────────────────────────────────── */}
        {panelItems.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Upload pipeline
              </p>
              {panelItems.some(
                (i) => i.status === "completed" || i.status === "cancelled" || i.status === "failed",
              ) && (
                <button
                  type="button"
                  onClick={() => {
                    const toRemove = panelItems.filter(
                      (i) =>
                        (i.status === "completed" || i.status === "cancelled") &&
                        broadcastStates.get(i.id)?.executed !== false,
                    );
                    for (const item of toRemove) dismissItem(item.id);
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

                const showProgress =
                  stage === "uploading" || stage === "finalizing";
                const showEncodingProgress =
                  stage === "encoding";
                const canChangeIntent =
                  bState && !bState.executed && !bState.executing;
                const isLocked =
                  !canChangeIntent ||
                  item.status === "cancelled" ||
                  item.status === "failed";

                return (
                  <li key={item.id} className="flex flex-col gap-1.5 px-3 py-2.5">
                    {/* Row: title + stage badge + dismiss */}
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Stage icon */}
                      <div className="shrink-0 text-muted-foreground">
                        {stage === "on-air" ? (
                          <span className="h-2 w-2 rounded-full bg-red-500 inline-block animate-pulse" />
                        ) : stage === "uploading" ? (
                          <Upload className="h-3.5 w-3.5 text-blue-500" />
                        ) : stage === "finalizing" || stage === "executing" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
                        ) : stage === "faststart" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
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

                      {/* Title */}
                      <span className="flex-1 min-w-0 truncate text-sm font-medium">
                        {item.title}
                      </span>

                      {/* Stage badge */}
                      <StageBadge stage={stage} />

                      {/* Dismiss / cancel */}
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

                    {/* Upload progress bar */}
                    {showProgress && (
                      <div className="space-y-1 pl-6">
                        <Progress value={item.progress} className="h-1.5" />
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span>
                            {formatBytes(item.uploadedBytes)} / {formatBytes(item.file.size)}
                            {item.speed > 0 && (
                              <> · {formatSpeed(item.speed)}</>
                            )}
                          </span>
                          {item.eta > 0 && (
                            <span>{formatEta(item.eta)} remaining</span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Faststart info */}
                    {stage === "faststart" && (
                      <p className="pl-6 text-[10px] text-blue-600 dark:text-blue-400">
                        Optimizing for streaming (moov atom relocation). Will air automatically when complete.
                      </p>
                    )}

                    {/* Encoding progress indicator */}
                    {showEncodingProgress && (
                      <p className="pl-6 text-[10px] text-amber-600 dark:text-amber-400">
                        HLS transcoding in progress. Video airs as MP4 until encoding completes.
                      </p>
                    )}

                    {/* Error message + retry queue */}
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

                    {/* Failed upload — retry upload */}
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

                    {/* Paused — resume / cancel */}
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

                    {/* Intent selector — shown while not yet executed */}
                    {!isLocked && bState && (
                      <div className="pl-6 flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] text-muted-foreground">When ready:</span>
                        {(["queue", "next-up", "play-now"] as const).map((intent) => (
                          <button
                            key={intent}
                            type="button"
                            onClick={() => changeIntent(item.id, intent)}
                            className={[
                              "flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
                              bState.intent === intent
                                ? intent === "play-now"
                                  ? "bg-red-600 text-white"
                                  : "bg-primary text-primary-foreground"
                                : "text-muted-foreground ring-1 ring-border hover:ring-primary/50 hover:text-foreground",
                            ].join(" ")}
                            title={
                              intent === "queue"
                                ? "Add to end of broadcast queue"
                                : intent === "next-up"
                                ? "Insert right after current on-air item"
                                : "Queue and immediately promote to front — goes live when broadcast-ready"
                            }
                          >
                            {INTENT_ICONS[intent]}
                            {INTENT_LABELS[intent]}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Queued — show queue position info */}
                    {bState?.executed && queueRow && stage !== "on-air" && (
                      <div className="pl-6 text-[10px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
                        <span>
                          {bState.intent === "play-now"
                            ? "Promoted to front of queue"
                            : bState.intent === "next-up"
                            ? "Inserted as Next Up"
                            : "Added to broadcast queue"}
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
                            {queueRow.hasHls ? "HLS adaptive streaming ready" : "MP4 ready"}
                          </span>
                        )}
                      </div>
                    )}

                    {/* On Air celebration */}
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
        {typeof navigator !== "undefined" && !navigator.onLine && hasActiveUploads && (
          <div className="flex items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200">
            <Wifi className="h-3.5 w-3.5 shrink-0" />
            Network offline — active uploads are paused and will resume automatically when connectivity is restored.
          </div>
        )}

        {/* Upload diagnostics legend */}
        {panelItems.length === 0 && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 text-[10px] text-muted-foreground border rounded-md px-3 py-2.5">
            <span className="flex items-center gap-1"><Upload className="h-2.5 w-2.5" /> Uploading in chunks (SHA-256)</span>
            <span className="flex items-center gap-1"><Loader2 className="h-2.5 w-2.5" /> Faststart optimization</span>
            <span className="flex items-center gap-1"><RotateCw className="h-2.5 w-2.5" /> HLS adaptive bitrate</span>
            <span className="flex items-center gap-1"><CheckCircle2 className="h-2.5 w-2.5" /> Broadcast validated</span>
            <span className="flex items-center gap-1"><AlertTriangle className="h-2.5 w-2.5" /> Transcoding guards queue</span>
            <span className="flex items-center gap-1"><Radio className="h-2.5 w-2.5" /> Auto-airs when ready</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
