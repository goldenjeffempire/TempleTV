import { getAdminToken } from "@/lib/admin-access";
import type { CompressionProgress, ProbeResult } from "@/lib/videoCompressor";

// ─── Constants ────────────────────────────────────────────────────────────────
export const CHUNK_SIZE = 8 * 1024 * 1024;          // 8 MB per chunk
export const MAX_CONCURRENT_PER_FILE = 8;            // raised from 6 → 8
export const MAX_CONCURRENT_FILES = 5;
export const MIN_CONCURRENCY = 1;                    // allow single-stream on poor links
export const MAX_CONCURRENCY = 16;                   // raised from 12 → 16 for fast links
export const PREFETCH_AHEAD = 6;                     // raised from 4 → 6 (pre-warm 6 chunks)
export const RENDER_THROTTLE_MS = 60;                // ~16fps UI refresh (was 80ms/12fps)
export const MAX_RETRIES = 8;                        // raised from 6 → 8
export const SPEED_SAMPLES = 20;                     // more samples for EMA
export const CHUNK_STALL_TIMEOUT_MS = 60_000;        // abort chunk if no bytes for 60s
export const CATEGORIES = [
  "sermon", "faith", "healing", "deliverance", "worship",
  "prophecy", "teachings", "special",
];

// EMA smoothing factor: 0 = no smoothing, 1 = instant (0.15 = gentle smoothing)
export const EMA_ALPHA = 0.15;

// ─── Types ────────────────────────────────────────────────────────────────────
export type TaskState =
  | "pending"
  | "compressing"
  | "initializing"
  | "uploading"
  | "paused"
  | "finalizing"
  | "done"
  | "error";

export interface FileTask {
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
  speed: number;           // EMA-smoothed bytes/sec
  speedRaw: number;        // last-window raw bytes/sec (for display)
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
  stallCount: number;      // how many chunk stalls have been auto-recovered
  skipCompression: boolean;
  compressionProgress: CompressionProgress | null;
  compressedBlob: Blob | null;
  probe: ProbeResult | null;
  // Network diagnostics
  networkType: string;     // e.g. "4g", "wifi", "unknown"
}

export interface StoredSession {
  sessionId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  form: { title: string; category: string; preacher: string; featured: boolean };
}

// ─── Network-aware initial concurrency ───────────────────────────────────────
/**
 * Uses the Network Information API (where available) to pick a sensible
 * starting concurrency.  Falls back to MAX_CONCURRENT_PER_FILE on browsers
 * that don't expose the API.
 *
 * Returns both the concurrency and a human-readable label for display.
 */
export function getNetworkAwareConcurrency(): { concurrency: number; networkType: string } {
  type NetworkInfo = { effectiveType?: string; downlink?: number; type?: string };
  const conn = (navigator as unknown as { connection?: NetworkInfo }).connection;

  if (!conn) return { concurrency: MAX_CONCURRENT_PER_FILE, networkType: "unknown" };

  const type = conn.type ?? conn.effectiveType ?? "unknown";
  const downlink = conn.downlink ?? 0; // Mbps

  // Use downlink if available (more precise), fall back to effectiveType labels
  if (downlink >= 50 || type === "wifi" || conn.effectiveType === "4g") {
    return { concurrency: 12, networkType: type };
  }
  if (downlink >= 10 || conn.effectiveType === "3g") {
    return { concurrency: 6, networkType: type };
  }
  if (downlink >= 2 || conn.effectiveType === "2g") {
    return { concurrency: 3, networkType: type };
  }
  // slow-2g / unknown
  return { concurrency: 2, networkType: type };
}

// ─── EMA speed helper ────────────────────────────────────────────────────────
/**
 * Exponential Moving Average speed estimate.
 * Produces a smoothed value that reacts to sudden changes while ignoring
 * short bursts / dips caused by TCP congestion or kernel scheduling.
 */
