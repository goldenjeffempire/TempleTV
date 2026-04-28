import { getAdminToken } from "@/lib/admin-access";
import { safeJson, describeJsonError } from "@/lib/safe-json";
import { apiBase } from "@/lib/api-base";
import {
  reportApiDegraded,
  reportApiHealthy,
} from "@/contexts/ApiHealthContext";

// Resolved at module load. The api-base helper honors VITE_API_BASE_URL when
// the SPA and API live on different origins (split-domain production); falls
// back to a same-origin relative path otherwise.
const BASE = apiBase();

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
      // Admin endpoints are real-time operational data (status panels, queues,
      // device counts, telemetry). Bypass the browser HTTP cache entirely so a
      // stale heuristically-cached response cannot make a recovered subsystem
      // appear "degraded" or vice-versa. Polling intervals are short (5–15s)
      // so the bandwidth cost is negligible compared to operator confusion.
      cache: "no-store",
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
    // Notify the global health monitor so the reconnection banner can show
    // and start polling /api/healthz independently. Fire-and-forget — this
    // can't throw and never blocks the caller.
    reportApiDegraded(path, detail);
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
// short, and the [500, 1500] schedule (Round 4l initial, ~2.0s wait budget)
// was right at the edge — an operator still saw the html_fallback diagnostic
// on the live-monitor page when they happened to load it at the start of a
// restart cycle. The [500, 1500, 3000] schedule gives ~5.0s wait budget
// across 4 attempts, which comfortably covers even slow restarts (typical
// build+start under load can spike to 3-4s) without making the page feel
// stuck — a successful response on the second or third attempt still lands
// in <2.5s, indistinguishable from a slow load. Tuning this requires no
// schema or dependency changes.
const RETRY_BACKOFF_MS = [500, 1500, 3000] as const;

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
      const result = await doAdminRequest<T>(method, path, body, signal);
      // Any successful round-trip means the API is reachable. Notify the
      // global health monitor so it can clear a degraded banner immediately
      // instead of waiting for its next scheduled /api/healthz probe.
      reportApiHealthy();
      return result;
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

/**
 * One scheduled (not-yet-aired) live override returned from the
 * `/admin/live/override/scheduled` list. Powers the "Up next" panel
 * in Live Control.
 */
export interface ScheduledOverride {
  id: string;
  title: string;
  youtubeVideoId: string | null;
  hlsStreamUrl: string | null;
  scheduledFor: string;
  endsAt: string | null;
  streamNotes: string | null;
}

export interface LiveOverride {
  id: string;
  title: string;
  isActive: boolean;
  hlsStreamUrl: string | null;
  /**
   * 11-character YouTube video ID. When set, viewer surfaces switch to a
   * YouTube embed instead of HLS — admins enable this by pasting a YouTube
   * live URL into Live Control.
   */
  youtubeVideoId: string | null;
  rtmpIngestKey: string | null;
  streamNotes: string | null;
  startedAt: string;
  endsAt: string | null;
}

/**
 * One row from the "recently broadcast YouTube streams" dropdown that
 * lets admins re-fire a recurring service with a single click. Built
 * server-side from the `live_overrides` history, deduped by video ID.
 */
export interface RecentYoutubeStream {
  videoId: string;
  url: string;
  title: string;
  thumbnailUrl: string;
  lastBroadcastAt: string | null;
}

/**
 * Result of the YouTube URL preview probe. The admin uses this to confirm
 * the URL resolves to a real, public, currently-live video before going
 * live across every viewer surface.
 */
