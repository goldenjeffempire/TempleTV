/**
 * Global multi-file upload queue engine.
 *
 * Module-level singleton so uploads survive React navigation — the user can
 * move between admin pages without losing progress. React components subscribe
 * via `useUploadQueue()` and receive a new snapshot on every state change.
 *
 * Architecture
 * ─────────────
 * • MAX_CONCURRENT_FILES (3) files upload in parallel. Within each file,
 *   chunk-level concurrency is determined adaptively by the Network Information
 *   API (1–4 parallel chunks per file).
 * • Pause: sets a `paused` flag and aborts the current AbortController so the
 *   in-flight XHR throws AbortError. The catch branch sees `paused=true`
 *   and marks the item as 'paused' instead of 'cancelled'. On resume the GET
 *   /status endpoint tells us which chunks arrived so we skip them cleanly.
 * • Cancel: aborts without setting `paused`; the catch marks the item 'cancelled'.
 * • Retry: creates a fresh sessionId (idempotent init), resets progress, re-queues.
 * • Speed: real-time XHR upload.onprogress feeds a 5-second rolling-window
 *   throughput estimate. Within-chunk byte events (not just chunk-complete events)
 *   give smooth MB/s display even for slow connections with large chunks.
 * • Progress: tracks confirmed bytes (fully acked chunks) + in-flight bytes
 *   (reported by XHR but not yet acked) so the progress bar moves continuously
 *   within each chunk rather than jumping at chunk boundaries.
 * • Network detection: window offline/online events auto-pause/resume active
 *   uploads. Uploads paused this way resume automatically when connectivity
 *   is restored.
 * • Integrity: SHA-256 checksum per chunk verified server-side on every upload.
 */

import { apiBase } from "./api-base";
import { tokenStore, ensureFreshToken, forceRefreshToken } from "./api";
import { notifyUploadActivity, setUploadActive } from "./session-activity";

// ── Public types ─────────────────────────────────────────────────────────────

export type UploadStatus =
  | "pending"
  | "uploading"
  | "finalizing"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled";

/**
 * When true, all chunks are already uploaded and the session is still valid.
 * Retry will skip chunk upload and call /finalize directly on the same sessionId
 * instead of creating a new session from scratch.
 */
const FINALIZE_ONLY_ERROR = "FINALIZE_ONLY";

export interface UploadItem {
  /** Queue-local UUID — stable across retries. */
  id: string;
  /** Server-side upload session UUID — changes on retry unless finalizeOnly=true. */
  sessionId: string;
  file: File;
  title: string;
  description: string;
  category: string;
  preacher: string;
  featured: boolean;
  status: UploadStatus;
  /** 0–100. Reserves 0–90 for chunk upload, 90–100 for finalize. */
  progress: number;
  /** Bytes/second (5 s rolling window fed by XHR progress events). */
  speed: number;
  /** Seconds remaining (estimated). */
  eta: number;
  uploadedBytes: number;
  error: string | null;
  addedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  /** Lower number = higher priority in the pending queue. */
  priority: number;
  /** Set to the created video ID after finalize succeeds. */
  videoId: string | null;
  speedLabel: string;
  /**
   * When true, all chunks are already on the server and the session is valid.
   * Retry skips chunk upload and re-calls /finalize on the SAME sessionId
   * instead of starting from scratch. Set when finalize times out or returns 408.
   */
  finalizeOnly: boolean;
}

export interface UploadQueueSummary {
  total: number;
  pending: number;
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  paused: number;
  totalSpeed: number;
  hasActive: boolean;
  /** Total bytes across all non-completed, non-cancelled items (for size-weighted progress). */
  totalBytes: number;
  /** Bytes uploaded across all non-completed, non-cancelled items. */
  uploadedBytes: number;
  /** True when the browser reports no network connectivity. */
  networkOffline: boolean;
}

export interface EnqueueParams {
  file: File;
  title: string;
  category: string;
  preacher: string;
  description: string;
  featured: boolean;
  priority?: number;
}

// ── Internal worker state ─────────────────────────────────────────────────────

interface WorkerState {
  cancelCtrl: AbortController;
  paused: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MAX_CONCURRENT_FILES = 3;
const MAX_CHUNK_RETRIES = 6;

function getAdaptiveParams(): {
  chunkSize: number;
  maxConcurrent: number;
  speedLabel: string;
} {
  const nav = navigator as unknown as Record<string, unknown>;
  const conn = nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
  const downlink =
    conn && typeof conn === "object" && "downlink" in conn
      ? Number((conn as { downlink: unknown }).downlink)
      : null;
  const effectiveType =
    conn && typeof conn === "object" && "effectiveType" in conn
      ? String((conn as { effectiveType: unknown }).effectiveType)
      : null;

  if (
    effectiveType === "slow-2g" ||
    effectiveType === "2g" ||
    (downlink !== null && !isNaN(downlink) && downlink < 1)
  ) {
    return { chunkSize: 1 * 1024 * 1024, maxConcurrent: 1, speedLabel: "Slow connection" };
  }
  if (effectiveType === "3g" || (downlink !== null && !isNaN(downlink) && downlink < 5)) {
    return { chunkSize: 4 * 1024 * 1024, maxConcurrent: 2, speedLabel: "Moderate connection" };
  }
  // Cap at 8 MiB regardless of connection speed — larger chunks increase
  // memory pressure in mobile browsers and risk OOM on low-end devices.
  return { chunkSize: 8 * 1024 * 1024, maxConcurrent: 3, speedLabel: "Fast connection" };
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "X-Admin-CSRF": "1" };
  const t = tokenStore.getAccess();
  if (t) h["Authorization"] = `Bearer ${t}`;
  return h;
}

