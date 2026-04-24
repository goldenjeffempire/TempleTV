import { getAdminToken } from "@/lib/admin-access";

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

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const j = await res.json();
      if (j.error) message = j.error;
      else if (j.message) message = j.message;
    } catch {}
    throw new AdminApiError(res.status, message);
  }

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
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
