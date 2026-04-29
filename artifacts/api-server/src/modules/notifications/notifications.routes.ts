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

  // Root alias for `/history`. The admin SPA's older notifications page
  // calls `GET /notifications` and expects the same paginated history
  // payload — keep both URLs serving the same handler so we don't break
  // the existing build while the SPA migrates to `/notifications/history`.
  r.get(
    "/",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["notifications"],
        summary: "Root alias for /history (admin SPA compatibility)",
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
