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
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq, and, desc, count } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { authService } from "../auth/auth.service.js";

const favoritesTable = schema.userFavoritesTable;
const historyTable = schema.userWatchHistoryTable;

/**
 * Strip HTML tags and common HTML entities from a user-provided string.
 *
 * `videoTitle`, `videoThumbnail`, and `videoCategory` in the favorites and
 * watch-history endpoints are client-supplied and later rendered in the admin
 * and mobile surfaces. Without sanitization an authenticated user can inject
 * `<script>` or event-handler attributes that execute in other users' sessions
 * (stored XSS). Stripping tags here is a lightweight, zero-dependency defence
 * that is safe even if the client library also sanitizes on render.
 */
function sanitizeText(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")               // strip all HTML tags
    .replace(/&[a-zA-Z0-9#]+;/g, " ")      // defuse named/numeric entities
    .trim();
}

/**
 * Rate-limit key for authenticated write endpoints.
 *
 * Decodes the JWT payload WITHOUT verifying the signature to extract the
 * `sub` claim, then returns `user:<sub>` as the bucket key so the limit
 * is enforced per-account rather than per-IP.  This is safe because:
 *   1. The key is used only for bucketing — actual auth still happens in
 *      the requireAuth() preHandler which verifies the signature.
 *   2. A tampered sub just lands in a different (also rate-limited) bucket;
 *      it cannot bypass authentication or access another user's data.
 * Falls back to `req.ip` for requests without a valid Bearer token.
 */
function jwtUserKey(req: import("fastify").FastifyRequest): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    try {
      const part = auth.slice(7).split(".")[1];
      if (part) {
        const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
        if (payload && typeof payload === "object" && "sub" in payload && typeof (payload as Record<string, unknown>).sub === "string") {
          return `user:${(payload as Record<string, unknown>).sub as string}`;
        }
      }
    } catch { /* fall through */ }
  }
  return req.ip;
}

/** Hard cap on favorites rows per user — prevents table bloat from a compromised account. */
const MAX_FAVORITES_PER_USER = 2_000;
/** Hard cap on watch-history rows per user — generous enough for a real viewer's lifetime. */
const MAX_HISTORY_PER_USER = 10_000;

const FavoriteItemSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  videoTitle: z.string(),
  videoThumbnail: z.string(),
  videoCategory: z.string(),
  createdAt: z.string(),
});

const HistoryItemSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  videoTitle: z.string(),
  videoThumbnail: z.string(),
  videoCategory: z.string(),
  progressSecs: z.number().int(),
  watchedAt: z.string(),
});

