/**
 * User data routes — favorites and watch history.
 *
 * All routes require authentication. User-specific rows are always scoped
 * to the authenticated principal so one user can never read another's data.
 *
 * Endpoints:
 *   GET    /user/me                      — profile alias (→ auth /me)
 *   GET    /user/favorites               — list all favorites
 *   POST   /user/favorites               — add a favorite
 *   DELETE /user/favorites/:videoId      — remove a specific favorite
 *
 *   GET    /user/history                 — list watch history (newest first)
 *   GET    /user/watch-history           — alias for /user/history
 *   POST   /user/history                 — upsert a watch-history entry
 *   DELETE /user/history                 — clear entire watch history
 */
import type { FastifyInstance } from "fastify";
export declare function userRoutes(app: FastifyInstance): Promise<void>;
