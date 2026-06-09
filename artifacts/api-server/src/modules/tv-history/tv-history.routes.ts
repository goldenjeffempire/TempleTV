import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";

const UpsertBodySchema = z.object({
  deviceId: z.string().min(1).max(128),
  videoId: z.string().min(1).max(128),
  title: z.string().max(500).default(""),
  thumbnailUrl: z.string().max(1000).default(""),
  hlsUrl: z.string().max(1000).nullable().optional(),
  positionSecs: z.number().int().min(0).default(0),
  durationSecs: z.number().int().min(0).default(0),
  completed: z.boolean().default(false),
  /** ISO-8601 timestamp; defaults to server now() when omitted. */
  watchedAt: z.string().datetime().optional(),
});

const EntrySchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  videoId: z.string(),
  title: z.string(),
  thumbnailUrl: z.string(),
  hlsUrl: z.string().nullable(),
  positionSecs: z.number(),
  durationSecs: z.number(),
  completed: z.boolean(),
  watchedAt: z.string(),
});

function toDto(r: typeof schema.deviceWatchHistoryTable.$inferSelect) {
  return {
    id: r.id,
    deviceId: r.deviceId,
    videoId: r.videoId,
    title: r.title,
    thumbnailUrl: r.thumbnailUrl,
    hlsUrl: r.hlsUrl ?? null,
    positionSecs: r.positionSecs,
    durationSecs: r.durationSecs,
    completed: r.completed,
    watchedAt: r.watchedAt.toISOString(),
  };
}

export async function tvHistoryRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Upsert ────────────────────────────────────────────────────────────────
  // Called fire-and-forget every ~5 s during playback and once at completion.
  // Inserts a new row or updates the existing (deviceId, videoId) pair —
  // whichever has the more recent watchedAt wins via the conditional SET.
  r.post(
    "/tv/history",
    {
      // Called fire-and-forget every ~5 s during TV playback.
      // 120/min covers bursts on fast-forward/seek while preventing
      // a misconfigured TV client from hammering the DB.
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        tags: ["tv"],
        summary: "Upsert a device watch-history entry",
        body: UpsertBodySchema,
        response: { 200: EntrySchema, 429: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const {
        deviceId,
        videoId,
        title,
        thumbnailUrl,
        hlsUrl,
        positionSecs,
        durationSecs,
        completed,
        watchedAt,
      } = req.body;

      const watchedAtDate = watchedAt ? new Date(watchedAt) : new Date();

      const [row] = await db
        .insert(schema.deviceWatchHistoryTable)
        .values({
          id: crypto.randomUUID(),
          deviceId,
          videoId,
          title,
          thumbnailUrl,
          hlsUrl: hlsUrl ?? null,
          positionSecs,
          durationSecs,
          completed,
          watchedAt: watchedAtDate,
        })
        .onConflictDoUpdate({
          target: [
            schema.deviceWatchHistoryTable.deviceId,
            schema.deviceWatchHistoryTable.videoId,
          ],
          set: {
            title,
            thumbnailUrl,
            hlsUrl: hlsUrl ?? null,
            positionSecs,
            durationSecs,
            completed,
            watchedAt: watchedAtDate,
          },
        })
        .returning();

      return reply.send(toDto(row!));
    },
  );

  // ── List ─────────────────────────────────────────────────────────────────
  r.get(
    "/tv/history/:deviceId",
    {
      schema: {
        tags: ["tv"],
        summary: "Get watch history for a device (newest first, max 100)",
        params: z.object({ deviceId: z.string().min(1) }),
        response: { 200: z.array(EntrySchema) },
      },
    },
    async (req, reply) => {
      const rows = await db
        .select()
        .from(schema.deviceWatchHistoryTable)
        .where(
          eq(schema.deviceWatchHistoryTable.deviceId, req.params.deviceId),
        )
        .orderBy(desc(schema.deviceWatchHistoryTable.watchedAt))
        .limit(100);

      return reply.send(rows.map(toDto));
    },
  );

  // ── Clear ─────────────────────────────────────────────────────────────────
  r.delete(
    "/tv/history/:deviceId",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["tv"],
        summary: "Clear all watch history for a device",
        params: z.object({ deviceId: z.string().min(1) }),
        response: { 204: z.null(), 429: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      await db
        .delete(schema.deviceWatchHistoryTable)
        .where(
          eq(schema.deviceWatchHistoryTable.deviceId, req.params.deviceId),
        );

      return reply.code(204).send(null);
    },
  );
}
