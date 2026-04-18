import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { resumePendingJobsOnStartup } from "./lib/transcoder";
import { startNotificationScheduler } from "./lib/notification-scheduler";
import { startSSEHeartbeat, closeAllSSEClients } from "./lib/liveEvents";

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

server.listen(port, () => {
  logger.info({ port }, "Server listening");

  resumePendingJobsOnStartup().catch((err) => {
    logger.error({ err }, "Failed to resume pending transcoding jobs");
  });

  startNotificationScheduler();
  startSSEHeartbeat();
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
