import { getAdminToken } from "@/lib/admin-access";
import { apiBase } from "@/lib/api-base";
import type { CompressionProgress, ProbeResult } from "@/lib/videoCompressor";

// ─── Fixed constants ──────────────────────────────────────────────────────────
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENT_FILES = 5;
export const RENDER_THROTTLE_MS = 50;            // ~20fps UI refresh
export const MAX_RETRIES = 8;
export const SPEED_SAMPLES = 24;                 // sliding-window for EMA
export const CATEGORIES = [
  "sermon", "faith", "healing", "deliverance", "worship",
  "prophecy", "teachings", "special",
];

// EMA alpha: higher = more reactive to sudden speed changes (0.25 for fast nets)
export const EMA_ALPHA = 0.25;

// ─── Network tier ─────────────────────────────────────────────────────────────
export type NetworkTier = "slow2g" | "2g" | "3g" | "4g" | "fast" | "5g" | "ultrafast";

export interface NetworkParams {
  chunkSize: number;        // bytes per chunk
  maxConcurrency: number;   // max parallel chunk uploads
  prefetchAhead: number;    // chunks to pre-buffer in memory
  stallTimeoutMs: number;   // abort chunk if no bytes for this long
  networkType: string;      // raw type from navigator.connection
  tier: NetworkTier;
}

/**
 * Probes the Network Information API and returns adaptive upload parameters.
 *
 * Tier mapping (upload-safe — uses download downlink as a proxy):
 *   ultrafast  ≥400 Mbps   64 MB chunks  ×32 concurrent  (5G mmWave / Fiber)
 *   5g         ≥150 Mbps   32 MB chunks  ×24 concurrent  (5G sub-6 / Wi-Fi 6)
 *   fast       ≥40 Mbps    16 MB chunks  ×16 concurrent  (4G+ / Gigabit Wi-Fi)
 *   4g         ≥10 Mbps     8 MB chunks  ×10 concurrent  (4G / fast Wi-Fi)
 *   3g         ≥2 Mbps      4 MB chunks  × 5 concurrent
 *   2g         ≥0.3 Mbps    2 MB chunks  × 2 concurrent
 *   slow2g    < 0.3 Mbps    1 MB chunks  × 1 concurrent
 *
 * Memory guard: (maxConcurrency + prefetchAhead) × chunkSize ≤ ~512 MB
 */
