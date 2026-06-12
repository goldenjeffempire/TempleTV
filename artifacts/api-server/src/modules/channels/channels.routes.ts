import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq, asc, and, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { ConflictError } from "../../shared/errors.js";
import { channelRegistry } from "./channel-registry.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { snapshotToCurrentResult } from "../broadcast/broadcast.routes.js";
import { overrideBus } from "../live-overrides/override-bus.js";

const ChannelBodySchema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens"),
  description: z.string().max(400).optional().default(""),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default("#DC2626"),
  failoverHlsUrl: z.string().url().optional().nullable(),
});

const QueueItemBodySchema = z.object({
  videoId: z.string().optional(),
  youtubeId: z.string().min(1),
  title: z.string().min(1).max(200),
  thumbnailUrl: z.string().optional().default(""),
  durationSecs: z.number().int().positive().default(1800),
  localVideoUrl: z.string().optional().nullable(),
  hlsMasterUrl: z.string().optional().nullable(),
  videoSource: z.enum(["youtube", "local", "hls"]).default("youtube"),
});

const ChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  color: z.string(),
  failoverHlsUrl: z.string().nullable(),
  isPrimary: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.string().or(z.date()).nullable(),
  updatedAt: z.string().or(z.date()).nullable(),
});

const ChannelQueueItemSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  videoId: z.string().nullable().optional(),
  youtubeId: z.string(),
  title: z.string(),
  thumbnailUrl: z.string(),
  durationSecs: z.number(),
  localVideoUrl: z.string().nullable(),
  hlsMasterUrl: z.string().nullable(),
  videoSource: z.enum(["youtube", "local", "hls"]),
  sortOrder: z.number(),
  isActive: z.boolean(),
  addedAt: z.string().or(z.date()).nullable(),
});

const ErrSchema = z.object({ error: z.string() });

