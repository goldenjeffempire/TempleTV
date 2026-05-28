import { getRedis } from "./redis.js";
import { logger } from "./logger.js";

/**
 * Cache abstraction. Backend resolution order:
 *   1. Redis (if REDIS_URL is set and connection is up)
 *   2. In-process LRU (always available; per-instance only)
 *
 * Use `cache.get/set/del`. For multi-instance coherency you MUST
 * provision Redis — the in-process backend is per-pod.
 *
 * Named caches can be registered via `registerNamedCache()` for
 * introspection by the `GET /admin/diagnostics/memory` endpoint.
 */
export interface Cache {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
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
  size(): number {
    // Purge expired entries on introspection so the count is accurate.
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (v.expiresAt !== null && v.expiresAt < now) this.map.delete(k);
    }
    return this.map.size;
  }
}

const REDIS_MAX_VALUE_BYTES = 8 * 1024 * 1024;

class RedisCache implements Cache {
  readonly backend = "redis" as const;
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
  return _cache;
}

// ── Named cache registry ──────────────────────────────────────────────────────
// Any module that maintains an in-process cache (LRU, Map, etc.) can register
// it here so the memory diagnostics endpoint reports live cache sizes.

interface NamedCache {
  name: string;
  getSize: () => number;
}

const _namedCaches: NamedCache[] = [];

/**
 * Register a cache instance under a human-readable name.
 * Idempotent — registering the same name twice replaces the previous entry.
 */
export function registerNamedCache(name: string, c: Cache): void {
  const idx = _namedCaches.findIndex((n) => n.name === name);
  const entry: NamedCache = { name, getSize: () => c.size() };
  if (idx >= 0) _namedCaches[idx] = entry;
  else _namedCaches.push(entry);
}

/**
 * Register an arbitrary size-reporting function under a name.
 * Use this for non-Cache Map/Set instances (e.g. dedup stores, token maps).
 */
export function registerNamedStore(name: string, getSize: () => number): void {
  const idx = _namedCaches.findIndex((n) => n.name === name);
  const entry: NamedCache = { name, getSize };
  if (idx >= 0) _namedCaches[idx] = entry;
  else _namedCaches.push(entry);
}

/** Returns a snapshot of all registered cache sizes for diagnostics. */
export function getRegisteredCacheStats(): Array<{ name: string; size: number }> {
  return _namedCaches.map(({ name, getSize }) => ({
    name,
    size: (() => { try { return getSize(); } catch { return -1; } })(),
  }));
}
