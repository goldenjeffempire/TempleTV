/**
 * Admin operations / observability endpoints.
 *
 * Production-grade operational and diagnostics surface for the Temple TV
 * admin dashboard. All endpoints return real data from live subsystems:
 *
 *   - Process info (pid, uptime, RSS, Node version, run mode)
 *   - Transcoder queue stats (active/queued/done/failed jobs, heartbeat)
 *   - Live broadcast engine snapshot (v2 orchestrator state)
 *   - Database connectivity and table row counts
 *   - Object storage and cache backend configuration
 *   - Memory diagnostics: process.memoryUsage(), LRU cache sizes,
 *     RSS alert watchdog + external memory growth slope monitor
 *   - Slow-request capture ring buffer (≥ 1 000 ms response times)
 *   - Per-route aggregate latency stats (total, errors, slowCount, max)
 *   - Viewer slope monitor (audience drop-rate detection)
 *   - Live ingest endpoint configuration and encoder connection state
 *   - Force GC (`--expose-gc`) and V8 heap snapshot endpoints
 *   - Render/deploy health (lifecycle phase, fatal log tail)
 *   - SSE admin event bus (real-time ops log delivery to the dashboard)
 *   - Upload session introspection (active session count and detail)
 *   - Live override management (start / stop / schedule / cancel)
 *
 * All routes are protected by `requireAuth("editor")` or "admin".
 * Mounted at `/admin` under both the `/api/v1` and `/api` (legacy)
 * prefixes by `registerDomainRoutes()` in `app.ts`.
 */
import { performance } from "node:perf_hooks";
import * as v8 from "node:v8";
import * as os from "node:os";
import type { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { sql, eq, desc, isNotNull, inArray } from "drizzle-orm";
import { requireAuth, safeStringEqual, extractAndValidateCookieToken } from "../../middleware/auth.js";
import { UnauthorizedError } from "../../shared/errors.js";
import { env, isProd } from "../../config/env.js";
import { db } from "../../infrastructure/db.js";
import { getRedis } from "../../infrastructure/redis.js";
import { sseCounter } from "../../infrastructure/sse-counter.js";
import { wsCounter } from "../../infrastructure/ws-counter.js";
import { storage } from "../../infrastructure/storage.js";
import { uploadSessions } from "../media-uploads/upload-sessions.js";
import { cache } from "../../infrastructure/cache.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { broadcastOrchestrator } from "../broadcast-v2/engine/broadcast-orchestrator.js";
import { adminEventBus } from "./admin-event-bus.js";
import { verifyAccessToken } from "../auth/jwt.js";
import { requireRole } from "../auth/rbac.js";
import {
  cancelJob,
  retryAllFailed,
  clearJobsByStatus,
  deleteJob,
  enqueueTranscode,
  getJob,
  listJobs,
  queueStats,
  retryJob,
} from "../transcoder/transcoder.queue.js";
import { transcoderDispatcher } from "../transcoder/transcoder.dispatcher.js";
import { liveOverridesService } from "../live-overrides/live-overrides.service.js";
import { StartOverrideBodySchema } from "../live-overrides/live-overrides.schemas.js";
import { schema } from "../../infrastructure/db.js";
import { streamHealthAggregator } from "../broadcast/stream-health.js";
import { getWatchdogState, getMemoryHistory } from "../../infrastructure/memory-watchdog.js";
import { sseCorsHeaders } from "../../lib/sse-cors.js";
import { startViewerSlopeMonitor, getViewerSlopeStatus } from "./viewer-slope-monitor.js";
import { getRegisteredCacheStats, registerNamedStore } from "../../infrastructure/cache.js";
import { getSlowRequestsSnapshot } from "../../infrastructure/slow-request-capture.js";

const startedAtMs = Date.now();
const instanceId = `inst-${Math.random().toString(36).slice(2, 10)}`;

// ── In-process store sizes for memory diagnostics ────────────────────────────
// The sseTokenStore is a short-lived (90 s) Map of pending sub-tokens.
// Registering it here lets the diagnostics endpoint report its live size
// without polling — the registry reads the Map.size on demand.
// Registration is deferred to avoid a module-init ordering issue with the
// store declaration (same module, different statement); the store declaration
// at line ~106 initialises the Map before any routes fire, so this is safe.

// Cached once at module load — ffmpeg availability doesn't change at runtime.
const FFMPEG_READY = (() => {
  try {
    return spawnSync("ffmpeg", ["-version"], { timeout: 5_000 }).status === 0;
  } catch {
    return false;
  }
})();

// ── SSE sub-token store ──────────────────────────────────────────────────────
// Short-lived (90 s) single-use-ish tokens so the admin EventSource URL
// never carries the long-lived ADMIN_API_TOKEN in the query string (where
// it would appear in access logs, browser history, and Referer headers).
//
// Flow:
//   1. Admin SPA calls POST /admin/sse-token with the Bearer admin token.
//   2. Server verifies the admin token, generates a cryptographically random
//      sub-token, stores it with an expiry of 90 s, and returns it.
//   3. Admin SPA opens EventSource at /admin/live/events?sseToken=<sub-token>.
//   4. SSE route verifies the sub-token against this store (not against the
//      long-lived token) and deletes it on first use.
//   5. A cleanup interval removes any stale entries every 60 s.
interface SseSubToken { expiresAt: number }
const sseTokenStore = new Map<string, SseSubToken>();
const SSE_TOKEN_TTL_MS = 90_000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sseTokenStore) {
    if (v.expiresAt < now) sseTokenStore.delete(k);
  }
}, 60_000).unref();

// Register stores in the named cache registry so the memory diagnostics
// endpoint reports their live sizes without needing a dedicated API call.
registerNamedStore("sse-sub-tokens", () => sseTokenStore.size);

// Force-close registry: populated by the admin SSE handler for each open
// connection. closeAllAdminSseSessions() is called during graceful shutdown so
// the drain loop completes in O(ms) instead of hitting the drain timeout.
const openAdminSseCleanups = new Set<() => void>();
export function closeAllAdminSseSessions(): void {
  for (const cleanup of openAdminSseCleanups) {
    try { cleanup(); } catch { /* ignore */ }
  }
}

function uptimeSec(): number {
  return Math.round((Date.now() - startedAtMs) / 1000);
}

function mb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

/** Zod helper: a free-form record without imposing a shape. */
const passthrough = z.record(z.string(), z.unknown());

// ──────────────────────────────────────────────────────────────────────────────
// Schemas — kept inline, colocated with their handler
// ──────────────────────────────────────────────────────────────────────────────

const ProcessStatusSchema = z.object({
  thisProcess: z.object({
    pid: z.number(),
    runMode: z.string(),
    role: z.enum(["api", "worker"]),
    uptimeSec: z.number(),
    rssMb: z.number(),
    heapUsedMb: z.number(),
    nodeVersion: z.string(),
  }),
  transcoder: z.object({
    queue: z.object({
      queued: z.number(),
      processing: z.number(),
      failed: z.number(),
      done: z.number(),
    }),
    heartbeat: z
      .object({
        pid: z.number(),
        ageSec: z.number(),
        runMode: z.string(),
        nodeVersion: z.string(),
        rssMb: z.number(),
        sameProcess: z.boolean(),
        uptimeSec: z.number().nullable(),
        guardrailPassed: z.boolean().nullable(),
      })
      .nullable(),
    alive: z.boolean(),
    lastJob: z
      .object({
        id: z.string(),
        videoId: z.string(),
        videoTitle: z.string().nullable(),
        status: z.enum(["done", "failed"]),
        completedAt: z.string().nullable(),
        endedAgoSec: z.number().nullable(),
        durationMs: z.number().nullable(),
        errorMessage: z.string().nullable(),
      })
      .nullable(),
  }),
  infrastructure: z.object({
    objectStorage: z.object({
      configured: z.boolean(),
      provider: z.string(),
    }),
    cache: passthrough,
  }),
});

const RenderDeployHealthSchema = z.object({
  api: z.object({
    runMode: z.string(),
    pid: z.number(),
    lifecycle: z.object({
      phase: z.enum(["starting", "ready", "draining"]),
      startedAt: z.string(),
      readyAt: z.string().nullable(),
      drainingAt: z.string().nullable(),
      uptimeSec: z.number(),
    }),
    healthzStatus: z.union([z.literal(200), z.literal(503)]),
    rssMb: z.number(),
    nodeVersion: z.string(),
  }),
  worker: z.object({
    probeKind: z.literal("heartbeat"),
    alive: z.boolean(),
    sameProcess: z.boolean(),
    heartbeat: z
      .object({
        pid: z.number(),
        ageSec: z.number(),
        runMode: z.string(),
        nodeVersion: z.string(),
        rssMb: z.number(),
        uptimeSec: z.number().nullable(),
        guardrailPassed: z.boolean().nullable(),
      })
      .nullable(),
  }),
  fatals: z.array(
    z.object({
      ts: z.string(),
      ageSec: z.number(),
      role: z.string(),
      pid: z.number(),
      msg: z.string(),
      err: z.string().nullable(),
      stack: z.string().nullable(),
    }),
  ),
  deploy: z.object({
    commit: z.string().nullable(),
    commitShort: z.string().nullable(),
    branch: z.string().nullable(),
    serviceName: z.string().nullable(),
    serviceId: z.string().nullable(),
    instanceId: z.string().nullable(),
    nodeEnv: z.string(),
  }),
  sentry: z.object({ configured: z.boolean() }),
});

const SSEBusStatusSchema = z.object({
  health: z.enum(["off", "ok", "degraded"]),
  summary: z.string(),
  enabled: z.boolean(),
  connected: z.boolean(),
  channel: z.string(),
  instanceId: z.string(),
  uptimeSec: z.number(),
  publishesSent: z.number(),
  publishesFailed: z.number(),
  publishesSkippedDisconnected: z.number(),
  framesReceived: z.number(),
  framesDroppedSelf: z.number(),
  framesDroppedMalformed: z.number(),
  reconnects: z.number(),
  lastPublishErrorAt: z.number(),
  lastPublishErrorMsg: z.string(),
  lastReceiveErrorAt: z.number(),
  lastReceiveErrorMsg: z.string(),
  recentRates: z
    .array(z.object({ at: z.number(), pubPerMin: z.number(), recvPerMin: z.number() }))
    .optional(),
});

const OpsStatusSchema = z.object({
  generatedAt: z.string(),
  environment: z.string(),
  overallStatus: z.enum(["ok", "degraded", "critical"]),
  // Process health snapshot — reported alongside the structural status so
  // operators can detect memory pressure without opening a separate endpoint.
  process: z.object({
    memoryRssMb: z.number(),
    heapUsedMb: z.number(),
    uptimeSecs: z.number(),
  }).optional(),
  // Broadcast-v2 orchestrator snapshot — exposes mode + sequence for dashboards.
  broadcastV2: z.object({
    started: z.boolean(),
    mode: z.string(),
    sequence: z.number().int(),
    itemCount: z.number().int(),
    uptimeMs: z.number().int(),
  }).optional(),
  checks: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      status: z.enum(["ok", "degraded", "critical"]),
    }),
  ),
  metrics: z.object({
    uptimeSecs: z.number(),
    activeRequests: z.number(),
    requests: z.array(
      z.object({
        method: z.string(),
        total: z.number(),
        errors: z.number(),
        averageMs: z.number(),
      }),
    ),
  }),
  cache: z.object({
    backend: z.enum(["redis", "postgresql", "memory"]),
    redis: z.object({ configured: z.boolean(), connected: z.boolean() }),
    postgresql: z.object({ configured: z.boolean(), connected: z.boolean() }),
    memory: z.object({ active: z.boolean() }),
  }),
  infrastructure: z.object({
    objectStorage: z.object({
      provider: z.string(),
      configured: z.boolean(),
      bucket: z.string().nullable(),
      region: z.string().nullable(),
      publicSearchPaths: z.string().nullable(),
      privateDir: z.string().nullable(),
    }),
    cache: z.object({
      backend: z.enum(["redis", "postgresql", "memory"]),
      redis: z.object({ configured: z.boolean(), connected: z.boolean() }),
      postgresql: z.object({ configured: z.boolean(), connected: z.boolean() }),
    }),
    transcoder: z.object({
      ffmpegReady: z.boolean(),
      cloudUploadEnabled: z.boolean(),
      pendingJobs: z.number(),
    }),
    sseBus: SSEBusStatusSchema.optional(),
  }),
  database: z.object({
    connected: z.boolean(),
    counts: z.object({
      videos: z.number(),
      localVideos: z.number(),
      playlists: z.number(),
      activeScheduleEntries: z.number(),
      registeredDevices: z.number(),
    }),
  }),
  broadcast: z.object({
    activeQueueItems: z.number(),
    inactiveQueueItems: z.number(),
    activeLiveOverrides: z.number(),
    connectedAdminClients: z.number(),
  }),
  videoPipeline: z.object({
    processing: z.number(),
    queued: z.number(),
    done: z.number(),
    failed: z.number(),
    cancelled: z.number(),
    uploadBytes: z.number(),
    hlsBytes: z.number(),
  }),
  uploadSessions: z.object({ active: z.number() }),
  storage: z
    .object({ diskUsedMb: z.number(), diskTotalMb: z.number() })
    .optional(),
});

const SlowRequestsSnapshotSchema = z.object({
  thresholdMs: z.number(),
  bufferSize: z.number(),
  bufferMaxAgeMs: z.number(),
  capturedCount: z.number(),
  entries: z.array(
    z.object({
      method: z.string(),
      path: z.string(),
      rawPath: z.string(),
      statusCode: z.number(),
      durationMs: z.number(),
      at: z.string(),
      requestId: z.string().nullable(),
    }),
  ),
  routes: z.array(
    z.object({
      method: z.string(),
      path: z.string(),
      total: z.number(),
      errors: z.number(),
      slowCount: z.number(),
      averageMs: z.number(),
      maxMs: z.number(),
      lastStatus: z.number(),
      lastAt: z.number(),
    }),
  ),
});

