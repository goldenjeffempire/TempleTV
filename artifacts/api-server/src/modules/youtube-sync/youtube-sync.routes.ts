import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { youtubeSyncDispatcher } from "./youtube-sync.dispatcher.js";
import {
  getSyncStatus,
  getCategoryStats,
  recategorizeAllVideos,
  isRecategorizeInProgress,
} from "./youtube-sync.service.js";

let manualSyncInProgress = false;

export async function youtubeSyncRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /admin/youtube/sync/status
   * Returns last sync info plus total YouTube video count and next scheduled sync time.
   */
  r.get(
    "/youtube/sync/status",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "YouTube sync status and statistics",
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            lastSyncId: z.string().nullable(),
            lastSyncAt: z.string().nullable(),
            lastSyncStatus: z.string().nullable(),
            lastSyncSource: z.string().nullable(),
            videosFound: z.number().nullable(),
            videosInserted: z.number().nullable(),
            videosUpdated: z.number().nullable(),
            videosSkipped: z.number().nullable(),
            videosDeleted: z.number().nullable(),
            errorMessage: z.string().nullable(),
            totalYoutubeVideos: z.number(),
            nextSyncAt: z.string().nullable(),
            syncInProgress: z.boolean(),
            contentWindowDays: z.number(),
          }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async () => {
      const status = await getSyncStatus();
      return { ...status, syncInProgress: manualSyncInProgress };
    },
  );

  /**
   * POST /admin/youtube/sync
   * Trigger an immediate manual sync of the @TEMPLETVJCTM YouTube channel.
   */
  r.post(
    "/youtube/sync",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "Trigger a manual YouTube channel sync",
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            syncId: z.string(),
            inserted: z.number(),
            updated: z.number(),
            total: z.number(),
            skipped: z.number(),
            deleted: z.number(),
            durationMs: z.number(),
            source: z.string(),
            rowErrors: z.number(),
          }),
          409: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (_req, reply) => {
      if (manualSyncInProgress) {
        return reply.code(409).send({ error: "A sync is already in progress" });
      }
      manualSyncInProgress = true;
      try {
        const result = await youtubeSyncDispatcher.triggerNow();
        return result;
      } finally {
        manualSyncInProgress = false;
      }
    },
  );

  /**
   * GET /admin/youtube/sync/history
   * Returns the last N sync log entries.
   */
  r.get(
    "/youtube/sync/history",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "YouTube sync history log",
        querystring: z.object({ limit: z.coerce.number().int().min(1).default(20).catch(20).transform(v => Math.min(v, 100)) }),
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            items: z.array(z.object({
              id: z.string(),
              startedAt: z.string(),
              completedAt: z.string().nullable(),
              status: z.string(),
              videosFound: z.number().nullable(),
              videosInserted: z.number().nullable(),
              videosUpdated: z.number().nullable(),
              errorMessage: z.string().nullable(),
              triggeredBy: z.string(),
              source: z.string().nullable(),
            })),
          }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req) => {
      const { db, schema } = await import("../../infrastructure/db.js");
      const { sql } = await import("drizzle-orm");
      const rows = await db
        .select()
        .from(schema.youtubeSyncLogTable)
        .orderBy(sql`${schema.youtubeSyncLogTable.startedAt} DESC`)
        .limit(req.query.limit);
      return {
        items: rows.map((r) => ({
          id: r.id,
          startedAt: r.startedAt.toISOString(),
          completedAt: r.completedAt?.toISOString() ?? null,
          status: r.status,
          videosFound: r.videosFound,
          videosInserted: r.videosInserted,
          videosUpdated: r.videosUpdated,
          errorMessage: r.errorMessage,
          triggeredBy: r.triggeredBy,
          source: r.source,
        })),
      };
    },
  );

  /**
   * GET /admin/youtube/sync/category-stats
   * Returns per-category video counts for all YouTube-sourced videos.
   */
  r.get(
    "/youtube/sync/category-stats",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "YouTube video category breakdown",
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            total: z.number(),
            liveServiceCount: z.number(),
            uncategorizedCount: z.number(),
            byCategory: z.array(z.object({
              category: z.string(),
              count: z.number(),
              pct: z.number(),
            })),
          }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async () => getCategoryStats(),
  );

  /**
   * POST /admin/youtube/recategorize
   * Re-runs detectCategory() on every unlocked YouTube video and persists changes.
   * Skips rows where metadata_locked = true (operator-curated assignments).
   */
  r.post(
    "/youtube/recategorize",
    {
      preHandler: requireAuth("admin"),
      config: { rateLimit: { max: 3, timeWindow: "5 minutes" } },      schema: {
        tags: ["admin"],
        summary: "Re-categorize all unlocked YouTube videos using current keyword rules",
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            processed: z.number(),
            changed: z.number(),
            unchanged: z.number(),
            errors: z.number(),
            durationMs: z.number(),
            changesByCategory: z.record(z.string(), z.number()),
          }),
          409: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (_req, reply) => {
      if (isRecategorizeInProgress()) {
        return reply.code(409).send({ error: "A recategorization is already in progress" });
      }
      const result = await recategorizeAllVideos();
      return result;
    },
  );
}