export function getAdaptiveNetworkParams(): NetworkParams {
  type NavConn = {
    effectiveType?: string;
    downlink?: number;
    type?: string;
    saveData?: boolean;
  };
  const conn = (navigator as unknown as { connection?: NavConn }).connection;

  // Data-saver mode — use minimal settings
  if (conn?.saveData) {
    return {
      chunkSize: 2 * 1024 * 1024, maxConcurrency: 2, prefetchAhead: 2,
      stallTimeoutMs: 60_000, networkType: conn.type ?? "unknown", tier: "2g",
    };
  }

  const downlink = conn?.downlink ?? 0;              // Mbps (download proxy)
  const effectiveType = conn?.effectiveType ?? "";
  const type = conn?.type ?? effectiveType ?? "unknown";

  // ── Ultra-fast: 5G mmWave / Fiber (400+ Mbps) ────────────────────────────
  if (downlink >= 400) {
    return {
      chunkSize: 64 * 1024 * 1024,   // 64 MB
      maxConcurrency: 32,
      prefetchAhead: 3,               // 3×64 = 192 MB prefetch
      stallTimeoutMs: 12_000,
      networkType: type,
      tier: "ultrafast",
    };
  }

  // ── 5G sub-6 / Wi-Fi 6 (150-400 Mbps) ───────────────────────────────────
  if (downlink >= 150) {
    return {
      chunkSize: 32 * 1024 * 1024,   // 32 MB
      maxConcurrency: 24,
      prefetchAhead: 5,               // 5×32 = 160 MB prefetch
      stallTimeoutMs: 15_000,
      networkType: type,
      tier: "5g",
    };
  }

  // ── Fast (4G+ / Gigabit Wi-Fi, 40-150 Mbps) ─────────────────────────────
  if (downlink >= 40 || type === "wifi") {
    return {
      chunkSize: 16 * 1024 * 1024,   // 16 MB
      maxConcurrency: 16,
      prefetchAhead: 6,               // 6×16 = 96 MB prefetch
      stallTimeoutMs: 20_000,
      networkType: type,
      tier: "fast",
    };
  }

  // ── 4G (10-40 Mbps) ──────────────────────────────────────────────────────
  if (downlink >= 10 || effectiveType === "4g") {
    return {
      chunkSize: 8 * 1024 * 1024,    // 8 MB
      maxConcurrency: 10,
      prefetchAhead: 6,
      stallTimeoutMs: 30_000,
      networkType: type,
      tier: "4g",
    };
  }

  // ── 3G (2-10 Mbps) ───────────────────────────────────────────────────────
  if (downlink >= 2 || effectiveType === "3g") {
    return {
      chunkSize: 4 * 1024 * 1024,    // 4 MB
      maxConcurrency: 5,
      prefetchAhead: 4,
      stallTimeoutMs: 45_000,
      networkType: type,
      tier: "3g",
    };
  }

  // ── 2G (0.3-2 Mbps) ──────────────────────────────────────────────────────
  if (downlink >= 0.3 || effectiveType === "2g") {
    return {
      chunkSize: 2 * 1024 * 1024,    // 2 MB
      maxConcurrency: 2,
      prefetchAhead: 2,
      stallTimeoutMs: 60_000,
      networkType: type,
      tier: "2g",
    };
  }

  // ── Slow / unknown ────────────────────────────────────────────────────────
  // No connection info available: use safe 8 MB default that works well on
  // any network ≥4G and is still safe on slower connections.
  return {
    chunkSize: 8 * 1024 * 1024,
    maxConcurrency: 8,
    prefetchAhead: 6,
    stallTimeoutMs: 45_000,
    networkType: type,
    tier: "4g",
  };
}

// Legacy compat shim (used in VideoUploadModal addFiles)
export function getNetworkAwareConcurrency(): { concurrency: number; networkType: string } {
  const p = getAdaptiveNetworkParams();
  return { concurrency: p.maxConcurrency, networkType: p.networkType };
}

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
  sessionId: string | null;
  state: TaskState;
  progress: number;
  bytesUploaded: number;
  speed: number;           // EMA-smoothed bytes/sec
  speedRaw: number;        // last-window raw bytes/sec
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
  stallCount: number;
  skipCompression: boolean;
  compressionProgress: CompressionProgress | null;
  compressedBlob: Blob | null;
  probe: ProbeResult | null;
  // ── Adaptive network params (set once at task creation) ──────────────────
  chunkSize: number;
  maxConcurrency: number;
  prefetchAhead: number;
  stallTimeoutMs: number;
  networkType: string;
  tier: NetworkTier;
}

export interface StoredSession {
  sessionId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  chunkSize: number;       // persisted so resume uses the same chunk size
  form: { title: string; category: string; preacher: string };
}

// ─── EMA speed helper ────────────────────────────────────────────────────────
export function emaSpeed(prevEma: number, newSample: number): number {
  if (prevEma === 0) return newSample;
  return EMA_ALPHA * newSample + (1 - EMA_ALPHA) * prevEma;
}

// ─── Utility helpers ──────────────────────────────────────────────────────────
export function exponentialBackoff(attempt: number): number {
  const base = Math.min(300 * Math.pow(2, attempt), 12_000);
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
    video.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    video.src = url;
  });
}

