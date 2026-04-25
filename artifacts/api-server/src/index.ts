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

  // ── Production safety gate ─────────────────────────────────────────────────
  // In production, refuse to keep serving traffic if AWS S3 is not configured.
  // Without S3, every uploaded video and transcoded HLS segment lands on the
  // ephemeral container disk and disappears on the next deploy/restart — a
  // silent data-loss path that should never reach users. Render (and any
  // sane orchestrator) will surface the crash and roll back to the previous
  // healthy revision so a stripped env var can't quietly downgrade us.
  // Dev and CI keep the soft warning behavior so local work isn't gated on
  // having AWS credentials.
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
    // Give pino a moment to flush to stdout before the orchestrator reaps us.
    setTimeout(() => process.exit(1), 250);
    return;
  }

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
