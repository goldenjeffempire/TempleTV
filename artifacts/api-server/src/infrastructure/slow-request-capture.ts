/**
 * Slow-request capture ring buffer.
 *
 * Attaches a Fastify `onResponse` hook that records every request whose
 * total response time exceeds SLOW_THRESHOLD_MS into a capped ring buffer
 * and updates per-route aggregate statistics.
 *
 * The data is exposed via `getSlowRequestsSnapshot()` which the
 * `GET /admin/ops/slow-requests` endpoint calls.
 *
 * Design constraints:
 *   - O(1) ring-buffer eviction (no sorting, no splicing)
 *   - Per-route aggregates keyed by "METHOD /normalised/path"
 *   - Normalises path parameters (/videos/123 → /videos/:id) so the
 *     per-route table doesn't explode on high-cardinality IDs
 *   - Thread-safe within a single Node.js event loop (no shared state
 *     across workers)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { registerNamedStore } from "./cache.js";

/** Requests slower than this (ms) are captured. */
export const SLOW_THRESHOLD_MS = 1_000;
/** Maximum number of individual slow-request entries retained. */
const BUFFER_MAX = 200;
/** Entries older than this are pruned from the ring buffer on each read. */
const BUFFER_MAX_AGE_MS = 5 * 60 * 1_000;

export interface SlowEntry {
  method: string;
  path: string;
  rawPath: string;
  statusCode: number;
  durationMs: number;
  at: string;
  requestId: string | null;
}

export interface RouteAggregate {
  method: string;
  path: string;
  total: number;
  errors: number;
  slowCount: number;
  totalDurationMs: number;
  maxMs: number;
  lastStatus: number;
  lastAt: number;
}

const ring: SlowEntry[] = [];
let capturedCount = 0;
const routeAggregates = new Map<string, RouteAggregate>();

// ── Periodic GC for route aggregates ───────────────────────────────────────
// routeAggregates entries are filtered on read (getSlowRequestsSnapshot uses
// the BUFFER_MAX_AGE_MS cutoff) but never deleted from the Map itself. On a
// 24/7 server with varied traffic patterns, stale entries accumulate
// indefinitely. This sweep runs every BUFFER_MAX_AGE_MS and:
//   1. Removes routes whose last slow request fell outside the retention window.
//   2. Caps total/totalDurationMs at 10k samples to prevent floating-point
//      precision drift on long-running processes — once the cap is hit the
//      counters are reset to a single representative entry that preserves the
//      current rolling average so the displayed averageMs stays accurate.
const AGGREGATE_SAMPLE_CAP = 10_000;
setInterval(() => {
  const cutoff = Date.now() - BUFFER_MAX_AGE_MS;
  for (const [key, agg] of routeAggregates) {
    if (agg.lastAt < cutoff) {
      routeAggregates.delete(key);
    } else if (agg.total > AGGREGATE_SAMPLE_CAP) {
      const avg = Math.round(agg.totalDurationMs / agg.total);
      agg.total = 1;
      agg.totalDurationMs = avg;
    }
  }
}, BUFFER_MAX_AGE_MS).unref?.();
registerNamedStore("slow-request-route-aggregates", () => routeAggregates.size);

/**
 * Normalise a URL path by replacing numeric and UUID-like segments with
 * their parameter placeholders so `/videos/1234` and `/videos/5678` both
 * aggregate under `/videos/:id`.
 */
function normalisePath(rawPath: string): string {
  return rawPath
    .split("?")[0]
    .split("/")
    .map((seg) => {
      // UUID
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
      // Pure numeric
      if (/^\d+$/.test(seg)) return ":id";
      // Nanoid-style (20–26 alphanumeric chars, mixed case)
      if (/^[A-Za-z0-9_-]{20,26}$/.test(seg)) return ":id";
      return seg;
    })
    .join("/");
}

function record(req: FastifyRequest, reply: FastifyReply, durationMs: number): void {
  const rawPath = req.url ?? "/";
  const path = normalisePath(rawPath);
  const method = req.method ?? "GET";
  const statusCode = reply.statusCode;

  // ── Ring buffer ────────────────────────────────────────────────────────────
  const entry: SlowEntry = {
    method,
    path,
    rawPath: rawPath.length > 512 ? rawPath.slice(0, 512) + "…" : rawPath,
    statusCode,
    durationMs: Math.round(durationMs),
    at: new Date().toISOString(),
    requestId: (req.id as string | undefined) ?? null,
  };
  if (ring.length >= BUFFER_MAX) ring.shift();
  ring.push(entry);
  capturedCount++;

  // ── Per-route aggregate ────────────────────────────────────────────────────
  const key = `${method} ${path}`;
  const agg = routeAggregates.get(key);
  if (agg) {
    agg.total++;
    if (statusCode >= 400) agg.errors++;
    agg.slowCount++;
    agg.totalDurationMs += durationMs;
    if (durationMs > agg.maxMs) agg.maxMs = durationMs;
    agg.lastStatus = statusCode;
    agg.lastAt = Date.now();
  } else {
    routeAggregates.set(key, {
      method,
      path,
      total: 1,
      errors: statusCode >= 400 ? 1 : 0,
      slowCount: 1,
      totalDurationMs: durationMs,
      maxMs: durationMs,
      lastStatus: statusCode,
      lastAt: Date.now(),
    });
  }
}

export function getSlowRequestsSnapshot() {
  const now = Date.now();
  const cutoff = now - BUFFER_MAX_AGE_MS;

  const entries = ring
    .filter((e) => new Date(e.at).getTime() >= cutoff)
    .slice()
    .reverse();

  const routes = Array.from(routeAggregates.values())
    .filter((r) => r.lastAt >= cutoff)
    .map((r) => ({
      method: r.method,
      path: r.path,
      total: r.total,
      errors: r.errors,
      slowCount: r.slowCount,
      averageMs: Math.round(r.totalDurationMs / r.total),
      maxMs: Math.round(r.maxMs),
      lastStatus: r.lastStatus,
      lastAt: r.lastAt,
    }))
    .sort((a, b) => b.maxMs - a.maxMs);

  return {
    thresholdMs: SLOW_THRESHOLD_MS,
    bufferSize: entries.length,
    bufferMaxAgeMs: BUFFER_MAX_AGE_MS,
    capturedCount,
    entries,
    routes,
  };
}

/**
 * Register the `onResponse` hook on the Fastify instance.
 * Must be called before any routes are registered so the hook covers
 * the entire route surface.
 */
export function registerSlowRequestHook(app: FastifyInstance): void {
  app.addHook("onResponse", (request, reply, done) => {
    const elapsed =
      typeof reply.elapsedTime === "number"
        ? reply.elapsedTime
        : Date.now() - ((request as unknown as { startTime?: number }).startTime ?? Date.now());
    if (elapsed >= SLOW_THRESHOLD_MS) {
      record(request, reply, elapsed);
    }
    done();
  });
}