export interface YouTubePreviewResult {
  ok: boolean;
  videoId?: string;
  exists?: boolean;
  isLive?: boolean;
  title?: string | null;
  thumbnailUrl?: string | null;
  reason?: string | null;
  method?: "oembed" | "live-page" | "none";
  /** Surfaces server-side validation errors (e.g. malformed URL). */
  error?: string;
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
    backend: "redis" | "postgresql" | "memory";
    redis: { configured: boolean; connected: boolean };
    postgresql: { configured: boolean; connected: boolean };
    memory: { active: boolean };
  };
  infrastructure: {
    objectStorage: {
      provider: string;
      configured: boolean;
      bucket: string | null;
      region: string | null;
      publicSearchPaths: string | null;
      privateDir: string | null;
    };
    cache: {
      backend: "redis" | "postgresql" | "memory";
      redis: { configured: boolean; connected: boolean };
      postgresql: { configured: boolean; connected: boolean };
    };
    transcoder: {
      ffmpegReady: boolean;
      cloudUploadEnabled: boolean;
      pendingJobs: number;
    };
    signedUrlCache?: {
      startedAt: string;
      uptimeSecs: number;
      total: { fresh: number; cached: number; hits: number; hitRate: number };
      bySource: Record<
        "s3-redirect-first" | "s3-redirect",
        { fresh: number; cached: number; hits: number; hitRate: number }
      >;
    };
    broadcastBuildLatency?: {
      startedAt: string;
      uptimeSecs: number;
      cold: { samples: number; total: number; p50: number; p95: number; p99: number; max: number };
      hot: { samples: number; total: number; p50: number; p95: number; p99: number; max: number };
    };
    /**
     * Cross-instance SSE bus (Redis pub/sub bridge) health. `health` is:
     *   - "off"      → REDIS_URL not set; single-instance fanout only.
     *                  This is the supported default, NOT an error.
     *   - "ok"       → bus enabled and both Redis clients are ready.
     *   - "degraded" → bus enabled but mid-(re)connect; local fanout
     *                  unaffected, self-heals when Redis comes back.
     * Optional because older deployments of the api-server (pre-Round 18)
     * don't include this field; the UI must treat absence as "off".
     */
    sseBus?: SSEBusStatus;
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

export interface ProcessStatus {
  thisProcess: {
    pid: number;
    runMode: string;
    role: "api" | "worker";
    uptimeSec: number;
    rssMb: number;
    heapUsedMb: number;
    nodeVersion: string;
  };
  transcoder: {
    queue: { queued: number; processing: number; failed: number; done: number };
    heartbeat:
      | {
          pid: number;
          ageSec: number;
          runMode: string;
          nodeVersion: string;
          rssMb: number;
          sameProcess: boolean;
          uptimeSec: number | null;
          guardrailPassed: boolean | null;
        }
      | null;
    alive: boolean;
    lastJob: {
      id: string;
      videoId: string;
      videoTitle: string | null;
      status: "done" | "failed";
      completedAt: string | null;
      endedAgoSec: number | null;
      durationMs: number | null;
      errorMessage: string | null;
    } | null;
  };
  infrastructure: {
    s3: { configured: boolean; bucket: string | null; region: string | null };
    cache: unknown;
  };
}

export const processApi = {
  getStatus: (signal?: AbortSignal) =>
    adminGet<ProcessStatus>("/admin/process-status", signal),
};

// ── Render deploy health ────────────────────────────────────────────────────
// Mirrors the response shape of GET /api/admin/render-deploy-health (see
// api-server/src/routes/admin.ts). Used by the Mission Control panel to
// surface API + worker liveness, recent fatal log lines, and Render deploy
// metadata so operators don't have to open Render Logs to spot a crashloop.
export interface RenderDeployHealth {
  api: {
    runMode: string;
    pid: number;
    lifecycle: {
      phase: "starting" | "ready" | "draining";
      startedAt: string;
      readyAt: string | null;
      drainingAt: string | null;
      uptimeSec: number;
    };
    healthzStatus: 200 | 503;
    rssMb: number;
    nodeVersion: string;
  };
  worker: {
    probeKind: "heartbeat";
    alive: boolean;
    sameProcess: boolean;
    heartbeat:
      | {
          pid: number;
          ageSec: number;
          runMode: string;
          nodeVersion: string;
          rssMb: number;
          uptimeSec: number | null;
          guardrailPassed: boolean | null;
        }
      | null;
  };
  fatals: Array<{
    ts: string;
    ageSec: number;
    role: string;
    pid: number;
    msg: string;
    err: string | null;
    stack: string | null;
  }>;
  deploy: {
    commit: string | null;
    commitShort: string | null;
    branch: string | null;
    serviceName: string | null;
    serviceId: string | null;
    instanceId: string | null;
    nodeEnv: string;
  };
  sentry: { configured: boolean };
}

export const renderDeployHealthApi = {
  get: (signal?: AbortSignal) =>
    adminGet<RenderDeployHealth>("/admin/render-deploy-health", signal),
};

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
    /** Paste a YouTube live URL — server extracts & validates the video ID. */
    youtubeUrl?: string;
    rtmpIngestKey?: string;
    streamNotes?: string;
    durationMinutes?: number;
    notify?: boolean;
    /** Emergency: skip the YouTube live-stream probe (URL shape still validated). */
    skipYoutubeValidation?: boolean;
  }) => adminPost<{ override: LiveOverride; push: { sent: number }; youtubeProbeWarning?: string | null }>(
    "/admin/live/override/start",
    data,
  ),
  stopOverride: () => adminPost<void>("/admin/live/override/stop"),
  extendOverride: (extraMinutes: number) =>
    adminPost<{ ok: boolean; override: LiveOverride }>("/admin/live/override/extend", { extraMinutes }),
  /**
   * Validates a pasted YouTube URL without touching the DB. Returns the
   * resolved video ID, whether it's currently live, and a thumbnail URL.
   */
  previewYoutube: (url: string) =>
    adminPost<YouTubePreviewResult>("/admin/live/override/preview-youtube", { url }),
  /**
   * Distinct most-recently-broadcast YouTube streams from history. Used
   * by the "Re-broadcast recent stream" dropdown so admins can re-fire
   * a recurring service without re-typing the URL.
   */
  getRecentYoutubeStreams: () =>
    adminGet<{ items: RecentYoutubeStream[] }>("/admin/live-overrides/recent-youtube"),
  /**
   * Queue a YouTube (or HLS) stream to auto-go-live at a future time.
   * The server-side scheduler picks it up at tick time and fires the
   * same SSE events as a manual Go Live.
   */
  schedule: (data: {
    title: string;
    youtubeUrl?: string;
    hlsStreamUrl?: string;
    streamNotes?: string;
    /** ISO timestamp — when to auto-go-live. Must be in the future. */
    scheduledFor: string;
    durationMinutes?: number;
    skipYoutubeValidation?: boolean;
  }) => adminPost<{ override: ScheduledOverride; youtubeProbeWarning?: string | null }>(
    "/admin/live/override/schedule",
    data,
  ),
  getScheduled: () =>
    adminGet<{ items: ScheduledOverride[] }>("/admin/live/override/scheduled"),
  cancelScheduled: (id: string) =>
    adminDelete<{ ok: boolean; id: string }>(`/admin/live/override/schedule/${encodeURIComponent(id)}`),
  getMonitor: (signal?: AbortSignal) => adminGet<LiveMonitorData>("/admin/live/monitor", signal),
  getStatus: (signal?: AbortSignal) => adminGet<{
    isLive: boolean;
    ytLive: boolean;
    liveOverride: LiveOverride | null;
    viewerCount: number;
    failureStats?: LiveFailureStats;
  }>("/admin/live", signal),
};

