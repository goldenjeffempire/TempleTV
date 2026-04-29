import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { NotFoundError } from "../../shared/errors.js";

/**
 * Prayer-request inbox for the admin SPA's `/admin/prayers` page.
 *
 * The viewer-facing submission endpoint already exists elsewhere (the
 * mobile + web apps POST to `/prayer-requests`); this module is the
 * admin side: list with pagination + unread filter, mark-as-read,
 * and hard-delete.
 *
 * "Read" is a soft signal — flipping `is_read=true` doesn't remove the
 * row from the inbox, it just stops it from incrementing the unread
 * count badge.
 */

const prayers = schema.prayerRequestsTable;

const PrayerSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  message: z.string(),
  isRead: z.boolean(),
  createdAt: z.string(),
});

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  unread: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === "true"),
  status: z.enum(["all", "unread", "read"]).optional(),
});

const ListResponseSchema = z.object({
  items: z.array(PrayerSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  unread: z.number().int().nonnegative(),
});

function toDto(row: typeof prayers.$inferSelect): z.infer<typeof PrayerSchema> {
  return {
    id: row.id,
    name: row.name,
    message: row.message,
    isRead: row.isRead,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function prayersAdminRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/prayers",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Paginated prayer-request inbox",
        querystring: ListQuerySchema,
        response: { 200: ListResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const q = req.query as z.infer<typeof ListQuerySchema>;
      const offset = (q.page - 1) * q.limit;

      // The SPA exposes both shapes of "show me unread only" — the
      // legacy boolean param + a tri-state `status=` selector. We map
      // both to the same SQL filter so older clients don't break.
      const wantUnreadOnly = q.unread === true || q.status === "unread";
      const wantReadOnly = q.status === "read";

      const filters: SQL[] = [];
      if (wantUnreadOnly) filters.push(eq(prayers.isRead, false));
      else if (wantReadOnly) filters.push(eq(prayers.isRead, true));

      const where = filters.length > 0 ? and(...filters) : undefined;

      const [rows, totalRows, unreadRows] = await Promise.all([
        db
          .select()
          .from(prayers)
          .where(where as SQL | undefined)
          .orderBy(desc(prayers.createdAt))
          .limit(q.limit)
          .offset(offset),
        db
          .select({ c: count() })
          .from(prayers)
          .where(where as SQL | undefined),
        db
          .select({ c: count() })
          .from(prayers)
          .where(eq(prayers.isRead, false)),
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
    "/prayers/:id/read",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Mark a prayer request as read (or unread via body)",
        params: z.object({ id: z.string().min(1) }),
        body: z
          .object({ isRead: z.boolean().optional() })
          .optional(),
        response: { 200: PrayerSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { isRead?: boolean };
      const next = body.isRead ?? true;

      const updated = await db
        .update(prayers)
        .set({ isRead: next })
        .where(eq(prayers.id, id))
        .returning();
      if (updated.length === 0) throw new NotFoundError(`Prayer request ${id} not found`);
      return toDto(updated[0]!);
    },
  );

  r.delete(
    "/prayers/:id",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Permanently delete a prayer request",
        params: z.object({ id: z.string().min(1) }),
        response: { 200: z.object({ ok: z.literal(true), id: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const removed = await db
        .delete(prayers)
        .where(eq(prayers.id, id))
        .returning({ id: prayers.id });
      if (removed.length === 0) throw new NotFoundError(`Prayer request ${id} not found`);
      return { ok: true as const, id };
    },
  );
}
