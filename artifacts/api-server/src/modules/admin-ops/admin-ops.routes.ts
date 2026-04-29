/**
 * Admin operations / observability endpoints.
 *
 * The April 2026 rebuild deliberately skipped a number of background
 * subsystems (FFmpeg transcoder worker, RTMP/SRT live ingest, push delivery
 * worker, alert dispatcher, YouTube quota tracker, S3 upload telemetry,
 * slow-request capture). The existing admin SPA still calls the read-side
 * of those subsystems on every page load via `services/adminApi.ts`.
 *
 * This module provides the missing endpoints so the admin SPA renders
 * cleanly end-to-end:
 *
 *   - Real data where the api-server actually has it: process info,
 *     `process.memoryUsage()`, `--expose-gc` cycles, `v8.writeHeapSnapshot`,
 *     database connectivity, broadcast engine snapshot, S3 + cache
 *     configuration, lifecycle phase / uptime.
 *   - Honest "off / disabled / empty" responses for the deliberately-
 *     skipped subsystems. Shapes match the TypeScript interfaces declared
 *     in `artifacts/admin/src/services/adminApi.ts` so each panel renders
 *     its empty-state UI instead of throwing.
 *
 * All routes are protected by `requireAuth("editor")` so the admin SPA's
 * existing AuthGate (paste ADMIN_API_TOKEN) gates them just like the rest
 * of the `/admin/*` surface.
 *
 * Mounted at `/admin` under both the `/api/v1` and `/api` (legacy)
 * prefixes by `registerDomainRoutes()` in `app.ts`.
 */
import { performance } from "node:perf_hooks";
import * as v8 from "node:v8";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../middleware/auth.js";
import { env } from "../../config/env.js";
import { db } from "../../infrastructure/db.js";
import { storage } from "../../infrastructure/storage.js";
import { uploadSessions } from "../media-uploads/upload-sessions.js";
import { cache } from "../../infrastructure/cache.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";

const startedAtMs = Date.now();
const instanceId = `inst-${Math.random().toString(36).slice(2, 10)}`;

function uptimeSec(): number {
  return Math.round((Date.now() - startedAtMs) / 1000);
}

function mb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

/** Zod helper: a free-form record without imposing a shape. */
const passthrough = z.record(z.string(), z.unknown());