export async function readJsonOrThrow<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  if (!text) {
    throw new Error(
      `${label}: empty response (HTTP ${res.status} ${res.statusText || "no status text"}). ` +
        "The request did not reach the server or was truncated by a proxy/network hop.",
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

// ─── Chunk upload with stall watchdog ─────────────────────────────────────────
/**
 * Uploads a single chunk via XHR with progress tracking and stall detection.
 *
 * The stall watchdog aborts and rejects if NO upload-progress bytes arrive
 * within `stallTimeoutMs`.  Any xhr.upload.progress event resets the timer,
 * so a chunk that is actively transmitting data will never be killed by it.
 */
export async function uploadChunk(
  sessionId: string,
  chunkIndex: number,
  data: ArrayBuffer,
  checksum: string,
  signal: AbortSignal,
  onProgress?: (bytes: number) => void,
  stallTimeoutMs = 45_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        if (stallTimer) clearTimeout(stallTimer);
        fn();
      }
    };

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
    resetStall();

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
        resetStall();
      }
    };

    xhr.onload = () =>
      settle(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          // Defense-in-depth: a 200 response with an HTML body almost always
          // means the request landed on the SPA host instead of the API
          // (e.g. split-domain prod where VITE_API_BASE_URL is unset, or a
          // proxy fallthrough during an api-server restart). Without this
          // check, the chunk would silently "succeed" against nothing and the
          // upload modal would fire its success toast even though no row was
          // ever written. We require either a JSON content-type or a body
          // that actually parses as JSON.
          const ct = (xhr.getResponseHeader("content-type") ?? "").toLowerCase();
          const looksJson = ct.includes("application/json");
          const body = xhr.responseText ?? "";
          let parsedOk = looksJson;
          if (!parsedOk && body) {
            try {
              JSON.parse(body);
              parsedOk = true;
            } catch {
              parsedOk = false;
            }
          }
          if (!parsedOk && body.trim().startsWith("<")) {
            reject(new Error(
              `Chunk ${chunkIndex} returned HTML instead of JSON — the upload reached the static SPA host, not the API server. Check VITE_API_BASE_URL on the admin deployment.`,
            ));
            return;
          }
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
    xhr.onabort = () => settle(() => { /* already rejected by stall or signal */ });

    signal.addEventListener(
      "abort",
      () => {
        xhr.abort();
        settle(() => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })));
      },
      { once: true },
    );

    xhr.open("POST", `${apiBase()}/admin/videos/upload/${sessionId}/chunk`);
    const token = getAdminToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.send(formData);
  });
}

// ─── Direct browser → S3 upload (single PUT) ─────────────────────────────────
//
// Used when the API server has been booted with valid AWS credentials. The
// admin's `s3-init` endpoint hands back a presigned PUT URL; this helper PUTs
// the file directly to S3 with the same XHR-based progress + stall watchdog
// that `uploadChunk` uses, so the modal's UI tracking code can stay shared.
//
// Returns the response ETag for optional verification at finalize time.
//
// On failure, the rejected Error carries diagnostic fields so the caller can
// decide whether to retry: `loadedBytes` (bytes the browser successfully
// pushed before the failure), `elapsedMs` (wall time from PUT open to error),
// and `kind` ("cors_or_dns" | "connection_drop" | "stall" | "http" | "abort").
// The XHR `onerror` event itself carries no detail by browser design — these
// fields reconstruct the picture from progress accounting.
export type S3UploadErrorKind =
  | "cors_or_dns"
  | "connection_drop"
  | "stall"
  | "http"
  | "abort";

export interface S3UploadError extends Error {
  kind: S3UploadErrorKind;
  loadedBytes: number;
  totalBytes: number;
  elapsedMs: number;
  httpStatus?: number;
}

