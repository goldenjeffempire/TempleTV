import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
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

type ScheduleListResult = Awaited<ReturnType<typeof scheduleService.list>>;

const SCHEDULE_CACHE_TTL_MS = 5 * 60 * 1000;
let scheduleCache: { data: ScheduleListResult; expiresAt: number } | null = null;

function invalidateScheduleCache() {
  scheduleCache = null;
}

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
    async (_req, reply) => {
      if (scheduleCache && Date.now() < scheduleCache.expiresAt) {
        reply.header("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
        return scheduleCache.data;
      }
      const result = await scheduleService.list();
      scheduleCache = { data: result, expiresAt: Date.now() + SCHEDULE_CACHE_TTL_MS };
      reply.header("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
      return result;
    },
  );

  r.post(
    "/",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["schedule"],
        summary: "Create a schedule entry",
        body: CreateScheduleBodySchema,
        response: { 201: ScheduleEntrySchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      invalidateScheduleCache();
      const created = await scheduleService.create(req.body);
      reply.code(201);
      return created;
    },
  );

  r.patch(
    "/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["schedule"],
        summary: "Update a schedule entry",
        params: idParam,
        body: UpdateScheduleBodySchema,
        response: { 200: ScheduleEntrySchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      invalidateScheduleCache();
      return scheduleService.update(req.params.id, req.body);
    },
  );

  r.delete(
    "/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },      schema: {
        tags: ["schedule"],
        summary: "Delete a schedule entry",
        params: idParam,
        response: { 200: z.object({ id: z.string(), deleted: z.boolean() }), 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      invalidateScheduleCache();
      return scheduleService.delete(req.params.id);
    },
  );
}
