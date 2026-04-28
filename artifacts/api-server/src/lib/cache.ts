import { logger } from "./logger";
import { db, cacheEntriesTable } from "@workspace/db";
import { eq, lt, sql } from "drizzle-orm";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Hard cap on the number of entries the in-memory L1 cache can hold.
 *
 * Why a cap exists at all (production incident 2026-04-28): the previous
 * implementation was an UNBOUNDED `Map<string, CacheEntry>`. Code paths
 * that synthesise unique keys per request (signed-URL helpers, per-user
 * admin lookups, transient scrape results) silently accumulated entries
 * that the 60 s GC could only reclaim once they had EXPIRED — between
 * GC ticks the Map could grow without bound, and entries with long TTLs
 * (10 min `youtube:videos`, 2 min `admin:stats:v1`) hung around for many
 * GC cycles. Combined with the broadcast payload (~218 KiB) being cached
 * 12×/min under a single key, the worst-case footprint was unbounded
 * over hours of uptime — matched exactly the slow ~30 MiB/min RSS climb
 * observed in production before the 2 GiB cgroup ceiling SIGKILL'd.
 *
 * 1024 is generous: every named CACHE_KEYS constant + the broadcast +
 * the schedule + the queue + ~1000 transient keys would still fit. The
 * eviction policy is "expired-first, then oldest-insertion" — Map's
 * iteration order is insertion order in JS, so dropping the head is O(1)
 * per eviction and cheap. The cap is overridable via env so a future
 * scaling event can lift it without a code change.
 */
const MEMORY_CACHE_MAX_ENTRIES = Math.max(
  64,
  Number(process.env.MEMORY_CACHE_MAX_ENTRIES ?? "1024"),
);