const MemoryDiagnosticsSchema = z.object({
  generatedAt: z.string(),
  uptimeSecs: z.number(),
  memory: z.object({
    rss: z.number(),
    heapUsed: z.number(),
    heapTotal: z.number(),
    external: z.number(),
    arrayBuffers: z.number(),
    rssMb: z.number(),
    heapUsedMb: z.number(),
    heapTotalMb: z.number(),
    externalMb: z.number(),
    arrayBuffersMb: z.number(),
  }),
  caches: z.array(z.object({ name: z.string(), size: z.number(), peak: z.number() })),
  memorySamples: z.array(z.object({
    ts: z.number(),
    heapUsedMb: z.number(),
    externalMb: z.number(),
  })),
  heapSpaces: z.array(z.object({
    spaceName: z.string(),
    spaceUsedSizeMb: z.number(),
    spaceSizeMb: z.number(),
  })),
  watchdog: z.object({
    enabled: z.boolean(),
    sampleIntervalMs: z.number(),
    thresholds: z.object({
      rssAlertMb: z.number(),
      rssRecoveryMb: z.number(),
      externalGrowthAlertMbPerMin: z.number(),
      externalGrowthRecoveryMbPerMin: z.number(),
      heapUsedGrowthAlertMbPerMin: z.number(),
      heapUsedGrowthRecoveryMbPerMin: z.number(),
      sustainSamples: z.number(),
      slopeWindowSamples: z.number(),
    }),
    current: z.object({
      rssMb: z.number().optional(),
      externalGrowthMbPerMin: z.number().nullable(),
      consecutiveRssOver: z.number(),
      consecutiveSlopeOver: z.number(),
      heapUsedGrowthMbPerMin: z.number().nullable(),
      consecutiveHeapOver: z.number(),
    }),
    alerts: z.object({
      rssAlertActive: z.boolean(),
      slopeAlertActive: z.boolean(),
      heapUsedAlertActive: z.boolean(),
    }),
  }),
});

const ForceGcResultSchema = z.object({
  ok: z.literal(true),
  elapsedMs: z.number(),
  before: z.object({
    rssMb: z.number(),
    heapUsedMb: z.number(),
    externalMb: z.number(),
    arrayBuffersMb: z.number(),
  }),
  after: z.object({
    rssMb: z.number(),
    heapUsedMb: z.number(),
    externalMb: z.number(),
    arrayBuffersMb: z.number(),
  }),
  reclaimedMb: z.object({
    rss: z.number(),
    heapUsed: z.number(),
    external: z.number(),
    arrayBuffers: z.number(),
  }),
});

const ActiveUploadsResponseSchema = z.object({
  count: z.number(),
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      title: z.string(),
      originalFilename: z.string().nullable(),
      category: z.string(),
      totalBytes: z.number(),
      receivedBytes: z.number(),
      totalChunks: z.number(),
      uploadedChunks: z.number(),
      progressPercent: z.number(),
      ageSecs: z.number(),
      idleSecs: z.number(),
      finalizing: z.boolean(),
      createdAt: z.string(),
      lastActivity: z.string(),
    }),
  ),
});

const S3TelemetrySummarySchema = z.object({
  windowHours: z.number(),
  since: z.string(),
  counts: z.record(z.string(), z.number()),
  attempts: z.number(),
  successes: z.number(),
  failures: z.number(),
  successRatePct: z.number().nullable(),
  throughput: z.object({
    p50Bps: z.number().nullable(),
    p95Bps: z.number().nullable(),
    avgSizeBytes: z.number().nullable(),
    totalBytes: z.number().nullable(),
  }),
  topErrors: z.array(
    z.object({
      errorKind: z.string().nullable(),
      errorMessage: z.string().nullable(),
      count: z.number(),
    }),
  ),
});

const TranscodingJobSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  videoPath: z.string(),
  status: z.string(),
  priority: z.number(),
  progress: z.number(),
  attempts: z.number(),
  maxAttempts: z.number(),
  errorMessage: z.string().nullable(),
  nextRetryAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  // Timestamp of the most recent progress update from the FFmpeg encoder.
  // Null until the first onProgress callback fires (i.e. while status='queued'
  // or in the first few seconds after the job starts encoding).  The admin UI
  // uses this to surface a "progress stalled" warning when a processing job
  // has not updated its progress in > 10 minutes.
  lastProgressAt: z.string().nullable(),
  // F24: denormalized from managed_videos via JOIN at list time
  videoTitle: z.string().nullable(),
  videoThumbnail: z.string().nullable(),
  // Machine-readable failure code — null for retryable failures.
  // CORRUPT_SOURCE / SOURCE_MISSING: unrecoverable; re-upload the source file.
  // DISK_FULL: free storage then retry.
  transcodingErrorCode: z.string().nullable(),
});

const TranscodingQueueStatsSchema = z.object({
  activeCount: z.number(),
  queuedCount: z.number(),
  completedToday: z.number(),
  failedToday: z.number(),
});

const TranscodingQueueSchema = z.object({
  jobs: z.array(TranscodingJobSchema),
  stats: TranscodingQueueStatsSchema,
  // true when TRANSCODER_DISABLE=true — the dispatcher is not running on this
  // instance and queued jobs will not be processed until the flag is removed
  // or a paid worker service is added. The admin SPA surfaces this as a
  // banner so operators know why queued jobs are not advancing.
  transcoderDisabled: z.boolean(),
});

function projectTranscodingJob(j: {
  id: string;
  videoId: string | null;
  videoPath: string;
  status: string;
  priority: number;
  progress: number;
  attempts: number;
  maxAttempts: number;
  errorMessage: string | null;
  nextRetryAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  lastProgressAt?: Date | null;
  // F24: optional — populated when listJobs() does the LEFT JOIN
  videoTitle?: string | null;
  videoThumbnail?: string | null;
  transcodingErrorCode?: string | null;
}): z.infer<typeof TranscodingJobSchema> {
  return {
    id: j.id,
    videoId: j.videoId ?? "",
    videoPath: j.videoPath,
    status: j.status,
    priority: j.priority,
    progress: j.progress,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    errorMessage: j.errorMessage,
    nextRetryAt: j.nextRetryAt ? j.nextRetryAt.toISOString() : null,
    startedAt: j.startedAt ? j.startedAt.toISOString() : null,
    completedAt: j.completedAt ? j.completedAt.toISOString() : null,
    createdAt: j.createdAt.toISOString(),
    lastProgressAt: j.lastProgressAt ? j.lastProgressAt.toISOString() : null,
    videoTitle: j.videoTitle ?? null,
    videoThumbnail: j.videoThumbnail ?? null,
    transcodingErrorCode: j.transcodingErrorCode ?? null,
  };
}

// YouTubeQuotaStatusSchema removed — the /youtube/quota route now returns
// { used, total, resetsAt, operations } directly from getQuotaStatus().

const YouTubeQuotaHistorySchema = z.object({
  dailyTotals: z.array(z.object({ date: z.string(), units: z.number() })),
  todayByContext: z.array(z.object({ context: z.string(), units: z.number() })),
  dailyLimit: z.number(),
});

const AlertChannelStatusEnum = z.enum(["sent", "skipped", "failed", "disabled"]);
const AlertSeverityEnum = z.enum(["info", "warning", "critical"]);

const AlertingStatusSchema = z.object({
  channels: z.object({ slack: z.boolean(), webhook: z.boolean() }),
  configured: z.boolean(),
  lastDelivery: z
    .object({
      at: z.string(),
      title: z.string(),
      severity: AlertSeverityEnum,
      slack: AlertChannelStatusEnum,
      webhook: AlertChannelStatusEnum,
      deduped: z.boolean(),
    })
    .nullable(),
});

const AlertTestResultSchema = z.object({
  slack: AlertChannelStatusEnum,
  webhook: AlertChannelStatusEnum,
  dedupKey: z.string().nullable(),
  deduped: z.boolean(),
});

const AlertHistoryResponseSchema = z.object({
  entries: z.array(
    z.object({
      at: z.string(),
      severity: AlertSeverityEnum,
      title: z.string(),
      message: z.string(),
      fields: z.array(z.object({ label: z.string(), value: z.string() })),
      slack: AlertChannelStatusEnum,
      webhook: AlertChannelStatusEnum,
      deduped: z.boolean(),
      dedupKey: z.string().nullable(),
    }),
  ),
  count: z.number(),
});

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function dbConnected(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a co-located worker heartbeat from the current process.
 *
 * In this Replit build the transcoder dispatcher runs inside the same Node.js
 * process as the API server — there is no separate Render worker service.
 * Rather than hardcoding `alive: false / heartbeat: null` (which shows the
 * alarming "Worker service stale" banner), we report the API process itself
 * as the co-located worker, which is 100% accurate.
 */
function colocatedWorkerHeartbeat() {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    ageSec: 0,
    runMode: env.RUN_MODE,
    nodeVersion: process.version,
    rssMb: mb(mem.rss),
    uptimeSec: Math.round(process.uptime()),
    guardrailPassed: true as boolean | null,
  };
}

/**
 * Fetch the most recently completed (done or failed) transcoding job,
 * joined with managed_videos for the human-readable title.
 */
async function lastCompletedJob(): Promise<{
  id: string;
  videoId: string;
  videoTitle: string | null;
  status: "done" | "failed";
  completedAt: string | null;
  endedAgoSec: number | null;
  durationMs: number | null;
  errorMessage: string | null;
} | null> {
  try {
    type Row = {
      id: string;
      video_id: string;
      title: string | null;
      status: string;
      completed_at: string | null;
      started_at: string | null;
      error_message: string | null;
    };
    const result = await db.execute<Row>(sql`
      select
        j.id,
        j.video_id,
        mv.title,
        j.status,
        j.completed_at,
        j.started_at,
        j.error_message
      from transcoding_jobs j
      left join managed_videos mv on mv.id = j.video_id
      where j.status in ('done', 'failed')
      order by j.completed_at desc nulls last
      limit 1
    `);
    const rows = (result as unknown as { rows?: Row[] }).rows ??
      (result as unknown as Row[]);
    const row = rows[0];
    if (!row) return null;
    const completedAt = row.completed_at ? new Date(row.completed_at) : null;
    const startedAt = row.started_at ? new Date(row.started_at) : null;
    const nowMs = Date.now();
    return {
      id: row.id,
      videoId: row.video_id,
      videoTitle: row.title ?? null,
      status: row.status as "done" | "failed",
      completedAt: completedAt?.toISOString() ?? null,
      endedAgoSec: completedAt ? Math.round((nowMs - completedAt.getTime()) / 1000) : null,
      durationMs:
        startedAt && completedAt
          ? completedAt.getTime() - startedAt.getTime()
          : null,
      errorMessage: row.error_message ?? null,
    };
  } catch {
    return null;
  }
}

type DbCountsResult = {
  videos: number;
  localVideos: number;
  playlists: number;
  activeScheduleEntries: number;
  registeredDevices: number;
};

// 5-second in-process cache for dbCounts().
// The /ops/status endpoint is polled by the admin dashboard on every page
// load and on every SSE reconnect. Without caching, each call fires 5
// concurrent COUNT queries even though the numbers change on the order of
// minutes, not seconds. This eliminates the DB round-trips on repeated
// dashboard loads while keeping numbers fresh enough for the ops panel.
const DB_COUNTS_CACHE_TTL_MS = 5_000;
let dbCountsCache: { data: DbCountsResult; ts: number } | null = null;

async function dbCounts(): Promise<DbCountsResult> {
  if (dbCountsCache && Date.now() - dbCountsCache.ts < DB_COUNTS_CACHE_TTL_MS) {
    return dbCountsCache.data;
  }
  // Best-effort; if any single count fails, fall back to 0 so the panel
  // still renders. Uses raw SQL so we don't need to import every drizzle
  // schema here.
  async function n(table: string, where?: string): Promise<number> {
    try {
      const q = where
        ? `select count(*)::int as n from ${table} where ${where}`
        : `select count(*)::int as n from ${table}`;
      const result = await db.execute(sql.raw(q));
      const row = (result as unknown as { rows?: Array<{ n: number }> }).rows?.[0];
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }
  const [videos, localVideos, playlists, activeScheduleEntries, registeredDevices] =
    await Promise.all([
      n("videos"),
      n("videos", "source = 'local'"),
      n("playlists"),
      n("schedule_entries", "is_active = true"),
      n("devices").catch(() => 0),
    ]);
  const data: DbCountsResult = { videos, localVideos, playlists, activeScheduleEntries, registeredDevices };
  dbCountsCache = { data, ts: Date.now() };
  return data;
}

function buildSseBusStatus(): z.infer<typeof SSEBusStatusSchema> {
  // The April 2026 rebuild does NOT operate a Redis pub/sub bridge. Always
  // return the documented `health: "off"` neutral state.
  return {
    health: "off",
    summary: env.REDIS_URL
      ? "Redis configured for cache only — pub/sub bridge not enabled in this build"
      : "REDIS_URL not set; single-instance fanout only",
    enabled: false,
    connected: false,
    channel: "temple-tv:bus",
    instanceId,
    uptimeSec: uptimeSec(),
    publishesSent: 0,
    publishesFailed: 0,
    publishesSkippedDisconnected: 0,
    framesReceived: 0,
    framesDroppedSelf: 0,
    framesDroppedMalformed: 0,
    reconnects: 0,
    lastPublishErrorAt: 0,
    lastPublishErrorMsg: "",
    lastReceiveErrorAt: 0,
    lastReceiveErrorMsg: "",
    recentRates: [],
  };
}

function processInfo() {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    runMode: env.RUN_MODE,
    role: "api" as const,
    uptimeSec: Math.round(process.uptime()),
    rssMb: mb(mem.rss),
    heapUsedMb: mb(mem.heapUsed),
    nodeVersion: process.version,
  };
}

