import { getAdminToken } from "@/lib/admin-access";
import { safeJson, describeJsonError } from "@/lib/safe-json";

const BASE = (() => {
  const b = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/\/admin\/?$/, "");
  return `${b}/api`;
})();

export class AdminApiError extends Error {
  // `transient` marks failures that are likely to succeed on a retry — network
  // unreachable, gateway timeouts (502/503/504), and the "/api/* fell through
  // to the SPA" case where the proxy returned HTML instead of JSON. The most
  // common real-world cause is the api-server being mid-restart while the
  // admin SPA tries to fetch (the dev workflow runs `build && start`, leaving
  // a ~1-2s window when port 8080 is refusing connections). The retry wrapper
  // below uses this flag to silently recover from those races on idempotent
  // requests; the operator only sees an error if BOTH attempts fail.
  public readonly transient: boolean;
  constructor(
    public status: number,
    message: string,
    options?: { transient?: boolean },
  ) {
    super(message);
    this.name = "AdminApiError";
    this.transient = options?.transient ?? false;
  }
}

// Internal: performs a single HTTP attempt and returns a parsed result or
// throws an AdminApiError tagged with `transient` when appropriate. Kept
// separate from the public adminRequest wrapper so the retry logic stays
// readable.
async function doAdminRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const token = getAdminToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (networkErr) {
    // fetch only rejects on network failure, abort, or CORS. Distinguish
    // them so the operator sees "API server unreachable" rather than the
    // generic "Failed to fetch" the browser raises.
    // Honor cancellation regardless of whether the runtime materializes it as
    // DOMException (browsers) or a plain Error with .name === "AbortError"
    // (some polyfills / SSR shims) — consumers like React Query rely on this
    // to distinguish abort from genuine failure.
    if (
      (networkErr instanceof DOMException && networkErr.name === "AbortError") ||
      (networkErr instanceof Error && networkErr.name === "AbortError")
    ) {
      throw networkErr;
    }
    const detail = networkErr instanceof Error ? networkErr.message : String(networkErr);
    throw new AdminApiError(
      0,
      `API server unreachable at ${BASE}${path} (${detail}). Check that the API workflow is running.`,
      { transient: true },
    );
  }

  if (!res.ok) {
    // Try to extract a structured error message. We use safeJson here too so
    // that an HTML 500 page from a proxy doesn't get reported as the literal
    // status text — operators want to know why the proxy failed, not just
    // "Internal Server Error".
    let message = res.statusText || `HTTP ${res.status}`;
    let isHtmlFallback = false;
    const parsed = await safeJson<{ error?: string; message?: string }>(res, `admin-api:${path}`);
    if (parsed.ok) {
      if (typeof parsed.data?.error === "string" && parsed.data.error) message = parsed.data.error;
      else if (typeof parsed.data?.message === "string" && parsed.data.message) message = parsed.data.message;
    } else if (parsed.reason === "html_fallback") {
      message = `${message} — server returned HTML (proxy may be routing /api to the SPA).`;
      isHtmlFallback = true;
    } else if (parsed.reason !== "empty") {
      // Non-JSON error body with content. Surface the content-type so the
      // operator can see the source.
      message = `${message} (non-JSON ${parsed.contentType})`;
    }
    // Gateway/proxy failures and the SPA-fallback case are likely transient
    // (api-server restart in progress, brief proxy hiccup). Real 4xx and 5xx
    // application errors with a structured JSON body are NOT marked transient
    // because retrying them would just hide a real bug.
    const transient =
      isHtmlFallback ||
      res.status === 502 ||
      res.status === 503 ||
      res.status === 504;
    throw new AdminApiError(res.status, message, { transient });
  }

  // 204 No Content / empty success body. Differentiate from the parse path.
  if (res.status === 204) return undefined as T;

  const parsed = await safeJson<T>(res, `admin-api:${path}`);
  if (parsed.ok) return parsed.data;
  if (parsed.reason === "empty") return undefined as T; // legacy: pre-existing pages treat empty 200 as undefined
  // A 200 response with an HTML body almost always means the proxy fell
  // through to the SPA (the api-server was momentarily unreachable, so
  // either vite or the workspace router served index.html). Mark transient
  // so the wrapper can retry.
  const transient = parsed.reason === "html_fallback";
  throw new AdminApiError(res.status, describeJsonError(`API ${path}`, parsed), { transient });
}