/**
 * Aggregated viewer-side YouTube live embed failure telemetry.
 * Surfaces "N viewers reported the live stream failed" on the Live Control
 * page so admins can spot platform-wide YouTube problems vs. one-off device
 * issues. Backed by `artifacts/api-server/src/lib/liveFailureReports.ts`.
 */
export interface LiveFailureStats {
  videoId: string | null;
  deviceCount: number;
  totalReports: number;
  surfaces: {
    "tv-hero"?: number;
    "tv-player"?: number;
    "mobile-hero"?: number;
    "mobile-player"?: number;
    unknown?: number;
  };
  ipCount: number;
  mostRecentAt: number | null;
  windowMs: number;
}

export const opsApi = {
  getStatus: (signal?: AbortSignal) => adminGet<OpsStatus>("/admin/ops/status", signal),
};

/**
 * Cross-instance SSE bus (Redis pub/sub bridge) status. Returned both by
 * the dedicated `/admin/sse-bus` endpoint AND inlined into `OpsStatus
 * .infrastructure.sseBus` so the operations page renders a single tile
 * without a second polling cycle. The dedicated endpoint exists for direct
 * curl/debug access and to leave room for a future detail page.
 *
 * `health: "off"` is a NORMAL state (single-instance deploys without
 * REDIS_URL) — render it as a neutral badge, NOT amber/red.
 */
