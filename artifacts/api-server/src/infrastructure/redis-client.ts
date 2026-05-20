/**
 * Redis client utilities for broadcast fan-out.
 *
 * Provides:
 *   - INSTANCE_ID: stable per-process identifier used for leader-election and
 *     pub/sub message deduplication.
 *   - createRedisSubscriberClient(): a dedicated ioredis connection that
 *     enters subscriber mode (SUBSCRIBE/PSUBSCRIBE).  A separate connection is
 *     required because ioredis blocks a connection from issuing regular
 *     commands once it enters subscriber mode.
 *
 * Regular command work (SET/GET/PUBLISH/SETEX) should continue to use the
 * existing getRedis() singleton from infrastructure/redis.ts so that command
 * and subscriber connections are not conflated.
 */

import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Unique identifier for this process instance.
 *
 * Combines hostname + PID + a hi-res timestamp suffix so two replicas
 * starting at the same millisecond on the same host still get distinct IDs.
 * Used as the value stored in the Redis leader key and as the `instanceId`
 * field in pub/sub messages so each replica can recognise and discard its
 * own published frames.
 */
export const INSTANCE_ID: string =
  `${process.env["HOSTNAME"] ?? "host"}-${process.pid}-${Date.now().toString(36)}`;

/**
 * Create a brand-new ioredis connection configured for subscriber mode.
 *
 * Returns null when REDIS_URL is absent so callers can degrade gracefully.
 * The caller owns the returned connection and must call .quit() on shutdown.
 *
 * `maxRetriesPerRequest` is set to null (unlimited) so that the subscriber
 * reconnects automatically after a Redis restart without throwing on the
 * pending SUBSCRIBE command — ioredis will re-issue it on reconnect.
 */
export function createRedisSubscriberClient(): Redis | null {
  if (!env.REDIS_URL) return null;

  const sub = new Redis(env.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    autoResubscribe: true,
  });

  sub.on("error", (err: Error) => {
    logger.warn({ err: err.message }, "[redis-subscriber] connection error (auto-reconnecting)");
  });
  sub.on("ready", () => {
    logger.info("[redis-subscriber] ready");
  });

  return sub;
}
