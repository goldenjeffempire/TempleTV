import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { NotFoundError } from "../../shared/errors.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";

const feedback = schema.userFeedbackTable;

const FeedbackTypeEnum = z.enum(["bug", "suggestion", "general"]);

const FeedbackSchema = z.object({
  id: z.string(),
  type: FeedbackTypeEnum,
  subject: z.string(),
  message: z.string(),
  platform: z.string(),
  appVersion: z.string().nullable(),
  userId: z.string().nullable(),
  userEmail: z.string().nullable(),
  isRead: z.boolean(),
  createdAt: z.string(),
});

const SubmitBodySchema = z.object({
  type: FeedbackTypeEnum,
  subject: z.string().min(1).max(200),
  message: z.string().min(1).max(4000),
  platform: z.string().max(32).optional().default("mobile"),
  appVersion: z.string().max(32).optional(),
  userEmail: z.string().email().max(200).optional(),
});

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).default(25).catch(25).transform(v => Math.min(v, 200)),
  status: z.enum(["all", "unread", "read"]).optional().default("all"),
  type: FeedbackTypeEnum.optional(),
});

const ListResponseSchema = z.object({
  items: z.array(FeedbackSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  unread: z.number().int().nonnegative(),
});

function toDto(row: typeof feedback.$inferSelect): z.infer<typeof FeedbackSchema> {
  return {
    id: row.id,
    type: row.type as z.infer<typeof FeedbackTypeEnum>,
    subject: row.subject,
    message: row.message,
    platform: row.platform,
    appVersion: row.appVersion ?? null,
    userId: row.userId ?? null,
    userEmail: row.userEmail ?? null,
    isRead: row.isRead,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function feedbackRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/feedback",
    {
      config: { rateLimit: { max: 10, timeWindow: "10 minutes" } },      schema: {
        tags: ["feedback"],
        summary: "Submit app feedback or bug report",
        body: SubmitBodySchema,
        response: { 201: z.object({ ok: z.literal(true), id: z.string() }), 429: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const userId = (req as { user?: { id?: string } }).user?.id ?? null;
      const id = randomUUID();

      await db.insert(feedback).values({
        id,
        type: body.type,
        subject: body.subject,
        message: body.message,
        platform: body.platform,
        appVersion: body.appVersion ?? null,
        userId,
        userEmail: body.userEmail ?? null,
        isRead: false,
      });

      adminEventBus.push("feedback-received", {
        id,
        type: body.type,
        subject: body.subject,
        platform: body.platform,
      });

      return reply.status(201).send({ ok: true as const, id });
    },
  );
}

export async function feedbackAdminRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/feedback",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "Paginated feedback inbox",
        querystring: ListQuerySchema,
        response: { 200: ListResponseSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const q = req.query;
      const offset = (q.page - 1) * q.limit;

      const filters: SQL[] = [];
      if (q.status === "unread") filters.push(eq(feedback.isRead, false));
      else if (q.status === "read") filters.push(eq(feedback.isRead, true));
      if (q.type) filters.push(eq(feedback.type, q.type));

      const where = filters.length > 0 ? and(...filters) : undefined;

      const [rows, totalRows, unreadRows] = await Promise.all([
        db
          .select()
          .from(feedback)
          .where(where as SQL | undefined)
          .orderBy(desc(feedback.createdAt))
          .limit(q.limit)
          .offset(offset),
        db.select({ c: count() }).from(feedback).where(where as SQL | undefined),
        db.select({ c: count() }).from(feedback).where(eq(feedback.isRead, false)),
      ]);

      return {
        items: rows.map(toDto),
        total: Number(totalRows[0]?.c ?? 0),
        page: q.page,
        limit: q.limit,
        unread: Number(unreadRows[0]?.c ?? 0),
      };
    },
  );

  r.patch(
    "/feedback/:id/read",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "Mark feedback as read or unread",
        params: z.object({ id: z.string().min(1) }),
        body: z.object({ isRead: z.boolean().optional() }).optional(),
        response: { 200: FeedbackSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params;
      const next = req.body?.isRead ?? true;
      const updated = await db
        .update(feedback)
        .set({ isRead: next })
        .where(eq(feedback.id, id))
        .returning();
      if (updated.length === 0) throw new NotFoundError(`Feedback ${id} not found`);
      return toDto(updated[0]!);
    },
  );

  r.delete(
    "/feedback/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "Permanently delete a feedback entry",
        params: z.object({ id: z.string().min(1) }),
        response: { 200: z.object({ ok: z.literal(true), id: z.string() }), 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params;
      const removed = await db
        .delete(feedback)
        .where(eq(feedback.id, id))
        .returning({ id: feedback.id });
      if (removed.length === 0) throw new NotFoundError(`Feedback ${id} not found`);
      return { ok: true as const, id };
    },
  );
}