export interface SSEBusStatus {
  health: "off" | "ok" | "degraded";
  summary: string;
  enabled: boolean;
  connected: boolean;
  channel: string;
  instanceId: string;
  uptimeSec: number;
  publishesSent: number;
  publishesFailed: number;
  publishesSkippedDisconnected: number;
  framesReceived: number;
  framesDroppedSelf: number;
  framesDroppedMalformed: number;
  reconnects: number;
  /** Unix ms; 0 means "never". */
  lastPublishErrorAt: number;
  lastPublishErrorMsg: string;
  /** Unix ms; 0 means "never". */
  lastReceiveErrorAt: number;
  lastReceiveErrorMsg: string;
  /**
   * Server-maintained rolling 5-minute window of per-minute publish/receive
   * rates, sampled every 10s by the bus module. Empty when the bus is
   * disabled or has just started (needs >=10s of uptime before the first
   * sample appears). Used by the SSE bus detail page sparkline so the
   * chart is populated on first paint instead of starting empty.
   *
   * Optional for backward compatibility with older api-server builds (and
   * with the catch-handler path in /admin/ops/status which doesn't set it).
   */
  recentRates?: Array<{ at: number; pubPerMin: number; recvPerMin: number }>;
}

export const sseBusApi = {
  getStatus: (signal?: AbortSignal) =>
    adminGet<SSEBusStatus>("/admin/sse-bus", signal),
};

export interface SlowRequestEntry {
  method: string;
  /** Path with high-cardinality segments collapsed to `:id`. */
  path: string;
  /** Original URL (path only, query stripped) before normalization. */
  rawPath: string;
  statusCode: number;
  durationMs: number;
  /** ISO timestamp of when the request started. */
  at: string;
  requestId: string | null;
}

export interface SlowRouteStats {
  method: string;
  path: string;
  total: number;
  errors: number;
  slowCount: number;
  averageMs: number;
  maxMs: number;
  lastStatus: number;
  /** ms since epoch — when this route was last touched. */
  lastAt: number;
}

export interface SlowRequestsSnapshot {
  thresholdMs: number;
  bufferSize: number;
  bufferMaxAgeMs: number;
  capturedCount: number;
  entries: SlowRequestEntry[];
  routes: SlowRouteStats[];
}

export const slowRequestsApi = {
  get: (signal?: AbortSignal) =>
    adminGet<SlowRequestsSnapshot>("/admin/ops/slow-requests", signal),
};

export interface MemoryWatchdogState {
  enabled: boolean;
  sampleIntervalMs: number;
  thresholds: {
    rssAlertMb: number;
    rssRecoveryMb: number;
    externalGrowthAlertMbPerMin: number;
    externalGrowthRecoveryMbPerMin: number;
    sustainSamples: number;
    slopeWindowSamples: number;
  };
  current: {
    externalGrowthMbPerMin: number | null;
    consecutiveRssOver: number;
    consecutiveSlopeOver: number;
  };
  alerts: {
    rssAlertActive: boolean;
    slopeAlertActive: boolean;
  };
}

export interface MemoryDiagnostics {
  generatedAt: string;
  uptimeSecs: number;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    externalMb: number;
    arrayBuffersMb: number;
  };
  caches: { name: string; size: number }[];
  watchdog: MemoryWatchdogState;
}

export interface ForceGcResult {
  ok: true;
  elapsedMs: number;
  before: { rssMb: number; heapUsedMb: number; externalMb: number; arrayBuffersMb: number };
  after: { rssMb: number; heapUsedMb: number; externalMb: number; arrayBuffersMb: number };
  reclaimedMb: { rss: number; heapUsed: number; external: number; arrayBuffers: number };
}

/**
 * Force a synchronous GC cycle on the server. Throws `AdminApiError` for
 * non-2xx responses — the caller should `catch` and inspect `err.status` /
 * `err.message`: 501 = process not started with `--expose-gc`, 429 =
 * cooldown not yet elapsed, 5xx = the GC call itself threw.
 */
export interface HeapSnapshotResult {
  filename: string;
  bytes: number;
  elapsedMs: number;
}

/**
 * Download a heap snapshot to disk. Uses streaming `Blob` so even
 * hundred-MiB snapshots from a leaking process don't OOM the browser tab,
 * and triggers a same-origin synthetic-anchor download with a meaningful
 * filename so the operator can drag it straight into Chrome DevTools'
 * Memory tab. Throws `AdminApiError` on non-2xx (rate-limit etc.).
 */
