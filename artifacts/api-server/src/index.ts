import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { resumePendingJobsOnStartup, startRetryTick } from "./lib/transcoder";
import { assertFfmpegAvailable } from "./lib/ffmpeg";
import { startNotificationScheduler } from "./lib/notification-scheduler";
import { startSSEHeartbeat, closeAllSSEClients } from "./lib/liveEvents";
import { startYoutubeCatalogueScheduler } from "./routes/youtube";

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

  // Verify ffmpeg + ffprobe are present BEFORE the worker can pick up jobs.
  // We log loudly on failure but don't crash — the rest of the API still
  // serves traffic, and uploads can still be received; only the transcoder
  // is gated behind this check.
  assertFfmpegAvailable()
    .then(() => {
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
  startYoutubeCatalogueScheduler();
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
