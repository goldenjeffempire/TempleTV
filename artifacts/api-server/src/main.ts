import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./infrastructure/logger.js";
import { broadcastEngine } from "./modules/broadcast/queue.engine.js";
import { closeDb } from "./infrastructure/db.js";
import { closeRedis } from "./infrastructure/redis.js";

async function main() {
  const app = await buildApp();

  try {
    await broadcastEngine.start();
  } catch (err) {
    logger.error({ err }, "broadcast engine failed to start (server still listening)");
  }

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info({ port: env.PORT }, "API ready — http://0.0.0.0:" + env.PORT);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "graceful shutdown starting");
    broadcastEngine.stop();
    try {
      await app.close();
    } catch (err) {
      logger.error({ err }, "error closing fastify");
    }
    await closeDb().catch(() => undefined);
    await closeRedis().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandledRejection");
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException — exiting");
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, "API failed to boot");
  process.exit(1);
});
