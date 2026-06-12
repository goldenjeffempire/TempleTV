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
export declare function cache(): Cache;
/**
 * Register a cache instance under a human-readable name.
 * Idempotent — registering the same name twice replaces the previous entry.
 */
export declare function registerNamedCache(name: string, c: Cache): void;
/**
 * Register an arbitrary size-reporting function under a name.
 * Use this for non-Cache Map/Set instances (e.g. dedup stores, token maps).
 * Idempotent — registering the same name twice replaces the function but
 * preserves any accumulated peak value across hot-module reloads.
 */
export declare function registerNamedStore(name: string, getSize: () => number): void;
/**
 * Update the lifetime peak for every registered store without returning data.
 * Called by the memory watchdog on each 30-second tick so peaks accumulate
 * accurately even when the diagnostics endpoint is not being polled.
 */
export declare function sampleNamedStorePeaks(): void;
/** Returns a snapshot of all registered cache sizes and lifetime peaks for diagnostics. */
export declare function getRegisteredCacheStats(): Array<{
    name: string;
    size: number;
    peak: number;
}>;