// Sleep that honors an AbortSignal. Resolves after `ms` if the signal stays
// quiet; rejects with a fresh AbortError the moment the signal fires (NOT the
// caller's underlying error — consumers like React Query branch on
// err.name === "AbortError" to distinguish cancellation from genuine failure).
function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Backoff schedule (ms) for retrying transient failures on idempotent requests.
// Sized to span the api-server's full dev-mode restart window: the workflow
// runs `pnpm run build && pnpm run start`, where the esbuild step alone takes
// ~600ms and the node startup adds another ~200-500ms before the port accepts
// connections. A single 800ms retry (Round 4k initial) was empirically too
// short — operators still saw the html_fallback diagnostic mid-restart on
// pages they navigated to during that window. With these two delays the worst
// case is ~2.0s of waiting before surfacing the error, which comfortably
// covers a clean restart but still feels like normal page-load latency.
// Tuning this requires no schema or dependency changes.
const RETRY_BACKOFF_MS = [500, 1500] as const;

// HTML-fallback detector for the response-level retry path. Same regex as
// safe-json.ts uses; duplicated here (3 lines) to avoid an import cycle and
// to keep the response-classification logic self-contained.
const FETCH_RETRY_HTML_RE = /^\s*<(?:!doctype\s+html|html\b|head\b|body\b)/i;
const FETCH_RETRY_JSON_CT = /\bapplication\/(?:[\w.+-]*\+)?json\b/i;

/**
 * Wrap a fetch-returning factory with the same one-shot-then-backoff retry
 * policy used by adminRequest. Intended for the small number of pages that
 * still use raw fetch (broadcast.tsx, videos.tsx, live-monitor.tsx,
 * command-palette.tsx) and therefore bypass the central client's retry.
 *
 * Retries on:
 *   - factory throwing (network error / fetch reject), excluding AbortError.
 *   - HTTP 502 / 503 / 504 from the workspace proxy.
 *   - HTTP 200 with an HTML body — the SPA-fallthrough case that occurs
 *     during the api-server restart window.
 *
 * Does NOT retry:
 *   - AbortError at any layer (caller cancellation is honored immediately).
 *   - Real 4xx and 5xx responses with JSON or other non-HTML bodies — those
 *     are application errors that should surface, not be hidden by a retry.
 *
 * The caller MUST treat this as suitable only for idempotent requests
 * (GET/HEAD). Mutating requests should call fetch directly.
 *
 * To detect the HTML body case we have to peek the body, which would consume
 * the stream. We use Response.clone() so the caller still receives a Response
 * with an unread body and existing safeJson() consumers keep working.
 */
export async function fetchWithTransientRetry(
  factory: () => Promise<Response>,
  signal?: AbortSignal,
): Promise<Response> {
  let lastErr: unknown;
  const maxAttempts = 1 + RETRY_BACKOFF_MS.length;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response | null = null;
    try {
      res = await factory();
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err;
      if (
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        throw err;
      }
      const isLastAttempt = attempt >= maxAttempts - 1;
      if (isLastAttempt) throw err;
      await delayWithAbort(RETRY_BACKOFF_MS[attempt], signal);
      continue;
    }

    // Gateway / proxy failure → retry.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      const isLastAttempt = attempt >= maxAttempts - 1;
      if (isLastAttempt) return res;
      await delayWithAbort(RETRY_BACKOFF_MS[attempt], signal);
      continue;
    }

    // SPA-fallthrough detection: 2xx response whose body is HTML. Skip the
    // body read entirely if the server explicitly claims JSON (the common
    // case) — saves a clone+text per request in the success path.
    const ctype = res.headers.get("content-type") ?? "";
    const explicitlyJson = FETCH_RETRY_JSON_CT.test(ctype);
    if (res.ok && !explicitlyJson) {
      let bodySnippet: string | null = null;
      try {
        // 128-char window is large enough to skip past leading whitespace, a
        // BOM, or a leading HTML comment before <!doctype html> while still
        // being cheap. (Round 4l initial used 32 chars; code review flagged
        // false-negative risk on uncommon prefixes.)
        bodySnippet = (await res.clone().text()).slice(0, 128);
      } catch {
        // If the body can't be cloned (already consumed by a Response polyfill
        // edge case), skip the HTML check rather than fail the request.
        bodySnippet = null;
      }
      if (bodySnippet !== null && FETCH_RETRY_HTML_RE.test(bodySnippet)) {
        const isLastAttempt = attempt >= maxAttempts - 1;
        if (isLastAttempt) return res;
        await delayWithAbort(RETRY_BACKOFF_MS[attempt], signal);
        continue;
      }
    }

    return res;
  }
  // Loop exits via return on success or throw on terminal failure; this
  // re-throw is reachable only if maxAttempts is 0, which we don't allow.
  throw lastErr ?? new Error("fetchWithTransientRetry exhausted attempts");
}

