import { getRedis } from "./redis.js";
import { logger } from "./logger.js";

/**
 * Cache abstraction. Backend resolution order:
 *   1. Redis (if REDIS_URL is set and connection is up)
 *   2. In-process LRU (always available; per-instance only)
 *
 * Use `cache.get/set/del`. For multi-instance coherency you MUST
 * provision Redis — the in-process backend is per-pod.
 */
export interface Cache {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  readonly backend: "redis" | "memory";
}

class MemoryCache implements Cache {
  /**
   * True LRU cache backed by a Map whose insertion order tracks
   * recency. On every read we delete and re-insert the entry so it
   * moves to the tail (most-recently-used). On overflow we evict from
   * the head (least-recently-used). This is O(1) for all operations
   * because Map iteration starts at the insertion head.
   *
   * Compared with the old FIFO eviction this ensures hot cache entries
   * (e.g. `/admin/stats`, the broadcast guide) are never evicted while
   * cold entries from one-off page loads are pruned first.
   */
  private readonly MAX_SIZE = 10_000;
  private map = new Map<string, { v: unknown; expiresAt: number | null }>();
  readonly backend = "memory" as const;

  async get<T>(key: string): Promise<T | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expiresAt !== null && hit.expiresAt < Date.now()) {
      this.map.delete(key);
      return null;
    }
    // Promote to tail (most-recently-used)
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.v as T;
  }
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    // Evict LRU entry (map head) when the cache is at capacity.
    // Delete before potential re-insertion to avoid counting an existing
    // key as a new entry.
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.MAX_SIZE) {
      const lruKey = this.map.keys().next().value;
      if (lruKey !== undefined) this.map.delete(lruKey);
    }
    this.map.set(key, {
      v: value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }
  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
}

class RedisCache implements Cache {
  readonly backend = "redis" as const;
  constructor(private readonly client: ReturnType<typeof getRedis> & {}) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const payload = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.set(key, payload, "EX", ttlSeconds);
    } else {
      await this.client.set(key, payload);
    }
  }
  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}

let _cache: Cache | null = null;

export function cache(): Cache {
  if (_cache) return _cache;
  const r = getRedis();
  _cache = r ? new RedisCache(r) : new MemoryCache();
  logger.info({ backend: _cache.backend }, "cache backend resolved");
  return _cache;
}
