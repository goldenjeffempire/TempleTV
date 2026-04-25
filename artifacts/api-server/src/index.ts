import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { resumePendingJobsOnStartup, startRetryTick } from "./lib/transcoder";
import { assertFfmpegAvailable } from "./lib/ffmpeg";
import { startNotificationScheduler } from "./lib/notification-scheduler";
import { startSSEHeartbeat, closeAllSSEClients } from "./lib/liveEvents";
import { startBroadcastTransitionTicker } from "./routes/broadcast";
import { startStreamHealthEmitter } from "./lib/streamHealth";
import { startYoutubeCatalogueScheduler } from "./routes/youtube";
import { cache } from "./lib/cache";
import { AWS_REGION, AWS_S3_BUCKET, isS3Configured } from "./lib/s3Storage";

const REQUIRED_ENV_VARS = ["DATABASE_URL", "JWT_SECRET"] as const;

for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    throw new Error(
      `Required environment variable "${key}" is missing. Set it before starting the server.`,
    );
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = http.createServer(app);

server.listen(port, "0.0.0.0", () => {
  logger.info({ port, host: "0.0.0.0" }, "Server listening");

  // ── Infrastructure diagnostics ──────────────────────────────────────────────
  // Log the status of all three production infrastructure services so that
  // the startup log is the single source of truth for operators.
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
      },
    },
    "Infrastructure status at startup",
  );

  // Verify ffmpeg + ffprobe are present BEFORE the worker can pick up jobs.
  // We log loudly on failure but don't crash — the rest of the API still
  // serves traffic, and uploads can still be received; only the transcoder
  // is gated behind this check.
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

  startNotificationScheduler();
  startSSEHeartbeat();
  startBroadcastTransitionTicker();
  startStreamHealthEmitter();
  startYoutubeCatalogueScheduler();

  // Log cache backend once it has had time to connect (2 s warm-up).
  setTimeout(() => {
    const status = cache.status();
    logger.info({ cacheStatus: status }, "Cache backend resolved");
  }, 2_000);
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});

let isShuttingDown = false;

function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, "Graceful shutdown initiated");

  closeAllSSEClients();

  server.close((err) => {
    if (err) {
      logger.error({ err }, "Error closing server");
      process.exit(1);
    }
    logger.info("Server closed cleanly");
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn("Forced shutdown after timeout");
    process.exit(1);
  }, 15_000).unref();
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
