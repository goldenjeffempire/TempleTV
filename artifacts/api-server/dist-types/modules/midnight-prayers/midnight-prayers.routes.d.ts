/**
 * Midnight Prayers Routes
 *
 * Mounts under /api/midnight-prayers (registered in app.ts).
 *
 * Endpoints consumed by the player-core V2Transport (same contract as
 * /api/broadcast-v2 so the transport works unchanged):
 *   GET /state         – REST snapshot (initial load + cache fallback)
 *   GET /events        – SSE stream (heartbeats + snapshot frames)
 *   GET /ws            – WebSocket stream (same frames over WS)
 *
 * Admin-only management endpoints:
 *   GET  /config       – read schedule config (public)
 *   PATCH /config      – update schedule config (editor+)
 *   GET  /queue        – list midnight-prayers videos (editor+)
 *   POST /queue/refresh – force video list reload (editor+)
 */
import type { FastifyInstance } from "fastify";
export declare function midnightPrayersRoutes(app: FastifyInstance): Promise<void>;