export async function uploadFileToS3(
  presignedUrl: string,
  body: Blob,
  contentType: string,
  signal: AbortSignal,
  onProgress?: (bytes: number) => void,
  stallTimeoutMs = 60_000,
): Promise<{ etag: string | null }> {
  const totalBytes = body.size;
  return new Promise<{ etag: string | null }>((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();

    const buildError = (
      message: string,
      kind: S3UploadErrorKind,
      extra?: { httpStatus?: number; name?: string },
    ): S3UploadError => {
      const err = new Error(message) as S3UploadError;
      err.kind = kind;
      err.loadedBytes = lastLoaded;
      err.totalBytes = totalBytes;
      err.elapsedMs = Date.now() - startedAt;
      if (extra?.httpStatus !== undefined) err.httpStatus = extra.httpStatus;
      if (extra?.name) err.name = extra.name;
      return err;
    };

    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        if (stallTimer) clearTimeout(stallTimer);
        fn();
      }
    };

    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const resetStall = () => {
      if (settled) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        xhr.abort();
        settle(() =>
          reject(
            buildError(
              `S3 upload stalled — no bytes for ${stallTimeoutMs / 1000}s after ${formatBytesShort(lastLoaded)} of ${formatBytesShort(totalBytes)}`,
              "stall",
              { name: "StallError" },
            ),
          ),
        );
      }, stallTimeoutMs);
    };
    resetStall();

    const xhr = new XMLHttpRequest();
    let lastLoaded = 0;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.loaded > lastLoaded) {
        const delta = e.loaded - lastLoaded;
        lastLoaded = e.loaded;
        onProgress?.(delta);
        resetStall();
      }
    };

    xhr.onload = () =>
      settle(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          // S3 returns the ETag (quoted MD5 for non-multipart) in a response
          // header — capture it so finalize can verify integrity if it wants.
          const etag = xhr.getResponseHeader("ETag");
          resolve({ etag: etag ? etag.replace(/^"|"$/g, "") : null });
        } else {
          // S3 errors are XML — surface a useful prefix for debugging.
          const snippet = (xhr.responseText ?? "").slice(0, 240).trim();
          reject(
            buildError(
              `S3 upload failed (HTTP ${xhr.status}): ${snippet || xhr.statusText || "no body"}`,
              "http",
              { httpStatus: xhr.status },
            ),
          );
        }
      });

    xhr.onerror = () =>
      settle(() => {
        const elapsedMs = Date.now() - startedAt;
        // Classify: zero bytes uploaded in under ~3s strongly suggests the
        // browser was blocked before any bytes flowed — the classic signature
        // of a missing S3 bucket CORS policy (browser silently drops the
        // response) or a DNS/TLS handshake failure. Any partial progress
        // means bytes did flow and the connection later died — typically a
        // residential NAT timeout, ISP transient blip, or server reset.
        if (lastLoaded === 0 && elapsedMs < 3_000) {
          reject(
            buildError(
              `S3 PUT rejected before any bytes were sent (${elapsedMs}ms). ` +
                `This is almost always a missing bucket CORS policy on the S3 ` +
                `bucket — apply CORS allowing PUT from this admin origin and ` +
                `expose ETag, then retry.`,
              "cors_or_dns",
            ),
          );
        } else {
          reject(
            buildError(
              `S3 connection dropped after ${formatBytesShort(lastLoaded)} of ` +
                `${formatBytesShort(totalBytes)} (${Math.round(elapsedMs / 1000)}s elapsed). ` +
                `Likely a network blip or NAT timeout — retrying may succeed.`,
              "connection_drop",
            ),
          );
        }
      });
    xhr.onabort = () =>
      settle(() => { /* already rejected by stall or external signal */ });

    signal.addEventListener(
      "abort",
      () => {
        xhr.abort();
        settle(() =>
          reject(buildError("Aborted", "abort", { name: "AbortError" })),
        );
      },
      { once: true },
    );

    xhr.open("PUT", presignedUrl);
    // Content-Type MUST match the value the server signed under or S3
    // returns 403 SignatureDoesNotMatch.
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.send(body);
  });
}

// ─── Direct browser → S3 multipart upload (parallel parts) ───────────────────
//
// Why this exists
// ───────────────
// `uploadFileToS3` does a SINGLE PUT to S3, which on a 5G or fibre link is
// throughput-limited by TCP windowing and the server's per-connection cap.
// In practice a single PUT tops out at ~50–200 Mbps even on a 1 Gbps uplink.
//
// S3's multipart upload protocol fixes this: the file is split into N parts,
// each part is PUT independently (and in parallel), and finally a single
// `Complete` call assembles them server-side. With 24 parallel parts on a
// 1 Gbps link you can sustain ~800 Mbps actual throughput — i.e. the wire
// speed your network can deliver.
//
// Wire
// ────
//   1. Caller has already POSTed `s3-multipart-init` and now has:
//        { uploadId, objectKey, partSize, totalParts, contentType }
//   2. Caller passes a `signPartUrls(partNumbers)` callback that batches a
//      POST to `s3-multipart-sign` and returns presigned PUT URLs.
//   3. This function PUTs each part to its presigned URL, captures the ETag
//      from the response header, tracks progress incrementally, and returns
//      the array of `{ partNumber, etag }` ready for `s3-multipart-complete`.
//   4. On error/abort, this function rejects WITHOUT calling abort — the
//      caller owns lifecycle and decides whether to abort or retry.
//
// Memory
// ──────
// At any moment we hold up to `maxConcurrency` part-sized Blob slices in
// memory plus their FileReader buffers (the browser handles the upload
// streaming itself; we never copy the bytes into a JS-owned ArrayBuffer).
// For 64 MB × 32 parallel = ~2 GB ceiling on `ultrafast`; the
// `getAdaptiveNetworkParams` tier picker is responsible for keeping that
// number sane on low-RAM devices.

