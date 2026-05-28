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
import type { FastifyInstance } from "fastify";
/** Requests slower than this (ms) are captured. */
export declare const SLOW_THRESHOLD_MS = 1000;
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
export declare function getSlowRequestsSnapshot(): {
    thresholdMs: number;
    bufferSize: number;
    bufferMaxAgeMs: number;
    capturedCount: number;
    entries: SlowEntry[];
    routes: {
        method: string;
        path: string;
        total: number;
        errors: number;
        slowCount: number;
        averageMs: number;
        maxMs: number;
        lastStatus: number;
        lastAt: number;
    }[];
};
/**
 * Register the `onResponse` hook on the Fastify instance.
 * Must be called before any routes are registered so the hook covers
 * the entire route surface.
 */
export declare function registerSlowRequestHook(app: FastifyInstance): void;
