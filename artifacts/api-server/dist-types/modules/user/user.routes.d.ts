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
 *
 *   GET    /user/continue-watching       — in-progress videos (cross-device resume)
 *
 *   GET    /user/watch-later             — list Watch Later items
 *   POST   /user/watch-later             — add to Watch Later
 *   DELETE /user/watch-later/:videoId    — remove a specific item
 *   DELETE /user/watch-later             — clear entire Watch Later list
 */
import type { FastifyInstance } from "fastify";
export declare function userRoutes(app: FastifyInstance): Promise<void>;
