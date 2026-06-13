import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, desc, eq, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { BadRequestError, NotFoundError } from "../../shared/errors.js";

/**
 * Scheduled push notifications.
 *
 * The admin SPA's notifications page lets editors queue a push for a
 * future timestamp ("send Sunday's livestream reminder at 8:30am").
 * This module is the persistence + listing surface for that queue. The
 * actual *delivery* is the responsibility of the out-of-process
 * push-worker which polls this table for `status='pending' AND
 * scheduled_at <= now()` rows and posts them through the same path as
 * an immediate `/notifications/send`.
 *
 * We deliberately don't run a setInterval inside the API process to
 * fire these — the API runs in autoscale and would either fire the
 * same notification N times (one per replica) or not at all (if the
 * lone instance is asleep). The scheduler lives in the worker exactly
 * for this reason.
 */

const scheduled = schema.scheduledNotificationsTable;

const ScheduledNotifSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  type: z.string(),
  videoId: z.string().nullable(),
  scheduledAt: z.string(),
  status: z.string(),
  sentCount: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
});

const ScheduleBodySchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(1000),
  type: z.string().min(1).max(64).default("general"),
  videoId: z.string().nullable().optional(),
  scheduledAt: z.string().datetime(),
});

const ListResponseSchema = z.object({ items: z.array(ScheduledNotifSchema) });

function toDto(row: typeof scheduled.$inferSelect): z.infer<typeof ScheduledNotifSchema> {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    type: row.type,
    videoId: row.videoId,
    scheduledAt: row.scheduledAt.toISOString(),
    status: row.status,
    sentCount: row.sentCount,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
  };
}

export async function scheduledNotificationsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/notifications/scheduled",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "List queued + completed scheduled notifications",
        response: { 200: ListResponseSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const rows = await db
        .select()
        .from(scheduled)
        .orderBy(desc(scheduled.scheduledAt))
        .limit(200);
      return { items: rows.map(toDto) };
    },
  );

  r.post(
    "/notifications/schedule",
    {
      preHandler: requireAuth("editor"),
      // Scheduling writes a DB row and will fan-out to thousands of devices
      // when the time arrives. 20/min matches the send endpoint's limit.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "Schedule a push notification for a future timestamp",
        body: ScheduleBodySchema,
        response: { 200: ScheduledNotifSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const body = req.body;
      const when = new Date(body.scheduledAt);
      // Reject anything more than 30 days out — the SPA's date picker
      // tops out there, and this catches obvious unit mistakes
      // (millis-vs-seconds, accidental year typo) before they wedge
      // the worker.
      const maxFutureMs = 30 * 24 * 60 * 60 * 1000;
      const skewMs = when.getTime() - Date.now();
      if (skewMs > maxFutureMs) {
        throw new BadRequestError(
          "scheduledAt is more than 30 days in the future — refusing to schedule",
        );
      }
      // Allow scheduling slightly in the past (≤2 min) so editors who
      // tab away mid-form aren't punished, but reject anything older
      // than that — the worker would just fire it immediately.
      if (skewMs < -2 * 60 * 1000) {
        throw new BadRequestError("scheduledAt is in the past");
      }

      // Validate videoId references a real video so the deep-link in the
      // delivered notification doesn't 404 when a viewer taps on it.
      if (body.videoId) {
        const [videoRow] = await db
          .select({ id: schema.videosTable.id })
          .from(schema.videosTable)
          .where(eq(schema.videosTable.id, body.videoId))
          .limit(1);
        if (!videoRow) throw new NotFoundError(`Video ${body.videoId} not found`);
      }

      const id = nanoid();
      const [row] = await db
        .insert(scheduled)
        .values({
          id,
          title: body.title,
          body: body.body,
          type: body.type,
          videoId: body.videoId ?? null,
          scheduledAt: when,
          status: "pending",
        })
        .returning();
      return toDto(row!);
    },
  );

  // F43: Surface permanently-failed scheduled notifications so operators
  // have visibility into missed sends without querying the DB manually.
  r.get(
    "/notifications/failed",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "List permanently-failed scheduled notifications (exhausted max_attempts)",
        querystring: z.object({
          limit: z.coerce.number().int().positive().default(50).catch(50).transform(v => Math.min(v, 200)),
        }),
        response: {
          200: z.object({
            count: z.number(),
            items: z.array(ScheduledNotifSchema),
          }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { limit } = req.query;
      const rows = await db
        .select()
        .from(scheduled)
        .where(
          and(
            eq(scheduled.status, "failed"),
            // Only return notifications that were actually scheduled in the past
            // (not pending future ones that haven't been attempted yet)
            lte(scheduled.scheduledAt, new Date()),
          ),
        )
        .orderBy(desc(scheduled.scheduledAt))
        .limit(limit);
      return { count: rows.length, items: rows.map(toDto) };
    },
  );

  r.delete(
    "/notifications/scheduled/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },      schema: {
        tags: ["admin"],
        summary: "Cancel (delete) a pending scheduled notification",
        params: z.object({ id: z.string().min(1) }),
        response: { 200: z.object({ ok: z.literal(true), id: z.string() }), 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params;
      // We hard-delete *only* pending rows. Once a notification has
      // been sent (or failed permanently), it stays as an audit record
      // — DELETE on a sent row would let an admin retroactively erase
      // delivery history, which we explicitly don't want.
      const [existing] = await db
        .select({ status: scheduled.status })
        .from(scheduled)
        .where(eq(scheduled.id, id))
        .limit(1);
      if (!existing) throw new NotFoundError(`Scheduled notification ${id} not found`);
      if (existing.status !== "pending") {
        throw new BadRequestError(
          `Cannot cancel a notification in status '${existing.status}' — only 'pending' is cancelable`,
        );
      }
      await db.delete(scheduled).where(eq(scheduled.id, id));
      return { ok: true as const, id };
    },
  );
}