async function downloadHeapSnapshot(
  onProgress?: (bytes: number) => void,
): Promise<HeapSnapshotResult> {
  const t0 = performance.now();
  const token = getAdminToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/admin/diagnostics/heap-snapshot`, {
    method: "POST",
    headers,
    cache: "no-store",
  });
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const parsed = (await res.json()) as { message?: string; error?: string };
      message = parsed.message || parsed.error || message;
    } catch {
      // body wasn't JSON; surface the status text
    }
    throw new AdminApiError(res.status, message);
  }
  const filename =
    res.headers.get("X-Snapshot-Filename") ??
    `heap-${new Date().toISOString().replace(/[:.]/g, "-")}.heapsnapshot`;

  // Stream into chunks so we can report progress and also so the browser
  // never has the snapshot in two places at once (Blob + memory).
  if (!res.body) throw new AdminApiError(0, "Response body missing");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      bytes += value.byteLength;
      onProgress?.(bytes);
    }
  }
  // Use a plain array to allow Blob constructor to do its own copy; safer
  // than juggling ArrayBuffer offsets across chunks of varying sizes. The
  // explicit `BlobPart[]` cast satisfies the strict TS types — fetch's
  // ReadableStream typings declare `Uint8Array<ArrayBufferLike>` (which
  // could in theory be a SharedArrayBuffer), but in practice every browser
  // returns plain ArrayBuffer-backed chunks here and Blob accepts them.
  const blob = new Blob(chunks as unknown as BlobPart[], {
    type: "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Object URL keeps the blob alive in browser memory until revoked —
    // critical to release for a hundred-MiB snapshot. Defer one tick so
    // the synthetic click has a chance to start the download dialog.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  return { filename, bytes, elapsedMs: Math.round(performance.now() - t0) };
}

export const memoryDiagnosticsApi = {
  get: (signal?: AbortSignal) =>
    adminGet<MemoryDiagnostics>("/admin/diagnostics/memory", signal),
  forceGc: (): Promise<ForceGcResult> =>
    adminPost<ForceGcResult>("/admin/diagnostics/gc"),
  downloadHeapSnapshot,
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

export interface S3TelemetrySummary {
  windowHours: number;
  since: string;
  counts: Record<string, number>;
  attempts: number;
  successes: number;
  failures: number;
  successRatePct: number | null;
  throughput: {
    p50Bps: number | null;
    p95Bps: number | null;
    avgSizeBytes: number | null;
    totalBytes: number | null;
  };
  topErrors: Array<{
    errorKind: string | null;
    errorMessage: string | null;
    count: number;
  }>;
}

export const uploadsApi = {
  listActive: (signal?: AbortSignal) =>
    adminGet<{ count: number; sessions: ActiveUploadSession[] }>(
      "/admin/uploads/active",
      signal,
    ),
  cancel: (sessionId: string) =>
    adminDelete<{ ok: true }>(`/admin/videos/upload/${sessionId}`),
  s3TelemetrySummary: (hours: number, signal?: AbortSignal) =>
    adminGet<S3TelemetrySummary>(
      `/admin/uploads/s3-telemetry/summary?hours=${encodeURIComponent(String(hours))}`,
      signal,
    ),
};

export interface TranscodingJobDetail extends TranscodingJob {
  outputDir?: string | null;
  inputPath?: string | null;
  attempts?: number;
  updatedAt?: string;
}

// ===========================================================================
// Live Ingest — Broadcast Operations Center
// ===========================================================================

export type LiveIngestProtocol = "rtmp" | "rtmps" | "srt" | "hls" | "whip";
export type LiveIngestHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface LiveIngestEndpoint {
  id: string;
  name: string;
  protocol: LiveIngestProtocol | string;
  ingestUrl: string;
  streamKey: string;
  hlsPlaybackUrl: string;
  fallbackYoutubeUrl: string | null;
  isPrimary: boolean;
  isActive: boolean;
  priority: number;
  notes: string | null;
  healthStatus: LiveIngestHealthStatus | string;
  lastHealthAt: string | null;
  lastHealthyAt: string | null;
  consecutiveFailures: number;
  lastBitrateKbps: number | null;
  lastSegmentLatencyMs: number | null;
  droppedFramesPct: number | null;
  lastError: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface LiveIngestEndpointList {
  endpoints: LiveIngestEndpoint[];
  summary: {
    total: number;
    active: number;
    primary: string | null;
    healthy: number;
    degraded: number;
    unhealthy: number;
  };
}

export interface LiveIngestProbeResult {
  id: string;
  ok: boolean;
  status: LiveIngestHealthStatus;
  latencyMs: number;
  bitrateKbps: number | null;
  segmentLatencyMs: number | null;
  error: string | null;
}

export interface LiveIngestEndpointInput {
  name: string;
  protocol: LiveIngestProtocol;
  ingestUrl: string;
  hlsPlaybackUrl: string;
  fallbackYoutubeUrl?: string;
  priority?: number;
  notes?: string;
}

export const liveIngestApi = {
  list: (signal?: AbortSignal) =>
    adminGet<LiveIngestEndpointList>("/admin/live-ingest/endpoints", signal),
  create: (input: LiveIngestEndpointInput) =>
    adminPost<LiveIngestEndpoint>("/admin/live-ingest/endpoints", input),
  update: (id: string, patch: Partial<LiveIngestEndpointInput> & { isActive?: boolean }) =>
    adminPatch<LiveIngestEndpoint>(`/admin/live-ingest/endpoints/${id}`, patch),
  remove: (id: string) =>
    adminDelete<{ ok: true }>(`/admin/live-ingest/endpoints/${id}`),
  rotateKey: (id: string) =>
    adminPost<{ id: string; streamKey: string }>(
      `/admin/live-ingest/endpoints/${id}/rotate-key`,
    ),
  promote: (id: string) =>
    adminPost<{ ok: true }>(`/admin/live-ingest/endpoints/${id}/promote`),
  stop: () => adminPost<{ ok: true }>("/admin/live-ingest/stop"),
  probe: (id: string) =>
    adminPost<LiveIngestProbeResult>(`/admin/live-ingest/endpoints/${id}/probe`),
  sweep: () =>
    adminPost<{ results: Array<{ id: string; name: string; isPrimary: boolean; healthStatus: string; latencyMs: number; bitrateKbps: number | null; error: string | null }> }>(
      "/admin/live-ingest/sweep",
    ),
  validateKey: (name: string, key: string) =>
    adminPost<{ allowed: boolean; endpointId: string | null; endpointName: string | null }>(
      "/admin/live-ingest/validate-key",
      { name, key },
    ),
};

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

export interface YouTubeQuotaStatus {
  estimatedUsedToday: number;
  dailyLimit: number;
  percentUsed: number;
  exhaustedUntil: string | null;
  exhausted: boolean;
  nextResetAt: string;
  throttle?: {
    enabled: boolean;
    contexts: string[];
    thresholdPct: number;
    percentUsed: number;
    t1Pct: number;
    t2Pct: number;
  };
}

export interface YouTubeQuotaHistory {
  dailyTotals: Array<{ date: string; units: number }>;
  todayByContext: Array<{ context: string; units: number }>;
  dailyLimit: number;
}

export const youtubeQuotaApi = {
  get: (signal?: AbortSignal) =>
    adminGet<YouTubeQuotaStatus>("/admin/youtube/quota", signal),
  getHistory: (signal?: AbortSignal) =>
    adminGet<YouTubeQuotaHistory>("/admin/youtube/quota/history", signal),
};

export type AlertChannelStatus = "sent" | "skipped" | "failed" | "disabled";

export interface AlertingStatus {
  channels: { slack: boolean; webhook: boolean };
  configured: boolean;
  lastDelivery: {
    at: string;
    title: string;
    severity: "info" | "warning" | "critical";
    slack: AlertChannelStatus;
    webhook: AlertChannelStatus;
    deduped: boolean;
  } | null;
}

export interface AlertTestResult {
  slack: AlertChannelStatus;
  webhook: AlertChannelStatus;
  dedupKey: string | null;
  deduped: boolean;
}

export interface AlertHistoryEntry {
  at: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  fields: Array<{ label: string; value: string }>;
  slack: AlertChannelStatus;
  webhook: AlertChannelStatus;
  deduped: boolean;
  dedupKey: string | null;
}

export interface AlertHistoryResponse {
  entries: AlertHistoryEntry[];
  count: number;
}

export const opsAlertsApi = {
  getStatus: (signal?: AbortSignal) =>
    adminGet<AlertingStatus>("/admin/alerts/status", signal),
  sendTest: () => adminPost<AlertTestResult>("/admin/alerts/test", {}),
  getHistory: (limit?: number, signal?: AbortSignal) =>
    adminGet<AlertHistoryResponse>(
      `/admin/alerts/history${limit ? `?limit=${limit}` : ""}`,
      signal,
    ),
};
