/**
 * BoundedTtlMap — a Map<K, V> with a hard size cap and per-entry TTL.
 *
 * Why this exists
 * ───────────────
 * Several middleware modules in the API process keep per-key in-memory
 * caches keyed by S3 object key (one signed-URL cache per file, one HEAD
 * existence cache, one transient HEAD-error negative cache, one in-flight
 * request counter, …). Originally those were plain `Map<string, …>`
 * instances with a TTL but NO size cap. Under sustained traffic against a
 * very large or growing object set (e.g. a CDN edge probing every uploaded
 * MP4, or an attacker walking distinct paths) the maps grow without bound
 * and the API process's `external` / V8 retained memory creeps until the
 * container OOM-kills.
 *
 * The fix: every cache uses BoundedTtlMap with an explicit `maxEntries`
 * and TTL. On `set`, if we'd exceed the cap, the oldest entry by insertion
 * order is evicted (FIFO). On `get`, expired entries are deleted lazily
 * AND fresh entries are moved to the most-recently-used position so the
 * eviction policy approximates LRU under steady-state load.
 *
 * The implementation leans on the well-defined property of JS `Map` that
 * iteration order matches insertion order — this lets us implement LRU in
 * O(1) per operation with no auxiliary doubly-linked list.
 *
 * Memory cost per entry: one Map slot (~48 bytes on V8) + one wrapper
 * object (`{ value, expiresAt }`). At maxEntries=10_000 the worst-case
 * footprint of a bounded map of small payloads is ~1 MB — comfortable on
 * even the smallest Render instance.
 */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class BoundedTtlMap<K, V> {
  private readonly map = new Map<K, Entry<V>>();
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
      throw new Error(
        `BoundedTtlMap: maxEntries must be a positive integer, got ${String(maxEntries)}`,
      );
    }
    this.maxEntries = Math.floor(maxEntries);
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Move to MRU position by re-inserting (Map preserves insertion order).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs: number): void {
    // If the key already exists, delete it first so the re-insert lands
    // at the MRU position rather than overwriting in place.
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      // The first key in iteration order is the LRU entry — evict it.
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
