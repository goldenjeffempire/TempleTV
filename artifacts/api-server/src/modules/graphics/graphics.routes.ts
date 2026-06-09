import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { logger } from "../../infrastructure/logger.js";
import { sseCorsHeaders } from "../../lib/sse-cors.js";

/**
 * On-Air Graphics Bus — fans out graphic activation/deactivation events
 * to all connected SSE clients in real time. No polling required.
 */
export class GraphicsBus extends EventEmitter {}
export const graphicsBus = new GraphicsBus();
graphicsBus.setMaxListeners(1024);

export interface GraphicsEvent {
  type: "graphic-activated" | "graphic-deactivated" | "graphics-snapshot";
  channelId: string;
  graphic?: {
    id: string;
    type: string;
    content: string;
    subContent: string | null;
    durationSecs: number | null;
  };
  allActive?: Array<{
    id: string;
    type: string;
    content: string;
    subContent: string | null;
    durationSecs: number | null;
  }>;
}

export async function graphicsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const GraphicBodySchema = z.object({
    channelId: z.string().min(1).default("temple-tv-live"),
    type: z.enum(["ticker", "lower_third", "bug_text"]),
    content: z.string().min(1).max(1000),
    subContent: z.string().max(200).optional().nullable(),
    // Cap at 24 h — prevents a rogue editor from scheduling a setTimeout
    // callback that fires weeks in the future and pins a closed-over reference.
    durationSecs: z.number().int().positive().max(86400).optional().nullable(),
  });

  // ── Public: get active graphics for a channel ──────────────────────────────
  r.get(
    "/graphics",
    {
      schema: {
        tags: ["graphics"],
        summary: "Get all active on-air graphics for a channel",
        querystring: z.object({ channelId: z.string().optional().default("temple-tv-live") }),
        response: {
          200: z.array(z.object({
            id: z.string(),
            channelId: z.string(),
            type: z.string(),
            content: z.string(),
            subContent: z.string().nullable(),
            durationSecs: z.number().nullable(),
            activatedAt: z.string().nullable(),
          })),
        },
      },
    },
    async (req) => {
      const rows = await db
        .select()
        .from(schema.channelGraphicsTable)
        .where(
          and(
            eq(schema.channelGraphicsTable.channelId, req.query.channelId),
            eq(schema.channelGraphicsTable.isActive, true),
          ),
        );
      return rows.map((r) => ({
        ...r,
        activatedAt: r.activatedAt?.toISOString() ?? null,
      }));
    },
  );

  // ── Public: SSE stream for live graphic events ─────────────────────────────
  r.get(
    "/graphics/events",
    {
      schema: {
        tags: ["graphics"],
        summary: "SSE stream for on-air graphic activation/deactivation",
        querystring: z.object({ channelId: z.string().optional().default("temple-tv-live") }),
      },
    },
    async (req, reply) => {
      const channelId = req.query.channelId;

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...sseCorsHeaders(req),
      });

      const send = (evt: GraphicsEvent) => {
        if (evt.channelId !== channelId && evt.channelId !== "all") return;
        try {
          reply.raw.write(`event: ${evt.type}\n`);
          reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
        } catch { /* ignore */ }
      };

      // Send current state on connect
      const active = await db
        .select()
        .from(schema.channelGraphicsTable)
        .where(
          and(
            eq(schema.channelGraphicsTable.channelId, channelId),
            eq(schema.channelGraphicsTable.isActive, true),
          ),
        );
      send({
        type: "graphics-snapshot",
        channelId,
        allActive: active.map((g) => ({
          id: g.id,
          type: g.type,
          content: g.content,
          subContent: g.subContent ?? null,
          durationSecs: g.durationSecs ?? null,
        })),
      });

      graphicsBus.on("event", send);
      const heartbeat = setInterval(() => {
        try { reply.raw.write(": ping\n\n"); } catch { /* ignore */ }
      }, 15_000);
      heartbeat.unref?.();

      const cleanup = () => {
        clearInterval(heartbeat);
        graphicsBus.off("event", send);
        try { reply.raw.end(); } catch { /* ignore */ }
      };
      req.raw.on("close", cleanup);
      req.raw.on("error", cleanup);
    },
  );

  const GraphicRowSchema = z.object({
    id: z.string(),
    channelId: z.string(),
    type: z.string(),
    content: z.string(),
    subContent: z.string().nullable(),
    durationSecs: z.number().nullable(),
    isActive: z.boolean(),
    activatedAt: z.string().nullable(),
    deactivatedAt: z.string().nullable(),
  });

  // ── Admin: activate/create a graphic ─────────────────────────────────────
  r.post(
    "/admin/graphics",
    {
      preHandler: requireAuth("editor"),
      // Each activation fans out an SSE graphic-activated event to all
      // connected clients. 10/min prevents a compromised editor account
      // from flooding every viewer's overlay in a tight loop.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["graphics"],
        summary: "Activate an on-air graphic overlay",
        body: GraphicBodySchema,
        response: { 201: GraphicRowSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { channelId, type, content, subContent, durationSecs } = req.body;
      const now = new Date();

      // Deactivate any existing graphic of the same type on this channel
      await db
        .update(schema.channelGraphicsTable)
        .set({ isActive: false, deactivatedAt: now })
        .where(
          and(
            eq(schema.channelGraphicsTable.channelId, channelId),
            eq(schema.channelGraphicsTable.type, type),
            eq(schema.channelGraphicsTable.isActive, true),
          ),
        );

      const [graphic] = await db.insert(schema.channelGraphicsTable).values({
        id: crypto.randomUUID(),
        channelId,
        type,
        content,
        subContent: subContent ?? null,
        durationSecs: durationSecs ?? null,
        isActive: true,
        activatedAt: now,
      }).returning();

      logger.info(
        {
          graphicId: graphic!.id,
          channelId,
          type,
          durationSecs: durationSecs ?? null,
          activatedBy: req.principal?.email ?? "admin",
        },
        "[graphics] graphic activated",
      );

      graphicsBus.emit("event", {
        type: "graphic-activated",
        channelId,
        graphic: {
          id: graphic!.id,
          type: graphic!.type,
          content: graphic!.content,
          subContent: graphic!.subContent ?? null,
          durationSecs: graphic!.durationSecs ?? null,
        },
      } satisfies GraphicsEvent);

      // Auto-dismiss after durationSecs if specified
      if (durationSecs) {
        const graphicId = graphic!.id;
        const t = setTimeout(() => {
          void (async () => {
            try {
              await db
                .update(schema.channelGraphicsTable)
                .set({ isActive: false, deactivatedAt: new Date() })
                .where(eq(schema.channelGraphicsTable.id, graphicId));
              graphicsBus.emit("event", {
                type: "graphic-deactivated",
                channelId,
                graphic: { id: graphicId, type, content, subContent: subContent ?? null, durationSecs },
              } satisfies GraphicsEvent);
            } catch (err) {
              logger.warn({ err, graphicId }, "[graphics] auto-dismiss timer: DB update failed (non-fatal)");
            }
          })();
        }, durationSecs * 1000);
        t.unref?.();
      }

      return reply.code(201).send({
        ...graphic!,
        activatedAt: graphic!.activatedAt?.toISOString() ?? null,
        deactivatedAt: graphic!.deactivatedAt?.toISOString() ?? null,
      });
    },
  );

  // ── Admin: deactivate a graphic ───────────────────────────────────────────
  r.delete(
    "/admin/graphics/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["graphics"],
        summary: "Deactivate an on-air graphic",
        params: z.object({ id: z.string().min(1).max(128) }),
        security: [{ bearerAuth: [] }],
        response: { 204: z.void(), 404: z.object({ error: z.string() }), 429: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const [graphic] = await db
        .update(schema.channelGraphicsTable)
        .set({ isActive: false, deactivatedAt: new Date() })
        .where(eq(schema.channelGraphicsTable.id, req.params.id))
        .returning();
      if (!graphic) return reply.code(404).send({ error: "Graphic not found" });

      logger.info(
        { graphicId: graphic.id, channelId: graphic.channelId, type: graphic.type, deactivatedBy: req.principal?.email ?? "admin" },
        "[graphics] graphic deactivated",
      );

      graphicsBus.emit("event", {
        type: "graphic-deactivated",
        channelId: graphic.channelId,
        graphic: {
          id: graphic.id,
          type: graphic.type,
          content: graphic.content,
          subContent: graphic.subContent ?? null,
          durationSecs: graphic.durationSecs ?? null,
        },
      } satisfies GraphicsEvent);

      return reply.code(204).send(null);
    },
  );

  // ── Admin: deactivate all graphics for a channel ──────────────────────────
  r.delete(
    "/admin/graphics/channel/:channelId",
    {
      preHandler: requireAuth("editor"),
      // Bulk-deactivate all graphics for a channel + fans out a snapshot SSE.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["graphics"],
        summary: "Clear all active on-air graphics for a channel",
        params: z.object({ channelId: z.string().min(1).max(128) }),
        security: [{ bearerAuth: [] }],
        response: { 204: z.void(), 429: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      await db
        .update(schema.channelGraphicsTable)
        .set({ isActive: false, deactivatedAt: new Date() })
        .where(
          and(
            eq(schema.channelGraphicsTable.channelId, req.params.channelId),
            eq(schema.channelGraphicsTable.isActive, true),
          ),
        );

      logger.info(
        { channelId: req.params.channelId, clearedBy: req.principal?.email ?? "admin" },
        "[graphics] all channel graphics cleared",
      );

      graphicsBus.emit("event", {
        type: "graphics-snapshot",
        channelId: req.params.channelId,
        allActive: [],
      } satisfies GraphicsEvent);

      return reply.code(204).send(null);
    },
  );
}
