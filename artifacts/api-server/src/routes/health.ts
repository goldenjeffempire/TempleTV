import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db, broadcastQueueTable, scheduleTable, videosTable, transcodingJobsTable } from "@workspace/db";
import { count, eq, sql } from "drizzle-orm";
import { cache } from "../lib/cache";
import { metricsSnapshot, metricsText } from "../middlewares/observability";
import { isFfmpegReady } from "../lib/ffmpeg";
import { AWS_REGION, AWS_S3_BUCKET, isS3Configured } from "../lib/s3Storage";
import { getLifecycleState, isDraining, isReady } from "../lib/lifecycle";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Liveness + readiness probe used by load balancers (Render, Replit
 * deployments) and by the admin frontend's connectivity poller.
 *
 * Status mapping (HTTP code is what the LB cares about):
 *   200 ok        — process is up, dependencies reachable, accepting traffic
 *   503 starting  — process up but schedulers/connections not yet armed
 *   503 draining  — SIGTERM received; drain new traffic away from this pod
 *   503 db_down   — process up but database unreachable; do not route here
 *
 * The DB ping uses a 1.5 s budget so a stuck connection cannot stall the
 * probe (Render cuts health checks at ~5 s and would mark us unhealthy
 * for the wrong reason).
 *
 * `Cache-Control: no-store` is mandatory: any intermediate cache returning
 * a stale 200 during a draining window would defeat the entire mechanism.
 */
router.get("/healthz", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  const lifecycle = getLifecycleState();

  if (isDraining()) {
    res.status(503).json({
      ...HealthCheckResponse.parse({ status: "draining" }),
      phase: lifecycle.phase,
      uptimeSec: lifecycle.uptimeSec,
      drainingAt: lifecycle.drainingAt,
    });
    return;
  }

  if (!isReady()) {
    res.status(503).json({
      status: "starting",
      phase: lifecycle.phase,
      uptimeSec: lifecycle.uptimeSec,
    });
    return;
  }

  // Bounded DB probe. AbortSignal isn't honored by node-postgres mid-query,
  // so we race the ping against a timer and treat a timeout as "db_down".
  const DB_PROBE_BUDGET_MS = 1_500;
  let dbOk = false;
  try {
    dbOk = await Promise.race<boolean>([
      db.execute(sql`select 1 as ok`).then(() => true).catch(() => false),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), DB_PROBE_BUDGET_MS).unref(),
      ),
    ]);
  } catch (err) {
    // Defensive: Promise.race itself shouldn't throw, but if anything in
    // the driver stack does, log once and degrade — never let /healthz throw.
    logger.warn({ err }, "/healthz: db probe threw unexpectedly");
    dbOk = false;
  }

  if (!dbOk) {
    res.status(503).json({
      status: "db_down",
      phase: lifecycle.phase,
      uptimeSec: lifecycle.uptimeSec,
    });
    return;
  }

  res.status(200).json({
    ...HealthCheckResponse.parse({ status: "ok" }),
    phase: lifecycle.phase,
    uptimeSec: lifecycle.uptimeSec,
    readyAt: lifecycle.readyAt,
  });
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
  const s3Ready = isS3Configured();
  const publicObjectPaths = process.env.PUBLIC_OBJECT_SEARCH_PATHS?.trim() ?? "";
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR?.trim() ?? "";
  const objectStorageConfigured = Boolean(s3Ready && publicObjectPaths && privateObjectDir);

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
      label: "AWS Cloud storage",
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
        provider: "aws-s3",
        configured: objectStorageConfigured,
        bucket: AWS_S3_BUCKET || null,
        region: AWS_REGION || null,
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
