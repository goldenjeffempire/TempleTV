import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { requireAuth } from "../../middleware/auth.js";
import {
  ListNotificationsQuerySchema,
  ListNotificationsResponseSchema,
  SendPushBodySchema,
  SendPushResponseSchema,
} from "./notifications.schemas.js";
import { notificationsService } from "./notifications.service.js";

export async function notificationsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/history",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["notifications"],
        summary: "List sent push notifications",
        querystring: ListNotificationsQuerySchema,
        response: { 200: ListNotificationsResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => notificationsService.listHistory(req.query),
  );

  r.post(
    "/send",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["notifications"],
        summary: "Queue a push notification for all subscribers",
        body: SendPushBodySchema,
        response: { 201: SendPushResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const created = await notificationsService.sendPush(req.body);
      reply.code(201);
      return created;
    },
  );
}
