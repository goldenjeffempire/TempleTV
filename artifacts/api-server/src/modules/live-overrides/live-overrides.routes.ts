import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import {
  LiveOverrideSchema,
  LiveStatusSchema,
  StartOverrideBodySchema,
} from "./live-overrides.schemas.js";
import { liveOverridesService } from "./live-overrides.service.js";

const ListResponseSchema = z.object({
  items: z.array(LiveOverrideSchema),
  total: z.number().int().nonnegative(),
});

export async function liveOverridesRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/status",
    {
      schema: {
        tags: ["live"],
        summary: "Public: is a live override currently active?",
        response: { 200: LiveStatusSchema },
      },
    },
    async () => liveOverridesService.getStatus(),
  );

  r.get(
    "/recent",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["live"],
        summary: "Admin: list recent live overrides for audit",
        response: { 200: ListResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => liveOverridesService.listRecent(),
  );

  r.post(
    "/start",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["live"],
        summary: "Admin: start a live override (deactivates any prior)",
        body: StartOverrideBodySchema,
        response: { 201: LiveOverrideSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const created = await liveOverridesService.start(req.body);
      reply.code(201);
      return created;
    },
  );

  r.post(
    "/stop",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["live"],
        summary: "Admin: stop the currently active live override",
        response: { 200: LiveOverrideSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => liveOverridesService.stop(),
  );
}
