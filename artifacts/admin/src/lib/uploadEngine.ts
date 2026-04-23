import { getAdminToken } from "@/lib/admin-access";
import type { CompressionProgress, ProbeResult } from "@/lib/videoCompressor";

// ─── Constants ────────────────────────────────────────────────────────────────
export const CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_CONCURRENT_PER_FILE = 6;
export const MAX_CONCURRENT_FILES = 5;
export const MIN_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 12;
export const PREFETCH_AHEAD = 4;
export const RENDER_THROTTLE_MS = 80;
export const MAX_RETRIES = 6;
export const SPEED_SAMPLES = 12;
export const CATEGORIES = ["sermon", "faith", "healing", "deliverance", "worship", "prophecy", "teachings", "special"];

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
  skipCompression: boolean;
  compressionProgress: CompressionProgress | null;
  compressedBlob: Blob | null;
  probe: ProbeResult | null;
}

export interface StoredSession {
  sessionId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  form: { title: string; category: string; preacher: string; featured: boolean };
}

// ─── Utility helpers ─────────────────────────────────────────────────────────
export function exponentialBackoff(attempt: number): number {
  const base = Math.min(500 * Math.pow(2, attempt), 16000);
  return base + Math.random() * base * 0.3;
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

export async function uploadChunk(
  sessionId: string,
  chunkIndex: number,
  data: ArrayBuffer,
  checksum: string,
  signal: AbortSignal,
  onProgress?: (bytes: number) => void,
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
    const token = getAdminToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.send(formData);
  });
}

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
