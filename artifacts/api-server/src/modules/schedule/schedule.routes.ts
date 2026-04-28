import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import {
  CreateScheduleBodySchema,
  ListScheduleResponseSchema,
  ScheduleEntrySchema,
  UpdateScheduleBodySchema,
} from "./schedule.schemas.js";
import { scheduleService } from "./schedule.service.js";

const idParam = z.object({ id: z.string().min(1) });

export async function scheduleRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/",
    {
      schema: {
        tags: ["schedule"],
        summary: "List the weekly broadcast schedule",
        response: { 200: ListScheduleResponseSchema },
      },
    },
    async () => scheduleService.list(),
  );

  r.post(
    "/",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["schedule"],
        summary: "Create a schedule entry",
        body: CreateScheduleBodySchema,
        response: { 201: ScheduleEntrySchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const created = await scheduleService.create(req.body);
      reply.code(201);
      return created;
    },
  );

  r.patch(
    "/:id",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["schedule"],
        summary: "Update a schedule entry",
        params: idParam,
        body: UpdateScheduleBodySchema,
        response: { 200: ScheduleEntrySchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => scheduleService.update(req.params.id, req.body),
  );

  r.delete(
    "/:id",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["schedule"],
        summary: "Delete a schedule entry",
        params: idParam,
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => scheduleService.delete(req.params.id),
  );
}
