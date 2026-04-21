/**
 * Rate-limit storage abstraction.
 *
 * Two backends:
 *   • MemoryRateStore  — in-process Map (fine for single-instance deploys).
 *   • RedisRateStore   — atomic INCR + EXPIRE (safe across N instances).
 *
 * The exported `rateStore` selects RedisRateStore when REDIS_URL is set,
 * otherwise falls back to MemoryRateStore. Application code never imports a
 * specific backend.
 */
import { logger } from "./logger";

export interface RateStore {
  /**
   * Atomically increment the counter for `key`. If the key was newly created,
   * the store sets its TTL to `windowMs` ms.
   * Returns the new count and the time (ms since epoch) at which the window
   * resets.
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

class RedisRateStore implements RateStore {
  private client: import("ioredis").default;
  private prefix = "rl:";
  constructor(client: import("ioredis").default) {
    this.client = client;
  }
  async hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const fullKey = `${this.prefix}${key}`;
    // Pipeline: INCR, then PEXPIRE only if this is the first hit (NX).
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
  if (!url) {
    logger.info("Rate limiter using in-memory store (set REDIS_URL for multi-instance safety)");
    return new MemoryRateStore();
  }
  try {
    // Lazy require to avoid pulling ioredis when not configured.
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
    logger.error({ err }, "Failed to initialize Redis rate store; falling back to memory");
    return new MemoryRateStore();
  }
}

export const rateStore: RateStore = buildStore();
