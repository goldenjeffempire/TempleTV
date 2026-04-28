/**
 * Process-wide registry of in-memory cache size getters.
 *
 * The /api/uploads/* middleware chain holds several BoundedTtlMap instances
 * (s3RedirectFirst HEAD-success / HEAD-error / signed-URL caches, the
 * staticWithS3Fallback signed-URL cache, the uploadRangeGuard inflight map).
 * Each is created inside a factory closure, which is the right
 * encapsulation for the runtime path but means there's no outside handle to
 * read its size for diagnostics.
 *
 * This registry sidesteps that without breaking the closure: each factory
 * registers a `() => number` size getter at construction time. The
 * /api/admin/diagnostics/memory endpoint then iterates the registry to
 * produce a live snapshot. The registry holds *function references*, not
 * cache values — so it adds zero retention pressure, and a registered cache
 * that's later GC'd would safely return 0 (the closure would still resolve
 * but the underlying Map is empty).
 *
 * Intentionally simple: append-only, process-local, no eviction. There's
 * exactly one register call per cache per process boot — the registry has
 * a hard ceiling of ~10 entries by construction.
 */

interface RegisteredCache {
  name: string;
  size: () => number;
}

const caches: RegisteredCache[] = [];

export function registerCacheStats(name: string, size: () => number): void {
  caches.push({ name, size });
}

export interface CacheStatsSnapshot {
  name: string;
  size: number;
}

export function snapshotCacheStats(): CacheStatsSnapshot[] {
  return caches.map(({ name, size }) => {
    try {
      return { name, size: size() };
    } catch {
      // A broken size getter must never break the diagnostics endpoint.
      return { name, size: -1 };
    }
  });
}
