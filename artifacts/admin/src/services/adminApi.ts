import { getAdminToken } from "@/lib/admin-access";
import { safeJson, describeJsonError } from "@/lib/safe-json";

const BASE = (() => {
  const b = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/\/admin\/?$/, "");
  return `${b}/api`;
})();

export class AdminApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

async function adminRequest<T>(
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
    );
  }

  if (!res.ok) {
    // Try to extract a structured error message. We use safeJson here too so
    // that an HTML 500 page from a proxy doesn't get reported as the literal
    // status text — operators want to know why the proxy failed, not just
    // "Internal Server Error".
    let message = res.statusText || `HTTP ${res.status}`;
    const parsed = await safeJson<{ error?: string; message?: string }>(res, `admin-api:${path}`);
    if (parsed.ok) {
      if (typeof parsed.data?.error === "string" && parsed.data.error) message = parsed.data.error;
      else if (typeof parsed.data?.message === "string" && parsed.data.message) message = parsed.data.message;
    } else if (parsed.reason === "html_fallback") {
      message = `${message} — server returned HTML (proxy may be routing /api to the SPA).`;
    } else if (parsed.reason !== "empty") {
      // Non-JSON error body with content. Surface the content-type so the
      // operator can see the source.
      message = `${message} (non-JSON ${parsed.contentType})`;
    }
    throw new AdminApiError(res.status, message);
  }

  // 204 No Content / empty success body. Differentiate from the parse path.
  if (res.status === 204) return undefined as T;

  const parsed = await safeJson<T>(res, `admin-api:${path}`);
  if (parsed.ok) return parsed.data;
  if (parsed.reason === "empty") return undefined as T; // legacy: pre-existing pages treat empty 200 as undefined
  throw new AdminApiError(res.status, describeJsonError(`API ${path}`, parsed));
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
