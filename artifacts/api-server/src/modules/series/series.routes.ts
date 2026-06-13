import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, eq, asc, desc, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import { logger } from "../../infrastructure/logger.js";
import { cache } from "../../infrastructure/cache.js";

// Monotonic generation counter — incremented on every admin mutation so all
// currently-cached series list variants become unreachable (orphaned keys expire
// naturally by their 60s TTL). Avoids needing prefix/wildcard cache deletion.
let seriesListGen = 0;
function bustSeriesListCache() {
  seriesListGen++;
}

export async function seriesRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const SeriesBodySchema = z.object({
    title: z.string().min(1).max(200),
    slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
    description: z.string().max(2000).optional().default(""),
    thumbnailUrl: z.string().optional().default(""),
    bannerUrl: z.string().optional().nullable(),
    preacher: z.string().max(100).optional().nullable(),
    category: z.string().max(60).optional().default("sermon"),
    isPublished: z.boolean().optional().default(false),
    isOngoing: z.boolean().optional().default(true),
    sortOrder: z.number().int().optional().default(0),
  });

  // ── Public: list published series ─────────────────────────────────────────
  r.get(
    "/series",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["series"],
        summary: "List all published sermon series",
        querystring: z.object({
          category: z.string().optional(),
          limit: z.coerce.number().int().positive().optional().default(20).catch(20).transform(v => Math.min(v, 50)),
          offset: z.coerce.number().int().nonnegative().optional().default(0),
        }),
        response: {
          200: z.object({ series: z.array(z.record(z.unknown())), total: z.number() }),
          304: z.void(),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      // 30-second public cache — series listings change infrequently and are
      // hit by every TV/mobile cold-start. stale-while-revalidate lets CDN
      // serve a fresh copy in the background without blocking the client.
      // stale-if-error=600: CDN/clients keep serving cached series list for up
      // to 10 min if the origin is temporarily unavailable (deploy, restart).
      // Vary: Accept-Encoding: required for correct CDN-level content-encoding
      // differentiation (gzip vs br vs identity must be stored separately).
      reply
        .header("Cache-Control", "public, max-age=30, s-maxage=30, stale-while-revalidate=60, stale-if-error=600")
        .header("Vary", "Accept-Encoding");

      // ── Server-side in-process LRU cache ──────────────────────────────────
      // Eliminates DB round-trips when multiple clients cold-start within the
      // same 60-second window (TV, mobile, and web all hit /series on boot).
      // Key includes all query params so filtered pages are cached separately.
      const { category, limit, offset } = req.query;
      const cacheKey = `series:list:v1:g${seriesListGen}:${category ?? "all"}:${limit}:${offset}`;

      // ETag based on cache key — the key embeds the generation counter which
      // increments on every admin mutation, so the ETag changes whenever the
      // underlying data changes. Saves response body transfer on CDN + client
      // conditional re-fetch cycles (304 Not Modified).
      const etag = `"${crypto.createHash("sha1").update(cacheKey).digest("hex").slice(0, 16)}"`;
      reply.header("ETag", etag);
      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch === etag) return reply.code(304).send();

      const cached = await cache().get<{ series: Record<string, unknown>[]; total: number }>(cacheKey).catch(() => null);
      if (cached) return cached;

      const conditions: SQL[] = [eq(schema.seriesTable.isPublished, true)];
      if (category) {
        conditions.push(eq(schema.seriesTable.category, category));
      }
      const rows = await db
        .select()
        .from(schema.seriesTable)
        .where(and(...conditions))
        .orderBy(asc(schema.seriesTable.sortOrder), desc(schema.seriesTable.createdAt))
        .limit(limit)
        .offset(offset);

      const result = {
        series: rows.map((s) => ({
          ...s,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          startedAt: s.startedAt?.toISOString() ?? null,
          completedAt: s.completedAt?.toISOString() ?? null,
        })),
        total: rows.length,
      };
      void cache().set(cacheKey, result, 60).catch(() => {});
      return result;
    },
  );

  // ── Public: get series with episodes ──────────────────────────────────────
  r.get(
    "/series/:slug",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["series"],
        summary: "Get a series with its episodes",
        params: z.object({ slug: z.string().min(1).max(80) }),
        response: {
          200: z.record(z.unknown()),
          304: z.void(),
          404: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      // 30-second public cache — series detail pages are fetched on every
      // episode-list open by TV, mobile, and web. youtubeLiveStatus changes
      // via SSE so a 30 s stale window is acceptable (player state is not
      // gated on this endpoint).
      // stale-if-error=600: keeps serving 10 min on origin outage.
      reply
        .header("Cache-Control", "public, max-age=30, s-maxage=30, stale-while-revalidate=60, stale-if-error=600")
        .header("Vary", "Accept-Encoding");

      // ── In-process LRU cache ───────────────────────────────────────────────
      // Key embeds the generation counter so any admin mutation (add/remove
      // episode, metadata edit) instantly promotes a new cache key; stale key
      // expires after its 60 s TTL.
      const cacheKey = `series:slug:v1:g${seriesListGen}:${req.params.slug}`;
      const slugEtag = `"${crypto.createHash("sha1").update(cacheKey).digest("hex").slice(0, 16)}"`;
      reply.header("ETag", slugEtag);
      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch === slugEtag) return reply.code(304).send();

      const cachedSlug = await cache().get<Record<string, unknown>>(cacheKey).catch(() => null);
      if (cachedSlug) return cachedSlug;

      const [series] = await db
        .select()
        .from(schema.seriesTable)
        .where(
          sql`${schema.seriesTable.slug} = ${req.params.slug}
            AND ${schema.seriesTable.isPublished} = true`,
        )
        .limit(1);

      if (!series) return reply.code(404).send({ error: "Series not found" });

      // Left-join managed_videos to carry the current youtubeLiveStatus into
      // each episode row — it changes in real time, so it must be read live.
      const episodeRows = await db
        .select({
          ep: schema.seriesEpisodesTable,
          youtubeLiveStatus: schema.videosTable.youtubeLiveStatus,
        })
        .from(schema.seriesEpisodesTable)
        .leftJoin(schema.videosTable, eq(schema.videosTable.id, schema.seriesEpisodesTable.videoId))
        .where(eq(schema.seriesEpisodesTable.seriesId, series.id))
        .orderBy(asc(schema.seriesEpisodesTable.episodeNumber));

      const result: Record<string, unknown> = {
        ...series,
        createdAt: series.createdAt.toISOString(),
        updatedAt: series.updatedAt.toISOString(),
        startedAt: series.startedAt?.toISOString() ?? null,
        completedAt: series.completedAt?.toISOString() ?? null,
        episodes: episodeRows.map(({ ep, youtubeLiveStatus }) => ({
          ...ep,
          addedAt: ep.addedAt.toISOString(),
          youtubeLiveStatus: (youtubeLiveStatus as "live" | "rebroadcast" | null) ?? null,
        })),
      };
      void cache().set(cacheKey, result, 60).catch(() => {});
      return reply.send(result);
    },
  );

  const SeriesRowSchema = z.object({
    id: z.string(),
    title: z.string(),
    slug: z.string(),
    description: z.string(),
    thumbnailUrl: z.string(),
    bannerUrl: z.string().nullable(),
    preacher: z.string().nullable(),
    category: z.string(),
    isPublished: z.boolean(),
    isOngoing: z.boolean(),
    sortOrder: z.number().int(),
    episodeCount: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  });

  const EpisodeRowSchema = z.object({
    id: z.string(),
    seriesId: z.string(),
    videoId: z.string(),
    episodeNumber: z.number().int(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    addedAt: z.string(),
  });

  // ── Admin: list all series (including unpublished) ────────────────────────
  r.get(
    "/admin/series",
    {
      preHandler: requireAuth("editor"),
      // Series listing scans the entire series table (including unpublished
      // rows invisible to the public endpoint). 30/min is ample for the admin
      // UI while blocking automated scraping via a compromised editor token.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["series"],
        summary: "List all series (admin, includes unpublished)",
        response: { 200: z.array(SeriesRowSchema), 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const rows = await db
        .select()
        .from(schema.seriesTable)
        .orderBy(asc(schema.seriesTable.sortOrder), desc(schema.seriesTable.createdAt));

      return rows.map((s) => ({
        ...s,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
        startedAt: s.startedAt?.toISOString() ?? null,
        completedAt: s.completedAt?.toISOString() ?? null,
      }));
    },
  );

  // ── Admin: create series ──────────────────────────────────────────────────
  r.post(
    "/admin/series",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["series"],
        summary: "Create a new sermon series",
        body: SeriesBodySchema,
        response: { 201: SeriesRowSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      let series: typeof schema.seriesTable.$inferSelect;
      try {
        const [row] = await db.insert(schema.seriesTable).values({
          id: crypto.randomUUID(),
          ...req.body,
          bannerUrl: req.body.bannerUrl ?? null,
          preacher: req.body.preacher ?? null,
        }).returning();
        series = row!;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictError(`A series with slug "${req.body.slug}" already exists`);
        }
        throw err;
      }
      bustSeriesListCache();
      logger.info(
        { seriesId: series.id, title: series.title, createdBy: req.principal?.email ?? "admin" },
        "[series] series created",
      );
      return reply.code(201).send({
        ...series,
        createdAt: series.createdAt.toISOString(),
        updatedAt: series.updatedAt.toISOString(),
        startedAt: null,
        completedAt: null,
      });
    },
  );

  // ── Admin: update series ───────────────────────────────────────────────────
  r.patch(
    "/admin/series/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["series"],
        summary: "Update series metadata",
        params: z.object({ id: z.string().min(1).max(128) }),
        body: SeriesBodySchema.partial(),
        response: { 200: SeriesRowSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const [updated] = await db
        .update(schema.seriesTable)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(schema.seriesTable.id, req.params.id))
        .returning();
      if (!updated) throw new NotFoundError(`Series ${req.params.id} not found`);
      bustSeriesListCache();
      return reply.send({
        ...updated,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
        startedAt: updated.startedAt?.toISOString() ?? null,
        completedAt: updated.completedAt?.toISOString() ?? null,
      });
    },
  );

  // ── Admin: delete series ──────────────────────────────────────────────────
  r.delete(
    "/admin/series/:id",
    {
      preHandler: requireAuth("admin"),
      // Cascade deletes all episodes. 5/min prevents bulk wipes.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },      schema: {
        tags: ["series"],
        summary: "Delete a series (removes episodes too via cascade)",
        params: z.object({ id: z.string().min(1).max(128) }),
        response: { 204: z.void(), 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      await db.delete(schema.seriesTable).where(eq(schema.seriesTable.id, req.params.id));
      bustSeriesListCache();
      logger.info(
        { seriesId: req.params.id, deletedBy: req.principal?.email ?? "admin" },
        "[series] series deleted (cascade)",
      );
      return reply.code(204).send();
    },
  );

  // ── Admin: add episode to series ─────────────────────────────────────────
  r.post(
    "/admin/series/:id/episodes",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["series"],
        summary: "Add a video as an episode in a series",
        params: z.object({ id: z.string().min(1).max(128) }),
        body: z.object({
          videoId: z.string().min(1),
          episodeNumber: z.number().int().positive().optional(),
          title: z.string().max(200).optional().nullable(),
          description: z.string().max(1000).optional().nullable(),
        }),
        response: { 201: EpisodeRowSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { videoId, episodeNumber, title, description } = req.body;

      // Auto-assign episode number: single MAX() query instead of
      // fetching all rows and calling Math.max() in JS.
      const resolvedEpNum = episodeNumber ?? await db
        .select({
          nextEp: sql<number>`coalesce(max(${schema.seriesEpisodesTable.episodeNumber}), 0) + 1`,
        })
        .from(schema.seriesEpisodesTable)
        .where(eq(schema.seriesEpisodesTable.seriesId, req.params.id))
        .then(([r]) => Number(r?.nextEp ?? 1));

      // Wrap INSERT + episodeCount UPDATE in a transaction so a failure between
      // the two writes never leaves the count permanently out of sync.
      let episode;
      try {
        await db.transaction(async (tx) => {
          [episode] = await tx.insert(schema.seriesEpisodesTable).values({
            id: crypto.randomUUID(),
            seriesId: req.params.id,
            videoId,
            episodeNumber: resolvedEpNum,
            title: title ?? null,
            description: description ?? null,
          }).returning();
          // Atomic increment — avoids the fetch-all-then-count round-trip.
          await tx
            .update(schema.seriesTable)
            .set({ episodeCount: sql`episode_count + 1`, updatedAt: new Date() })
            .where(eq(schema.seriesTable.id, req.params.id));
        });
      } catch (err: unknown) {
        // Two concurrent requests can race on MAX()+1 for the same series.
        // The unique constraint on (series_id, episode_number) fires a 23505;
        // retry once with a fresh MAX() to resolve the conflict.
        if ((err as { code?: string }).code === "23505") {
          const retryEpNum = await db
            .select({
              nextEp: sql<number>`coalesce(max(${schema.seriesEpisodesTable.episodeNumber}), 0) + 1`,
            })
            .from(schema.seriesEpisodesTable)
            .where(eq(schema.seriesEpisodesTable.seriesId, req.params.id))
            .then(([r]) => Number(r?.nextEp ?? 1));
          await db.transaction(async (tx) => {
            [episode] = await tx.insert(schema.seriesEpisodesTable).values({
              id: crypto.randomUUID(),
              seriesId: req.params.id,
              videoId,
              episodeNumber: retryEpNum,
              title: title ?? null,
              description: description ?? null,
            }).returning();
            await tx
              .update(schema.seriesTable)
              .set({ episodeCount: sql`episode_count + 1`, updatedAt: new Date() })
              .where(eq(schema.seriesTable.id, req.params.id));
          });
          logger.warn({ seriesId: req.params.id, resolved: retryEpNum }, "series: episode number conflict resolved on retry");
        } else {
          throw err;
        }
      }

      bustSeriesListCache();
      logger.info(
        { seriesId: req.params.id, videoId, episodeNumber: resolvedEpNum, addedBy: req.principal?.email ?? "admin" },
        "[series] episode added",
      );
      return reply.code(201).send({
        ...episode!,
        addedAt: episode!.addedAt.toISOString(),
      });
    },
  );

  // ── Admin: remove episode from series ────────────────────────────────────
  r.delete(
    "/admin/series/:id/episodes/:episodeId",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["series"],
        summary: "Remove an episode from a series",
        params: z.object({ id: z.string().min(1).max(128), episodeId: z.string().min(1).max(128) }),
        response: { 204: z.void(), 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      // Wrap DELETE + episodeCount decrement in a transaction so a mid-flight
      // failure never leaves the count permanently out of sync with actual rows.
      await db.transaction(async (tx) => {
        await tx
          .delete(schema.seriesEpisodesTable)
          .where(eq(schema.seriesEpisodesTable.id, req.params.episodeId));
        // Atomic decrement — GREATEST(..., 0) prevents underflow on concurrent deletes.
        await tx
          .update(schema.seriesTable)
          .set({ episodeCount: sql`greatest(episode_count - 1, 0)`, updatedAt: new Date() })
          .where(eq(schema.seriesTable.id, req.params.id));
      });
      bustSeriesListCache();
      return reply.code(204).send();
    },
  );
}
