import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

let client: Redis | null = null;

export function getRedis(): Redis | null {
  if (client) return client;
  if (!env.REDIS_URL) return null;
  client = new Redis(env.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });
  client.on("error", (err) => {
    logger.warn({ err: err.message }, "redis error (degraded to pg fallback)");
  });
  client.on("ready", () => {
    logger.info("redis ready");
  });
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
}