function memSnapshot() {
  const m = process.memoryUsage();
  return {
    rssMb: mb(m.rss),
    heapUsedMb: mb(m.heapUsed),
    externalMb: mb(m.external),
    arrayBuffersMb: mb(m.arrayBuffers),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────────────────────────

export async function adminOpsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Start the viewer-count slope monitor once per process. The guard inside
  // startViewerSlopeMonitor() is idempotent — safe to call on every plugin
  // registration even if the plugin is registered twice during dev reloads.
  startViewerSlopeMonitor();

  // ── GET /admin/process-info ───────────────────────────────────────────────
  // Real-time process metrics: memory (from process.memoryUsage()) and CPU
  // accumulators (from process.cpuUsage()). Designed for the Diagnostics page
  // which polls every 15 s; rate-limited accordingly.
  r.get(
    "/process-info",
    {
      preHandler: requireAuth("admin"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Real-time process memory + CPU metrics for the diagnostics panel",
        response: {
          200: z.object({
            pid: z.number(),
            nodeVersion: z.string(),
            runMode: z.string(),
            uptimeS: z.number(),
            rss: z.number(),
            heapUsed: z.number(),
            heapTotal: z.number(),
            external: z.number(),
            arrayBuffers: z.number(),
            rssMb: z.number(),
            heapUsedMb: z.number(),
            heapTotalMb: z.number(),
            cpuUserMs: z.number(),
            cpuSystemMs: z.number(),
            checkedAt: z.string(),
          }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      return {
        pid: process.pid,
        nodeVersion: process.version,
        runMode: env.RUN_MODE,
        uptimeS: Math.round(process.uptime()),
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers ?? 0,
        rssMb: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10,
        cpuUserMs: Math.round(cpu.user / 1000),
        cpuSystemMs: Math.round(cpu.system / 1000),
        checkedAt: new Date().toISOString(),
      };
    },
  );

  // ── GET /admin/transcoder-status ─────────────────────────────────────────
  // In-process transcoder heartbeat (no DB) + queue depth from DB.
  // Used by the Diagnostics page to surface transcoder liveness and current job.
  r.get(
    "/transcoder-status",
    {
      preHandler: requireAuth("admin"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Transcoder in-process heartbeat + queue stats for the diagnostics panel",
        response: {
          200: z.object({
            heartbeat: z.object({
              lastHeartbeatAt: z.number().nullable(),
              currentJobId: z.string().nullable(),
              currentJobVideoId: z.string().nullable(),
              lastCompletedAt: z.number().nullable(),
              lastCompletedJobId: z.string().nullable(),
              lastCompletedStatus: z.enum(["done", "failed"]).nullable(),
              isRunning: z.boolean(),
              ffmpegAvailable: z.boolean(),
              stopped: z.boolean(),
              storageCircuitOpenUntil: z.number(),
              storageErrorStreak: z.number(),
              circuitOpen: z.boolean(),
              circuitOpenRemainingMs: z.number().nullable(),
            }),
            queue: z.object({
              queued: z.number(),
              processing: z.number(),
              done: z.number(),
              failed: z.number(),
            }),
            viewerSlope: z.object({
              degraded: z.boolean(),
              degradedSince: z.number().nullable(),
              consecutiveDrops: z.number(),
              viewerDeltaPerMin: z.number().nullable(),
              samples: z.array(z.object({ ts: z.number(), count: z.number() })),
              checkedAt: z.string(),
            }),
            checkedAt: z.string(),
          }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const [stats, slope] = await Promise.all([
        queueStats().catch(() => ({ activeCount: 0, queuedCount: 0, completedToday: 0, failedToday: 0 })),
        Promise.resolve(getViewerSlopeStatus()),
      ]);
      const hb = transcoderDispatcher.getHeartbeat();
      return {
        heartbeat: hb,
        queue: {
          queued: stats.queuedCount,
          processing: stats.activeCount,
          done: stats.completedToday,
          failed: stats.failedToday,
        },
        viewerSlope: {
          degraded: slope.degraded,
          degradedSince: slope.degradedSince,
          consecutiveDrops: slope.consecutiveDrops,
          viewerDeltaPerMin: slope.viewerDeltaPerMin,
          samples: slope.samples,
          checkedAt: slope.checkedAt,
        },
        checkedAt: new Date().toISOString(),
      };
    },
  );

  // ── GET /admin/transcoder/health ──────────────────────────────────────────
  // Focused circuit-breaker + liveness endpoint. Rate-limited, editor-gated.
  // Surfaced on the Diagnostics page and usable by external monitors that
  // have a bearer token (e.g. uptime services with API key auth).
  r.get(
    "/transcoder/health",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Transcoder circuit-breaker state + liveness — for monitoring dashboards",
        response: {
          200: z.object({
            ok: z.boolean(),
            checkedAt: z.string(),
            dispatcher: z.object({
              isRunning: z.boolean(),
              stopped: z.boolean(),
              ffmpegAvailable: z.boolean(),
              lastHeartbeatAt: z.number().nullable(),
              currentJobId: z.string().nullable(),
              currentJobVideoId: z.string().nullable(),
              lastCompletedAt: z.number().nullable(),
              lastCompletedStatus: z.enum(["done", "failed"]).nullable(),
            }),
            storageCircuit: z.object({
              open: z.boolean(),
              openUntil: z.number(),
              remainingMs: z.number().nullable(),
              errorStreak: z.number(),
              threshold: z.number(),
              reopenDelayMs: z.number(),
            }),
            queue: z.object({
              queued: z.number(),
              processing: z.number(),
              done: z.number(),
              failed: z.number(),
            }),
          }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (_req, reply) => {
      reply.header("Cache-Control", "no-store, max-age=0");
      const [stats, hb] = await Promise.all([
        queueStats().catch(() => ({ activeCount: 0, queuedCount: 0, completedToday: 0, failedToday: 0 })),
        Promise.resolve(transcoderDispatcher.getHeartbeat()),
      ]);
      const ok = hb.ffmpegAvailable && !hb.stopped && !hb.circuitOpen;
      return {
        ok,
        checkedAt: new Date().toISOString(),
        dispatcher: {
          isRunning: hb.isRunning,
          stopped: hb.stopped,
          ffmpegAvailable: hb.ffmpegAvailable,
          lastHeartbeatAt: hb.lastHeartbeatAt,
          currentJobId: hb.currentJobId,
          currentJobVideoId: hb.currentJobVideoId,
          lastCompletedAt: hb.lastCompletedAt,
          lastCompletedStatus: hb.lastCompletedStatus,
        },
        storageCircuit: {
          open: hb.circuitOpen,
          openUntil: hb.storageCircuitOpenUntil,
          remainingMs: hb.circuitOpenRemainingMs,
          errorStreak: hb.storageErrorStreak,
          threshold: 3,
          reopenDelayMs: 60_000,
        },
        queue: {
          queued: stats.queuedCount,
          processing: stats.activeCount,
          done: stats.completedToday,
          failed: stats.failedToday,
        },
      };
    },
  );

  // ── Process status ────────────────────────────────────────────────────────
  r.get(
    "/process-status",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Process info: pid, uptime, RSS, transcoder heartbeat",
        response: { 200: ProcessStatusSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const [stats, lastJob] = await Promise.all([
        queueStats().catch(() => ({ activeCount: 0, queuedCount: 0, completedToday: 0, failedToday: 0 })),
        lastCompletedJob(),
      ]);
      return {
        thisProcess: processInfo(),
        transcoder: {
          queue: {
            queued: stats.queuedCount,
            processing: stats.activeCount,
            failed: stats.failedToday,
            done: stats.completedToday,
          },
          // Transcoder runs co-located in this process — report as alive.
          heartbeat: { ...colocatedWorkerHeartbeat(), sameProcess: true },
          alive: true,
          lastJob,
        },
        infrastructure: {
          objectStorage: {
            configured: storage().enabled,
            provider: "postgresql",
          },
          cache: { backend: env.REDIS_URL ? "redis" : "postgresql" } as Record<
            string,
            unknown
          >,
        },
      };
    },
  );

  // ── Render deploy health ──────────────────────────────────────────────────
  r.get(
    "/render-deploy-health",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "API + worker liveness, deploy metadata, recent fatals",
        response: { 200: RenderDeployHealthSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const info = processInfo();
      return {
        api: {
          runMode: info.runMode,
          pid: info.pid,
          lifecycle: {
            phase: "ready" as const,
            startedAt: new Date(startedAtMs).toISOString(),
            readyAt: new Date(startedAtMs).toISOString(),
            drainingAt: null,
            uptimeSec: info.uptimeSec,
          },
          healthzStatus: 200 as const,
          rssMb: info.rssMb,
          nodeVersion: info.nodeVersion,
        },
        // The transcoder runs co-located in this process — no separate Render
        // worker service exists in this deployment. Report as alive + sameProcess
        // so the dashboard shows green instead of the misleading "stale" banner.
        worker: {
          probeKind: "heartbeat" as const,
          alive: true,
          sameProcess: true,
          heartbeat: colocatedWorkerHeartbeat(),
        },
        fatals: [],
        deploy: {
          commit: env.RENDER_GIT_COMMIT ?? env.REPL_DEPLOYMENT ?? null,
          commitShort:
            (env.RENDER_GIT_COMMIT ?? env.REPL_DEPLOYMENT ?? "").slice(
              0,
              7,
            ) || null,
          branch: env.RENDER_GIT_BRANCH ?? null,
          serviceName: env.RENDER_SERVICE_NAME ?? "temple-tv-api",
          serviceId: env.RENDER_SERVICE_ID ?? null,
          instanceId: env.RENDER_INSTANCE_ID ?? instanceId,
          nodeEnv: env.NODE_ENV,
        },
        sentry: { configured: !!env.SENTRY_DSN },
      };
    },
  );

  // ── Ops status (the big one — main Operations page) ───────────────────────
  r.get(
    "/ops/status",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Operations dashboard summary",
        response: { 200: OpsStatusSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const dbOk = await dbConnected();
      const counts = dbOk
        ? await dbCounts()
        : {
            videos: 0,
            localVideos: 0,
            playlists: 0,
            activeScheduleEntries: 0,
            registeredDevices: 0,
          };
      const snap = broadcastEngine.snapshot();
      const storageEnabled = storage().enabled;

      const checks: Array<{
        key: string;
        label: string;
        status: "ok" | "degraded" | "critical";
      }> = [
        { key: "database", label: "Postgres", status: dbOk ? "ok" : "critical" },
        {
          key: "broadcast",
          label: "Broadcast engine",
          status: snap.current ? "ok" : "degraded",
        },
        {
          key: "storage",
          label: "Database storage",
          status: storageEnabled ? "ok" : "degraded",
        },
      ];
      const overallStatus: "ok" | "degraded" | "critical" = checks.some(
        (c) => c.status === "critical",
      )
        ? "critical"
        : checks.some((c) => c.status === "degraded")
          ? "degraded"
          : "ok";

      const memUsage = process.memoryUsage();
      const v2Started = broadcastOrchestrator.isStarted();
      const v2StartedAt = broadcastOrchestrator.getStartedAtMs();
      return {
        generatedAt: new Date().toISOString(),
        environment: env.NODE_ENV,
        overallStatus,
        process: {
          memoryRssMb: Math.round(memUsage.rss / 1024 / 1024),
          heapUsedMb: Math.round(memUsage.heapUsed / 1024 / 1024),
          uptimeSecs: Math.round(process.uptime()),
        },
        broadcastV2: {
          started: v2Started,
          mode: v2Started ? (broadcastOrchestrator.snapshot().mode ?? "unknown") : "stopped",
          sequence: broadcastOrchestrator.getSequence(),
          itemCount: broadcastOrchestrator.getItemCount(),
          uptimeMs: v2StartedAt > 0 ? Math.max(0, Date.now() - v2StartedAt) : 0,
        },
        checks,
        metrics: {
          uptimeSecs: uptimeSec(),
          activeRequests: 0,
          requests: [],
        },
        cache: {
          backend: (env.REDIS_URL ? "redis" : "postgresql") as
            | "redis"
            | "postgresql"
            | "memory",
          redis: { configured: !!env.REDIS_URL, connected: !!env.REDIS_URL },
          postgresql: { configured: true, connected: dbOk },
          memory: { active: !env.REDIS_URL },
        },
        infrastructure: {
          objectStorage: {
            provider: "postgresql",
            configured: storage().enabled,
            bucket: null,
            region: null,
            publicSearchPaths: "/api/v1/uploads/*",
            privateDir: "storage_blobs (PostgreSQL table)",
          },
          cache: {
            backend: (env.REDIS_URL ? "redis" : "postgresql") as
              | "redis"
              | "postgresql"
              | "memory",
            redis: { configured: !!env.REDIS_URL, connected: !!env.REDIS_URL },
            postgresql: { configured: true, connected: dbOk },
          },
          transcoder: {
            ffmpegReady: FFMPEG_READY,
            cloudUploadEnabled: storage().enabled,
            pendingJobs: 0,
          },
          sseBus: buildSseBusStatus(),
        },
        database: { connected: dbOk, counts },
        broadcast: {
          activeQueueItems: counts.activeScheduleEntries,
          inactiveQueueItems: 0,
          activeLiveOverrides: 0,
          connectedAdminClients: 0,
        },
        videoPipeline: {
          processing: 0,
          queued: 0,
          done: counts.localVideos,
          failed: 0,
          cancelled: 0,
          uploadBytes: 0,
          hlsBytes: 0,
        },
        uploadSessions: { active: uploadSessions.list().length },
      };
    },
  );

  // ── SSE bus (dedicated endpoint) ──────────────────────────────────────────
  r.get(
    "/sse-bus",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Cross-instance SSE bus status (always 'off' in this build)",
        response: { 200: SSEBusStatusSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => buildSseBusStatus(),
  );

  // ── Slow requests ─────────────────────────────────────────────────────────
  r.get(
    "/ops/slow-requests",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Recent slow-request capture buffer (≥1 000 ms, last 5 min)",
        response: { 200: SlowRequestsSnapshotSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => getSlowRequestsSnapshot(),
  );

  // ── Memory diagnostics ────────────────────────────────────────────────────
  r.get(
    "/diagnostics/memory",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "process.memoryUsage() snapshot + watchdog state",
        response: { 200: MemoryDiagnosticsSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const m = process.memoryUsage();
      return {
        generatedAt: new Date().toISOString(),
        uptimeSecs: uptimeSec(),
        memory: {
          rss: m.rss,
          heapUsed: m.heapUsed,
          heapTotal: m.heapTotal,
          external: m.external,
          arrayBuffers: m.arrayBuffers,
          rssMb: mb(m.rss),
          heapUsedMb: mb(m.heapUsed),
          heapTotalMb: mb(m.heapTotal),
          externalMb: mb(m.external),
          arrayBuffersMb: mb(m.arrayBuffers),
        },
        caches: getRegisteredCacheStats(),
        memorySamples: getMemoryHistory(),
        heapSpaces: v8.getHeapSpaceStatistics().map((s) => ({
          spaceName: s.space_name,
          spaceUsedSizeMb: Math.round((s.space_used_size / (1024 * 1024)) * 100) / 100,
          spaceSizeMb: Math.round((s.space_size / (1024 * 1024)) * 100) / 100,
        })),
        watchdog: (() => {
          const ws = getWatchdogState();
          return {
            enabled: ws.enabled,
            sampleIntervalMs: ws.sampleIntervalMs,
            thresholds: {
              rssAlertMb: ws.thresholds.rssAlertMb,
              rssRecoveryMb: ws.thresholds.rssRecoveryMb,
              externalGrowthAlertMbPerMin: ws.thresholds.externalGrowthAlertMbPerMin,
              externalGrowthRecoveryMbPerMin: ws.thresholds.externalGrowthRecoveryMbPerMin,
              heapUsedGrowthAlertMbPerMin: ws.thresholds.heapUsedGrowthAlertMbPerMin,
              heapUsedGrowthRecoveryMbPerMin: ws.thresholds.heapUsedGrowthRecoveryMbPerMin,
              sustainSamples: ws.thresholds.sustainSamples,
              slopeWindowSamples: ws.thresholds.slopeWindowSamples,
            },
            current: {
              rssMb: ws.current.rssMb,
              externalGrowthMbPerMin: ws.current.externalGrowthMbPerMin,
              consecutiveRssOver: ws.current.consecutiveRssOver,
              consecutiveSlopeOver: ws.current.consecutiveSlopeOver,
              heapUsedGrowthMbPerMin: ws.current.heapUsedGrowthMbPerMin,
              consecutiveHeapOver: ws.current.consecutiveHeapOver,
            },
            alerts: {
              rssAlertActive: ws.alerts.rssAlertActive,
              slopeAlertActive: ws.alerts.slopeAlertActive,
              heapUsedAlertActive: ws.alerts.heapUsedAlertActive,
            },
          };
        })(),
      };
    },
  );

  // ── Memory hourly history ──────────────────────────────────────────────────
  r.get(
    "/diagnostics/memory/history",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Memory hourly snapshot history",
        querystring: z.object({
          hours: z.coerce.number().int().min(1).max(168).default(24),
        }),
        response: {
          200: z.object({
            snapshots: z.array(z.object({
              id: z.number(),
              snapshotAt: z.string(),
              rssMb: z.number(),
              heapUsedMb: z.number(),
              heapTotalMb: z.number(),
              externalMb: z.number(),
              heapUsedGrowthMbPerMin: z.number().nullable(),
              externalGrowthMbPerMin: z.number().nullable(),
              namedStores: z.array(z.object({
                name: z.string(),
                size: z.number(),
                peak: z.number(),
              })),
            })),
            totalRows: z.number(),
            rangeHours: z.number(),
          }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req) => {
      const { hours } = req.query;
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      const rows = await db
        .select()
        .from(schema.memoryHourlySnapshotsTable)
        .where(
          (await import("drizzle-orm").then(({ gte }) => gte))(
            schema.memoryHourlySnapshotsTable.snapshotAt,
            since,
          ),
        )
        .orderBy(schema.memoryHourlySnapshotsTable.snapshotAt);
      return {
        snapshots: rows.map((r) => ({
          id: r.id,
          snapshotAt: r.snapshotAt.toISOString(),
          rssMb: r.rssMb ?? 0,
          heapUsedMb: r.heapUsedMb ?? 0,
          heapTotalMb: r.heapTotalMb ?? 0,
          externalMb: r.externalMb ?? 0,
          heapUsedGrowthMbPerMin: r.heapUsedGrowthMbPerMin ?? null,
          externalGrowthMbPerMin: r.externalGrowthMbPerMin ?? null,
          namedStores: (r.namedStores as Array<{ name: string; size: number; peak: number }>) ?? [],
        })),
        totalRows: rows.length,
        rangeHours: hours,
      };
    },
  );

  // ── Force GC (requires --expose-gc) ───────────────────────────────────────
  r.post(
    "/diagnostics/gc",
    {
      preHandler: requireAuth("admin"),
      // GC is a stop-the-world operation that pauses all JS execution.
      // Capped at 4/hour to prevent malicious or runaway scripts from
      // continuously stalling the event loop.
      config: { rateLimit: { max: 4, timeWindow: "1 hour" } },      schema: {
        tags: ["admin-ops"],
        summary: "Force a synchronous GC cycle (501 if --expose-gc not set)",
        response: {
          200: ForceGcResultSchema,
          501: z.object({ message: z.string() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (_req, reply) => {
      const g = (globalThis as { gc?: () => void }).gc;
      if (typeof g !== "function") {
        reply.code(501);
        return {
          message:
            "GC unavailable: process must be started with --expose-gc to force collection",
        };
      }
      const before = memSnapshot();
      const t0 = performance.now();
      g();
      const elapsedMs = Math.round(performance.now() - t0);
      const after = memSnapshot();
      return {
        ok: true as const,
        elapsedMs,
        before,
        after,
        reclaimedMb: {
          rss: Math.round((before.rssMb - after.rssMb) * 100) / 100,
          heapUsed: Math.round((before.heapUsedMb - after.heapUsedMb) * 100) / 100,
          external: Math.round((before.externalMb - after.externalMb) * 100) / 100,
          arrayBuffers:
            Math.round((before.arrayBuffersMb - after.arrayBuffersMb) * 100) / 100,
        },
      };
    },
  );

  // ── Heap snapshot download (real, streamed) ───────────────────────────────
  r.post(
    "/diagnostics/heap-snapshot",
    {
      preHandler: requireAuth("admin"),
      // Heap snapshots can be hundreds of MiB; streaming them pins Node
      // memory for seconds. Limit to 2/hour so a compromised editor
      // account cannot use this to OOM the server.
      config: { rateLimit: { max: 2, timeWindow: "1 hour" } },      schema: {
        tags: ["admin-ops"],
        summary: "v8.getHeapSnapshot() streamed as application/octet-stream",
        // Binary streaming response — ZodTypeProvider cannot type-check a
        // Readable stream body, so no response schema is declared here.
        // The 429 case is enforced by the rate-limit plugin at the plugin level.
        security: [{ bearerAuth: [] }],
      },
    },
    async (_req, reply) => {
      const filename = `heap-${new Date().toISOString().replace(/[:.]/g, "-")}.heapsnapshot`;
      reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", `attachment; filename="${filename}"`)
        .header("x-snapshot-filename", filename)
        .header("cache-control", "no-store");
      // v8.getHeapSnapshot() returns a Readable. Pipe directly to the reply
      // so even multi-hundred-MiB snapshots stream without buffering.
      const snap: Readable = v8.getHeapSnapshot();
      return reply.send(snap);
    },
  );

  // ── Active uploads ────────────────────────────────────────────────────────
  // Reads from the same in-memory registry that the multipart-upload
  // gateway (`modules/media-uploads`) writes into when `s3-multipart-init`
  // succeeds. Surfaces every in-flight session for the admin Operations
  // tab. Per-part progress isn't tracked server-side (the browser PUTs
  // each part directly to S3), so we report 0 received chunks until the
  // session is removed on `s3-multipart-complete` / `-abort`.
  r.get(
    "/uploads/active",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Active S3 multipart upload sessions",
        response: { 200: ActiveUploadsResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const now = Date.now();
      const list = uploadSessions.list();
      return {
        count: list.length,
        sessions: list.map((s) => {
          const ageSecs = Math.max(0, Math.floor((now - s.startedAt) / 1000));
          return {
            sessionId: s.sessionId,
            title: s.title,
            originalFilename: null,
            category: "",
            totalBytes: s.sizeBytes,
            receivedBytes: 0,
            totalChunks: s.totalParts,
            uploadedChunks: 0,
            progressPercent: 0,
            ageSecs,
            idleSecs: ageSecs,
            finalizing: !!s.completedVideoId,
            createdAt: new Date(s.startedAt).toISOString(),
            lastActivity: new Date(s.startedAt).toISOString(),
          };
        }),
      };
    },
  );

  // Cancel an upload session — accepts the URL the admin SPA uses
  // (`DELETE /admin/videos/upload/:sessionId`).
  //
  // Handles DB-based chunked sessions (the primary upload path since the
  // S3 multipart path was replaced). Immediately frees all chunk data from
  // storage_blobs and upload_chunks so the operator doesn't have to wait
  // for the 48-hour stale-session GC sweep.
  //
  // Status rules:
  //   uploading  → cancelled immediately (chunks + parts deleted)
  //   assembling → 409 (background assembly is in flight — cannot abort safely)
  //   completed  → 409 (use the video delete route instead)
  r.delete(
    "/videos/upload/:sessionId",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Cancel and clean up an in-progress upload session",
        params: z.object({ sessionId: z.string().min(1) }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          409: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { sessionId } = req.params;

      const session = await db
        .select({
          status: schema.uploadSessionsTable.status,
          uploadId: schema.uploadSessionsTable.uploadId,
          storageBackend: schema.uploadSessionsTable.storageBackend,
        })
        .from(schema.uploadSessionsTable)
        .where(eq(schema.uploadSessionsTable.sessionId, sessionId))
        .limit(1)
        .then((r) => r[0]);

      // Session already gone — idempotent OK.
      if (!session) return { ok: true as const };

      if (session.status === "assembling") {
        return reply.code(409).send({
          error:
            "Assembly is in progress for this session — cannot cancel now. " +
            "Poll /finalize-status until it completes, then delete the video if unwanted.",
        });
      }

      if (session.status === "completed") {
        return reply.code(409).send({
          error:
            "This session has already been completed. " +
            "Use the video delete route to remove the resulting video.",
        });
      }

      // Delete chunks first (FK dependency), then any orphaned multipart
      // part rows from storage_blobs, then the session row itself.
      await db
        .delete(schema.uploadChunksTable)
        .where(eq(schema.uploadChunksTable.sessionId, sessionId))
        .catch(() => {});

      if (session.uploadId) {
        const partPrefix = `_parts/${session.uploadId}/`;
        await db
          .execute(sql`DELETE FROM storage_blobs WHERE starts_with(key, ${partPrefix})`)
          .catch(() => {});
      }

      await db
        .delete(schema.uploadSessionsTable)
        .where(eq(schema.uploadSessionsTable.sessionId, sessionId))
        .catch(() => {});

      req.log.info(
        { sessionId, storageBackend: session.storageBackend },
        "[admin-ops] upload session cancelled and cleaned up",
      );

      return { ok: true as const };
    },
  );

  r.get(
    "/uploads/s3-telemetry/summary",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Upload session telemetry rollup (completed/failed/in-progress, with throughput stats)",
        querystring: z.object({ hours: z.coerce.number().int().positive().default(24) }),
        response: { 200: S3TelemetrySummarySchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { hours } = req.query;
      const since = new Date(Date.now() - hours * 3600 * 1000);
      const sinceIso = since.toISOString();

      // Percentile helper (used by both code paths below)
      function percentile(arr: number[], p: number): number | null {
        if (arr.length === 0) return null;
        const sorted = [...arr].sort((a, b) => a - b);
        const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
        return Math.round(sorted[idx]!);
      }

      // Primary path: aggregate from s3_upload_telemetry which has accurate
      // per-event records (init / success / server_fail) and measured throughput.
      // Fallback to upload_sessions when the telemetry table is empty (e.g.
      // early in a new deployment before any events have been recorded).
      const telemetryRows = await db
        .select({
          event: schema.s3UploadTelemetryTable.event,
          sizeBytes: schema.s3UploadTelemetryTable.sizeBytes,
          throughputBps: schema.s3UploadTelemetryTable.throughputBps,
          errorKind: schema.s3UploadTelemetryTable.errorKind,
        })
        .from(schema.s3UploadTelemetryTable)
        .where(sql`${schema.s3UploadTelemetryTable.createdAt} >= ${since}`)
        .catch(() => [] as Array<{
          event: string;
          sizeBytes: number | null;
          throughputBps: number | null;
          errorKind: string | null;
        }>);

      if (telemetryRows.length > 0) {
        // Use telemetry data (accurate server-side events)
        const counts: Record<string, number> = {};
        let successes = 0, failures = 0;
        const completedBps: number[] = [];
        let totalBytes = 0;
        const errorKindCounts: Record<string, number> = {};

        for (const row of telemetryRows) {
          counts[row.event] = (counts[row.event] ?? 0) + 1;
          if (row.event === "success") {
            successes++;
            totalBytes += row.sizeBytes ?? 0;
            if (row.throughputBps != null && row.throughputBps > 0) {
              completedBps.push(row.throughputBps);
            }
          } else if (row.event === "server_fail") {
            failures++;
            if (row.errorKind) {
              errorKindCounts[row.errorKind] = (errorKindCounts[row.errorKind] ?? 0) + 1;
            }
          }
        }

        const inits = counts["init"] ?? 0;
        const attempts = inits > 0 ? inits : successes + failures;
        const successRatePct = attempts > 0 ? Math.round((successes / attempts) * 1_000) / 10 : null;

        const topErrors = Object.entries(errorKindCounts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([kind, count]) => ({ errorKind: kind, errorMessage: null, count }));

        return {
          windowHours: hours,
          since: sinceIso,
          counts,
          attempts,
          successes,
          failures,
          successRatePct,
          throughput: {
            p50Bps: percentile(completedBps, 50),
            p95Bps: percentile(completedBps, 95),
            avgSizeBytes: successes > 0 ? Math.round(totalBytes / successes) : null,
            totalBytes: successes > 0 ? totalBytes : null,
          },
          topErrors,
        };
      }

      // Fallback: derive stats from upload_sessions (pre-telemetry deployments
      // or when telemetry table has no data for the requested window).
      const rows = await db
        .select({
          status: schema.uploadSessionsTable.status,
          storageBackend: schema.uploadSessionsTable.storageBackend,
          sizeBytes: schema.uploadSessionsTable.sizeBytes,
          createdAt: schema.uploadSessionsTable.createdAt,
          updatedAt: schema.uploadSessionsTable.updatedAt,
        })
        .from(schema.uploadSessionsTable)
        .where(sql`${schema.uploadSessionsTable.createdAt} >= ${since}`)
        .catch(() => [] as Array<{
          status: string;
          storageBackend: string;
          sizeBytes: number;
          createdAt: Date;
          updatedAt: Date;
        }>);

      const counts: Record<string, number> = {};
      let successes = 0, failures = 0;
      const completedBps: number[] = [];
      let totalBytes = 0;

      for (const row of rows) {
        const key = `${row.storageBackend}:${row.status}`;
        counts[key] = (counts[key] ?? 0) + 1;
        if (row.status === "completed" || row.status === "finalized") {
          successes++;
          totalBytes += row.sizeBytes ?? 0;
          const elapsedMs = (row.updatedAt?.getTime() ?? Date.now()) - (row.createdAt?.getTime() ?? Date.now());
          if (elapsedMs > 1_000 && row.sizeBytes > 0) {
            completedBps.push((row.sizeBytes * 1_000) / elapsedMs);
          }
        } else if (row.status === "failed" || row.status === "cancelled") {
          failures++;
        }
      }

      const attempts = rows.length;
      const successRatePct = attempts > 0 ? Math.round((successes / attempts) * 1_000) / 10 : null;

      return {
        windowHours: hours,
        since: sinceIso,
        counts,
        attempts,
        successes,
        failures,
        successRatePct,
        throughput: {
          p50Bps: percentile(completedBps, 50),
          p95Bps: percentile(completedBps, 95),
          avgSizeBytes: successes > 0 ? Math.round(totalBytes / successes) : null,
          totalBytes: successes > 0 ? totalBytes : null,
        },
        topErrors: [],
      };
    },
  );

  // ── Transcoding queue (FFmpeg HLS pipeline) ───────────────────────────────
  // Wired to the in-process FFmpeg dispatcher
  // (modules/transcoder/transcoder.dispatcher.ts) and the queue helpers
  // in transcoder.queue.ts. The dispatcher polls `transcoding_jobs` every
  // TRANSCODER_POLL_MS (default 10s); these routes give the admin SPA
  // read + control over that queue.
  r.get(
    "/transcoding/queue",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Transcoding queue + per-day stats",
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(500).optional(),
          status: z.string().min(1).optional(),
        }),
        response: { 200: TranscodingQueueSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const q = req.query;
      const [rows, stats] = await Promise.all([
        listJobs({ limit: q.limit, status: q.status }),
        queueStats(),
      ]);
      return {
        jobs: rows.map(projectTranscodingJob),
        stats,
        transcoderDisabled: false,
      };
    },
  );

  r.get(
    "/transcoding/jobs/:jobId",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Transcoding job detail",
        params: z.object({ jobId: z.string().min(1) }),
        response: {
          200: TranscodingJobSchema,
          404: z.object({ message: z.string(), code: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { jobId } = req.params;
      const job = await getJob(jobId);
      if (!job) {
        reply.code(404);
        return { message: "Transcoding job not found", code: "JOB_NOT_FOUND" };
      }
      return projectTranscodingJob(job);
    },
  );

  // Retry a job — POST and DELETE both supported because the admin SPA
  // historically used DELETE on the retry path; we keep both verbs to
  // avoid client breakage.
  for (const verb of ["post", "delete"] as const) {
    r[verb](
      "/transcoding/retry/:id",
      {
        preHandler: requireAuth("editor"),
        config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
        schema: {
          tags: ["admin-ops"],
          summary: "Re-arm a transcoding job (resets attempts + clears error)",
          params: z.object({ id: z.string().min(1).max(128) }),
          response: {
            200: z.object({ ok: z.literal(true) }),
            404: z.object({ message: z.string() }),
            429: z.object({ error: z.string() }),
          },
          security: [{ bearerAuth: [] }],
        },
      },
      async (req, reply) => {
        const { id } = req.params;
        const ok = await retryJob(id);
        if (!ok) {
          reply.code(404);
          return { message: "Transcoding job not found" };
        }
        transcoderDispatcher.nudge();
        adminEventBus.push("videos-library-updated", { reason: "single-job-retry", jobId: id });
        adminEventBus.push("broadcast-queue-updated", { reason: "single-job-retry", jobId: id });
        return { ok: true as const };
      },
    );
  }
  // Batch-retry all failed transcoding jobs in one click.
  // Re-arms every row with status="failed" to status="queued" (attempts reset,
  // errorMessage cleared) and nudges the dispatcher to pick them up immediately.
  r.post(
    "/transcoding/retry-failed",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Re-arm all failed transcoding jobs (batch retry)",
        response: {
          200: z.object({ ok: z.literal(true), retried: z.number() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (_req, _reply) => {
      const retried = await retryAllFailed();
      if (retried > 0) {
        transcoderDispatcher.nudge();
        // Notify admin UI immediately so the queue panel refreshes without waiting
        // for the next SSE heartbeat or polling interval.
        adminEventBus.push("transcoding-update", { type: "bulk-retry", retried });
        adminEventBus.push("videos-library-updated", { reason: "bulk-retry-failed" });
        // Re-queued jobs may immediately become playable — signal the broadcast
        // engine to reload so it picks them up without waiting for the next
        // scheduled validator cycle (up to 10 minutes away).
        adminEventBus.push("broadcast-queue-updated", { reason: "bulk-retry-failed" });
      }
      return { ok: true as const, retried };
    },
  );

  r.post(
    "/transcoding/cancel/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Cancel a queued or failed transcoding job (cannot cancel in-progress jobs)",
        params: z.object({ id: z.string().min(1).max(128) }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          404: z.object({ message: z.string() }),
          409: z.object({ message: z.string(), reason: z.string() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const result = await cancelJob(id);
      if (!result.ok) {
        if (result.reason === "not_found") {
          reply.code(404);
          return { message: "Transcoding job not found" };
        }
        if (result.reason === "processing") {
          reply.code(409);
          return {
            message: "Job is currently being processed by FFmpeg and cannot be cancelled. Wait for it to finish or time out.",
            reason: "processing",
          };
        }
        reply.code(409);
        return {
          message: "Job is already in a terminal state and cannot be cancelled.",
          reason: result.reason ?? "terminal",
        };
      }
      return { ok: true as const };
    },
  );
  r.delete(
    "/transcoding/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Delete a transcoding job row (does not touch the source video)",
        params: z.object({ id: z.string().min(1).max(128) }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          404: z.object({ message: z.string() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const ok = await deleteJob(id);
      if (!ok) {
        reply.code(404);
        return { message: "Transcoding job not found" };
      }
      return { ok: true as const };
    },
  );
  r.post(
    "/transcoding/requeue/:videoId",
    {
      preHandler: requireAuth("editor"),
      // Submitting a requeue spawns a real FFmpeg process. 10/min prevents
      // editors from accidentally flooding the transcoder queue.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Re-queue a video for transcoding (idempotent on existing jobs)",
        params: z.object({ videoId: z.string().min(1).max(128) }),
        body: z.object({ priority: z.number().int().optional() }).optional(),
        response: {
          200: z.object({ id: z.string(), reused: z.boolean() }),
          404: z.object({ message: z.string() }),
          409: z.object({ message: z.string(), code: z.string() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { videoId } = req.params;
      const body = (req.body ?? {}) as { priority?: number };

      const rows = await db
        .select({
          id: schema.videosTable.id,
          objectPath: schema.videosTable.objectPath,
          localVideoUrl: schema.videosTable.localVideoUrl,
          videoSource: schema.videosTable.videoSource,
        })
        .from(schema.videosTable)
        .where(eq(schema.videosTable.id, videoId))
        .limit(1);

      const video = rows[0];
      if (!video) {
        reply.code(404);
        return { message: "Video not found" };
      }
      // Prefer the explicit object key. Fall back to localVideoUrl when
      // the row only has the legacy URL form (older uploads). Refuse
      // YouTube-sourced rows — they have no source bytes to encode.
      const sourceKey = video.objectPath ?? video.localVideoUrl ?? null;
      if (!sourceKey || video.videoSource !== "local") {
        reply.code(409);
        return {
          message: "Video has no local source to transcode",
          code: "NO_LOCAL_SOURCE",
        };
      }
      const result = await enqueueTranscode({
        videoId,
        videoPath: sourceKey,
        priority: body.priority,
      });
      transcoderDispatcher.nudge();
      return result;
    },
  );
  r.delete(
    "/transcoding/clear",
    {
      // Bulk delete is a destructive admin-only action — require admin, not just editor.
      preHandler: requireAuth("admin"),
      // Bulk delete — 3/min keeps it operator-controlled only.
      config: { rateLimit: { max: 3, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Bulk-delete transcoding jobs by status (admin only; active jobs are never deleted)",
        querystring: z.object({
          status: z.enum(["done", "failed", "cancelled", "all"]),
        }),
        response: {
          200: z.object({ cleared: z.number() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { status } = req.query;
      const cleared = await clearJobsByStatus(status);
      // Notify the admin UI that the job list changed so it refreshes immediately.
      if (cleared > 0) {
        adminEventBus.push("transcoding-update", { type: "bulk-cleared", status, cleared });
        // Cleared jobs change the visible video library state (status badges reset)
        // and may free up queue slots — notify both channels so the Video Library
        // and broadcast engine panels refresh immediately without waiting for polling.
        adminEventBus.push("videos-library-updated", { reason: "bulk-cleared", status });
        adminEventBus.push("broadcast-queue-updated", { reason: "bulk-cleared", status });
      }
      return { cleared };
    },
  );

  // ── YouTube quota — real in-process tracker with DB persistence ──────────
  r.get(
    "/youtube/quota",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "YouTube Data API v3 daily quota usage",
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            used: z.number(),
            total: z.number(),
            resetsAt: z.string(),
            operations: z.array(z.object({
              operation: z.string(),
              cost: z.number(),
              count: z.number(),
            })),
          }),
        },
      },
    },
    async () => {
      const { getQuotaStatus } = await import("../youtube-sync/youtube-sync.service.js");
      return getQuotaStatus();
    },
  );
  r.get(
    "/youtube/quota/history",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "YouTube quota daily history (tracker disabled, returns empty)",
        response: { 200: YouTubeQuotaHistorySchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({
      dailyTotals: [],
      todayByContext: [],
      dailyLimit: env.YOUTUBE_QUOTA_DAILY_LIMIT,
    }),
  );

  // ── GET /admin/alerts — aggregate list for the Alerts page ───────────────
  r.get(
    "/alerts",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "List system alerts sourced from emergency_alerts table",
        response: {
          200: z.object({
            alerts: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                message: z.string(),
                severity: z.enum(["info", "warning", "error", "critical"]),
                source: z.string(),
                resolvedAt: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      try {
        const rows = await db
          .select()
          .from(schema.emergencyAlertsTable)
          .orderBy(desc(schema.emergencyAlertsTable.createdAt))
          .limit(100);

        const alerts = rows.map((row) => ({
          id: row.id,
          title: row.title,
          message: row.message,
          // emergency maps to critical for the admin UI severity enum
          severity: (row.severity === "emergency" ? "critical" : row.severity) as
            "info" | "warning" | "error" | "critical",
          source: "emergency_broadcast",
          resolvedAt: row.dismissedAt?.toISOString() ?? null,
          createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
        }));

        return { alerts };
      } catch {
        return { alerts: [] };
      }
    },
  );

  // ── GET /admin/system/metrics — live system resource snapshot ─────────────
  r.get(
    "/system/metrics",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Live system resource metrics: CPU load, memory, uptime, connections",
        response: {
          200: z.object({
            cpu: z.number(),
            memoryUsedMb: z.number(),
            memoryTotalMb: z.number(),
            diskUsedGb: z.number(),
            diskTotalGb: z.number(),
            uptimeSec: z.number(),
            version: z.string(),
            nodeVersion: z.string(),
            activeSseConnections: z.number(),
            activeWsConnections: z.number(),
            requestsPerMinute: z.number(),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const m = process.memoryUsage();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const cpuLoad = os.loadavg()[0] ?? 0;
      const cpuCount = os.cpus().length || 1;
      return {
        cpu: Math.min(100, Math.round((cpuLoad / cpuCount) * 100)),
        memoryUsedMb: mb(totalMem - freeMem),
        memoryTotalMb: mb(totalMem),
        diskUsedGb: Math.round(mb(m.rss) / 1024 * 100) / 100,
        diskTotalGb: 0,
        uptimeSec: uptimeSec(),
        version: env.APP_VERSION ?? process.env.npm_package_version ?? "1.0.20",
        nodeVersion: process.version,
        activeSseConnections: sseCounter.get(),
        activeWsConnections: wsCounter.get(),
        requestsPerMinute: 0,
      };
    },
  );

  // ── Playback Configuration (admin-facing HLS/CDN/ABR settings) ────────────
  const PLAYBACK_CONFIG_KEYS = [
    "playback:mode",
    "playback:cdnEnabled",
    "playback:adaptiveBitrate",
    "playback:maxBitrate",
    "playback:defaultQuality",
    "playback:cacheEnabled",
    "playback:hlsSegmentDuration",
  ];
  const PLAYBACK_CONFIG_DEFAULTS: Record<string, string> = {
    "playback:mode": "hls",
    "playback:cdnEnabled": "false",
    "playback:adaptiveBitrate": "true",
    "playback:maxBitrate": "0",
    "playback:defaultQuality": "auto",
    "playback:cacheEnabled": "true",
    "playback:hlsSegmentDuration": "6",
  };

  function parsePlaybackConfig(rows: { key: string; value: string }[]) {
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;
    const get = (k: string) => map[k] ?? PLAYBACK_CONFIG_DEFAULTS[k] ?? "";
    return {
      mode: get("playback:mode"),
      cdnEnabled: get("playback:cdnEnabled") === "true",
      adaptiveBitrate: get("playback:adaptiveBitrate") !== "false",
      maxBitrate: parseInt(get("playback:maxBitrate"), 10) || 0,
      defaultQuality: get("playback:defaultQuality"),
      cacheEnabled: get("playback:cacheEnabled") !== "false",
      hlsSegmentDuration: parseInt(get("playback:hlsSegmentDuration"), 10) || 6,
    };
  }

  r.get(
    "/playback/config",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Get HLS/CDN/ABR playback configuration",
        response: {
          200: z.object({
            mode: z.string(),
            cdnEnabled: z.boolean(),
            adaptiveBitrate: z.boolean(),
            maxBitrate: z.number(),
            defaultQuality: z.string(),
            cacheEnabled: z.boolean(),
            hlsSegmentDuration: z.number(),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const rows = await db
        .select({ key: schema.appConfigTable.key, value: schema.appConfigTable.value })
        .from(schema.appConfigTable)
        .where(inArray(schema.appConfigTable.key, PLAYBACK_CONFIG_KEYS));
      return parsePlaybackConfig(rows);
    },
  );

  r.patch(
    "/playback/config",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Update HLS/CDN/ABR playback configuration",
        body: z.object({
          mode: z.string().max(64).optional(),
          cdnEnabled: z.boolean().optional(),
          adaptiveBitrate: z.boolean().optional(),
          // Cap at 100 Mbps — above that no HLS player can consume it anyway.
          maxBitrate: z.number().int().positive().max(100_000_000).optional(),
          defaultQuality: z.string().max(32).optional(),
          cacheEnabled: z.boolean().optional(),
          // HLS segment duration: 1–60 s is the valid range for all players.
          hlsSegmentDuration: z.number().int().positive().max(60).optional(),
        }),
        response: {
          200: z.object({
            mode: z.string(),
            cdnEnabled: z.boolean(),
            adaptiveBitrate: z.boolean(),
            maxBitrate: z.number(),
            defaultQuality: z.string(),
            cacheEnabled: z.boolean(),
            hlsSegmentDuration: z.number(),
          }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const updates: { key: string; value: string }[] = [];
      const b = req.body;
      if (b.mode !== undefined) updates.push({ key: "playback:mode", value: String(b.mode) });
      if (b.cdnEnabled !== undefined) updates.push({ key: "playback:cdnEnabled", value: String(b.cdnEnabled) });
      if (b.adaptiveBitrate !== undefined) updates.push({ key: "playback:adaptiveBitrate", value: String(b.adaptiveBitrate) });
      if (b.maxBitrate !== undefined) updates.push({ key: "playback:maxBitrate", value: String(b.maxBitrate) });
      if (b.defaultQuality !== undefined) updates.push({ key: "playback:defaultQuality", value: String(b.defaultQuality) });
      if (b.cacheEnabled !== undefined) updates.push({ key: "playback:cacheEnabled", value: String(b.cacheEnabled) });
      if (b.hlsSegmentDuration !== undefined) updates.push({ key: "playback:hlsSegmentDuration", value: String(b.hlsSegmentDuration) });

      for (const u of updates) {
        await db
          .insert(schema.appConfigTable)
          .values({ key: u.key, value: u.value, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: schema.appConfigTable.key,
            set: { value: u.value, updatedAt: new Date() },
          });
      }

      const rows = await db
        .select({ key: schema.appConfigTable.key, value: schema.appConfigTable.value })
        .from(schema.appConfigTable)
        .where(inArray(schema.appConfigTable.key, PLAYBACK_CONFIG_KEYS));
      return parsePlaybackConfig(rows);
    },
  );

  // ── Alerts (dispatcher not wired in this build) ───────────────────────────
  r.get(
    "/alerts/status",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Alert dispatcher status (Slack/webhook not configured in build)",
        response: { 200: AlertingStatusSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({
      channels: { slack: false, webhook: false },
      configured: false,
      lastDelivery: null,
    }),
  );
  r.post(
    "/alerts/test",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Send a test alert (no-op: dispatcher not configured)",
        response: {
          200: AlertTestResultSchema,
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({
      slack: "disabled" as const,
      webhook: "disabled" as const,
      dedupKey: null,
      deduped: false,
    }),
  );
  r.get(
    "/alerts/history",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Alert delivery history sourced from emergency_alerts table",
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(500).optional(),
        }),
        response: { 200: AlertHistoryResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const limit = req.query.limit ?? 200;
      try {
        const rows = await db
          .select()
          .from(schema.emergencyAlertsTable)
          .orderBy(desc(schema.emergencyAlertsTable.createdAt))
          .limit(limit);

        const entries = rows.map((row) => ({
          at: row.createdAt?.toISOString() ?? new Date().toISOString(),
          title: row.title,
          message: row.message,
          severity: (row.severity === "emergency" ? "critical" : row.severity) as
            "info" | "warning" | "critical",
          fields: [] as { label: string; value: string }[],
          slack: "disabled" as const,
          webhook: "disabled" as const,
          deduped: false,
          dedupKey: null,
        }));

        return { entries, count: entries.length };
      } catch {
        return { entries: [], count: 0 };
      }
    },
  );

  // ── POST /admin/alerts/:id/resolve ────────────────────────────────────────
  r.post(
    "/alerts/:id/resolve",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Dismiss/resolve an emergency alert by ID",
        params: z.object({ id: z.string().min(1).max(128) }),
        response: {
          200: z.object({ ok: z.literal(true), resolvedAt: z.string() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const now = new Date();
      try {
        await db
          .update(schema.emergencyAlertsTable)
          .set({ dismissedAt: now, isActive: false })
          .where(eq(schema.emergencyAlertsTable.id, req.params.id));
      } catch {
        // Non-fatal — alert may not exist
      }
      return { ok: true as const, resolvedAt: now.toISOString() };
    },
  );

  // ── Live overrides — admin-side paths ─────────────────────────────────────
  // The /api/v1/live module exposes the public `/status` and operator
  // `/start` `/stop` `/recent` actions. The admin SPA additionally calls
  // a richer set of `/admin/live*` endpoints (legacy paths) for the Live
  // Control panel. These are now wired to `liveOverridesService` — the
  // same real DB-backed service used by the canonical /live routes.

  const LiveOverrideShape = z.object({
    id: z.string(),
    title: z.string(),
    isActive: z.boolean(),
    hlsStreamUrl: z.string().nullable(),
    youtubeVideoId: z.string().nullable(),
    rtmpIngestKey: z.string().nullable(),
    streamNotes: z.string().nullable(),
    startedAt: z.string(),
    endsAt: z.string().nullable(),
    scheduledFor: z.string().nullable(),
    autoStarted: z.boolean(),
    createdAt: z.string(),
  });
  const ScheduledOverrideShape = z.object({
    id: z.string(),
    title: z.string(),
    youtubeVideoId: z.string().nullable(),
    hlsStreamUrl: z.string().nullable(),
    scheduledFor: z.string().nullable(),
    endsAt: z.string().nullable(),
    streamNotes: z.string().nullable(),
    autoStarted: z.boolean(),
    createdAt: z.string(),
  });

  r.get(
    "/live-overrides",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "List recent live overrides (admin Live Control)",
        response: { 200: z.array(LiveOverrideShape) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const { items } = await liveOverridesService.listRecent();
      return items;
    },
  );

  r.get(
    "/live-overrides/recent-youtube",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Recent YouTube streams used in live overrides (audit dropdown)",
        response: {
          200: z.object({
            items: z.array(
              z.object({
                videoId: z.string(),
                url: z.string(),
                title: z.string(),
                thumbnailUrl: z.string(),
                lastBroadcastAt: z.string().nullable(),
              }),
            ),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      try {
        const rows = await db
          .select({
            youtubeVideoId: schema.liveOverridesTable.youtubeVideoId,
            title: schema.liveOverridesTable.title,
            startedAt: schema.liveOverridesTable.startedAt,
          })
          .from(schema.liveOverridesTable)
          .where(isNotNull(schema.liveOverridesTable.youtubeVideoId))
          .orderBy(desc(schema.liveOverridesTable.startedAt))
          .limit(20);

        // Deduplicate by youtubeVideoId, keeping most recent occurrence
        const seen = new Set<string>();
        const items = rows
          .filter((r) => {
            if (!r.youtubeVideoId || seen.has(r.youtubeVideoId)) return false;
            seen.add(r.youtubeVideoId);
            return true;
          })
          .map((r) => {
            const vid = r.youtubeVideoId!;
            return {
              videoId: vid,
              url: `https://www.youtube.com/watch?v=${vid}`,
              title: r.title,
              thumbnailUrl: `https://img.youtube.com/vi/${vid}/mqdefault.jpg`,
              lastBroadcastAt: r.startedAt?.toISOString() ?? null,
            };
          });

        return { items };
      } catch {
        return { items: [] };
      }
    },
  );

  r.post(
    "/live/override/start",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Start a live override (HLS URL or YouTube video ID)",
        body: StartOverrideBodySchema,
        response: {
          201: LiveOverrideShape,
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const created = await liveOverridesService.start(req.body);
      reply.code(201);
      return created;
    },
  );

  r.post(
    "/live/override/stop",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Stop the currently-active live override",
        response: {
          200: LiveOverrideShape,
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => liveOverridesService.stop(),
  );

  r.post(
    "/live/override/extend",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Extend the active live override's end time by N minutes",
        body: z.object({ extraMinutes: z.number().int().positive().max(720) }),
        response: {
          200: LiveOverrideShape,
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => liveOverridesService.extend(req.body.extraMinutes),
  );

  r.post(
    "/live/override/preview-youtube",
    {
      preHandler: requireAuth("editor"),
      // Makes an outbound HTTP probe to YouTube. 20/min prevents editors
      // from using this as a SSRF relay or hammering YouTube's API.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Validate a YouTube URL and return metadata (lightweight probe)",
        body: z.object({ url: z.string().max(2048) }),
        response: {
          200: z.object({
            ok: z.boolean(),
            videoId: z.string().nullable().optional(),
            error: z.string().optional(),
            reason: z.string().nullable().optional(),
          }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { url } = req.body;
      const ytIdRe = /^[A-Za-z0-9_-]{11}$/;
      let videoId: string | null = null;
      try {
        const u = new URL(url.trim());
        if (u.hostname.endsWith("youtu.be")) {
          const id = u.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
          if (ytIdRe.test(id)) videoId = id;
        } else if (u.hostname.includes("youtube.com")) {
          const v = u.searchParams.get("v");
          if (v && ytIdRe.test(v)) {
            videoId = v;
          } else {
            const seg = u.pathname.split("/").filter(Boolean);
            const idx = seg.findIndex((p) => ["embed", "live", "shorts", "v"].includes(p));
            if (idx >= 0 && seg[idx + 1] && ytIdRe.test(seg[idx + 1]!)) {
              videoId = seg[idx + 1]!;
            }
          }
        } else if (ytIdRe.test(url.trim())) {
          videoId = url.trim();
        }
      } catch {
        if (ytIdRe.test(url.trim())) videoId = url.trim();
      }
      if (!videoId) {
        return { ok: false, videoId: null, reason: "Could not parse a YouTube video ID from the supplied URL" };
      }
      return { ok: true, videoId };
    },
  );

  r.post(
    "/live/override/schedule",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Schedule a future live override (sets scheduledFor, isActive=false)",
        body: StartOverrideBodySchema,
        response: {
          201: ScheduledOverrideShape,
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const created = await liveOverridesService.schedule(req.body);
      reply.code(201);
      return created;
    },
  );

  r.get(
    "/live/override/scheduled",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "List upcoming scheduled live overrides",
        response: { 200: z.object({ items: z.array(ScheduledOverrideShape) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => liveOverridesService.listScheduled(),
  );

  r.delete(
    "/live/override/schedule/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },      schema: {
        tags: ["admin-ops"],
        summary: "Cancel a scheduled live override",
        params: z.object({ id: z.string().min(1).max(128) }),
        response: {
          200: z.object({ ok: z.literal(true), id: z.string() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => liveOverridesService.cancelScheduled(req.params.id),
  );

  r.get(
    "/live/monitor",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Live monitor: current active override + recent override history",
        response: {
          200: z.object({
            current: z.object({
              isLive: z.boolean(),
              videoId: z.string().nullable(),
              title: z.string().nullable(),
              checkedAt: z.number(),
              staleSec: z.number(),
              detectionMethod: z.string().optional(),
              uptimeSecs: z.number(),
              liveSessionStartedAt: z.number().nullable(),
              viewerCount: z.number().nullable(),
            }),
            polling: z.object({
              intervalMs: z.number(),
              mode: z.enum(["normal", "burst"]),
              lastStateChangeAt: z.number(),
            }),
            history: z.array(
              z.object({
                ts: z.number(),
                isLive: z.boolean(),
                videoId: z.string().nullable(),
                title: z.string().nullable(),
                method: z.string().nullable(),
              }),
            ),
            viewerHistory: z.array(z.object({ ts: z.number(), count: z.number() })),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const status = await liveOverridesService.getStatus();
      const { items } = await liveOverridesService.listRecent(20);
      const active = status.active;
      return {
        current: {
          isLive: status.isLive,
          videoId: active?.youtubeVideoId ?? null,
          title: active?.title ?? null,
          checkedAt: Date.now(),
          staleSec: 0,
          detectionMethod: active ? "live-override" : "none",
          uptimeSecs: uptimeSec(),
          liveSessionStartedAt: active ? new Date(active.startedAt).getTime() : null,
          viewerCount: broadcastEngine.getViewerCount(),
        },
        polling: { intervalMs: 30_000, mode: "normal" as const, lastStateChangeAt: 0 },
        history: items.map((o) => ({
          ts: new Date(o.startedAt).getTime(),
          isLive: o.isActive,
          videoId: o.youtubeVideoId,
          title: o.title,
          method: "live-override",
        })),
        viewerHistory: [],
      };
    },
  );

  r.get(
    "/live",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Live status snapshot for the admin Live Control header",
        response: {
          200: z.object({
            isLive: z.boolean(),
            ytLive: z.boolean(),
            liveOverride: LiveOverrideShape.nullable(),
            viewerCount: z.number(),
            failureStats: passthrough.optional(),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const status = await liveOverridesService.getStatus();
      return {
        isLive: status.isLive,
        ytLive: status.isLive && Boolean(status.active?.youtubeVideoId),
        liveOverride: status.active,
        viewerCount: broadcastEngine.getViewerCount(),
      };
    },
  );

  // ── /admin/live/health ──────────────────────────────────────────────────
  // Lightweight summary the Live Control page polls for its top-of-page
  // status pill. Computed inline (no DB) so it stays cheap to poll on a
  // 5-second interval. Anything that requires a row scan should live in
  // the dedicated `/admin/live-ingest/*` endpoints, which are slower
  // but correct for the deeper diagnostics view.
  r.get(
    "/live/health",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Cheap live-pipeline health summary for the admin status pill",
        response: {
          200: z.object({
            status: z.enum(["healthy", "degraded", "unknown"]),
            viewerCount: z.number().int().nonnegative(),
            queueDepth: z.number().int().nonnegative(),
            currentItemId: z.string().nullable(),
            checkedAt: z.string(),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const snap = broadcastEngine.snapshot();
      const queueDepth = snap.upcoming.length + (snap.next ? 1 : 0) + (snap.current ? 1 : 0);
      // Status semantics:
      //   healthy  — at least a current item AND a next item queued
      //   degraded — current playing but nothing queued behind it (about to repeat)
      //   unknown  — no current item at all (engine empty / cold-start)
      const status: "healthy" | "degraded" | "unknown" =
        snap.current && snap.next
          ? "healthy"
          : snap.current
            ? "degraded"
            : "unknown";
      return {
        status,
        viewerCount: broadcastEngine.getViewerCount(),
        queueDepth,
        currentItemId: snap.current?.id ?? null,
        checkedAt: new Date().toISOString(),
      };
    },
  );

  // ── GET /admin/ingest/status ──────────────────────────────────────────────
  // Returns the current RTMP/HLS ingest endpoint configuration and live
  // encoder connection state. Reads from the liveIngestEndpointsTable so the
  // Live Ingest admin page has real data to display. Returns a safe stub when
  // no endpoints are configured yet.
  r.get(
    "/ingest/status",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Live ingest endpoint configuration and encoder connection state",
        response: {
          200: z.object({
            rtmpEndpoint: z.string(),
            hlsEndpoint: z.string(),
            isReceiving: z.boolean(),
            bitrateKbps: z.number().optional(),
            fps: z.number().optional(),
            resolution: z.string().optional(),
            encoderType: z.string().optional(),
            connectedAt: z.string().optional(),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      // Read the primary ingest endpoint from the DB if one is configured.
      const rows = await db
        .select()
        .from(schema.liveIngestEndpointsTable)
        .limit(10);
      const primary = rows.find((r) => r.isPrimary) ?? rows[0] ?? null;
      const rtmpEndpoint = primary?.ingestUrl ?? "rtmp://ingest.temple.tv/live";
      const hlsEndpoint = primary?.hlsPlaybackUrl ?? "/hls/live/master.m3u8";
      // Use health status + broadcast engine snapshot to determine if signal
      // is being received.
      const snap = broadcastEngine.snapshot();
      const isReceiving =
        (primary?.healthStatus === "healthy" || primary?.healthStatus === "degraded") &&
        snap.current != null;
      return {
        rtmpEndpoint,
        hlsEndpoint,
        isReceiving,
        ...(primary?.lastBitrateKbps != null ? { bitrateKbps: Math.round(primary.lastBitrateKbps) } : {}),
        ...(primary?.protocol ? { encoderType: primary.protocol.toUpperCase() } : {}),
        ...(primary?.lastHealthAt ? { connectedAt: primary.lastHealthAt.toISOString() } : {}),
      };
    },
  );

  // ── GET /admin/me ────────────────────────────────────────────────────────
  // Returns the currently-authenticated principal so the admin SPA can:
  //   1. Display the operator's email / role in the UI
  //   2. Enforce client-side RBAC (e.g. hide admin-only sidebar nav items
  //      from operators whose role is "editor")
  //
  // Works for both auth paths:
  //   - ADMIN_API_TOKEN static token → synthetic principal
  //     { id: "system:admin-token", email: "system@temple.tv", role: <ADMIN_API_TOKEN_ROLE> }
  //   - JWT session cookie           → real user row from requireAuth()
  app.get(
    "/me",
    {
      preHandler: [requireAuth("editor")],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        response: {
          200: z.object({ id: z.string(), email: z.string(), role: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req) => {
      return {
        id: req.principal!.id,
        email: req.principal!.email,
        role: req.principal!.role,
      };
    },
  );

  // ── POST /admin/session/auto ─────────────────────────────────────────────
  // Issues an admin_session cookie using the server's own ADMIN_API_TOKEN
  // env var — no credential input required from the operator.
  //
  // Security model: same-origin only.
  //   EventSource / XHR from a cross-origin page cannot set the
  //   X-Admin-CSRF: 1 header — the CORS preflight blocks custom headers.
  //   The admin SPA's configureAdminAccess() fetch interceptor injects
  //   this header automatically on every POST to /api/admin/*, so the
  //   check is satisfied transparently for same-origin callers.
  //
  // Returns 503 when ADMIN_API_TOKEN is not configured in the environment.
  // The auth gate surfaces this as a "misconfigured" error rather than
  // prompting for a key, so operators know to set the env var.
  // Rate-limit session/auto even though it's protected by the X-Admin-CSRF
  // header — double-protection against bots that forge the header value.
  // 10/min matches the manually-keyed /session endpoint.
  app.post("/session/auto", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { response: { 403: z.object({ error: z.string() }), 503: z.object({ error: z.string() }), 429: z.object({ error: z.string() }) } } }, async (req, reply) => {
    const csrfHeader = req.headers["x-admin-csrf"];
    if (csrfHeader !== "1") {
      reply.code(403).send({ error: "CSRF check failed" });
      return;
    }
    if (!env.ADMIN_API_TOKEN) {
      reply.code(503).send({ error: "ADMIN_API_TOKEN is not configured on the server" });
      return;
    }
    void reply.setCookie("admin_session", env.ADMIN_API_TOKEN, {
      httpOnly: true,
      // SameSite=None (prod) allows the admin SPA to send the cookie on
      // cross-origin requests when the SPA and API live on different origins
      // (e.g. temple-tv-admin.onrender.com → api.templetv.org.ng). Requires
      // Secure=true which is enforced by isProd(). In dev we stay Strict
      // because localhost → localhost is same-origin and Strict is more secure.
      // CSRF is still protected by the X-Admin-CSRF: 1 header double-proof
      // (CORS preflights block custom headers from untrusted origins) so
      // loosening SameSite doesn't introduce a CSRF vulnerability.
      sameSite: isProd() ? "none" : "strict",
      secure: isProd(),
      path: "/",
      maxAge: 7 * 86_400, // 7 days — ADMIN_API_TOKEN is static so cookie just needs to outlive user sessions
    });
    return { ok: true };
  });

  // ── POST /admin/session ──────────────────────────────────────────────────
  // Exchange a raw ADMIN_API_TOKEN or a signed JWT for an HttpOnly
  // session cookie. The cookie (`admin_session`) is:
  //   - HttpOnly: never readable by JavaScript → immune to XSS exfil
  //   - SameSite=Strict: not sent on cross-site navigations (CSRF safe)
  //   - Secure: only sent over HTTPS in production
  //   - Path=/: sent to all API routes
  //   - Max-Age=86400: 24-hour sliding window
  //
  // Once set, the admin SPA can drop the token from localStorage entirely.
  // All admin fetch calls with `credentials: "include"` will carry the
  // cookie automatically. The server's `requireAuth()` middleware accepts
  // both the Bearer header (for scripts / backwards compat) and this
  // cookie (for the SPA flow) in that priority order.
  //
  // SEC-02 remediation: storing the token only in an HttpOnly cookie
  // instead of localStorage means an XSS payload in any admin page
  // (chat messages, prayer bodies, display names) can no longer read
  // the admin credential and exfiltrate it to an attacker's server.
  const SessionBodySchema = z.object({ token: z.string().min(1).max(2048) });
  r.post(
    "/session",
    {
      // Accepts a bearer token and issues an HttpOnly cookie.
      // Rate-limit tightly — same surface as login, same abuse model.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        body: SessionBodySchema,
        response: {
          200: z.object({ ok: z.literal(true) }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const { token } = req.body;

      // Validate the token against the same logic as requireAuth().
      let isValid = false;
      if (env.ADMIN_API_TOKEN && safeStringEqual(token, env.ADMIN_API_TOKEN)) {
        isValid = true;
      } else {
        try {
          await verifyAccessToken(token);
          isValid = true;
        } catch { /* invalid */ }
      }

      if (!isValid) {
        throw new UnauthorizedError("Invalid admin token");
      }

      void reply.setCookie("admin_session", token, {
        httpOnly: true,
        // Same cross-origin rationale as session/auto above.
        sameSite: isProd() ? "none" : "strict",
        secure: isProd(),
        path: "/",
        maxAge: 86_400, // 24 h for JWT tokens (they expire at their own TTL anyway)
      });
      return { ok: true as const };
    },
  );

  // ── GET /admin/stream-health/metrics ────────────────────────────────────
  // A4: Observability — returns the 5-minute rolling stream health aggregate.
  // Consumed by the admin Stream Health dashboard (pages/stream-health.tsx).
  // Data is entirely in-memory (no DB); stale results after server restart are
  // expected and harmless — the window refills within 5 minutes.
  app.get(
    "/stream-health/metrics",
    {
      preHandler: [requireAuth("editor")],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        response: {
          200: passthrough,
          429: z.object({ error: z.string() }),
        },
      },
    },
    async () => {
      return streamHealthAggregator.getDetailedStats();
    },
  );

  // ── POST /admin/session/refresh ──────────────────────────────────────────
  // Re-issue the admin_session cookie without requiring a credential re-entry.
  //
  // Two supported paths:
  //   A. ADMIN_API_TOKEN static token — cookie is simply reissued using the
  //      server's current env var value. Works as long as the env var has not
  //      been rotated. No input required.
  //   B. JWT refresh token — caller provides `{ refreshToken }` in the body;
  //      the server validates + rotates it and stores the new access token in
  //      the cookie. Supports long-running sessions where the access token
  //      (15 min default) expires but the refresh token (30 days) is still
  //      valid.
  //
  // The CSRF header is NOT required here because there is no admin_session
  // cookie yet (or it just expired) — the CSRF middleware exempts unauthenticated
  // requests (no cookie → adminCsrfHook returns early). The endpoint performs
  // its own lightweight validation instead.
  r.post(
    "/session/refresh",
    {
      // Refresh is effectively a token-exchange — rate-limit like a login.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },      schema: {
        body: z.object({ refreshToken: z.string().max(2048).optional() }),
        response: {
          200: z.object({ ok: z.literal(true), method: z.string(), expiresIn: z.number().optional() }),
          401: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
    // No admin_session cookie → treat as anonymous; re-issue via ADMIN_API_TOKEN.
    if (env.ADMIN_API_TOKEN) {
      const currentCookie = (req.cookies as Record<string, string | undefined>)?.admin_session;
      // Accept EITHER:
      //   1. No cookie present (expired / first-visit)
      //   2. The cookie exactly matches the current ADMIN_API_TOKEN
      if (!currentCookie || safeStringEqual(currentCookie, env.ADMIN_API_TOKEN)) {
        void reply.setCookie("admin_session", env.ADMIN_API_TOKEN, {
          httpOnly: true,
          sameSite: isProd() ? "none" : "strict",
          secure: isProd(),
          path: "/",
          maxAge: 7 * 86_400,
        });
        return { ok: true as const, method: "static-token" };
      }
    }

    // JWT refresh-token path: body must contain { refreshToken }.
    const rawRefreshToken = req.body.refreshToken?.trim() ?? null;
    if (!rawRefreshToken) {
      reply.code(401);
      return { error: "No refresh token provided and ADMIN_API_TOKEN path not applicable" };
    }

    const { authService } = await import("../auth/auth.service.js");
    const tokens = await authService.refresh(rawRefreshToken);
    void reply.setCookie("admin_session", tokens.accessToken, {
      httpOnly: true,
      sameSite: isProd() ? "none" : "strict",
      secure: isProd(),
      path: "/",
      maxAge: 86_400,
    });
    return { ok: true as const, method: "jwt-refresh", expiresIn: tokens.accessTokenExpiresIn };
  },
  );

  // ── DELETE /admin/session ────────────────────────────────────────────────
  // Clear the admin_session cookie (logout). No auth required — clearing
  // a cookie you may or may not have is always safe.
  app.delete("/session", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } }, schema: { response: { 429: z.object({ error: z.string() }) } } }, async (_req, reply) => {
    void reply.clearCookie("admin_session", { path: "/" });
    return { ok: true };
  });

  // ── POST /admin/sse-token ───────────────────────────────────────────────
  // Issues a short-lived (90 s) SSE sub-token so the admin EventSource URL
  // never carries the long-lived ADMIN_API_TOKEN in the query string.
  // Requires a valid Bearer admin token in the Authorization header.
  app.post(
    "/sse-token",
    { preHandler: [requireAuth("editor")], config: { rateLimit: { max: 30, timeWindow: "1 minute" } }, schema: { response: { 201: z.object({ token: z.string(), expiresAt: z.string(), ttlMs: z.number() }), 429: z.object({ error: z.string() }) } } },
    async (_req, reply) => {
      const subToken = crypto.randomUUID();
      // F04: persist sub-token in Redis (when available) so it survives across
      // replicas. Fall back to the in-process Map for single-replica / no-Redis
      // deployments. TTL is enforced by Redis PEXPIRE, so the cleanup interval
      // on sseTokenStore is a no-op when Redis is the active store.
      const redis = getRedis();
      if (redis) {
        await redis.set(`SSETOK:${subToken}`, "1", "PX", SSE_TOKEN_TTL_MS);
      } else {
        sseTokenStore.set(subToken, { expiresAt: Date.now() + SSE_TOKEN_TTL_MS });
      }
      reply.code(201);
      return {
        token: subToken,
        expiresAt: new Date(Date.now() + SSE_TOKEN_TTL_MS).toISOString(),
        ttlMs: SSE_TOKEN_TTL_MS,
      };
    },
  );

  // ── /admin/live/events (SSE) ────────────────────────────────────────────
  // Server-Sent Events stream for the admin Live Control page. Bridges
  // the in-process `broadcastEngine` event bus directly to the browser
  // so editors see queue advances / preload windows / viewer-count
  // ticks in real time without polling.
  //
  // Why not reuse `/realtime/sse`? That endpoint is unauthenticated
  // (anyone — including embedded TV clients — can subscribe to
  // public broadcast snapshots). The admin variant requires editor auth
  // and may grow to emit privileged events (moderation actions, ingest
  // health changes, etc.) that we do NOT want to leak to viewers.
  //
  // Auth accepts three forms (in priority order):
  //   1. Authorization: Bearer <token>  — fetch/XHR only
  //   2. ?sseToken=<sub-token>          — preferred for EventSource
  //      Short-lived token issued by POST /admin/sse-token. Verified
  //      against the in-memory sseTokenStore and consumed on first use.
  //   3. ?token=<admin-token>           — legacy fallback (deprecated)
  //      Direct long-lived token in URL; kept for backwards-compat but
  //      clients should migrate to the sub-token flow above.
  app.get<{ Querystring: { platform?: string; token?: string; sseToken?: string } }>(
    "/live/events",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      // Inline auth check that supports query param auth for EventSource.
      // Can't use requireAuth() here — that helper only reads the header.
      const headerToken = (() => {
        const h = req.headers.authorization;
        const m = h && /^Bearer\s+(.+)$/i.exec(h);
        return m?.[1] ?? null;
      })();
      const rawSseToken = typeof req.query?.sseToken === "string" ? req.query.sseToken : null;
      const rawQueryToken = typeof req.query?.token === "string" ? req.query.token : null;

      // Path 1: header bearer (most secure, used when proxying via fetch)
      if (headerToken) {
        try {
          if (env.ADMIN_API_TOKEN && safeStringEqual(headerToken, env.ADMIN_API_TOKEN)) {
            // system token — always permitted
          } else {
            const decoded = await verifyAccessToken(headerToken);
            requireRole(decoded.role, "editor");
          }
        } catch {
          reply.code(401).send({ error: "invalid token" });
          return;
        }
      }
      // Path 2: short-lived SSE sub-token (preferred for EventSource)
      else if (rawSseToken) {
        // F04: check Redis first (multi-replica path); fall back to in-process Map.
        const redis = getRedis();
        if (redis) {
          const exists = await redis.exists(`SSETOK:${rawSseToken}`);
          if (!exists) {
            reply.code(401).send({ error: "sseToken invalid or expired" });
            return;
          }
          // Single-use: delete immediately after validation.
          await redis.del(`SSETOK:${rawSseToken}`);
        } else {
          const stored = sseTokenStore.get(rawSseToken);
          if (!stored || stored.expiresAt < Date.now()) {
            reply.code(401).send({ error: "sseToken invalid or expired" });
            return;
          }
          // Consume the sub-token — one-time use reduces replay window
          sseTokenStore.delete(rawSseToken);
        }
      }
      // Path 3: legacy long-lived token in query string (deprecated)
      else if (rawQueryToken) {
        try {
          if (env.ADMIN_API_TOKEN && safeStringEqual(rawQueryToken, env.ADMIN_API_TOKEN)) {
            // system token — always permitted
          } else {
            const decoded = await verifyAccessToken(rawQueryToken);
            requireRole(decoded.role, "editor");
          }
        } catch {
          reply.code(401).send({ error: "invalid token" });
          return;
        }
      }
      // Path 4: admin_session HttpOnly cookie — used when the SPA is on the
      // cookie-only auth path and fetchSseSubToken() failed (e.g. network blip
      // at page load). EventSource cannot send custom headers, so we read the
      // cookie directly here. No CSRF check applies — GET requests (which SSE
      // connections are) are exempt from CSRF protection because they are
      // read-only and cannot modify server state.
      else {
        const cookieResult = await extractAndValidateCookieToken(req);
        if (cookieResult) {
          try {
            if (env.ADMIN_API_TOKEN && safeStringEqual(cookieResult.token, env.ADMIN_API_TOKEN)) {
              // system token — always permitted
            } else {
              const decoded = await verifyAccessToken(cookieResult.token);
              requireRole(decoded.role, "editor");
            }
          } catch {
            reply.code(401).send({ error: "invalid session" });
            return;
          }
        } else {
          reply.code(401).send({ error: "missing bearer token" });
          return;
        }
      }

      sseCounter.inc();

      // Disable Nagle's algorithm so each SSE frame is flushed immediately
      // to the client without TCP batching. Without this, small heartbeat
      // and snapshot frames may be held in the kernel send buffer for up to
      // 40 ms, which delays the EventSource `open` event in browsers and
      // makes the admin connection indicator flicker on idle streams.
      reply.raw.socket?.setNoDelay(true);

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        // Explicitly opt out of any response compression middleware.
        // Compressors buffer data before flushing — catastrophic for SSE.
        "Content-Encoding": "identity",
        ...sseCorsHeaders(req),
      });

      // Flush the response headers immediately so the browser's EventSource
      // fires its `open` event without waiting for the first data frame.
      // Without this, Vite's dev proxy and nginx may buffer the response
      // until data arrives, delaying the `open` event by several seconds and
      // causing the admin panel to stay in "connecting" state.
      // A bare SSE comment (": ok") is invisible to JavaScript listeners but
      // travels through all proxy layers, confirming the stream is live.
      reply.raw.write(": ok\n\n");

      let lastAdminSseWriteOkMs = Date.now();
      const send = (event: string, data: unknown) => {
        try {
          const ok = reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          if (ok) lastAdminSseWriteOkMs = Date.now();
        } catch {
          /* socket gone — close handler will clean up */
        }
      };

      // Initial snapshot so the client UI can render immediately
      // without waiting for the first engine event.
      send("snapshot", broadcastEngine.snapshot());
      send("viewer-count", { count: broadcastEngine.getViewerCount() });

      const onEvent = (e: { type: string; data: unknown }) => {
        send(e.type, e.data);
      };
      broadcastEngine.on("event", onEvent);

      const onAdminEvent = (e: { type: string; data: unknown }) => {
        send(e.type, e.data);
      };
      adminEventBus.on("admin-event", onAdminEvent);

      // Send a named `heartbeat` event every 5 s so the client-side
      // EventSource listener fires and updates `lastFrameAt`. A bare
      // `: comment` (e.g. `: ping`) is silently discarded by the browser's
      // EventSource implementation — it keeps the TCP connection alive at
      // the transport layer but is invisible to the JavaScript watchdog that
      // detects zombie connections. Using a named event ensures the client
      // knows the stream is alive even during broadcast idle periods.
      //
      // Interval: 5 s (halved from 10 s) so Replit's reverse proxy and any
      // intermediate nginx/Vite proxy layers see activity well within their
      // idle-timeout windows and do not silently drop the connection.
      // Client stale threshold remains 45 s (= 9 missed beats at 5 s).
      const heartbeat = setInterval(() => {
        try {
          const ok = reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
          if (ok) lastAdminSseWriteOkMs = Date.now();
        } catch {
          /* ignore — close handler will clean up */
        }
      }, 5_000);
      heartbeat.unref?.();

      // Zombie detection: half-open TCP keeps socket open silently.
      // Close if no successful write in 90 s (= 18 missed 5 s heartbeats).
      const zombieCheck = setInterval(() => {
        const idleMs = Date.now() - lastAdminSseWriteOkMs;
        const writable = !reply.raw.socket?.destroyed && reply.raw.socket?.writable;
        if (!writable || idleMs > 90_000) cleanup();
      }, 30_000);
      zombieCheck.unref?.();

      let adminSseClosed = false;
      const cleanup = () => {
        if (adminSseClosed) return;
        adminSseClosed = true;
        openAdminSseCleanups.delete(cleanup);
        clearInterval(heartbeat);
        clearInterval(zombieCheck);
        broadcastEngine.off("event", onEvent);
        adminEventBus.off("admin-event", onAdminEvent);
        sseCounter.dec();
        try {
          reply.raw.end();
        } catch {
          /* ignore */
        }
      };

      openAdminSseCleanups.add(cleanup);
      req.raw.on("close", cleanup);
      req.raw.on("error", cleanup);
    },
  );

  // ── Content Purge ─────────────────────────────────────────────────────────
  // Irreversible bulk-delete endpoint. Requires admin role + confirmation
  // phrase to prevent accidental calls. Each target is deleted atomically;
  // failures are logged and returned per-target so the caller can see exactly
  // what was and wasn't cleared.
  r.post(
    "/purge",
    {
      preHandler: requireAuth("admin"),
      // Irreversible bulk delete — 2/min is a hard stop against
      // accidental double-submit or a script hammering this endpoint.
      config: { rateLimit: { max: 2, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "Bulk purge content (irreversible)",
        description:
          "Permanently deletes all content of the specified types. " +
          "Requires `confirmationPhrase: 'PURGE CONFIRMED'`. " +
          "Only accounts with the `admin` role or above may call this endpoint.",
        body: z.object({
          targets: z
            .array(
              z.enum([
                "local_videos",
                "youtube_videos",
                "broadcast_queue",
                "playlists",
                "transcoding_jobs",
                "schedule_entries",
              ]),
            )
            .min(1),
          confirmationPhrase: z.literal("PURGE CONFIRMED"),
        }),
        response: {
          200: z.object({
            deleted: z.record(z.string(), z.number()),
            errors: z.record(z.string(), z.string()).optional(),
            cacheCleared: z.boolean(),
          }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { targets } = req.body;

      const deleted: Record<string, number> = {};
      const errors: Record<string, string> = {};

      for (const target of targets) {
        try {
          switch (target) {
            case "local_videos": {
              const rows = await db
                .delete(schema.videosTable)
                .where(eq(schema.videosTable.videoSource, "local"))
                .returning({ id: schema.videosTable.id });
              deleted[target] = rows.length;
              break;
            }
            case "youtube_videos": {
              const rows = await db
                .delete(schema.videosTable)
                .where(eq(schema.videosTable.videoSource, "youtube"))
                .returning({ id: schema.videosTable.id });
              deleted[target] = rows.length;
              break;
            }
            case "broadcast_queue": {
              const rows = await db
                .delete(schema.broadcastQueueTable)
                .returning({ id: schema.broadcastQueueTable.id });
              deleted[target] = rows.length;
              // Reload the engine so SSE-connected clients immediately see an
              // empty queue rather than stale programme data.
              try { broadcastEngine.reload(); } catch { /* non-fatal */ }
              break;
            }
            case "playlists": {
              // playlist_videos has a FK to playlists; delete children first.
              await db.delete(schema.playlistVideosTable);
              const rows = await db
                .delete(schema.playlistsTable)
                .returning({ id: schema.playlistsTable.id });
              deleted[target] = rows.length;
              break;
            }
            case "transcoding_jobs": {
              const count = await clearJobsByStatus("all");
              deleted[target] = count;
              break;
            }
            case "schedule_entries": {
              const rows = await db
                .delete(schema.scheduleTable)
                .returning({ id: schema.scheduleTable.id });
              deleted[target] = rows.length;
              break;
            }
            default:
              break;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors[target] = msg;
          req.log.error({ err, target }, "[purge] target failed");
        }
      }

      // Bust the public video catalogue cache so playback surfaces don't
      // serve stale content after a purge.
      let cacheCleared = false;
      try {
        await cache().del("videos:catalogue");
        cacheCleared = true;
      } catch (err) {
        req.log.warn({ err }, "[purge] cache.del failed (non-fatal)");
      }

      req.log.warn(
        { targets, deleted, errors: Object.keys(errors).length > 0 ? errors : undefined },
        "[purge] content purge completed",
      );

      // Notify all SSE-connected admin tabs so they refresh their query cache
      // immediately after a destructive purge without waiting for poll intervals.
      if (Object.values(deleted).some((n) => n > 0)) {
        adminEventBus.push("videos-library-updated", { reason: "purge", targets, deleted });
        adminEventBus.push("broadcast-queue-updated", { reason: "purge", targets, deleted });
      }

      return {
        deleted,
        ...(Object.keys(errors).length > 0 ? { errors } : {}),
        cacheCleared,
      };
    },
  );

  // ── GET /admin/diagnostics/slow-queries ───────────────────────────────────
  // Returns the slowest SQL queries captured by pg_stat_statements (if the
  // extension is installed), falling back to the in-process slow-request ring
  // buffer when the extension is unavailable.
  //
  // pg_stat_statements is read-only; calling RESET is intentionally not exposed
  // here (operators can run `SELECT pg_stat_statements_reset()` directly if
  // needed). The ring buffer snapshot comes from the existing slow-request-
  // capture infrastructure already used by the diagnostics panel.
  r.get(
    "/diagnostics/slow-queries",
    {
      preHandler: requireAuth("admin"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin-ops"],
        summary: "Slowest SQL queries from pg_stat_statements + in-process request ring buffer",
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          minMs: z.coerce.number().int().nonnegative().default(500),
        }),
        response: {
          200: z.object({
            pgStatStatements: z.object({
              available: z.boolean(),
              queries: z.array(z.object({
                query: z.string(),
                calls: z.number(),
                totalTimeMs: z.number(),
                meanTimeMs: z.number(),
                maxTimeMs: z.number(),
                stddevTimeMs: z.number(),
                rows: z.number(),
                sharedBlksHit: z.number(),
                sharedBlksRead: z.number(),
              })),
            }),
            slowRequests: z.object({
              available: z.boolean(),
              requests: z.array(z.object({
                method: z.string(),
                url: z.string(),
                statusCode: z.number(),
                durationMs: z.number(),
                capturedAt: z.number(),
              })),
            }),
            checkedAt: z.string(),
          }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { limit, minMs } = req.query;

      // ── pg_stat_statements ────────────────────────────────────────────────
      let pgStatAvailable = false;
      const pgStatQueries: Array<{
        query: string; calls: number; totalTimeMs: number; meanTimeMs: number;
        maxTimeMs: number; stddevTimeMs: number; rows: number;
        sharedBlksHit: number; sharedBlksRead: number;
      }> = [];

      try {
        // Check if extension is installed before querying — avoids a 42P01 error
        // on DBs that don't have pg_stat_statements enabled.
        const extCheck = await db.execute(
          sql`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements' LIMIT 1`,
        );
        pgStatAvailable = (extCheck.rows?.length ?? 0) > 0;

        if (pgStatAvailable) {
          const rows = await db.execute(sql`
            SELECT
              query,
              calls,
              total_exec_time       AS total_time_ms,
              mean_exec_time        AS mean_time_ms,
              max_exec_time         AS max_time_ms,
              stddev_exec_time      AS stddev_time_ms,
              rows,
              shared_blks_hit,
              shared_blks_read
            FROM pg_stat_statements
            WHERE mean_exec_time >= ${minMs}
            ORDER BY mean_exec_time DESC
            LIMIT ${limit}
          `);
          for (const r of rows.rows ?? []) {
            pgStatQueries.push({
              query: String(r["query"] ?? ""),
              calls: Number(r["calls"] ?? 0),
              totalTimeMs: Math.round(Number(r["total_time_ms"] ?? 0) * 100) / 100,
              meanTimeMs: Math.round(Number(r["mean_time_ms"] ?? 0) * 100) / 100,
              maxTimeMs: Math.round(Number(r["max_time_ms"] ?? 0) * 100) / 100,
              stddevTimeMs: Math.round(Number(r["stddev_time_ms"] ?? 0) * 100) / 100,
              rows: Number(r["rows"] ?? 0),
              sharedBlksHit: Number(r["shared_blks_hit"] ?? 0),
              sharedBlksRead: Number(r["shared_blks_read"] ?? 0),
            });
          }
        }
      } catch (err) {
        req.log.warn({ err }, "[diagnostics/slow-queries] pg_stat_statements query failed (non-fatal)");
      }

      // ── In-process slow-request ring buffer ───────────────────────────────
      // getSlowRequestsSnapshot() returns { thresholdMs, bufferSize, entries, routes }
      // NOT an array — use .entries for the per-request log.
      const snapshot = getSlowRequestsSnapshot();
      const slowRequests = snapshot.entries
        .filter((r) => r.durationMs >= minMs)
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, limit)
        .map((r) => ({
          method: r.method,
          url: r.path,
          statusCode: r.statusCode,
          durationMs: r.durationMs,
          capturedAt: new Date(r.at).getTime(),
        }));

      return {
        pgStatStatements: { available: pgStatAvailable, queries: pgStatQueries },
        slowRequests: { available: snapshot.entries.length > 0, requests: slowRequests },
        checkedAt: new Date().toISOString(),
      };
    },
  );

}
