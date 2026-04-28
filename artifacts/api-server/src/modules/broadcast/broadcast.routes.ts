import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AddQueueItemSchema,
  BroadcastSnapshotSchema,
  ReorderQueueSchema,
} from "./broadcast.schemas.js";
import { broadcastService } from "./broadcast.service.js";
import { broadcastEngine } from "./queue.engine.js";
import { requireAuth } from "../../middleware/auth.js";

export async function broadcastRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/current",
    {
      schema: {
        tags: ["broadcast"],
        summary: "Current channel state — what is airing now and what's next",
        response: { 200: BroadcastSnapshotSchema },
      },
    },
    async () => broadcastService.snapshot(),
  );

  r.get(
    "/queue",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["broadcast"],
        summary: "Admin: list every program in the queue (active + inactive)",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => broadcastService.listQueue(),
  );

  r.post(
    "/queue",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["broadcast"],
        summary: "Admin: append a program to the queue",
        body: AddQueueItemSchema,
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const created = await broadcastService.addToQueue(req.body);
      reply.code(201);
      return created;
    },
  );

  r.delete(
    "/queue/:id",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["broadcast"],
        summary: "Admin: remove a program from the queue",
        params: z.object({ id: z.string() }),
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => broadcastService.removeFromQueue(req.params.id),
  );

  r.post(
    "/queue/reorder",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["broadcast"],
        summary: "Admin: reorder the active queue",
        body: ReorderQueueSchema,
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => broadcastService.reorder(req.body.itemIds),
  );

  r.patch(
    "/queue/:id/active",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["broadcast"],
        summary: "Admin: toggle whether a queue item is in rotation",
        params: z.object({ id: z.string() }),
        body: z.object({ isActive: z.boolean() }),
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => broadcastService.toggleActive(req.params.id, req.body.isActive),
  );

  r.get(
    "/viewers",
    {
      schema: {
        tags: ["broadcast"],
        summary: "Live viewer count for the channel",
        response: {
          200: z.object({ channelId: z.string(), count: z.number().int().nonnegative() }),
        },
      },
    },
    async () => ({ channelId: broadcastEngine.channelId, count: broadcastEngine.getViewerCount() }),
  );
}