// ──────────────────────────────────────────────────────────────────────────────
// Schemas (kept inline; this module is mostly read-only stub-or-real responses)
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
    s3: z.object({
      configured: z.boolean(),
      bucket: z.string().nullable(),
      region: z.string().nullable(),
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
  caches: z.array(z.object({ name: z.string(), size: z.number() })),
  watchdog: z.object({
    enabled: z.boolean(),
    sampleIntervalMs: z.number(),
    thresholds: z.object({
      rssAlertMb: z.number(),
      rssRecoveryMb: z.number(),
      externalGrowthAlertMbPerMin: z.number(),
      externalGrowthRecoveryMbPerMin: z.number(),
      sustainSamples: z.number(),
      slopeWindowSamples: z.number(),
    }),
    current: z.object({
      externalGrowthMbPerMin: z.number().nullable(),
      consecutiveRssOver: z.number(),
      consecutiveSlopeOver: z.number(),
    }),
    alerts: z.object({
      rssAlertActive: z.boolean(),
      slopeAlertActive: z.boolean(),
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

const TranscodingQueueSchema = z.object({
  jobs: z.array(passthrough),
  stats: z.object({
    activeCount: z.number(),
    queuedCount: z.number(),
    completedToday: z.number(),
    failedToday: z.number(),
  }),
});

const YouTubeQuotaStatusSchema = z.object({
  estimatedUsedToday: z.number(),
  dailyLimit: z.number(),
  percentUsed: z.number(),
  exhaustedUntil: z.string().nullable(),
  exhausted: z.boolean(),
  nextResetAt: z.string(),
  throttle: z
    .object({
      enabled: z.boolean(),
      contexts: z.array(z.string()),
      thresholdPct: z.number(),
      percentUsed: z.number(),
      t1Pct: z.number(),
      t2Pct: z.number(),
    })
    .optional(),
});

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

async function dbCounts() {
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
  return { videos, localVideos, playlists, activeScheduleEntries, registeredDevices };
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
    runMode: process.env.RUN_MODE ?? "all",
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

  // ── Process status ────────────────────────────────────────────────────────
  r.get(
    "/process-status",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Process info: pid, uptime, RSS, transcoder heartbeat (stubbed)",
        response: { 200: ProcessStatusSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({
      thisProcess: processInfo(),
      transcoder: {
        queue: { queued: 0, processing: 0, failed: 0, done: 0 },
        heartbeat: null,
        alive: false,
        lastJob: null,
      },
      infrastructure: {
        s3: {
          configured: !!env.S3_BUCKET,
          bucket: env.S3_BUCKET ?? null,
          region: env.S3_REGION ?? null,
        },
        cache: { backend: env.REDIS_URL ? "redis" : "postgresql" } as Record<
          string,
          unknown
        >,
      },
    }),
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
        worker: {
          probeKind: "heartbeat" as const,
          alive: false,
          sameProcess: false,
          heartbeat: null,
        },
        fatals: [],
        deploy: {
          commit: process.env.RENDER_GIT_COMMIT ?? process.env.REPL_DEPLOYMENT ?? null,
          commitShort:
            (process.env.RENDER_GIT_COMMIT ?? process.env.REPL_DEPLOYMENT ?? "").slice(
              0,
              7,
            ) || null,
          branch: process.env.RENDER_GIT_BRANCH ?? null,
          serviceName: process.env.RENDER_SERVICE_NAME ?? "temple-tv-api",
          serviceId: process.env.RENDER_SERVICE_ID ?? null,
          instanceId: process.env.RENDER_INSTANCE_ID ?? instanceId,
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
          label: "Object storage",
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

      return {
        generatedAt: new Date().toISOString(),
        environment: env.NODE_ENV,
        overallStatus,
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
            provider: env.S3_ENDPOINT ? "s3-compatible" : "aws-s3",
            configured: !!env.S3_BUCKET,
            bucket: env.S3_BUCKET ?? null,
            region: env.S3_REGION ?? null,
            publicSearchPaths: null,
            privateDir: null,
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
            ffmpegReady: false,
            cloudUploadEnabled: !!env.S3_BUCKET,
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
        uploadSessions: { active: 0 },
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
        summary: "Recent slow-request capture buffer (capture not enabled in build)",
        response: { 200: SlowRequestsSnapshotSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({
      thresholdMs: 1000,
      bufferSize: 0,
      bufferMaxAgeMs: 5 * 60 * 1000,
      capturedCount: 0,
      entries: [],
      routes: [],
    }),
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
        caches: [],
        watchdog: {
          enabled: false,
          sampleIntervalMs: 30_000,
          thresholds: {
            rssAlertMb: Number(process.env.MEMORY_WARN_RSS_MB ?? 1500),
            rssRecoveryMb: Number(process.env.MEMORY_WARN_RSS_MB ?? 1500) - 200,
            externalGrowthAlertMbPerMin: 50,
            externalGrowthRecoveryMbPerMin: 10,
            sustainSamples: 3,
            slopeWindowSamples: 6,
          },
          current: {
            externalGrowthMbPerMin: null,
            consecutiveRssOver: 0,
            consecutiveSlopeOver: 0,
          },
          alerts: { rssAlertActive: false, slopeAlertActive: false },
        },
      };
    },
  );

  // ── Force GC (requires --expose-gc) ───────────────────────────────────────
  r.post(
    "/diagnostics/gc",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Force a synchronous GC cycle (501 if --expose-gc not set)",
        response: {
          200: ForceGcResultSchema,
          501: z.object({ message: z.string() }),
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
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "v8.getHeapSnapshot() streamed as application/octet-stream",
        // Binary response — no Zod schema; document via tags only.
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
  // (`DELETE /admin/videos/upload/:sessionId`). Aborts the underlying
  // S3 multipart upload (best-effort) and drops the session.
  r.delete(
    "/videos/upload/:sessionId",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Cancel an active multipart upload session",
        params: z.object({ sessionId: z.string().min(1) }),
        response: { 200: z.object({ ok: z.literal(true), aborted: z.boolean() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { sessionId } = req.params as { sessionId: string };
      const session = uploadSessions.remove(sessionId);
      if (!session) return { ok: true as const, aborted: false };
      try {
        await storage().abortMultipartUpload({
          key: session.objectKey,
          uploadId: session.uploadId,
        });
      } catch (err) {
        req.log.warn(
          { err, sessionId, objectKey: session.objectKey },
          "[admin-ops] abort during DELETE failed",
        );
      }
      return { ok: true as const, aborted: true };
    },
  );

  r.get(
    "/uploads/s3-telemetry/summary",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "S3 upload telemetry rollup (capture not enabled in build)",
        querystring: z.object({ hours: z.coerce.number().int().positive().default(24) }),
        response: { 200: S3TelemetrySummarySchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { hours } = req.query as { hours: number };
      return {
        windowHours: hours,
        since: new Date(Date.now() - hours * 3600 * 1000).toISOString(),
        counts: {},
        attempts: 0,
        successes: 0,
        failures: 0,
        successRatePct: null,
        throughput: {
          p50Bps: null,
          p95Bps: null,
          avgSizeBytes: null,
          totalBytes: null,
        },
        topErrors: [],
      };
    },
  );

  // ── Transcoding queue (FFmpeg pipeline not wired in this build) ───────────
  r.get(
    "/transcoding/queue",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Transcoding queue (empty: FFmpeg pipeline disabled)",
        response: { 200: TranscodingQueueSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({
      jobs: [],
      stats: { activeCount: 0, queuedCount: 0, completedToday: 0, failedToday: 0 },
    }),
  );

  r.get(
    "/transcoding/jobs/:jobId",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Transcoding job detail (always 404: pipeline disabled)",
        params: z.object({ jobId: z.string().min(1) }),
        response: {
          404: z.object({ message: z.string(), code: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (_req, reply) => {
      reply.code(404);
      return { message: "Transcoding pipeline not enabled", code: "TRANSCODER_DISABLED" };
    },
  );

  for (const verb of ["post", "delete"] as const) {
    r[verb](
      "/transcoding/retry/:id",
      {
        preHandler: requireAuth("editor"),
        schema: {
          tags: ["admin-ops"],
          params: z.object({ id: z.string() }),
          response: { 200: z.object({ ok: z.literal(true) }) },
          security: [{ bearerAuth: [] }],
        },
      },
      async () => ({ ok: true as const }),
    );
  }
  r.delete(
    "/transcoding/:id",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        params: z.object({ id: z.string() }),
        response: { 200: z.object({ ok: z.literal(true) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({ ok: true as const }),
  );
  r.post(
    "/transcoding/requeue/:videoId",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        params: z.object({ videoId: z.string() }),
        body: z.object({ priority: z.number().optional() }).optional(),
        response: { 501: z.object({ message: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (_req, reply) => {
      reply.code(501);
      return { message: "Transcoding pipeline not enabled" };
    },
  );
  r.delete(
    "/transcoding/clear",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        querystring: z.object({
          status: z.enum(["done", "failed", "cancelled", "all"]),
        }),
        response: { 200: z.object({ cleared: z.number() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({ cleared: 0 }),
  );

  // ── YouTube quota (tracker not wired in this build) ───────────────────────
  r.get(
    "/youtube/quota",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "YouTube Data API quota usage (tracker disabled in build)",
        response: { 200: YouTubeQuotaStatusSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const dailyLimit = Number(process.env.YOUTUBE_QUOTA_DAILY_LIMIT ?? 10_000);
      const tomorrowMidnightUtc = new Date();
      tomorrowMidnightUtc.setUTCDate(tomorrowMidnightUtc.getUTCDate() + 1);
      tomorrowMidnightUtc.setUTCHours(0, 0, 0, 0);
      return {
        estimatedUsedToday: 0,
        dailyLimit,
        percentUsed: 0,
        exhaustedUntil: null,
        exhausted: false,
        nextResetAt: tomorrowMidnightUtc.toISOString(),
      };
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
      dailyLimit: Number(process.env.YOUTUBE_QUOTA_DAILY_LIMIT ?? 10_000),
    }),
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
      schema: {
        tags: ["admin-ops"],
        summary: "Send a test alert (no-op: dispatcher not configured)",
        response: { 200: AlertTestResultSchema },
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
        summary: "Alert delivery history (empty: dispatcher not configured)",
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(500).optional(),
        }),
        response: { 200: AlertHistoryResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({ entries: [], count: 0 }),
  );

  // ── Live overrides — admin-side paths ─────────────────────────────────────
  // The /api/v1/live module already exposes the public `/status` and
  // operator `/start` `/stop` `/recent` actions. The admin SPA additionally
  // calls a richer set of `/admin/live*` endpoints (legacy paths) for the
  // Live Control panel. The underlying subsystem (RTMP/SRT ingest, YouTube
  // live probing, scheduled go-lives) lives in a deliberately-skipped
  // phase, so these endpoints return empty/disabled responses.

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
  });
  const ScheduledOverrideShape = z.object({
    id: z.string(),
    title: z.string(),
    youtubeVideoId: z.string().nullable(),
    hlsStreamUrl: z.string().nullable(),
    scheduledFor: z.string(),
    endsAt: z.string().nullable(),
    streamNotes: z.string().nullable(),
  });

  r.get(
    "/live-overrides",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "List active live overrides (admin Live Control)",
        response: { 200: z.array(LiveOverrideShape) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => [],
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
    async () => ({ items: [] }),
  );

  r.post(
    "/live/override/start",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Start a live override (501: live subsystem disabled in build)",
        body: passthrough,
        response: { 501: z.object({ message: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (_req, reply) => {
      reply.code(501);
      return {
        message:
          "Live override subsystem (YouTube probe / RTMP ingest) not enabled in this build",
      };
    },
  );

  r.post(
    "/live/override/stop",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "Stop the active live override (no-op: live subsystem disabled)",
        response: { 200: z.object({ ok: z.literal(true) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({ ok: true as const }),
  );

  r.post(
    "/live/override/extend",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        body: z.object({ extraMinutes: z.number().int().positive() }),
        response: { 501: z.object({ message: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (_req, reply) => {
      reply.code(501);
      return { message: "Live override subsystem not enabled" };
    },
  );

  r.post(
    "/live/override/preview-youtube",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        body: z.object({ url: z.string() }),
        response: {
          200: z.object({
            ok: z.boolean(),
            error: z.string().optional(),
            reason: z.string().nullable().optional(),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({
      ok: false,
      reason: "YouTube preview probe not enabled in this build",
    }),
  );

  r.post(
    "/live/override/schedule",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        body: passthrough,
        response: { 501: z.object({ message: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (_req, reply) => {
      reply.code(501);
      return { message: "Scheduled live overrides not enabled" };
    },
  );

  r.get(
    "/live/override/scheduled",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        response: { 200: z.object({ items: z.array(ScheduledOverrideShape) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({ items: [] }),
  );

  r.delete(
    "/live/override/schedule/:id",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        params: z.object({ id: z.string() }),
        response: { 200: z.object({ ok: z.literal(true), id: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => ({ ok: true as const, id: (req.params as { id: string }).id }),
  );

  r.get(
    "/live/monitor",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin-ops"],
        summary: "YouTube live monitor data (poller disabled in build)",
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
    async () => ({
      current: {
        isLive: false,
        videoId: null,
        title: null,
        checkedAt: Date.now(),
        staleSec: 0,
        uptimeSecs: uptimeSec(),
        liveSessionStartedAt: null,
        viewerCount: null,
      },
      polling: { intervalMs: 30_000, mode: "normal" as const, lastStateChangeAt: 0 },
      history: [],
      viewerHistory: [],
    }),
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
    async () => ({
      isLive: false,
      ytLive: false,
      liveOverride: null,
      viewerCount: broadcastEngine.getViewerCount(),
    }),
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
  // Auth note: EventSource cannot send custom headers in browsers, so
  // the admin SPA passes the bearer either as `Authorization` (when
  // proxying through fetch) or as `?token=` (when using the native
  // EventSource API). Both flows are accepted below.
  app.get<{ Querystring: { platform?: string; token?: string } }>(
    "/live/events",
    async (req, reply) => {
      // Inline auth check that supports the `?token=` query param. We
      // can't put this behind `requireAuth()` because that helper only
      // looks at the Authorization header.
      const headerToken = (() => {
        const h = req.headers.authorization;
        const m = h && /^Bearer\s+(.+)$/i.exec(h);
        return m?.[1] ?? null;
      })();
      const queryToken = typeof req.query?.token === "string" ? req.query.token : null;
      const token = headerToken ?? queryToken;
      if (!token) {
        reply.code(401).send({ error: "missing bearer token" });
        return;
      }
      // Reuse the same verification path as `requireAuth` — accept the
      // legacy ADMIN_API_TOKEN OR a JWT issued to an editor+ user.
      const { env } = await import("../../config/env.js");
      const { verifyAccessToken } = await import("../auth/jwt.js");
      const { requireRole } = await import("../auth/rbac.js");
      try {
        if (env.ADMIN_API_TOKEN && token === env.ADMIN_API_TOKEN) {
          // system token — always permitted
        } else {
          const decoded = verifyAccessToken(token);
          requireRole(decoded.role, "editor");
        }
      } catch {
        reply.code(401).send({ error: "invalid token" });
        return;
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const send = (event: string, data: unknown) => {
        try {
          reply.raw.write(`event: ${event}\n`);
          reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
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

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(`: ping\n\n`);
        } catch {
          /* ignore — close handler will clean up */
        }
      }, 25_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        broadcastEngine.off("event", onEvent);
        try {
          reply.raw.end();
        } catch {
          /* ignore */
        }
      };

      req.raw.on("close", cleanup);
      req.raw.on("error", cleanup);
    },
  );
}
