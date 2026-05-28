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
export declare function cache(): Cache;
/**
 * Register a cache instance under a human-readable name.
 * Idempotent — registering the same name twice replaces the previous entry.
 */
export declare function registerNamedCache(name: string, c: Cache): void;
/**
 * Register an arbitrary size-reporting function under a name.
 * Use this for non-Cache Map/Set instances (e.g. dedup stores, token maps).
 */
export declare function registerNamedStore(name: string, getSize: () => number): void;
/** Returns a snapshot of all registered cache sizes for diagnostics. */
export declare function getRegisteredCacheStats(): Array<{
    name: string;
    size: number;
}>;