export interface S3MultipartProgress {
  /** Bytes successfully transferred since last call (delta, not cumulative). */
  delta: number;
  /** Number of parts fully completed since the upload started. */
  partsDone: number;
  /** Total parts in this upload. */
  partsTotal: number;
}

export interface S3MultipartPart {
  partNumber: number;
  etag: string;
}

export interface S3MultipartUploadOpts {
  file: Blob;
  partSize: number;
  totalParts: number;
  maxConcurrency: number;
  contentType: string;
  /** Time per-part with no upload-progress bytes before we abort that part. */
  stallTimeoutMs: number;
  /**
   * Returns presigned PUT URLs for the given part numbers. The caller is
   * expected to batch (we may call this with up to ~500 part numbers per
   * call). Implementations should retry on transient network errors.
   */
  signPartUrls: (partNumbers: number[]) => Promise<Array<{ partNumber: number; url: string }>>;
  signal: AbortSignal;
  onProgress?: (p: S3MultipartProgress) => void;
}

const PART_BATCH_SIZE = 500;             // server caps this at 1000
const PART_MAX_RETRIES = 4;              // per-part retry budget

async function putOnePart(
  url: string,
  partNumber: number,
  body: Blob,
  signal: AbortSignal,
  stallTimeoutMs: number,
  onDelta: (n: number) => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let lastLoaded = 0;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        if (stallTimer) clearTimeout(stallTimer);
        fn();
      }
    };
    const resetStall = () => {
      if (settled) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        xhr.abort();
        settle(() =>
          reject(
            Object.assign(
              new Error(
                `Part ${partNumber} stalled — no bytes for ${stallTimeoutMs / 1000}s`,
              ),
              { name: "StallError", retryable: true },
            ),
          ),
        );
      }, stallTimeoutMs);
    };
    resetStall();

    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.loaded > lastLoaded) {
        const delta = e.loaded - lastLoaded;
        lastLoaded = e.loaded;
        onDelta(delta);
        resetStall();
      }
    };
    xhr.onload = () =>
      settle(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          // S3 returns the per-part ETag in a response header. Without it we
          // cannot Complete the upload, so treat its absence as a hard error.
          const etag = xhr.getResponseHeader("ETag");
          if (!etag) {
            reject(
              Object.assign(
                new Error(
                  `Part ${partNumber}: S3 did not expose the ETag header. ` +
                    "Add ETag to the bucket CORS ExposeHeaders list and retry.",
                ),
                { retryable: false },
              ),
            );
            return;
          }
          resolve(etag.replace(/^"|"$/g, ""));
        } else {
          const snippet = (xhr.responseText ?? "").slice(0, 240).trim();
          // 5xx and 408/429 are worth retrying; 4xx (except those) are not.
          const retryable =
            xhr.status >= 500 || xhr.status === 408 || xhr.status === 429;
          reject(
            Object.assign(
              new Error(
                `Part ${partNumber} failed (HTTP ${xhr.status}): ${snippet || xhr.statusText || "no body"}`,
              ),
              { retryable },
            ),
          );
        }
      });
    xhr.onerror = () =>
      settle(() =>
        reject(
          Object.assign(
            new Error(
              `Part ${partNumber}: network error after ${lastLoaded} bytes — likely a connection drop`,
            ),
            { retryable: true },
          ),
        ),
      );
    xhr.onabort = () =>
      settle(() => {
        // External-signal abort
        if (signal.aborted) {
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        }
        // Otherwise it was a stall-timer abort which already rejected.
      });

    signal.addEventListener(
      "abort",
      () => {
        xhr.abort();
        settle(() =>
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
        );
      },
      { once: true },
    );

    xhr.open("PUT", url);
    // Content-Type does not need to be set on UploadPart — S3 ignores it on
    // individual parts and uses the value from CreateMultipartUpload.
    xhr.send(body);
  });
}