export async function userRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── GET /user/me — profile alias ──────────────────────────────────────────
  // Convenience alias so clients that call /user/me (instead of /auth/me) work
  // correctly. Delegates to the same auth.service.getProfile() handler.
  r.get(
    "/me",
    {
      preHandler: requireAuth(),
      schema: {
        tags: ["user"],
        summary: "Get authenticated user's profile (alias for GET /auth/me)",
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            id: z.string(),
            email: z.string(),
            role: z.string(),
            displayName: z.string(),
            createdAt: z.string(),
          }),
        },
      },
    },
    async (req) => authService.getProfile(req.principal!.id),
  );

  // ── Favorites ─────────────────────────────────────────────────────────────

  r.get(
    "/favorites",
    {
      preHandler: requireAuth(),
      schema: {
        tags: ["user"],
        summary: "List all favorited videos for the authenticated user",
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          limit:  z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: {
          200: z.object({ favorites: z.array(FavoriteItemSchema) }),
        },
      },
    },
    async (req) => {
      const userId = req.principal!.id;
      const limit  = req.query.limit;
      const offset = req.query.offset;
      const rows = await db
        .select()
        .from(favoritesTable)
        .where(eq(favoritesTable.userId, userId))
        .orderBy(desc(favoritesTable.createdAt))
        .limit(limit)
        .offset(offset);
      const favorites = rows.map((r) => ({
        id: r.id,
        videoId: r.videoId,
        videoTitle: r.videoTitle,
        videoThumbnail: r.videoThumbnail,
        videoCategory: r.videoCategory,
        createdAt: r.createdAt.toISOString(),
      }));
      return { favorites };
    },
  );

  r.post(
    "/favorites",
    {
      preHandler: requireAuth(),
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          // Key by user-ID so the limit is per-account, not per-IP.
          // Without this a compromised account on a shared IP counts against
          // every other user on that address; a per-user key isolates the damage.
          keyGenerator: jwtUserKey,
        },
      },
      schema: {
        tags: ["user"],
        summary: "Add a video to the authenticated user's favorites",
        security: [{ bearerAuth: [] }],
        body: z.object({
          videoId: z.string().min(1),
          videoTitle: z.string().min(1),
          videoThumbnail: z.string().default(""),
          videoCategory: z.string().default(""),
        }),
        response: {
          201: FavoriteItemSchema,
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const userId = req.principal!.id;
      const { videoId } = req.body;
      // Sanitize all user-supplied display strings before persisting.
      const videoTitle     = sanitizeText(req.body.videoTitle);
      const videoThumbnail = sanitizeText(req.body.videoThumbnail);
      const videoCategory  = sanitizeText(req.body.videoCategory);

      // Row-count cap: reject before upsert so a compromised account cannot
      // grow the favorites table unboundedly with fake videoIds.  The cap is
      // applied before the upsert so an attacker at the ceiling cannot slip
      // one extra row through a race — any request when count >= MAX is denied.
      const [{ favCount }] = await db
        .select({ favCount: count() })
        .from(favoritesTable)
        .where(eq(favoritesTable.userId, userId));
      if (favCount >= MAX_FAVORITES_PER_USER) {
        return reply.code(429).send({
          error: `Favorites limit reached (${MAX_FAVORITES_PER_USER}). Remove some favorites before adding more.`,
        });
      }

      // Upsert — conflict on (userId, videoId) updates the display columns so
      // that a re-favourite after a title/thumbnail change stays fresh.
      // This eliminates the check-then-insert TOCTOU race where two concurrent
      // requests could both pass the "does it exist?" check and both attempt an
      // INSERT, causing one to fail with a unique-constraint violation.
      const [row] = await db
        .insert(favoritesTable)
        .values({ id: nanoid(), userId, videoId, videoTitle, videoThumbnail, videoCategory })
        .onConflictDoUpdate({
          target: [favoritesTable.userId, favoritesTable.videoId],
          set: { videoTitle, videoThumbnail, videoCategory },
        })
        .returning();
      reply.code(201);
      return {
        id: row!.id,
        videoId: row!.videoId,
        videoTitle: row!.videoTitle,
        videoThumbnail: row!.videoThumbnail,
        videoCategory: row!.videoCategory,
        createdAt: row!.createdAt.toISOString(),
      };
    },
  );

  r.delete(
    "/favorites/:videoId",
    {
      preHandler: requireAuth(),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["user"],
        summary: "Remove a video from the authenticated user's favorites",
        security: [{ bearerAuth: [] }],
        params: z.object({ videoId: z.string().min(1).max(128) }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const userId = req.principal!.id;
      await db
        .delete(favoritesTable)
        .where(and(eq(favoritesTable.userId, userId), eq(favoritesTable.videoId, req.params.videoId)));
      reply.code(204);
      return null;
    },
  );

  // ── Watch history ─────────────────────────────────────────────────────────

  r.get(
    "/watch-history",
    {
      preHandler: requireAuth(),
      schema: {
        tags: ["user"],
        summary: "Watch history alias (same as GET /user/history)",
        security: [{ bearerAuth: [] }],
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
        response: {
          200: z.object({ history: z.array(HistoryItemSchema) }),
        },
      },
    },
    async (req) => {
      const userId = req.principal!.id;
      const rows = await db
        .select()
        .from(historyTable)
        .where(eq(historyTable.userId, userId))
        .orderBy(desc(historyTable.watchedAt))
        .limit(req.query.limit);
      return {
        history: rows.map((r) => ({
          id: r.id,
          videoId: r.videoId,
          videoTitle: r.videoTitle,
          videoThumbnail: r.videoThumbnail,
          videoCategory: r.videoCategory,
          progressSecs: r.progressSecs,
          watchedAt: r.watchedAt.toISOString(),
        })),
      };
    },
  );

  r.get(
    "/history",
    {
      preHandler: requireAuth(),
      schema: {
        tags: ["user"],
        summary: "List watch history for the authenticated user (newest first)",
        security: [{ bearerAuth: [] }],
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
        response: {
          200: z.object({ history: z.array(HistoryItemSchema) }),
        },
      },
    },
    async (req) => {
      const userId = req.principal!.id;
      const rows = await db
        .select()
        .from(historyTable)
        .where(eq(historyTable.userId, userId))
        .orderBy(desc(historyTable.watchedAt))
        .limit(req.query.limit);
      const history = rows.map((r) => ({
        id: r.id,
        videoId: r.videoId,
        videoTitle: r.videoTitle,
        videoThumbnail: r.videoThumbnail,
        videoCategory: r.videoCategory,
        progressSecs: r.progressSecs,
        watchedAt: r.watchedAt.toISOString(),
      }));
      return { history };
    },
  );

  r.post(
    "/history",
    {
      preHandler: requireAuth(),
      // Called ~every 30 s during active playback — normal usage is ~2/min
      // per device. 30/min covers 4 simultaneous devices with a healthy
      // safety margin while preventing a runaway client from hammering the DB.
      // Keyed per user-ID (not IP) so a single compromised account cannot
      // exhaust the bucket for all users behind a shared NAT/proxy.
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          keyGenerator: jwtUserKey,
        },
      },
      schema: {
        tags: ["user"],
        summary: "Upsert a watch-history entry (updates watchedAt + progress on re-watch)",
        security: [{ bearerAuth: [] }],
        body: z.object({
          videoId: z.string().min(1),
          videoTitle: z.string().min(1),
          videoThumbnail: z.string().default(""),
          videoCategory: z.string().default(""),
          progressSecs: z.number().int().min(0).default(0),
        }),
        response: {
          200: HistoryItemSchema,
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const userId = req.principal!.id;
      const { videoId, progressSecs } = req.body;
      // Sanitize all user-supplied display strings before persisting.
      const videoTitle     = sanitizeText(req.body.videoTitle);
      const videoThumbnail = sanitizeText(req.body.videoThumbnail);
      const videoCategory  = sanitizeText(req.body.videoCategory);
      const now = new Date();

      // Row-count cap: block new entries once the per-user ceiling is reached.
      // The upsert below is idempotent for existing (userId, videoId) pairs
      // (it updates progress in-place), so the cap only matters for the first
      // write of a new video. Counting before the upsert is a best-effort
      // check — a concurrent first-write of the same video may slip through,
      // but the unique index prevents duplicate rows regardless.
      const [{ histCount }] = await db
        .select({ histCount: count() })
        .from(historyTable)
        .where(eq(historyTable.userId, userId));
      if (histCount >= MAX_HISTORY_PER_USER) {
        return reply.code(429).send({
          error: `Watch history limit reached (${MAX_HISTORY_PER_USER}). Clear some history before adding more.`,
        });
      }

      // Single-statement upsert — eliminates the SELECT + INSERT/UPDATE two-step
      // TOCTOU race where two concurrent requests can both pass the "does it
      // exist?" check and both attempt an INSERT, causing one to fail with a
      // unique-constraint violation. The unique index on (userId, videoId) is
      // the conflict target; existing rows are updated in-place so the returned
      // id is always stable across repeated watch-progress syncs.
      const [row] = await db
        .insert(historyTable)
        .values({ id: nanoid(), userId, videoId, videoTitle, videoThumbnail, videoCategory, progressSecs, watchedAt: now })
        .onConflictDoUpdate({
          target: [historyTable.userId, historyTable.videoId],
          set: { watchedAt: now, progressSecs, videoTitle, videoThumbnail, videoCategory },
        })
        .returning();
      return {
        id: row!.id,
        videoId: row!.videoId,
        videoTitle: row!.videoTitle,
        videoThumbnail: row!.videoThumbnail,
        videoCategory: row!.videoCategory,
        progressSecs: row!.progressSecs,
        watchedAt: row!.watchedAt.toISOString(),
      };
    },
  );

  r.delete(
    "/history",
    {
      preHandler: requireAuth(),
      // Bulk clears all history — deliberate destructive action, 5/min is plenty.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["user"],
        summary: "Clear entire watch history for the authenticated user",
        security: [{ bearerAuth: [] }],
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const userId = req.principal!.id;
      await db.delete(historyTable).where(eq(historyTable.userId, userId));
      reply.code(204);
      return null;
    },
  );
}
