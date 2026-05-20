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
export declare function cache(): Cache;
