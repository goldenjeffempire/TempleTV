import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db, broadcastQueueTable, scheduleTable, videosTable, transcodingJobsTable } from "@workspace/db";
import { count, eq, sql } from "drizzle-orm";
import { cache } from "../lib/cache";
import { metricsSnapshot, metricsText } from "../middlewares/observability";
import { isFfmpegReady } from "../lib/ffmpeg";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/cache/status", (_req, res) => {
  const status = cache.status();
  res.json(status);
});

router.get("/ops/status", async (_req, res) => {
  const generatedAt = new Date().toISOString();
  const cacheStatus = cache.status();
  const dbConnected = await db.execute(sql`select 1 as ok`).then(() => true).catch(() => false);

  const [videosResult, scheduleResult, broadcastResult, transcodingResult] = dbConnected
    ? await Promise.all([
        db.select({ count: count() }).from(videosTable).catch(() => [{ count: 0 }]),
        db.select({ count: count() }).from(scheduleTable).where(eq(scheduleTable.isActive, true)).catch(() => [{ count: 0 }]),
        db.select({ count: count() }).from(broadcastQueueTable).where(eq(broadcastQueueTable.isActive, true)).catch(() => [{ count: 0 }]),
        db.select({ count: count() }).from(transcodingJobsTable).where(eq(transcodingJobsTable.status, "queued")).catch(() => [{ count: 0 }]),
      ])
    : [[{ count: 0 }], [{ count: 0 }], [{ count: 0 }], [{ count: 0 }]];

  const activeQueueItems = Number(broadcastResult[0]?.count ?? 0);
  const pendingTranscodeJobs = Number(transcodingResult[0]?.count ?? 0);

  // ── Infrastructure readiness ─────────────────────────────────────────────
  const objectStorageBucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID?.trim() ?? "";
  const publicObjectPaths = process.env.PUBLIC_OBJECT_SEARCH_PATHS?.trim() ?? "";
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR?.trim() ?? "";
  const objectStorageConfigured = Boolean(objectStorageBucketId && publicObjectPaths && privateObjectDir);

  const redisConfigured = Boolean(process.env.REDIS_URL?.trim());
  const redisConnected = cache.isRedisActive();
  const pgCacheActive = cache.isPgCacheActive();
  const ffmpegReady = isFfmpegReady();

  const checks = [
    {
      key: "api",
      label: "API process",
      status: "ok" as "ok" | "degraded" | "critical",
    },
    {
      key: "database",
      label: "Database",
      status: dbConnected ? ("ok" as const) : ("critical" as const),
    },
    {
      key: "cache",
      label: "Distributed cache",
      status: (redisConnected || pgCacheActive) ? ("ok" as const) : ("degraded" as const),
    },
    {
      key: "object_storage",
      label: "Cloud object storage",
      status: objectStorageConfigured ? ("ok" as const) : ("degraded" as const),
    },
    {
      key: "transcoder",
      label: "HLS transcoder (ffmpeg)",
      status: ffmpegReady ? ("ok" as const) : ("degraded" as const),
    },
    {
      key: "broadcast",
      label: "Broadcast continuity",
      status: activeQueueItems > 0 ? ("ok" as const) : ("degraded" as const),
    },
  ];

  const overallStatus = checks.some((c) => c.status === "critical")
    ? "critical"
    : checks.some((c) => c.status === "degraded")
      ? "degraded"
      : "ok";

  res.json({
    generatedAt,
    overallStatus,
    checks,
    metrics: metricsSnapshot(),
    infrastructure: {
      objectStorage: {
        configured: objectStorageConfigured,
        bucketId: objectStorageBucketId || null,
        publicSearchPaths: publicObjectPaths || null,
        privateDir: privateObjectDir || null,
      },
      cache: {
        backend: cacheStatus.backend,
        redis: {
          configured: redisConfigured,
          connected: redisConnected,
        },
        postgresql: {
          configured: true,
          connected: pgCacheActive,
        },
      },
      transcoder: {
        ffmpegReady,
        pendingJobs: pendingTranscodeJobs,
        cloudUploadEnabled: objectStorageConfigured,
      },
    },
    database: {
      connected: dbConnected,
      counts: {
        videos: Number(videosResult[0]?.count ?? 0),
        activeScheduleEntries: Number(scheduleResult[0]?.count ?? 0),
      },
    },
    broadcast: {
      activeQueueItems,
    },
  });
});

router.get("/metrics", (_req, res) => {
  res.type("text/plain; version=0.0.4; charset=utf-8").send(metricsText());
});

export default router;