/**
 * Poll /finalize-status every 5 s until the assembly completes, the session
 * is released back to "uploading" (previous finalize failed server-side), or
 * the caller's AbortSignal fires (deadline / user cancel).
 *
 * Returns the video ID when completed, or null when polling stopped without
 * a completion (deadline fired, or session went back to "uploading").
 */
async function pollFinalizeStatus(
  sessionId: string,
  base: string,
  signal: AbortSignal,
): Promise<string | null> {
  // 2-second interval: snappy feedback when finalize-status transitions to
  // "completed" without burning too many requests on long assemblies.
  const POLL_INTERVAL_MS = 2_000;
  while (!signal.aborted) {
    // Wait for the next poll tick, aborting early if the signal fires.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, POLL_INTERVAL_MS);
      signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
    if (signal.aborted) return null;

    try {
      const resp = await fetch(
        `${base}/v1/admin/videos/upload/${sessionId}/finalize-status`,
        { headers: authHeaders() },
      );
      if (!resp.ok) continue;
      const body = (await resp.json()) as { status: string; videoId?: string | null };
      if (body.status === "completed" && body.videoId) return body.videoId;
      // Server released the lock (previous finalize failed) — let the caller retry.
      if (body.status === "uploading") return null;
      // "assembling" — keep polling.
    } catch {
      // Network hiccup — keep polling until deadline.
    }
  }
  return null;
}

// ── Engine ────────────────────────────────────────────────────────────────────

class UploadQueueEngine {
  private items = new Map<string, UploadItem>();
  private workerStates = new Map<string, WorkerState>();
  private activeWorkers = new Set<string>();
  private listeners = new Set<() => void>();

  /** IDs of items that were auto-paused because the network went offline. */
  private networkPausedIds = new Set<string>();
  private _beforeUnloadInstalled = false;

