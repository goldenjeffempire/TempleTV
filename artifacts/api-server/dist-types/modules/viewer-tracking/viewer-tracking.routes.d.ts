/**
 * Viewer Tracking Routes
 *
 * POST /viewer-tracking/heartbeat   — unauthenticated, rate-limited
 *   Called every ~10 s by every active player (TV, mobile, web).
 *   No DB write — pure Redis.
 *
 * GET  /viewer-tracking/stats       — requireAuth("editor")
 *   Returns current viewer counts, peak, and 5-min trend per stream.
 *
 * GET  /viewer-tracking/stats/:streamId — requireAuth("editor")
 *   Per-stream view.
 */
import type { FastifyInstance } from "fastify";
export declare function viewerTrackingRoutes(app: FastifyInstance): Promise<void>;