export function emaSpeed(prevEma: number, newSample: number): number {
  if (prevEma === 0) return newSample;
  return EMA_ALPHA * newSample + (1 - EMA_ALPHA) * prevEma;
}

// ─── Utility helpers ─────────────────────────────────────────────────────────
export function exponentialBackoff(attempt: number): number {
  const base = Math.min(300 * Math.pow(2, attempt), 12_000); // faster initial, same ceiling
  return base + Math.random() * base * 0.25;
}

export async function computeSha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function detectVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const secs = isFinite(video.duration) ? Math.round(video.duration) : 0;
      URL.revokeObjectURL(url);
      resolve(secs);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    video.src = url;
  });
}

export async function readJsonOrThrow<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  if (!text) {
    throw new Error(
      `${label}: empty response (HTTP ${res.status} ${res.statusText || "no status text"}). ` +
        `The request did not reach the server or was truncated by a proxy/network hop.`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `${label}: server returned non-JSON response (HTTP ${res.status} ${res.statusText || ""}). ` +
        `Body snippet: ${text.slice(0, 200)}`,
    );
  }
}

// ─── Chunk upload with stall watchdog ────────────────────────────────────────
/**
 * Uploads a single chunk via XHR.
 *
 * Stall watchdog: if no upload progress bytes arrive within `stallTimeoutMs`
 * the XHR is aborted and a StallError is thrown so the caller's retry loop
 * can re-attempt the chunk.  This prevents indefinite hangs caused by broken
 * HTTP/1.1 keep-alive connections or mobile network dropouts that don't
 * trigger an actual TCP error.
 */
export async function uploadChunk(
  sessionId: string,
  chunkIndex: number,
  data: ArrayBuffer,
  checksum: string,
  signal: AbortSignal,
  onProgress?: (bytes: number) => void,
  stallTimeoutMs = CHUNK_STALL_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) { settled = true; if (stallTimer) clearTimeout(stallTimer); fn(); }
    };

    // ── Stall watchdog ─────────────────────────────────────────────────────
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const resetStall = () => {
      if (settled) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        xhr.abort();
        settle(() =>
          reject(
            Object.assign(
              new Error(`Chunk ${chunkIndex} stalled — no bytes for ${stallTimeoutMs / 1000}s, retrying`),
              { name: "StallError" },
            ),
          ),
        );
      }, stallTimeoutMs);
    };
    resetStall(); // arm immediately on send

    const formData = new FormData();
    formData.append("chunk", new Blob([data]));
    formData.append("chunkIndex", String(chunkIndex));
    formData.append("checksum", checksum);

    const xhr = new XMLHttpRequest();
    let lastLoaded = 0;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.loaded > lastLoaded) {
        const delta = e.loaded - lastLoaded;
        lastLoaded = e.loaded;
        onProgress?.(delta);
        resetStall(); // any progress resets the watchdog
      }
    };

    xhr.onload = () =>
      settle(() => {
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
      });

    xhr.onerror = () => settle(() => reject(new Error("Network error — connection lost")));
    xhr.onabort = () => settle(() => { /* already rejected by stall or signal handler */ });

    signal.addEventListener(
      "abort",
      () => { xhr.abort(); settle(() => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))); },
      { once: true },
    );

    xhr.open("POST", `/api/admin/videos/upload/${sessionId}/chunk`);
    const token = getAdminToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.send(formData);
  });
}

// ─── Formatting helpers ───────────────────────────────────────────────────────
export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatSpeed(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${(bps / 1024).toFixed(0)} KB/s`;
}

export function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export function networkTypeLabel(type: string): string {
  const map: Record<string, string> = {
    wifi: "Wi-Fi",
    "4g": "4G",
    "3g": "3G",
    "2g": "2G",
    "slow-2g": "2G (slow)",
    ethernet: "Ethernet",
    bluetooth: "BT",
    cellular: "Cellular",
    unknown: "",
  };
  return map[type] ?? type;
}
