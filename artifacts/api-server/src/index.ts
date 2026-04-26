import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import {
  resumePendingJobsOnStartup,
  startRetryTick,
  stopRetryTick,
} from "./lib/transcoder";
import { assertFfmpegAvailable } from "./lib/ffmpeg";
import { startNotificationScheduler } from "./lib/notification-scheduler";
import { startLiveOverrideScheduler } from "./lib/live-override-scheduler";
import { startSSEHeartbeat, closeAllSSEClients } from "./lib/liveEvents";
import { startBroadcastTransitionTicker } from "./routes/broadcast";
import { startLiveIngestHealthMonitor, stopLiveIngestHealthMonitor } from "./lib/liveIngestHealth";
import { startStreamHealthEmitter } from "./lib/streamHealth";
import { startYoutubeCatalogueScheduler } from "./routes/youtube";
import { cache } from "./lib/cache";
import { AWS_REGION, AWS_S3_BUCKET, isS3Configured } from "./lib/s3Storage";
import { runS3MirrorReconciliation } from "./lib/s3MirrorReconciler";
import { markDraining, markReady } from "./lib/lifecycle";

const REQUIRED_ENV_VARS = ["DATABASE_URL", "JWT_SECRET"] as const;

for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    throw new Error(
      `Required environment variable "${key}" is missing. Set it before starting the server.`,
    );
  }
}

const RUN_MODE = (process.env.RUN_MODE ?? "all").toLowerCase();
const VALID_RUN_MODES = new Set(["api", "worker", "all"]);

if (!VALID_RUN_MODES.has(RUN_MODE)) {
  throw new Error(
    `Invalid RUN_MODE "${process.env.RUN_MODE}". Must be one of: api, worker, all (default).`,
  );
}

const RUNS_API = RUN_MODE === "all" || RUN_MODE === "api";
const RUNS_WORKER = RUN_MODE === "all" || RUN_MODE === "worker";

logger.info(
  { runMode: RUN_MODE, runsApi: RUNS_API, runsWorker: RUNS_WORKER },
  "Process role resolved",
);

function logInfrastructureStatus() {
  const s3Configured = isS3Configured();
  const redisConfigured = Boolean(process.env.REDIS_URL?.trim());

  logger.info(
    {
      objectStorage: {
        provider: "aws-s3",
        configured: s3Configured,
        bucket: s3Configured
          ? AWS_S3_BUCKET
          : "not set — uploads will use local FS only",
        region: s3Configured ? AWS_REGION : "not set",
        publicPaths: process.env.PUBLIC_OBJECT_SEARCH_PATHS ?? "not set",
        privateDir: process.env.PRIVATE_OBJECT_DIR ?? "not set",
      },
      distributedCache: {
        redis: redisConfigured ? "configured" : "not configured",
        pgCache: "active (cache_entries table)",
        note: redisConfigured
          ? "Redis primary, PostgreSQL secondary"
          : "PostgreSQL distributed cache active across all instances",
      },
      hlsTranscoder: {
        ffmpegPath: process.env.FFMPEG_PATH ?? "system PATH",
        cloudUpload: s3Configured ? "enabled (AWS S3)" : "disabled (no bucket)",
        runsInThisProcess: RUNS_WORKER,
      },
    },
    "Infrastructure status at startup",
  );

  // ── Production safety gate ─────────────────────────────────────────────────
  // In production, refuse to keep serving traffic if AWS S3 is not configured.
  // Without S3, every uploaded video and transcoded HLS segment lands on the
  // ephemeral container disk and disappears on the next deploy/restart — a
  // silent data-loss path that should never reach users.
  if (process.env.NODE_ENV === "production" && !s3Configured) {
    logger.fatal(
      {
        missing: [
          process.env.AWS_S3_BUCKET ? null : "AWS_S3_BUCKET",
          process.env.AWS_REGION ? null : "AWS_REGION",
          process.env.AWS_ACCESS_KEY_ID ? null : "AWS_ACCESS_KEY_ID",
          process.env.AWS_SECRET_ACCESS_KEY ? null : "AWS_SECRET_ACCESS_KEY",
        ].filter(Boolean),
      },
      "Refusing to start: AWS S3 is required in production but is not configured. " +
        "Uploads would be written to ephemeral disk and lost on the next deploy. " +
        "Set AWS_S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY " +
        "in the deployment environment, then redeploy.",
    );
    setTimeout(() => process.exit(1), 250);
    return;
  }
}

function startTranscoderRole() {
  // Verify ffmpeg + ffprobe are present BEFORE the worker can pick up jobs.
  assertFfmpegAvailable()
    .then(() => {
      logger.info("FFmpeg preflight passed — transcoding pipeline active");
      resumePendingJobsOnStartup().catch((err) => {
        logger.error({ err }, "Failed to resume pending transcoding jobs");
      });
      startRetryTick();
    })
    .catch((err) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "FFmpeg preflight failed — transcoder disabled until binaries are available",
      );
    });
}

