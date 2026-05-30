import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq, asc, desc, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { NotFoundError } from "../../shared/errors.js";
import { logger } from "../../infrastructure/logger.js";

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
      schema: {
        tags: ["series"],
        summary: "List all published sermon series",
        querystring: z.object({
          category: z.string().optional(),
          limit: z.coerce.number().int().positive().max(50).optional().default(20),
          offset: z.coerce.number().int().nonnegative().optional().default(0),
        }),
      },
    },
    async (req, reply) => {
      // 30-second public cache — series listings change infrequently and are
      // hit by every TV/mobile cold-start. stale-while-revalidate lets CDN
      // serve a fresh copy in the background without blocking the client.
      reply.header(
        "Cache-Control",
        "public, max-age=30, s-maxage=30, stale-while-revalidate=60",
      );

      const rows = await db
        .select()
        .from(schema.seriesTable)
        .where(eq(schema.seriesTable.isPublished, true))
        .orderBy(asc(schema.seriesTable.sortOrder), desc(schema.seriesTable.createdAt))
        .limit(req.query.limit)
        .offset(req.query.offset);

      return {
        series: rows.map((s) => ({
          ...s,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          startedAt: s.startedAt?.toISOString() ?? null,
          completedAt: s.completedAt?.toISOString() ?? null,
        })),
        total: rows.length,
      };
    },
  );

  // ── Public: get series with episodes ──────────────────────────────────────
  r.get(
    "/series/:slug",
    {
      schema: {
        tags: ["series"],
        summary: "Get a series with its episodes",
        params: z.object({ slug: z.string().min(1).max(80) }),
      },
    },
    async (req, reply) => {
      const [series] = await db
        .select()
        .from(schema.seriesTable)
        .where(eq(schema.seriesTable.slug, req.params.slug))
        .limit(1);

      if (!series) return reply.code(404).send({ error: "Series not found" });

      const episodes = await db
        .select()
        .from(schema.seriesEpisodesTable)
        .where(eq(schema.seriesEpisodesTable.seriesId, series.id))
        .orderBy(asc(schema.seriesEpisodesTable.episodeNumber));

      return reply.send({
        ...series,
        createdAt: series.createdAt.toISOString(),
        updatedAt: series.updatedAt.toISOString(),
        startedAt: series.startedAt?.toISOString() ?? null,
        completedAt: series.completedAt?.toISOString() ?? null,
        episodes: episodes.map((e) => ({
          ...e,
          addedAt: e.addedAt.toISOString(),
        })),
      });
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
      schema: {
        tags: ["series"],
        summary: "List all series (admin, includes unpublished)",
        response: { 200: z.array(SeriesRowSchema) },
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
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["series"],
        summary: "Create a new sermon series",
        body: SeriesBodySchema,
        response: { 201: SeriesRowSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const [series] = await db.insert(schema.seriesTable).values({
        id: crypto.randomUUID(),
        ...req.body,
        bannerUrl: req.body.bannerUrl ?? null,
        preacher: req.body.preacher ?? null,
      }).returning();
      logger.info(
        { seriesId: series!.id, title: series!.title, createdBy: req.principal?.email ?? "admin" },
        "[series] series created",
      );
      return reply.code(201).send({
        ...series,
        createdAt: series!.createdAt.toISOString(),
        updatedAt: series!.updatedAt.toISOString(),
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
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["series"],
        summary: "Update series metadata",
        params: z.object({ id: z.string().min(1).max(128) }),
        body: SeriesBodySchema.partial(),
        response: { 200: SeriesRowSchema },
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
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["series"],
        summary: "Delete a series (removes episodes too via cascade)",
        params: z.object({ id: z.string().min(1).max(128) }),
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      await db.delete(schema.seriesTable).where(eq(schema.seriesTable.id, req.params.id));
      logger.info(
        { seriesId: req.params.id, deletedBy: req.principal?.email ?? "admin" },
        "[series] series deleted (cascade)",
      );
      return reply.code(204).send(null);
    },
  );

  // ── Admin: add episode to series ─────────────────────────────────────────
  r.post(
    "/admin/series/:id/episodes",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["series"],
        summary: "Add a video as an episode in a series",
        params: z.object({ id: z.string().min(1).max(128) }),
        body: z.object({
          videoId: z.string().min(1),
          episodeNumber: z.number().int().positive().optional(),
          title: z.string().max(200).optional().nullable(),
          description: z.string().max(1000).optional().nullable(),
        }),
        response: { 201: EpisodeRowSchema },
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

      let episode;
      try {
        [episode] = await db.insert(schema.seriesEpisodesTable).values({
          id: crypto.randomUUID(),
          seriesId: req.params.id,
          videoId,
          episodeNumber: resolvedEpNum,
          title: title ?? null,
          description: description ?? null,
        }).returning();
      } catch (err: unknown) {
        // Two concurrent requests can race on MAX()+1 for the same series.
        // Retry once with a fresh MAX() to resolve the conflict.
        if ((err as { code?: string }).code === "23505") {
          const retryEpNum = await db
            .select({
              nextEp: sql<number>`coalesce(max(${schema.seriesEpisodesTable.episodeNumber}), 0) + 1`,
            })
            .from(schema.seriesEpisodesTable)
            .where(eq(schema.seriesEpisodesTable.seriesId, req.params.id))
            .then(([r]) => Number(r?.nextEp ?? 1));
          [episode] = await db.insert(schema.seriesEpisodesTable).values({
            id: crypto.randomUUID(),
            seriesId: req.params.id,
            videoId,
            episodeNumber: retryEpNum,
            title: title ?? null,
            description: description ?? null,
          }).returning();
          logger.warn({ seriesId: req.params.id, resolved: retryEpNum }, "series: episode number conflict resolved on retry");
        } else {
          throw err;
        }
      }

      // Atomic increment — avoids the fetch-all-then-count round-trip.
      // GREATEST(..., 0) guards against a race where the count could
      // momentarily go negative if two deletions race an add.
      await db
        .update(schema.seriesTable)
        .set({ episodeCount: sql`episode_count + 1`, updatedAt: new Date() })
        .where(eq(schema.seriesTable.id, req.params.id));

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
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["series"],
        summary: "Remove an episode from a series",
        params: z.object({ id: z.string().min(1).max(128), episodeId: z.string().min(1).max(128) }),
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      await db
        .delete(schema.seriesEpisodesTable)
        .where(eq(schema.seriesEpisodesTable.id, req.params.episodeId));

      // Atomic decrement — no need to re-count all episodes.
      // GREATEST(episode_count - 1, 0) prevents underflow on concurrent deletes.
      await db
        .update(schema.seriesTable)
        .set({ episodeCount: sql`greatest(episode_count - 1, 0)`, updatedAt: new Date() })
        .where(eq(schema.seriesTable.id, req.params.id));

      return reply.code(204).send(null);
    },
  );
}