  /**
   * Stored as an arrow property so the same function reference is used for
   * both addEventListener and removeEventListener (required for removal to work).
   * Setting returnValue is the legacy cross-browser pattern; modern browsers
   * also respect the return value from the handler.
   */
  private readonly _beforeUnloadHandler = (e: BeforeUnloadEvent): void => {
    e.preventDefault();
    e.returnValue = "Uploads are in progress. Leaving will cancel them.";
  };

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("offline", () => this._onNetworkOffline());
      window.addEventListener("online", () => this._onNetworkOnline());
    }
  }

  private _onNetworkOffline(): void {
    for (const id of Array.from(this.activeWorkers)) {
      const item = this.items.get(id);
      if (item && (item.status === "uploading" || item.status === "finalizing")) {
        this.networkPausedIds.add(id);
        this.pause(id);
      }
    }
    // Notify so the panel can show the offline indicator immediately
    this.notify();
  }

  private _onNetworkOnline(): void {
    for (const id of this.networkPausedIds) {
      this.resume(id);
    }
    this.networkPausedIds.clear();
    this.notify();
  }

  // ── Subscription ───────────────────────────────────────────────────────────

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    // Wire upload-active state into the session keep-alive monitor on every
    // queue change. setUploadActive() is idempotent and a no-op when the
    // boolean hasn't crossed zero, so this is safe to call frequently.
    try {
      const summary = this.getSummary();
      setUploadActive(summary.active > 0 || summary.pending > 0);

      // Install/uninstall the beforeunload guard so the browser prompts
      // before navigation when uploads are in flight or pending.
      if (typeof window !== "undefined") {
        const hasActive = summary.active > 0 || summary.pending > 0;
        if (hasActive && !this._beforeUnloadInstalled) {
          window.addEventListener("beforeunload", this._beforeUnloadHandler);
          this._beforeUnloadInstalled = true;
        } else if (!hasActive && this._beforeUnloadInstalled) {
          window.removeEventListener("beforeunload", this._beforeUnloadHandler);
          this._beforeUnloadInstalled = false;
        }
      }
    } catch { /* never let session wiring break the queue */ }
    for (const cb of this.listeners) cb();
  }

  private update(id: string, patch: Partial<UploadItem>): void {
    const item = this.items.get(id);
    if (!item) return;
    this.items.set(id, { ...item, ...patch });
    this.notify();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getItems(): UploadItem[] {
    return Array.from(this.items.values()).sort((a, b) => {
      // Sort: active first, then pending by priority/addedAt, then completed, failed, cancelled
      const rank = (s: UploadStatus) => {
        if (s === "uploading" || s === "finalizing") return 0;
        if (s === "paused") return 1;
        if (s === "pending") return 2;
        if (s === "failed" || s === "cancelled") return 3;
        return 4; // completed
      };
      const ra = rank(a.status);
      const rb = rank(b.status);
      if (ra !== rb) return ra - rb;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.addedAt - b.addedAt;
    });
  }

  getSummary(): UploadQueueSummary {
    const items = Array.from(this.items.values());
    const total = items.length;
    const pending = items.filter((i) => i.status === "pending").length;
    const active = items.filter((i) => i.status === "uploading" || i.status === "finalizing").length;
    const completed = items.filter((i) => i.status === "completed").length;
    const failed = items.filter((i) => i.status === "failed").length;
    const cancelled = items.filter((i) => i.status === "cancelled").length;
    const paused = items.filter((i) => i.status === "paused").length;
    const totalSpeed = items.reduce((s, i) => s + i.speed, 0);

    // Size-weighted progress across all in-progress items (excludes completed/cancelled)
    const inProgress = items.filter(
      (i) => i.status !== "completed" && i.status !== "cancelled",
    );
    const totalBytes = inProgress.reduce((s, i) => s + i.file.size, 0);
    const uploadedBytes = inProgress.reduce((s, i) => s + i.uploadedBytes, 0);

    const networkOffline = typeof navigator !== "undefined" ? !navigator.onLine : false;

    return {
      total, pending, active, completed, failed, cancelled, paused,
      totalSpeed, hasActive: active > 0 || pending > 0,
      totalBytes, uploadedBytes, networkOffline,
    };
  }

  enqueue(files: EnqueueParams[]): void {
    const base = Date.now();
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const id = crypto.randomUUID();
      const item: UploadItem = {
        id,
        sessionId: crypto.randomUUID(),
        file: f.file,
        title: f.title,
        description: f.description || "",
        category: f.category || "sermon",
        preacher: f.preacher || "",
        featured: f.featured ?? false,
        status: "pending",
        progress: 0,
        speed: 0,
        eta: 0,
        uploadedBytes: 0,
        error: null,
        addedAt: base + i,
        startedAt: null,
        completedAt: null,
        priority: f.priority ?? base + i,
        videoId: null,
        speedLabel: "",
        finalizeOnly: false,
      };
      this.items.set(id, item);
    }
    this.notify();
    this.scheduleWorkers();
  }

  pause(id: string): void {
    const ws = this.workerStates.get(id);
    const item = this.items.get(id);
    if (!item || !ws) return;
    if (item.status !== "uploading" && item.status !== "finalizing") return;
    ws.paused = true;
    ws.cancelCtrl.abort();
    // Status will be updated to 'paused' by the runUpload catch block
  }

  resume(id: string): void {
    const item = this.items.get(id);
    if (!item || item.status !== "paused") return;
    // Reset to pending — the worker will pick it up and resume from where it left off
    this.update(id, { status: "pending", error: null });
    this.scheduleWorkers();
  }

  cancel(id: string): void {
    const ws = this.workerStates.get(id);
    const item = this.items.get(id);
    if (!item) return;
    if (ws && !ws.paused) {
      ws.cancelCtrl.abort();
      // runUpload catch handles the status update
    } else {
      // Pending or paused — mark directly
      this.update(id, { status: "cancelled" });
    }
  }

  retry(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    if (item.status !== "failed" && item.status !== "cancelled") return;

    if (item.finalizeOnly) {
      // All chunks are already on the server — skip re-upload, just re-call /finalize
      // on the SAME sessionId. Progress resumes at 92 to show we're going straight
      // to the assembly phase.
      this.update(id, {
        status: "pending",
        progress: 92,
        speed: 0,
        eta: 0,
        error: null,
        completedAt: null,
        videoId: null,
        // keepfinalizeOnly: true so the worker knows to skip chunk upload
      });
    } else {
      // Normal retry: fresh session, re-upload all chunks from scratch.
      this.update(id, {
        sessionId: crypto.randomUUID(),
        status: "pending",
        progress: 0,
        speed: 0,
        eta: 0,
        uploadedBytes: 0,
        error: null,
        startedAt: null,
        completedAt: null,
        videoId: null,
        finalizeOnly: false,
      });
    }
    this.scheduleWorkers();
  }

  prioritize(id: string): void {
    const item = this.items.get(id);
    if (!item || item.status !== "pending") return;
    this.update(id, { priority: Date.now() - 1_000_000 }); // push to front
    this.scheduleWorkers();
  }

  dismiss(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    if (item.status === "uploading" || item.status === "finalizing") return; // use cancel instead
    this.items.delete(id);
    this.workerStates.delete(id);
    this.notify();
  }

  clearCompleted(): void {
    for (const [id, item] of this.items) {
      if (item.status === "completed" || item.status === "cancelled") {
        this.items.delete(id);
        this.workerStates.delete(id);
      }
    }
    this.notify();
  }

  clearAll(): void {
    // Abort any active uploads first
    for (const [id, ws] of this.workerStates) {
      if (this.activeWorkers.has(id)) {
        ws.cancelCtrl.abort();
      }
    }
    this.items.clear();
    this.workerStates.clear();
    this.activeWorkers.clear();
    this.notify();
  }

  // ── Worker scheduling ───────────────────────────────────────────────────────

  private scheduleWorkers(): void {
    if (this.activeWorkers.size >= MAX_CONCURRENT_FILES) return;

    const pending = Array.from(this.items.values())
      .filter((i) => i.status === "pending")
      .sort((a, b) => a.priority - b.priority || a.addedAt - b.addedAt);

    for (const item of pending) {
      if (this.activeWorkers.size >= MAX_CONCURRENT_FILES) break;
      this.activeWorkers.add(item.id);
      void this.runUpload(item.id);
    }
  }

  // ── Core upload logic ───────────────────────────────────────────────────────

  private async runUpload(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) {
      this.activeWorkers.delete(id);
      return;
    }

    const cancelCtrl = new AbortController();
    const ws: WorkerState = { cancelCtrl, paused: false };
    this.workerStates.set(id, ws);

    const adaptive = getAdaptiveParams();
    const CHUNK_SIZE = adaptive.chunkSize;
    let maxConcurrent = adaptive.maxConcurrent;
    const file = item.file;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const base = apiBase();
    const signal = cancelCtrl.signal;

    // For finalizeOnly retries (chunks already uploaded, re-calling /finalize)
    // skip straight to the finalizing state so the UI doesn't briefly flash "uploading".
    const isFinalizeOnly = item.finalizeOnly;
    this.update(id, {
      status: isFinalizeOnly ? "finalizing" : "uploading",
      startedAt: item.startedAt ?? Date.now(),
      speedLabel: adaptive.speedLabel,
      error: null,
    });

    // ── Speed & progress tracking ─────────────────────────────────────────────
    //
    // confirmedBytes: bytes from fully-acknowledged chunks (server returned 200/409)
    // inFlightMap:    bytes reported by XHR for chunks still in-flight
    //                 key = chunkIndex, value = cumulative bytes sent in current attempt
    // effectiveBytes: confirmedBytes + sum(inFlightMap) → feeds the progress bar
    //
    // This gives a smooth, continuously-moving bar. When a chunk fails the
    // in-flight bytes for that chunk are removed (brief dip) and then rebuild
    // as the retry sends data again.

    let confirmedBytes = 0;
    const inFlightMap = new Map<number, number>();

    // 5-second rolling window fed by XHR progress events (not chunk-complete events)
    const speedWindow: Array<{ bytes: number; time: number }> = [];

    // rAF-throttled updater — caps React re-renders at display refresh rate
    let pendingRaf = false;
    const scheduleUpdate = () => {
      if (pendingRaf) return;
      pendingRaf = true;
      requestAnimationFrame(() => {
        pendingRaf = false;
        const currentItem = this.items.get(id);
        if (!currentItem || currentItem.status !== "uploading") return;

        const now = Date.now();
        // Prune entries older than 5 seconds
        while (speedWindow.length > 0 && now - speedWindow[0]!.time > 5_000) {
          speedWindow.shift();
        }
        const windowBytes = speedWindow.reduce((s, e) => s + e.bytes, 0);
        const windowSecs =
          speedWindow.length > 1
            ? Math.max(0.1, (speedWindow[speedWindow.length - 1]!.time - speedWindow[0]!.time) / 1000)
            : speedWindow.length === 1
              ? Math.max(0.1, (now - speedWindow[0]!.time) / 1000)
              : 0;
        const speed = windowSecs > 0.05 ? windowBytes / windowSecs : 0;

        const inFlightTotal = Array.from(inFlightMap.values()).reduce((s, b) => s + b, 0);
        const effectiveBytes = confirmedBytes + inFlightTotal;
        const pct = Math.min(Math.floor((effectiveBytes / file.size) * 90), 90);
        const remaining = file.size - effectiveBytes;
        const eta = speed > 0 ? remaining / speed : 0;

        this.update(id, {
          progress: Math.max(currentItem.progress, pct),
          speed,
          eta,
          uploadedBytes: Math.min(effectiveBytes, file.size),
        });
      });
    };

    // Remove in-flight tracking for a chunk (on failure or 409-that-was-resumed)
    const clearInFlight = (chunkIndex: number) => {
      inFlightMap.delete(chunkIndex);
    };

    // Move a chunk from in-flight → confirmed
    const confirmChunk = (chunkIndex: number, chunkBytes: number) => {
      confirmedBytes += chunkBytes;
      inFlightMap.delete(chunkIndex);
      scheduleUpdate();
    };

    // ── XHR-based chunk upload with real-time byte progress ───────────────────

    const uploadChunk = async (chunkIndex: number): Promise<void> => {
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const buffer = await file.slice(start, end).arrayBuffer();
      const checksum = await sha256Hex(buffer);
      const chunkBytes = end - start;

      let lastErr: Error | null = null;

      for (let attempt = 0; attempt < MAX_CHUNK_RETRIES; attempt++) {
        if (signal.aborted) throw new DOMException("Upload aborted", "AbortError");

        if (attempt > 0) {
          // Clear stale in-flight bytes from previous attempt before retrying
          clearInFlight(chunkIndex);
          scheduleUpdate();
          // Exponential backoff: 1s, 2s, 4s, 8s …
          await new Promise<void>((r) => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 30_000)));
        }

        // Proactively refresh the JWT access token if it is within 5 minutes
        // of expiry. Large uploads (700 MB+) routinely outlast the 15-minute
        // default access-token TTL; refreshing keeps the Bearer credential
        // valid for the full transfer without restarting on 401.
        await ensureFreshToken().catch(() => { /* non-fatal — 401 path below recovers */ });

        // Guard: if the token store was cleared (e.g. by a failed refresh on a
        // previous attempt), stop immediately — retrying without credentials
        // only wastes attempts and produces confusing 401 errors.
        if (!tokenStore.getAccess()) {
          throw Object.assign(
            new Error("Session expired — please log in again"),
            { fatal: true },
          );
        }

        try {
          const { ok, status, responseText } = await new Promise<{
            ok: boolean;
            status: number;
            responseText: string;
          }>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(
              "POST",
              `${base}/v1/admin/videos/upload/${this.items.get(id)!.sessionId}/chunk`,
            );

            const hdrs: Record<string, string> = {
              ...authHeaders(),
              "Content-Type": "application/octet-stream",
              "X-Chunk-Index": String(chunkIndex),
              "X-Chunk-Checksum": checksum,
            };
            for (const [k, v] of Object.entries(hdrs)) xhr.setRequestHeader(k, v);

            // XHR upload progress — fires as bytes are written to the network.
            // e.loaded is cumulative within this XHR attempt; compute delta vs
            // current inFlightMap to avoid double-counting.
            xhr.upload.addEventListener("progress", (e) => {
              if (e.loaded > 0) {
                const prev = inFlightMap.get(chunkIndex) ?? 0;
                const delta = e.loaded - prev;
                if (delta > 0) {
                  inFlightMap.set(chunkIndex, e.loaded);
                  speedWindow.push({ bytes: delta, time: Date.now() });
                  scheduleUpdate();
                }
              }
            });

            xhr.addEventListener("load", () => {
              // Flush any bytes that weren't fired by progress events
              // (some browsers skip the final progress event)
              const prev = inFlightMap.get(chunkIndex) ?? 0;
              const remaining = chunkBytes - prev;
              if (remaining > 0) {
                inFlightMap.set(chunkIndex, chunkBytes);
                speedWindow.push({ bytes: remaining, time: Date.now() });
                scheduleUpdate();
              }
              resolve({
                ok: xhr.status >= 200 && xhr.status < 300,
                status: xhr.status,
                responseText: xhr.responseText,
              });
            });

            xhr.addEventListener("error", () => {
              clearInFlight(chunkIndex);
              scheduleUpdate();
              reject(new Error("Network error during chunk upload"));
            });

            xhr.addEventListener("abort", () => {
              clearInFlight(chunkIndex);
              scheduleUpdate();
              reject(new DOMException("Upload aborted", "AbortError"));
            });

            signal.addEventListener("abort", () => xhr.abort(), { once: true });
            xhr.send(buffer);
          });

          if (status === 409) {
            // Chunk already received server-side (idempotent / resume race).
            // The XHR already populated inFlightMap for this chunk; calling
            // confirmChunk moves those bytes to confirmedBytes without
            // double-counting.
            confirmChunk(chunkIndex, chunkBytes);
            notifyUploadActivity();
            return;
          }

          if (ok) {
            confirmChunk(chunkIndex, chunkBytes);
            notifyUploadActivity();
            return;
          }

          // Non-OK response — clear in-flight bytes, parse error message
          clearInFlight(chunkIndex);
          scheduleUpdate();

          let errMsg = `Chunk ${chunkIndex} rejected (${status})`;
          try {
            const errBody = JSON.parse(responseText) as Record<string, unknown>;
            errMsg = (errBody.message as string) || (errBody.error as string) || errMsg;
          } catch { /* responseText isn't JSON */ }
          lastErr = new Error(errMsg);

          if (status === 401) {
            // The access token expired mid-upload. Force-refresh and retry
            // this chunk. The server-side session is still intact.
            // If the refresh itself fails (refresh token expired / network
            // down) tag the error as fatal so the outer catch exits the
            // retry loop immediately instead of burning all MAX_CHUNK_RETRIES
            // iterations with requests that have no Authorization header.
            try {
              await forceRefreshToken();
            } catch {
              throw Object.assign(
                new Error("Session expired — please log in again"),
                { fatal: true },
              );
            }
            continue; // retry immediately with fresh token (skip backoff)
          }

          // Hard 4xx errors (not 401, 429) are non-retriable
          if (status >= 400 && status < 500 && status !== 429) throw lastErr;

        } catch (e) {
          if ((e as Error).name === "AbortError" || signal.aborted) throw e;
          // Fatal errors (e.g. session expired) must propagate immediately —
          // retrying without valid credentials only wastes attempts.
          if ((e as { fatal?: boolean }).fatal) throw e;
          lastErr = e instanceof Error ? e : new Error(String(e));
        }
      }

      throw lastErr ?? new Error(`Chunk ${chunkIndex} failed after ${MAX_CHUNK_RETRIES} attempts`);
    };

    try {
      const sessionId = this.items.get(id)!.sessionId;

      // ── 1–3. Init + resume check + chunk upload (skipped for finalizeOnly retries) ──
      if (!isFinalizeOnly) {
      // ── 1. Init ────────────────────────────────────────────────────────────
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "mp4";

      // Proactively refresh the access token before init. ensureFreshToken()
      // is called before every chunk but was never called before the init
      // request — an expired token at upload-start caused an immediate 401
      // with no recovery path.
      console.log("[upload-queue] start item", { id, sessionId, fileName: file.name, size: file.size, totalChunks });
      const tokenResult = await ensureFreshToken().then(
        () => "ok",
        (e) => `error: ${(e as Error)?.message ?? String(e)}`,
      );
      console.log("[upload-queue] ensureFreshToken →", tokenResult);
      console.log("[upload-queue] authHeaders presence:", Object.keys(authHeaders()));

      const initBody = JSON.stringify({
        sessionId,
        title: item.title,
        description: item.description || "",
        category: item.category || "sermon",
        preacher: item.preacher || "",
        featured: item.featured ?? false,
        totalChunks,
        totalBytes: file.size,
        ext,
        originalFilename: file.name,
        mimeType: file.type || "video/mp4",
      });

      // Race the init fetch against a 30-second timeout so a slow server never
      // leaves the item stuck in "uploading" forever.
      let initTimeoutId: ReturnType<typeof setTimeout> | null = null;
      const initTimeoutPromise = new Promise<never>((_, reject) => {
        initTimeoutId = setTimeout(
          () => reject(new Error("Upload init timed out (30 s) — check server connectivity")),
          30_000,
        );
      });

      const initUrl = `${base}/v1/admin/videos/upload/init`;
      console.log("[upload-queue] POST", initUrl);
      let initResp: Response;
      try {
        initResp = await Promise.race([
          fetch(initUrl, {
            method: "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: initBody,
            signal,
          }),
          initTimeoutPromise,
        ]).finally(() => {
          if (initTimeoutId !== null) clearTimeout(initTimeoutId);
        });
        console.log("[upload-queue] init response", { status: initResp.status, ok: initResp.ok });
      } catch (err) {
        console.error("[upload-queue] init FETCH THREW", err);
        throw err;
      }

      // On 401 at init, force-refresh and retry once — mirrors the per-chunk
      // recovery path. The server session does not exist yet so the retry is
      // a clean idempotent re-attempt.
      if (initResp.status === 401) {
        await forceRefreshToken().catch(() => {});
        initResp = await fetch(`${base}/v1/admin/videos/upload/init`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: initBody,
          signal,
        });
      }

      if (!initResp.ok) {
        const errBody = (await initResp.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(
          (errBody.message as string) ||
          (errBody.error as string) ||
          `Upload init failed (${initResp.status})`,
        );
      }

      // ── 2. Resume check — skip already-uploaded chunks ────────────────────
      const uploadedIndices = new Set<number>();
      try {
        const statusResp = await fetch(
          `${base}/v1/admin/videos/upload/${sessionId}/status`,
          { headers: authHeaders(), signal },
        );
        if (statusResp.ok) {
          const statusBody = (await statusResp.json()) as { uploadedChunkIndices?: number[] };
          for (const i of statusBody.uploadedChunkIndices ?? []) uploadedIndices.add(i);
        }
      } catch {
        /* non-fatal — start from scratch on status failure */
      }

      // Seed confirmed bytes from already-uploaded chunks.
      // Use actual per-chunk byte sizes (last chunk may be smaller than CHUNK_SIZE).
      if (uploadedIndices.size > 0) {
        confirmedBytes = Array.from(uploadedIndices).reduce((sum, idx) => {
          const chunkStart = idx * CHUNK_SIZE;
          const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, file.size);
          return sum + (chunkEnd - chunkStart);
        }, 0);
        this.update(id, {
          uploadedBytes: confirmedBytes,
          progress: Math.min(Math.floor((confirmedBytes / file.size) * 90), 90),
        });
      }

      // ── 3. Upload remaining chunks ────────────────────────────────────────
      const queue = Array.from({ length: totalChunks }, (_, i) => i).filter(
        (i) => !uploadedIndices.has(i),
      );

      while (queue.length > 0) {
        if (signal.aborted) throw new DOMException("Upload aborted", "AbortError");

        const batchStart = Date.now();
        const batch = queue.splice(0, maxConcurrent);
        await Promise.all(batch.map(uploadChunk));

        // Dynamic concurrency tuning based on observed batch throughput
        const batchElapsed = (Date.now() - batchStart) / 1000;
        const batchBytes = batch.reduce(
          (sum, idx) => sum + Math.min(CHUNK_SIZE, file.size - idx * CHUNK_SIZE),
          0,
        );
        if (batchElapsed > 0.1) {
          const speedMiB = batchBytes / batchElapsed / (1024 * 1024);
          if (speedMiB > 5 && maxConcurrent < 4) {
            maxConcurrent = 4;
          } else if (speedMiB > 1 && maxConcurrent < 3) {
            maxConcurrent = Math.min(3, maxConcurrent + 1);
          } else if (speedMiB < 0.5 && maxConcurrent > 1) {
            maxConcurrent = 1;
          }
        }
      }

      } // end if (!isFinalizeOnly)

      // ── 4. Finalize ───────────────────────────────────────────────────────
      this.update(id, { status: "finalizing", progress: 92, speed: 0, eta: 0 });

      // Animate progress from 92 → 99 while finalization runs.
      // Ticks every 800 ms at 0.3% per step — reaches 99% after ~23 seconds.
      // This gives honest visual feedback for large-file (500 MB+) assembly
      // which can take 30–90 seconds with the batch-hex algorithm.
      let finalizeProgress = 92;
      const finalizeTimer = setInterval(() => {
        finalizeProgress = Math.min(parseFloat((finalizeProgress + 0.3).toFixed(1)), 99);
        const curr = this.items.get(id);
        if (curr?.status === "finalizing") {
          this.update(id, { progress: Math.floor(finalizeProgress) });
        } else {
          clearInterval(finalizeTimer);
        }
      }, 800);

      // 5-minute client-side deadline: if the server is still assembling after
      // 5 minutes, abort the fetch and poll /finalize-status to check if it
      // actually completed (race-condition safety). If it did complete, mark
      // done; otherwise mark failed with finalizeOnly=true so retry re-calls
      // /finalize on the same session without re-uploading all chunks.
      const FINALIZE_TIMEOUT_MS = 5 * 60 * 1000;
      const finalizeTimeoutCtrl = new AbortController();
      let finalizeTimeoutId: ReturnType<typeof setTimeout> | null = setTimeout(
        () => finalizeTimeoutCtrl.abort(),
        FINALIZE_TIMEOUT_MS,
      );
      // Propagate user cancel → finalize abort
      signal.addEventListener("abort", () => finalizeTimeoutCtrl.abort(), { once: true });

      try {
        // Proactively refresh before finalizing — even if all chunks succeeded,
        // the token may have expired in the final moments of a very long transfer.
        await ensureFreshToken().catch(() => {});

        // On finalizeOnly retries, check /finalize-status first to detect if
        // the previous assembly already completed while the client was waiting
        // (e.g. the 5-minute deadline fired, but the server finished shortly
        // after). Skipping straight to /finalize in that case would just return
        // the idempotent result, but if the session is still assembling we would
        // get a 409 and lose context that we should be polling, not calling again.
        if (isFinalizeOnly) {
          const preCheck = await fetch(
            `${base}/v1/admin/videos/upload/${sessionId}/finalize-status`,
            { headers: authHeaders(), signal: finalizeTimeoutCtrl.signal },
          ).catch(() => null);
          if (preCheck?.ok) {
            const preCheckBody = (await preCheck.json()) as { status: string; videoId?: string | null };
            if (preCheckBody.status === "completed" && preCheckBody.videoId) {
              // Already done — mark complete without a redundant /finalize call.
              this.update(id, {
                status: "completed",
                progress: 100,
                completedAt: Date.now(),
                videoId: preCheckBody.videoId,
                speed: 0,
                eta: 0,
                finalizeOnly: false,
              });
              this._onComplete(id);
              return;
            }
            if (preCheckBody.status === "assembling") {
              // Still assembling — poll instead of calling /finalize (which
              // would return 409 and require another manual retry).
              const polledVideoId = await pollFinalizeStatus(
                sessionId,
                base,
                finalizeTimeoutCtrl.signal,
              );
              if (polledVideoId) {
                this.update(id, {
                  status: "completed",
                  progress: 100,
                  completedAt: Date.now(),
                  videoId: polledVideoId,
                  speed: 0,
                  eta: 0,
                  finalizeOnly: false,
                });
                this._onComplete(id);
                return;
              }
              // Deadline fired without completion — surface error so the
              // user can retry again when the server is less busy.
              throw Object.assign(
                new Error(
                  "Assembly is still running on the server. All chunks are safely stored. " +
                  "Click Retry to check completion.",
                ),
                { code: FINALIZE_ONLY_ERROR },
              );
            }
            // status === "uploading" — proceed to call /finalize normally below.
          }
        }

        let finalizeResp: Response;
        try {
          finalizeResp = await fetch(
            `${base}/v1/admin/videos/upload/${sessionId}/finalize`,
            { method: "POST", headers: authHeaders(), signal: finalizeTimeoutCtrl.signal },
          );
        } catch {
          // Distinguish user cancel from our 5-minute timeout.
          if (signal.aborted) throw new DOMException("Upload aborted", "AbortError");

          // Timeout fired — check if server actually finished while we waited.
          const statusCheck = await fetch(
            `${base}/v1/admin/videos/upload/${sessionId}/finalize-status`,
            { headers: authHeaders() },
          ).catch(() => null);

          if (statusCheck?.ok) {
            const statusBody = (await statusCheck.json()) as { status: string; videoId?: string | null };
            if (statusBody.status === "completed" && statusBody.videoId) {
              // Server finished — mark complete without another finalize call.
              this.update(id, {
                status: "completed",
                progress: 100,
                completedAt: Date.now(),
                videoId: statusBody.videoId,
                speed: 0,
                eta: 0,
                finalizeOnly: false,
              });
              this._onComplete(id);
              return;
            }
          }

          // Server hasn't finished. Mark failed with finalizeOnly so retry
          // skips chunk re-upload and just calls /finalize again.
          throw Object.assign(
            new Error(
              "Assembly timed out after 5 minutes. All chunks are safely stored. " +
              "Click Retry to resume finalization without re-uploading.",
            ),
            { code: FINALIZE_ONLY_ERROR },
          );
        }

        // On 401, refresh and retry once — all chunks are safely stored server-side;
        // only the Bearer credential may have expired during the transfer.
        if (finalizeResp.status === 401) {
          await forceRefreshToken().catch(() => {});
          finalizeResp = await fetch(
            `${base}/v1/admin/videos/upload/${sessionId}/finalize`,
            { method: "POST", headers: authHeaders(), signal: finalizeTimeoutCtrl.signal },
          );
        }

        // 408 = server-side assembly timeout (8-min hard deadline).
        // All chunks are intact — retry will re-call /finalize without re-uploading.
        if (finalizeResp.status === 408) {
          throw Object.assign(
            new Error(
              "Server assembly timed out. All chunks are safely stored. " +
              "Click Retry to resume finalization without re-uploading.",
            ),
            { code: FINALIZE_ONLY_ERROR },
          );
        }

        // 409 = a concurrent finalize request already holds the assembly lock.
        // Rather than surfacing an error that forces the user to manually click
        // Retry, automatically poll /finalize-status every 5 s so the upload
        // item transitions to "completed" the moment the assembly finishes —
        // completely transparent to the operator.
        if (finalizeResp.status === 409) {
          const polledVideoId = await pollFinalizeStatus(
            sessionId,
            base,
            finalizeTimeoutCtrl.signal,
          );
          if (polledVideoId) {
            // Assembly finished while we were polling — mark complete.
            this.update(id, {
              status: "completed",
              progress: 100,
              completedAt: Date.now(),
              videoId: polledVideoId,
              speed: 0,
              eta: 0,
              finalizeOnly: false,
            });
            this._onComplete(id);
            return;
          }
          // Deadline fired or server released the lock without completing.
          // Mark finalizeOnly so Retry re-calls /finalize without re-uploading.
          throw Object.assign(
            new Error(
              "Assembly is running on the server. All chunks are safely stored. " +
              "Click Retry to check completion.",
            ),
            { code: FINALIZE_ONLY_ERROR },
          );
        }

        if (!finalizeResp.ok) {
          const errBody = (await finalizeResp.json().catch(() => ({}))) as Record<string, unknown>;
          throw new Error(
            (errBody.message as string) ||
            (errBody.error as string) ||
            `Finalize failed (${finalizeResp.status})`,
          );
        }
        const result = (await finalizeResp.json()) as { id?: string };

        this.update(id, {
          status: "completed",
          progress: 100,
          completedAt: Date.now(),
          videoId: result.id ?? null,
          speed: 0,
          eta: 0,
          finalizeOnly: false,
        });

        // Notify all engine subscribers so video list queries can invalidate
        this._onComplete(id);
      } finally {
        clearInterval(finalizeTimer);
        if (finalizeTimeoutId !== null) clearTimeout(finalizeTimeoutId);
        finalizeTimeoutId = null;
      }

    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.name === "AbortError" || cancelCtrl.signal.aborted) {
        const ws2 = this.workerStates.get(id);
        if (ws2?.paused) {
          this.update(id, { status: "paused", speed: 0, eta: 0 });
        } else {
          this.update(id, { status: "cancelled", speed: 0, eta: 0 });
        }
      } else if (err.code === FINALIZE_ONLY_ERROR) {
        // Finalize timed out or was rejected with 408/409 — chunks are intact.
        // Retry will skip chunk re-upload and call /finalize on the same session.
        this.update(id, {
          status: "failed",
          error: err.message,
          speed: 0,
          eta: 0,
          finalizeOnly: true,
        });
      } else {
        this.update(id, {
          status: "failed",
          error: err.message || "Upload failed",
          speed: 0,
          eta: 0,
          finalizeOnly: false,
        });
      }
    } finally {
      this.activeWorkers.delete(id);
      this.scheduleWorkers();
    }
  }

  // ── Completion callbacks ────────────────────────────────────────────────────
  // External listeners (e.g. TanStack Query invalidation) register here.

  private completionListeners = new Set<(id: string) => void>();

  onComplete(cb: (id: string) => void): () => void {
    this.completionListeners.add(cb);
    return () => this.completionListeners.delete(cb);
  }

  private _onComplete(id: string): void {
    for (const cb of this.completionListeners) cb(id);
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const uploadQueue = new UploadQueueEngine();

// ── React hook ────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";

interface QueueSnapshot {
  items: UploadItem[];
  summary: UploadQueueSummary;
}

// Cache the last snapshot so useSyncExternalStore can return stable references
// when nothing has changed. Without this, getItems() returns a new array every
// call and React sees an always-different value → infinite re-render loop.
let _cachedSnapshot: QueueSnapshot = { items: [], summary: uploadQueue.getSummary() };

function getSnapshot(): QueueSnapshot {
  return _cachedSnapshot;
}

// Stable subscribe that also refreshes the cached snapshot on each notify
const subscribe = (cb: () => void) =>
  uploadQueue.subscribe(() => {
    _cachedSnapshot = {
      items: uploadQueue.getItems(),
      summary: uploadQueue.getSummary(),
    };
    cb();
  });

export function useUploadQueue() {
  const { items, summary } = useSyncExternalStore(subscribe, getSnapshot);
  return { items, summary };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatSpeed(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatEta(secs: number): string {
  if (!isFinite(secs) || secs <= 0) return "";
  if (secs < 60) return `${Math.ceil(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.ceil(secs % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${rm}m`;
  }
  return `${m}m ${s}s`;
}

export function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
