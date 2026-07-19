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
 *
 * SERVER-SIDE WINDOW ENFORCEMENT:
 *   All snapshot-returning endpoints (/state, /events, /ws) rely on
 *   midnightPrayersService.getSnapshot() which enforces the [startHour,
 *   endHour) window in the configured IANA timezone and returns
 *   mode="offline_hold" with null items outside the window. Routes do not
 *   need to duplicate the check — getSnapshot() is authoritative.
 *
 *   Cache headers on /state use stale-if-error=10 (not 60) to minimise the
 *   window during which a browser-cached snapshot can serve midnight-prayer
 *   content after 3:00 AM.
 */
import type { FastifyInstance } from "fastify";
export declare function closeAllMidnightPrayersSseSessions(): void;
export declare function midnightPrayersRoutes(app: FastifyInstance): Promise<void>;