export async function uploadFileToS3Multipart(
  opts: S3MultipartUploadOpts,
): Promise<S3MultipartPart[]> {
  const {
    file, partSize, totalParts, maxConcurrency,
    stallTimeoutMs, signPartUrls, signal, onProgress,
  } = opts;

  // ── Prefetch presigned URLs in batches of PART_BATCH_SIZE ──────────────
  const allPartNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);
  const urlByPart = new Map<number, string>();
  for (let i = 0; i < allPartNumbers.length; i += PART_BATCH_SIZE) {
    if (signal.aborted) {
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    }
    const batch = allPartNumbers.slice(i, i + PART_BATCH_SIZE);
    const signed = await signPartUrls(batch);
    for (const { partNumber, url } of signed) urlByPart.set(partNumber, url);
  }
  if (urlByPart.size !== totalParts) {
    throw new Error(
      `Multipart sign returned ${urlByPart.size} URLs for ${totalParts} parts — server side issue.`,
    );
  }

  // ── Worker pool ────────────────────────────────────────────────────────
  const completed: S3MultipartPart[] = [];
  let nextIndex = 0;
  let partsDone = 0;
  let firstError: unknown = null;

  const workerCount = Math.min(maxConcurrency, totalParts);
  const workers: Promise<void>[] = [];

  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (true) {
          if (signal.aborted) {
            throw Object.assign(new Error("Aborted"), { name: "AbortError" });
          }
          if (firstError) return; // another worker crashed — short-circuit
          const idx = nextIndex++;
          if (idx >= totalParts) return; // queue drained
          const partNumber = idx + 1;
          const start = idx * partSize;
          const end = Math.min(start + partSize, file.size);
          const blob = file.slice(start, end);
          const url = urlByPart.get(partNumber);
          if (!url) {
            throw new Error(`Internal: no presigned URL for part ${partNumber}`);
          }

          let attempt = 0;
          let lastErr: unknown = null;
          while (attempt < PART_MAX_RETRIES) {
            attempt++;
            try {
              const etag = await putOnePart(
                url,
                partNumber,
                blob,
                signal,
                stallTimeoutMs,
                (delta) => onProgress?.({ delta, partsDone, partsTotal: totalParts }),
              );
              completed.push({ partNumber, etag });
              partsDone++;
              onProgress?.({ delta: 0, partsDone, partsTotal: totalParts });
              break;
            } catch (err) {
              lastErr = err;
              const e = err as Error & { retryable?: boolean; name?: string };
              if (e.name === "AbortError") throw err;
              if (e.retryable === false || attempt >= PART_MAX_RETRIES) {
                throw err;
              }
              await new Promise((r) => setTimeout(r, exponentialBackoff(attempt - 1)));
            }
          }
          if (attempt >= PART_MAX_RETRIES && completed.findIndex(p => p.partNumber === partNumber) === -1) {
            throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
          }
        }
      })().catch((err) => {
        if (!firstError) firstError = err;
      }),
    );
  }

  await Promise.all(workers);
  if (firstError) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }
  if (completed.length !== totalParts) {
    throw new Error(
      `Multipart upload finished ${completed.length}/${totalParts} parts — internal error.`,
    );
  }
  return completed;
}

function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────
export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatSpeed(bps: number): string {
  if (bps >= 1024 * 1024 * 1024) return `${(bps / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${(bps / 1024).toFixed(0)} KB/s`;
}

export function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function networkTypeLabel(type: string, tier?: NetworkTier): string {
  // Prioritise tier label for precise display
  if (tier === "ultrafast") return "5G Ultra";
  if (tier === "5g") return "5G";
  if (tier === "fast") return "Wi-Fi / 4G+";
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