async function adminRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  // Idempotent reads can be safely retried on transient failure. Mutating
  // methods (POST/PUT/PATCH/DELETE) are NEVER retried because retry-on-failure
  // can produce double-creates, double-deletes, or out-of-order updates if the
  // first request actually reached the server but the response was lost.
  const isIdempotent = method === "GET" || method === "HEAD";
  let lastErr: unknown;
  // Total attempts = 1 + RETRY_BACKOFF_MS.length. For mutating methods we
  // collapse the loop to a single attempt by ignoring the backoff schedule.
  const maxAttempts = isIdempotent ? 1 + RETRY_BACKOFF_MS.length : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await doAdminRequest<T>(method, path, body, signal);
    } catch (err) {
      lastErr = err;
      if (!isIdempotent) throw err;
      if (signal?.aborted) throw err;
      // Only retry tagged-transient AdminApiErrors. AbortError (DOMException)
      // and any other surprise error type fail through immediately.
      if (!(err instanceof AdminApiError) || !err.transient) throw err;
      const isLastAttempt = attempt >= maxAttempts - 1;
      if (isLastAttempt) throw err;
      // Wait before the next attempt; abort during the wait surfaces
      // immediately as a clean cancellation (not a retried failure).
      await delayWithAbort(RETRY_BACKOFF_MS[attempt], signal);
    }
  }
  // Unreachable: the loop either returns a value or throws. Re-throw the last
  // captured error to satisfy the type checker without using a non-null
  // assertion that would mask a real "no attempts ran" bug.
  throw lastErr ?? new AdminApiError(0, `adminRequest exhausted attempts for ${method} ${path}`);
}

export const adminGet = <T>(path: string, signal?: AbortSignal) =>
  adminRequest<T>("GET", path, undefined, signal);

export const adminPost = <T>(path: string, body?: unknown) =>
  adminRequest<T>("POST", path, body);

export const adminPut = <T>(path: string, body?: unknown) =>
  adminRequest<T>("PUT", path, body);

export const adminPatch = <T>(path: string, body?: unknown) =>
  adminRequest<T>("PATCH", path, body);

export const adminDelete = <T>(path: string) =>
  adminRequest<T>("DELETE", path);

export interface LiveOverride {
  id: string;
  title: string;
  isActive: boolean;
  hlsStreamUrl: string | null;
  rtmpIngestKey: string | null;
  streamNotes: string | null;
  startedAt: string;
  endsAt: string | null;
}

export interface OpsStatus {
  generatedAt: string;
  environment: string;
  overallStatus: "ok" | "degraded" | "critical";
  checks: Array<{ key: string; label: string; status: "ok" | "degraded" | "critical" }>;
  metrics: {
    uptimeSecs: number;
    activeRequests: number;
    requests: Array<{ method: string; total: number; errors: number; averageMs: number }>;
  };
  cache: {
    redis: { configured: boolean; connected: boolean };
    memory: { active: boolean };
  };
  database: {
    connected: boolean;
    counts: {
      videos: number;
      localVideos: number;
      playlists: number;
      activeScheduleEntries: number;
      registeredDevices: number;
    };
  };
  broadcast: {
    activeQueueItems: number;
    inactiveQueueItems: number;
    activeLiveOverrides: number;
    connectedAdminClients: number;
  };
  videoPipeline: {
    processing: number;
    queued: number;
    done: number;
    failed: number;
    cancelled: number;
    uploadBytes: number;
    hlsBytes: number;
  };
  uploadSessions: {
    active: number;
  };
  storage?: {
    diskUsedMb: number;
    diskTotalMb: number;
  };
}

