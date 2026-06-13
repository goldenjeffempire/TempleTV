import { getRedis } from "./redis.js";
import { logger } from "./logger.js";

/**
 * Cache abstraction. Backend resolution order:
 *   1. Redis (if REDIS_URL is set and connection is up)
 *   2. In-process LRU (always available; per-instance only)
 *
 * Use `cache.get/set/del/getOrSet`. For multi-instance coherency you MUST
 * provision Redis — the in-process backend is per-pod.
 *
 * Named caches can be registered via `registerNamedCache()` for
 * introspection by the `GET /admin/diagnostics/memory` endpoint.
 */
export interface Cache {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Stampede-safe get-or-set. If `key` is cached, returns immediately.
   * Otherwise calls `fn()` exactly once — even when N concurrent requests
   * race on the same expired/missing key — then caches the result for
   * `ttlSeconds`. All concurrent callers await the same in-flight Promise
   * so the origin DB/service is hit at most once per cache miss.
   */
  getOrSet<T = unknown>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T>;
  /** Current number of live (non-expired) entries. */
  size(): number;
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
   * MAX_SIZE is kept modest (1,000 entries) — the video catalog has ≤ 50
   * pages, broadcast/channel responses are a handful of keys, and the
   * short TTLs (3–300 s) mean hot entries expire quickly. 10,000 was
   * excessive and allowed the map to fill with stale JSON objects that
   * V8 couldn't reclaim until accessed again.
   */
  private readonly MAX_SIZE = 1_000;
  private map = new Map<string, { v: unknown; expiresAt: number | null }>();
  private readonly _inflight = new Map<string, Promise<unknown>>();
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
  async getOrSet<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;
    const existing = this._inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = (async () => {
      try {
        const v = await fn();
        await this.set(key, v, ttlSeconds).catch(() => {});
        return v;
      } finally {
        this._inflight.delete(key);
      }
    })();
    this._inflight.set(key, promise);
    return promise;
  }
  size(): number {
    // Purge expired entries on introspection so the count is accurate.
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (v.expiresAt !== null && v.expiresAt < now) this.map.delete(k);
    }
    return this.map.size;
  }

  /**
   * Proactively sweep all expired entries from the map and return the count
   * of entries removed. Called on a background interval AND by the memory
   * watchdog during RSS / heap-growth pressure events so stale JSON objects
   * are freed before V8 is forced to trigger a GC cycle.
   */
  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;
    for (const [k, v] of this.map) {
      if (v.expiresAt !== null && v.expiresAt < now) {
        this.map.delete(k);
        purged++;
      }
    }
    return purged;
  }
}

const REDIS_MAX_VALUE_BYTES = 8 * 1024 * 1024;

class RedisCache implements Cache {
  readonly backend = "redis" as const;
  private readonly _inflight = new Map<string, Promise<unknown>>();
  constructor(private readonly client: ReturnType<typeof getRedis> & {}) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) return null;
    if (raw.length > REDIS_MAX_VALUE_BYTES) {
      logger.warn(
        { key, bytes: raw.length, cap: REDIS_MAX_VALUE_BYTES },
        "cache: Redis value exceeds JSON.parse safety cap — discarding",
      );
      await this.client.del(key).catch(() => {});
      return null;
    }
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
  async getOrSet<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;
    const existing = this._inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = (async () => {
      try {
        const v = await fn();
        await this.set(key, v, ttlSeconds).catch(() => {});
        return v;
      } finally {
        this._inflight.delete(key);
      }
    })();
    this._inflight.set(key, promise);
    return promise;
  }
  /** Redis DBSIZE is not used here (it's a cluster-wide count and expensive).
   *  Returns -1 to signal "remote cache — size not locally tracked." */
  size(): number {
    return -1;
  }
}

let _cache: Cache | null = null;

export function cache(): Cache {
  if (_cache) return _cache;
  const r = getRedis();
  _cache = r ? new RedisCache(r) : new MemoryCache();
  logger.info({ backend: _cache.backend }, "cache backend resolved");
  // Register under a stable name for diagnostics introspection.
  registerNamedCache("main", _cache);

  // Background TTL sweep for the in-process cache.
  // Lazy eviction (evict only on access) leaves expired entries occupying
  // heap until something reads their key again — on a 24/7 server with
  // short-TTL broadcast/catalog entries this can be never. The sweep runs
  // every 60 s and frees those objects without waiting for an access hit.
  // Redis manages its own TTL server-side so the sweep is a no-op there.
  if (_cache.backend === "memory") {
    const memCache = _cache as MemoryCache;
    const sweepInterval = setInterval(() => {
      try {
        const purged = memCache.purgeExpired();
        if (purged > 0) {
          logger.debug({ purged }, "cache: background TTL sweep freed expired entries");
        }
      } catch {
        // non-fatal
      }
    }, 60_000);
    sweepInterval.unref();
  }

  return _cache;
}

/**
 * Proactively sweep expired entries from the in-process cache.
 * Called by the memory watchdog during RSS / heap-growth pressure events.
 * Returns 0 when the backend is Redis (TTL managed server-side).
 */
export function purgeExpiredCacheEntries(): number {
  if (!_cache || _cache.backend !== "memory") return 0;
  return (_cache as MemoryCache).purgeExpired();
}

// ── Named cache registry ──────────────────────────────────────────────────────
// Any module that maintains an in-process cache (LRU, Map, etc.) can register
// it here so the memory diagnostics endpoint reports live cache sizes.

interface NamedCache {
  name: string;
  getSize: () => number;
  /** Lifetime high-water mark for this store — updated on every sample. */
  peak: number;
}

const _namedCaches: NamedCache[] = [];

/**
 * Register a cache instance under a human-readable name.
 * Idempotent — registering the same name twice replaces the previous entry.
 */
export function registerNamedCache(name: string, c: Cache): void {
  const idx = _namedCaches.findIndex((n) => n.name === name);
  const entry: NamedCache = { name, getSize: () => c.size(), peak: 0 };
  if (idx >= 0) _namedCaches[idx] = { ...entry, peak: _namedCaches[idx].peak };
  else _namedCaches.push(entry);
}

/**
 * Register an arbitrary size-reporting function under a name.
 * Use this for non-Cache Map/Set instances (e.g. dedup stores, token maps).
 * Idempotent — registering the same name twice replaces the function but
 * preserves any accumulated peak value across hot-module reloads.
 */
export function registerNamedStore(name: string, getSize: () => number): void {
  const idx = _namedCaches.findIndex((n) => n.name === name);
  const entry: NamedCache = { name, getSize, peak: 0 };
  if (idx >= 0) _namedCaches[idx] = { ...entry, peak: _namedCaches[idx].peak };
  else _namedCaches.push(entry);
}

/**
 * Update the lifetime peak for every registered store without returning data.
 * Called by the memory watchdog on each 30-second tick so peaks accumulate
 * accurately even when the diagnostics endpoint is not being polled.
 */
export function sampleNamedStorePeaks(): void {
  for (const entry of _namedCaches) {
    try {
      const s = entry.getSize();
      if (s > entry.peak) entry.peak = s;
    } catch {
      // non-fatal — store may have been torn down
    }
  }
}

/** Returns a snapshot of all registered cache sizes and lifetime peaks for diagnostics. */
export function getRegisteredCacheStats(): Array<{ name: string; size: number; peak: number }> {
  return _namedCaches.map((entry) => {
    const size = (() => { try { return entry.getSize(); } catch { return -1; } })();
    if (size > entry.peak) entry.peak = size;
    return { name: entry.name, size, peak: entry.peak };
  });
}