function startApiSchedulers() {
  startNotificationScheduler();
  startLiveOverrideScheduler();
  startSSEHeartbeat();
  startBroadcastTransitionTicker();
  startStreamHealthEmitter();
  startYoutubeCatalogueScheduler();
  startLiveIngestHealthMonitor();

  // Log cache backend once it has had time to connect (2s warm-up).
  setTimeout(() => {
    const status = cache.status();
    logger.info({ cacheStatus: status }, "Cache backend resolved");
  }, 2_000);

  // Reconcile any local uploads whose S3 mirror failed at finalize time.
  // Fire-and-forget so a slow/large backlog never blocks request serving.
  // The reconciler is internally bounded-concurrency and idempotent.
  runS3MirrorReconciliation().catch((err) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "s3MirrorReconciler: pass crashed",
    );
  });

  // All schedulers armed and the HTTP server is already listening at this
  // point — flip /healthz from `starting` (503) to `ok` (200) so load
  // balancers begin routing traffic to this instance.
  markReady();
  logger.info("Lifecycle: ready (healthz now reports 200)");
}

let server: http.Server | null = null;

if (RUNS_API) {
  const rawPort = process.env["PORT"];
  if (!rawPort) {
    throw new Error(
      "PORT environment variable is required for api mode but was not provided.",
    );
  }
  const port = Number(rawPort);
  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  server = http.createServer(app);
  server.listen(port, "0.0.0.0", () => {
    logger.info({ port, host: "0.0.0.0" }, "Server listening");
    logInfrastructureStatus();
    startApiSchedulers();
    if (RUNS_WORKER) {
      startTranscoderRole();
    }
  });

  server.on("error", (err) => {
    logger.error({ err }, "Server error");
    process.exit(1);
  });
} else {
  // Pure worker process: no HTTP listener. The retry interval (and any
  // in-flight ffmpeg child) keeps the event loop alive. Render `worker`
  // services do not expose a port and do not require a health endpoint.
  logger.info("Starting in worker-only mode (no HTTP listener)");
  logInfrastructureStatus();
  startTranscoderRole();
}

let isShuttingDown = false;

/**
 * Two-phase graceful shutdown.
 *
 * Phase 1 — DRAIN (default 5 s, override via SHUTDOWN_DRAIN_MS):
 *   Flip /healthz to 503 `draining` immediately. The HTTP server keeps
 *   accepting and serving requests so in-flight calls finish cleanly.
 *   The drain window gives the LB time to observe ≥1 failed health probe
 *   and stop routing new traffic to this instance. Without this window,
 *   `server.close()` would race the LB and produce mid-request TCP resets
 *   (the symptom users see as "API connection lost").
 *
 * Phase 2 — CLOSE:
 *   Stop schedulers, close SSE clients, then `server.close()` to drain
 *   any remaining in-flight requests. A hard 15 s overall timer prevents
 *   a stuck connection from blocking the deploy forever.
 */
function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const drainMs = Math.max(
    0,
    Number(process.env.SHUTDOWN_DRAIN_MS ?? 5_000) || 0,
  );

  logger.info(
    { signal, runMode: RUN_MODE, drainMs },
    "Graceful shutdown initiated — entering drain phase",
  );

  // Phase 1: announce drain via /healthz so the LB can divert new traffic.
  if (RUNS_API) {
    markDraining();
  }

  // Hard cap on the total shutdown — fires regardless of which phase we're in.
  const forceTimer = setTimeout(() => {
    logger.warn("Forced shutdown after timeout");
    process.exit(1);
  }, 15_000);
  forceTimer.unref();

  const closePhase = () => {
    if (RUNS_WORKER) {
      try {
        stopRetryTick();
      } catch (err) {
        logger.warn({ err }, "Error stopping retry tick");
      }
    }

    if (RUNS_API) {
      try {
        stopLiveIngestHealthMonitor();
      } catch (err) {
        logger.warn({ err }, "Error stopping live ingest health monitor");
      }
    }

    if (server) {
      closeAllSSEClients();
      server.close((err) => {
        if (err) {
          logger.error({ err }, "Error closing server");
          process.exit(1);
        }
        logger.info("Server closed cleanly");
        process.exit(0);
      });
    } else {
      // Worker-only process — exit immediately after stopping the tick.
      logger.info("Worker stopped cleanly");
      setTimeout(() => process.exit(0), 100);
    }
  };

  if (drainMs > 0 && RUNS_API) {
    setTimeout(closePhase, drainMs).unref();
  } else {
    closePhase();
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled rejection");
});
