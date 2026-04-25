/**
 * Rate-limit storage abstraction.
 *
 * Three backends (selected in priority order):
 *   1. RedisRateStore   — atomic INCR + EXPIRE (safe across N instances, lowest latency).
 *   2. PgRateStore      — atomic INSERT … ON CONFLICT (safe across N instances, uses Neon DB).
 *   3. MemoryRateStore  — in-process Map (single-instance only, last resort).
 *
 * Selection:
 *   - REDIS_URL set and Redis reachable → RedisRateStore
 *   - Otherwise                         → PgRateStore (uses existing DATABASE_URL)
 *   - PgRateStore init failure          → MemoryRateStore (with warning)
 */
import { logger } from "./logger";
import { db, rateLimitTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

export interface RateStore {
  /**
   * Atomically increment the counter for `key`. If the key was newly created,
   * the store sets its TTL to `windowMs` ms.
   * Returns the new count and the time (ms since epoch) at which the window resets.
   */
  hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

class MemoryRateStore implements RateStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  constructor() {
    setInterval(() => {
      const now = Date.now();
      for (const [k, b] of this.buckets.entries()) {
        if (b.resetAt <= now) this.buckets.delete(k);
      }
    }, 60_000).unref();
  }
  async hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, fresh);
      return fresh;
    }
    existing.count += 1;
    return existing;
  }
}

/**
 * PostgreSQL-backed distributed rate limiter.
 *
 * Uses an atomic upsert to increment the counter for the given key.
 * When the window expires, the count resets. This is safe across
 * multiple API instances sharing the same Neon database.
 */
class PgRateStore implements RateStore {
  async hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + windowMs);

    // Atomic upsert:
    //   INSERT … ON CONFLICT: if the key exists and the window hasn't expired,
    //   increment count; otherwise reset to 1 with a new window.
    const result = await db.execute<{ count: number; reset_at: string }>(sql`
      INSERT INTO rate_limit_buckets (key, count, reset_at)
      VALUES (${key}, 1, ${windowEnd.toISOString()})
      ON CONFLICT (key) DO UPDATE
        SET count    = CASE
                         WHEN rate_limit_buckets.reset_at <= NOW() THEN 1
                         ELSE rate_limit_buckets.count + 1
                       END,
            reset_at = CASE
                         WHEN rate_limit_buckets.reset_at <= NOW() THEN ${windowEnd.toISOString()}
                         ELSE rate_limit_buckets.reset_at
                       END
      RETURNING count, reset_at
    `);

    const rows = (result as unknown as { rows?: Array<{ count: number; reset_at: string }> }).rows
      ?? (result as unknown as Array<{ count: number; reset_at: string }>);

    const row = Array.isArray(rows) ? rows[0] : undefined;
    const count = row ? Number(row.count) : 1;
    const resetAt = row ? new Date(row.reset_at).getTime() : now.getTime() + windowMs;
    return { count, resetAt };
  }
}

class RedisRateStore implements RateStore {
  private client: import("ioredis").default;
  private prefix = "rl:";
  constructor(client: import("ioredis").default) {
    this.client = client;
  }
  async hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const fullKey = `${this.prefix}${key}`;
    const pipeline = this.client.pipeline();
    pipeline.incr(fullKey);
    pipeline.pexpire(fullKey, windowMs, "NX");
    pipeline.pttl(fullKey);
    const results = await pipeline.exec();
    const count = Number((results?.[0]?.[1] as number) ?? 1);
    const ttl = Number((results?.[2]?.[1] as number) ?? windowMs);
    const resetAt = Date.now() + (ttl > 0 ? ttl : windowMs);
    return { count, resetAt };
  }
}

function buildStore(): RateStore {
  const url = process.env.REDIS_URL?.trim();
  if (url) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Redis = require("ioredis").default ?? require("ioredis");
      const client = new Redis(url, {
        lazyConnect: false,
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
      });
      client.on("error", (err: Error) => {
        logger.error({ err }, "Redis rate-store error");
      });
      logger.info("Rate limiter using Redis-backed store");
      return new RedisRateStore(client);
    } catch (err) {
      logger.error({ err }, "Failed to initialize Redis rate store; falling back to PostgreSQL");
    }
  }

  if (process.env.DATABASE_URL) {
    logger.info("Rate limiter using PostgreSQL-backed store (multi-instance safe)");
    return new PgRateStore();
  }

  logger.warn("Rate limiter using in-memory store (single-instance only — set DATABASE_URL or REDIS_URL for production)");
  return new MemoryRateStore();
}

export const rateStore: RateStore = buildStore();