export async function channelsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Public: list active channels ──────────────────────────────────────────
  r.get(
    "/channels",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["channels"],
        summary: "List all active channels",
        response: {
          429: ErrSchema,
          200: z.array(z.object({
            id: z.string(),
            name: z.string(),
            slug: z.string(),
            description: z.string(),
            color: z.string(),
            isPrimary: z.boolean(),
            sortOrder: z.number(),
            viewerCount: z.number(),
            isRunning: z.boolean(),
          })),
        },
      },
    },
    async (req, reply) => {
      // Channel list is nearly static — it changes only when an operator
      // adds or removes a channel in the admin panel. A 15-second public
      // cache dramatically reduces DB round-trips on mobile clients that
      // poll this every 15 s for the viewer count / isRunning badge.
      // `stale-while-revalidate=30` lets CDN/edge serve the cached body
      // instantly while refreshing in the background.
      reply.header("Cache-Control", "public, max-age=15, s-maxage=15, stale-while-revalidate=30, stale-if-error=300");
      const rows = await db
        .select()
        .from(schema.channelsTable)
        .where(eq(schema.channelsTable.isActive, true))
        .orderBy(asc(schema.channelsTable.sortOrder));

      return rows.map((ch) => {
        if (ch.isPrimary) {
          return {
            id: ch.id,
            name: ch.name,
            slug: ch.slug,
            description: ch.description,
            color: ch.color,
            isPrimary: ch.isPrimary,
            sortOrder: ch.sortOrder,
            viewerCount: broadcastEngine.getViewerCount(),
            isRunning: broadcastEngine.isRunning(),
          };
        }
        const engine = channelRegistry.get(ch.id);
        return {
          id: ch.id,
          name: ch.name,
          slug: ch.slug,
          description: ch.description,
          color: ch.color,
          isPrimary: ch.isPrimary,
          sortOrder: ch.sortOrder,
          viewerCount: engine?.getViewerCount() ?? 0,
          isRunning: engine?.isRunning() ?? false,
        };
      });
    },
  );

  // ── Public: get current broadcast for a channel ───────────────────────────
  r.get(
    "/channels/:slug/current",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["channels"],
        summary: "Get current broadcast snapshot for a channel by slug",
        params: z.object({ slug: z.string().min(1).max(80) }),
        response: {
          200: z.unknown(),
          404: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const ch = await db
        .select()
        .from(schema.channelsTable)
        .where(eq(schema.channelsTable.slug, req.params.slug))
        .limit(1)
        .then((r) => r[0]);

      if (!ch) return reply.code(404).send({ error: "Channel not found" });

      if (ch.isPrimary) {
        return reply.send(snapshotToCurrentResult(broadcastEngine.snapshot(), overrideBus.active));
      }
      const engine = await channelRegistry.getOrCreate(ch.id);
      return reply.send(snapshotToCurrentResult(engine.snapshot(), null));
    },
  );

  // ── Admin: create channel ─────────────────────────────────────────────────
  r.post(
    "/admin/channels",
    {
      preHandler: requireAuth("admin"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },      schema: {
        tags: ["channels"],
        summary: "Create a new broadcast channel",
        body: ChannelBodySchema,
        response: {
          201: ChannelSchema,
          409: ErrSchema,
          429: ErrSchema,
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const id = crypto.randomUUID();
      try {
        const [ch] = await db.insert(schema.channelsTable).values({
          id,
          name: req.body.name,
          slug: req.body.slug,
          description: req.body.description ?? "",
          color: req.body.color ?? "#DC2626",
          failoverHlsUrl: req.body.failoverHlsUrl ?? null,
          isPrimary: false,
          isActive: true,
          sortOrder: 0,
        }).returning();
        await channelRegistry.getOrCreate(id);
        return reply.code(201).send(ch);
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictError(`A channel with slug "${req.body.slug}" already exists`);
        }
        throw err;
      }
    },
  );

  // ── Admin: update channel ─────────────────────────────────────────────────
  r.patch(
    "/admin/channels/:id",
    {
      preHandler: requireAuth("admin"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["channels"],
        summary: "Update channel metadata",
        params: z.object({ id: z.string().min(1).max(128) }),
        body: ChannelBodySchema.partial(),
        response: {
          200: ChannelSchema,
          404: ErrSchema,
          429: ErrSchema,
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const [updated] = await db
        .update(schema.channelsTable)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(schema.channelsTable.id, req.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: "Channel not found" });
      return reply.send(updated);
    },
  );

  // ── Admin: delete channel ─────────────────────────────────────────────────
  r.delete(
    "/admin/channels/:id",
    {
      preHandler: requireAuth("admin"),
      // Deletes the channel and cascades to its queue. 5/min prevents
      // accidental rapid deletion of multiple channels.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },      schema: {
        tags: ["channels"],
        summary: "Delete a non-primary channel",
        params: z.object({ id: z.string().min(1).max(128) }),
        response: {
          204: z.void(),
          400: ErrSchema,
          404: ErrSchema,
          429: ErrSchema,
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const [ch] = await db
        .select()
        .from(schema.channelsTable)
        .where(eq(schema.channelsTable.id, req.params.id))
        .limit(1);
      if (!ch) return reply.code(404).send({ error: "Channel not found" });
      if (ch.isPrimary) return reply.code(400).send({ error: "Cannot delete the primary channel" });

      // Delete queue items and channel row atomically so a partial failure
      // never leaves orphaned queue rows pointing at a non-existent channel.
      await db.transaction(async (tx) => {
        await tx.delete(schema.channelQueueTable).where(eq(schema.channelQueueTable.channelId, req.params.id));
        await tx.delete(schema.channelsTable).where(eq(schema.channelsTable.id, req.params.id));
      });
      // Remove from in-memory registry AFTER the DB transaction commits so
      // a DB failure leaves the registry consistent with the DB state.
      await channelRegistry.remove(req.params.id);
      return reply.code(204).send();
    },
  );

  // ── Admin: get queue for a channel ───────────────────────────────────────
  r.get(
    "/admin/channels/:id/queue",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["channels"],
        summary: "List queue items for a channel",
        params: z.object({ id: z.string().min(1).max(128) }),
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(z.unknown()), 429: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const items = await db
        .select()
        .from(schema.channelQueueTable)
        .where(eq(schema.channelQueueTable.channelId, req.params.id))
        .orderBy(asc(schema.channelQueueTable.sortOrder), asc(schema.channelQueueTable.addedAt));
      return reply.send(items);
    },
  );

  // ── Admin: add item to channel queue ──────────────────────────────────────
  r.post(
    "/admin/channels/:id/queue",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["channels"],
        summary: "Add a video to a channel's broadcast queue",
        params: z.object({ id: z.string().min(1).max(128) }),
        body: QueueItemBodySchema,
        response: {
          201: ChannelQueueItemSchema,
          429: ErrSchema,
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      // Compute MAX(sort_order) and INSERT atomically inside a transaction to
      // prevent TOCTOU races when two operators add items concurrently.
      // Previous bug: used ASC LIMIT 1 (returns MIN, not MAX) so every item
      // after the first was assigned sort_order = min+1, causing collisions.
      const [item] = await db.transaction(async (tx) => {
        const [maxRow] = await tx
          .select({ max: sql<number>`COALESCE(MAX(sort_order), -1)` })
          .from(schema.channelQueueTable)
          .where(eq(schema.channelQueueTable.channelId, req.params.id));
        const sortOrder = (maxRow?.max ?? -1) + 1;
        return tx.insert(schema.channelQueueTable).values({
          id: crypto.randomUUID(),
          channelId: req.params.id,
          ...req.body,
          sortOrder,
        }).returning();
      });

      await channelRegistry.reload(req.params.id);
      // Cast videoSource to the literal union — the DB column is plain text but
      // the Zod schema (and ChannelQueueItemSchema) narrows it to the enum.
      return reply.code(201).send({
        ...item,
        videoSource: item!.videoSource as "youtube" | "local" | "hls",
      });
    },
  );

  // ── Admin: remove item from channel queue ────────────────────────────────
  r.delete(
    "/admin/channels/:channelId/queue/:itemId",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["channels"],
        summary: "Remove an item from a channel's queue",
        params: z.object({ channelId: z.string().min(1).max(128), itemId: z.string().min(1).max(128) }),
        response: {
          204: z.void(),
          429: ErrSchema,
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      await db
        .delete(schema.channelQueueTable)
        .where(
          and(
            eq(schema.channelQueueTable.id, req.params.itemId),
            eq(schema.channelQueueTable.channelId, req.params.channelId),
          ),
        );
      await channelRegistry.reload(req.params.channelId);
      return reply.code(204).send();
    },
  );

  // ── Admin: toggle queue item active ─────────────────────────────────────
  r.patch(
    "/admin/channels/:channelId/queue/:itemId/active",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["channels"],
        summary: "Toggle active status of a channel queue item",
        params: z.object({ channelId: z.string().min(1).max(128), itemId: z.string().min(1).max(128) }),
        body: z.object({ isActive: z.boolean() }),
        response: {
          204: z.void(),
          429: ErrSchema,
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      await db
        .update(schema.channelQueueTable)
        .set({ isActive: req.body.isActive })
        .where(
          and(
            eq(schema.channelQueueTable.id, req.params.itemId),
            eq(schema.channelQueueTable.channelId, req.params.channelId),
          ),
        );
      await channelRegistry.reload(req.params.channelId);
      return reply.code(204).send();
    },
  );
}