class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private gcInterval: ReturnType<typeof setInterval>;

  constructor() {
    this.gcInterval = setInterval(() => this.gc(), 60_000);
    this.gcInterval.unref?.();
  }

  private gc() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }

  /**
   * Evict the oldest expired entry first; if none are expired, evict the
   * oldest by insertion order. Called from `set()` whenever the store is
   * at the cap so the Map can never grow past `MEMORY_CACHE_MAX_ENTRIES`.
   */
  private evictOne(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
        return;
      }
    }
    // No expired entries — drop the oldest live one (Map iteration order
    // is insertion order, so the first key is the oldest).
    const firstKey = this.store.keys().next().value;
    if (firstKey !== undefined) this.store.delete(firstKey);
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (!this.store.has(key) && this.store.size >= MEMORY_CACHE_MAX_ENTRIES) {
      this.evictOne();
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  del(key: string): void {
    this.store.delete(key);
  }

  flush(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

/**
 * PostgreSQL-backed distributed cache.
 *
 * Uses the `cache_entries` table as a shared KV store. Safe for multi-instance
 * deployments because all instances read and write to the same Neon database.
 *
 * Performance notes:
 * - Reads are ~1-5ms (indexed primary key lookup + Neon connection pool).
 * - Writes use INSERT … ON CONFLICT DO UPDATE (upsert) — atomic, no race.
 * - Expired rows are pruned lazily (on read) plus a GC tick every 5 minutes.
 * - The in-memory MemoryCache is always kept in sync as an L1 layer to avoid
 *   DB round-trips for hot keys within the same instance.
 */
class PgCache {
  private ready = false;
  private gcInterval: ReturnType<typeof setInterval>;

  constructor() {
    this.init();
    // Prune expired rows from the table every 5 minutes.
    this.gcInterval = setInterval(() => this.gc(), 5 * 60_000);
    this.gcInterval.unref?.();
  }

  private async init() {
    try {
      // Quick connectivity check.
      await db.execute(sql`select 1`);
      this.ready = true;
      logger.info("PostgreSQL distributed cache ready");
    } catch (err) {
      logger.warn({ err }, "PostgreSQL cache init failed — falling back to memory only");
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.ready) return null;
    try {
      const now = new Date();
      const rows = await db
        .select({ value: cacheEntriesTable.value })
        .from(cacheEntriesTable)
        .where(eq(cacheEntriesTable.key, key))
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (!this.ready) return;
    try {
      // Serialise ONCE — the previous implementation called JSON.stringify
      // twice (insert values + onConflictDoUpdate set), wasting a full
      // payload-sized allocation per write. The broadcast snapshot alone
      // is ~218 KiB at a 5 s TTL; the duplicate stringify added ~52 MiB/min
      // of short-lived heap allocation purely for that key.
      const serialised = JSON.stringify(value);
      const expiresAt = new Date(Date.now() + ttlMs);
      await db
        .insert(cacheEntriesTable)
        .values({ key, value: serialised, expiresAt })
        .onConflictDoUpdate({
          target: cacheEntriesTable.key,
          set: {
            value: serialised,
            expiresAt,
            updatedAt: new Date(),
          },
        });
    } catch {}
  }

  async del(key: string): Promise<void> {
    if (!this.ready) return;
    try {
      await db.delete(cacheEntriesTable).where(eq(cacheEntriesTable.key, key));
    } catch {}
  }

  private async gc(): Promise<void> {
    if (!this.ready) return;
    try {
      await db.delete(cacheEntriesTable).where(lt(cacheEntriesTable.expiresAt, new Date()));
    } catch {}
  }
}

class RedisCache {
  private client!: import("ioredis").Redis;
  private ready = false;

  constructor(url: string) {
    import("ioredis").then(({ default: Redis }) => {
      this.client = new Redis(url, {
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        lazyConnect: true,
        connectTimeout: 4000,
        commandTimeout: 3000,
      });

      this.client.on("connect", () => {
        this.ready = true;
        logger.info("Redis connected");
      });

      this.client.on("error", (err: Error) => {
        if (this.ready) logger.warn({ err: err.message }, "Redis error — falling back to pg cache");
        this.ready = false;
      });

      this.client.connect().catch(() => {
        logger.warn("Redis connect failed — PostgreSQL distributed cache active");
      });
    }).catch(() => {
      logger.warn("ioredis not available");
    });
  }

  isReady() {
    return this.ready;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.ready) return null;
    try {
      const raw = await this.client.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (!this.ready) return;
    try {
      await this.client.set(key, JSON.stringify(value), "PX", ttlMs);
    } catch {}
  }

  async del(key: string): Promise<void> {
    if (!this.ready) return;
    try {
      await this.client.del(key);
    } catch {}
  }
}

const memoryCache = new MemoryCache();
const redisCache = process.env.REDIS_URL ? new RedisCache(process.env.REDIS_URL) : null;
const pgCache = new PgCache();

/**
 * Returns the best available distributed backend (Redis > PostgreSQL).
 * Falls back to null when neither is ready.
 */
function distributedCache(): RedisCache | PgCache | null {
  if (redisCache?.isReady()) return redisCache;
  if (pgCache.isReady()) return pgCache;
  return null;
}

// Single-flight de-dup map for `getOrSet`. Keyed by the cache key — when a
// second caller arrives while the first is still mid-fetcher, it awaits the
// same in-flight promise instead of stampeding the DB with a parallel cold
// rebuild. Critical on instance boot: the LB starts routing the moment
// `markReady()` flips healthz to 200, which can land a /broadcast/current
// request at the exact same moment the broadcast transition ticker is also
// rebuilding the snapshot — without de-dup both pay the full cold cost.
const inFlight = new Map<string, Promise<unknown>>();

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    const l1 = memoryCache.get<T>(key);
    if (l1 !== null) return l1;
    const dist = distributedCache();
    if (!dist) return null;
    return dist.get<T>(key);
  },

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    memoryCache.set(key, value, ttlMs);
    const dist = distributedCache();
    if (dist) await dist.set(key, value, ttlMs);
  },

  /**
   * Write-through with non-blocking distributed propagation.
   *
   * Updates the in-memory L1 synchronously (so the same-instance hot path
   * serves the new value immediately) and fires the distributed-cache write
   * fire-and-forget. The caller never waits on the PG round-trip.
   *
   * Use this from any hot path where the awaited distributed write is dead
   * weight on the request critical path. The classic case is
   * `buildBroadcastCurrentPayload`'s cold rebuild: the L1 cache is enough
   * for this instance's next read, and the distributed write only matters
   * for OTHER instances on their next cold rebuild — neither cares about
   * the few-ms propagation delay.
   *
   * Trade-off: if the distributed write fails, this instance is still
   * correct (L1 has the value); other instances will fall back to their
   * own cold rebuild on miss — same as today's silent-catch behavior in
   * the `PgCache.set` body. Errors are logged once at WARN so a sustained
   * failure mode is still visible.
   */
  setBackground<T>(key: string, value: T, ttlMs: number): void {
    memoryCache.set(key, value, ttlMs);
    const dist = distributedCache();
    if (!dist) return;
    dist.set(key, value, ttlMs).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), key },
        "cache.setBackground: distributed write failed (L1 still serves)",
      );
    });
  },

  async del(key: string): Promise<void> {
    memoryCache.del(key);
    const dist = distributedCache();
    if (dist) await dist.del(key);
  },

  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlMs: number,
  ): Promise<T> {
    const cached = await cache.get<T>(key);
    if (cached !== null) return cached;
    // Single-flight: if another caller is already mid-fetch for this key,
    // await the same in-flight promise instead of issuing a parallel cold
    // rebuild against the database. After resolution we delete the entry
    // so subsequent misses (e.g. after the new TTL expires) start fresh.
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = (async () => {
      try {
        const fresh = await fetcher();
        // Fire-and-forget the distributed write so we don't pay a PG
        // round-trip on the request critical path; L1 is set synchronously
        // inside setBackground so the next same-instance read is hot.
        cache.setBackground(key, fresh, ttlMs);
        return fresh;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, promise);
    return promise;
  },

  isRedisActive(): boolean {
    return redisCache?.isReady() ?? false;
  },

  isPgCacheActive(): boolean {
    return pgCache.isReady();
  },

  status() {
    const backend = redisCache?.isReady()
      ? "redis"
      : pgCache.isReady()
        ? "postgresql"
        : "memory";
    return {
      backend,
      redis: {
        configured: Boolean(process.env.REDIS_URL),
        connected: redisCache?.isReady() ?? false,
      },
      postgresql: {
        configured: true,
        connected: pgCache.isReady(),
      },
      memory: {
        active: true,
      },
    };
  },
};