export interface TranscodingJob {
  id: string;
  videoId: string;
  videoTitle: string;
  videoThumbnail: string;
  status: "queued" | "processing" | "done" | "failed" | "cancelled";
  priority: number;
  progress: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface TranscodingQueue {
  jobs: TranscodingJob[];
  stats: {
    activeCount: number;
    queuedCount: number;
    completedToday: number;
    failedToday: number;
  };
}

export interface LiveMonitorData {
  current: {
    isLive: boolean;
    videoId: string | null;
    title: string | null;
    checkedAt: number;
    staleSec: number;
    detectionMethod?: string;
    uptimeSecs: number;
    liveSessionStartedAt: number | null;
    viewerCount: number | null;
  };
  polling: {
    intervalMs: number;
    mode: "normal" | "burst";
    lastStateChangeAt: number;
  };
  history: Array<{
    ts: number;
    isLive: boolean;
    videoId: string | null;
    title: string | null;
    method: string | null;
  }>;
  viewerHistory: Array<{ ts: number; count: number }>;
}

export const liveApi = {
  getOverrides: () => adminGet<LiveOverride[]>("/admin/live-overrides"),
  startOverride: (data: {
    title: string;
    hlsStreamUrl?: string;
    rtmpIngestKey?: string;
    streamNotes?: string;
    durationMinutes?: number;
    notify?: boolean;
  }) => adminPost<{ override: LiveOverride; push: { sent: number } }>("/admin/live/override/start", data),
  stopOverride: () => adminPost<void>("/admin/live/override/stop"),
  extendOverride: (extraMinutes: number) =>
    adminPost<{ ok: boolean; override: LiveOverride }>("/admin/live/override/extend", { extraMinutes }),
  getMonitor: (signal?: AbortSignal) => adminGet<LiveMonitorData>("/admin/live/monitor", signal),
  getStatus: (signal?: AbortSignal) => adminGet<{
    isLive: boolean;
    ytLive: boolean;
    liveOverride: LiveOverride | null;
    viewerCount: number;
  }>("/admin/live", signal),
};

export const opsApi = {
  getStatus: (signal?: AbortSignal) => adminGet<OpsStatus>("/admin/ops/status", signal),
};

export interface ActiveUploadSession {
  sessionId: string;
  title: string;
  originalFilename: string | null;
  category: string;
  totalBytes: number;
  receivedBytes: number;
  totalChunks: number;
  uploadedChunks: number;
  progressPercent: number;
  ageSecs: number;
  idleSecs: number;
  finalizing: boolean;
  createdAt: string;
  lastActivity: string;
}

export const uploadsApi = {
  listActive: (signal?: AbortSignal) =>
    adminGet<{ count: number; sessions: ActiveUploadSession[] }>(
      "/admin/uploads/active",
      signal,
    ),
  cancel: (sessionId: string) =>
    adminDelete<{ ok: true }>(`/admin/videos/upload/${sessionId}`),
};

export interface TranscodingJobDetail extends TranscodingJob {
  outputDir?: string | null;
  inputPath?: string | null;
  attempts?: number;
  updatedAt?: string;
}

export const transcodingApi = {
  getQueue: (signal?: AbortSignal) => adminGet<TranscodingQueue>("/admin/transcoding/queue", signal),
  getJob: (jobId: string, signal?: AbortSignal) =>
    adminGet<TranscodingJobDetail>(`/admin/transcoding/jobs/${jobId}`, signal),
  retryJob: (id: string) => adminPost<void>(`/admin/transcoding/retry/${id}`),
  cancelJob: (id: string) => adminDelete<void>(`/admin/transcoding/${id}`),
  requeue: (videoId: string, priority?: number) =>
    adminPost<{ jobId: string }>(`/admin/transcoding/requeue/${videoId}`, priority !== undefined ? { priority } : undefined),
  clearHistory: (status: "done" | "failed" | "cancelled" | "all") =>
    adminDelete<{ cleared: number }>(`/admin/transcoding/clear?status=${status}`),
};
