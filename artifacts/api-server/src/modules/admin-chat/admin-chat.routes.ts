import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { NotFoundError } from "../../shared/errors.js";

/**
 * Admin chat moderation surface.
 *
 * The viewer-facing chat endpoints live in `modules/realtime/chat.routes`
 * (history + post). This module is the privileged side: editors can
 * soft-delete messages and create active mute/ban records that the
 * realtime gateway consults on every incoming send.
 *
 * Routes:
 *   POST /admin/chat/messages/:id/delete
 *   POST /admin/chat/moderate
 *
 * Soft-delete only: the row stays in `chat_messages` with
 * `deleted_at` populated so audit logs and abuse forensics survive,
 * and the public history endpoint already filters on `deleted_at IS NULL`.
 */

const messages = schema.chatMessagesTable;
const moderation = schema.chatModerationTable;

const ModerateBodySchema = z.object({
  subjectKind: z.enum(["user", "ip"]),
  subjectId: z.string().min(1).max(256),
  action: z.enum(["mute", "ban"]),
  durationSecs: z.number().int().positive().max(365 * 24 * 60 * 60).nullable().optional(),
  reason: z.string().max(500).optional(),
});

const ModerationRowSchema = z.object({
  id: z.string(),
  subjectKind: z.enum(["user", "ip"]),
  subjectId: z.string(),
  action: z.enum(["mute", "ban"]),
  reason: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});

export async function adminChatRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/chat/messages/:id/delete",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Soft-delete a chat message",
        params: z.object({ id: z.string().min(1) }),
        response: {
          200: z.object({
            ok: z.literal(true),
            id: z.string(),
            deletedAt: z.string(),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const now = new Date();
      const updated = await db
        .update(messages)
        .set({ deletedAt: now, deletedBy: req.principal?.id ?? null })
        .where(eq(messages.id, id))
        .returning({ id: messages.id });
      if (updated.length === 0) throw new NotFoundError(`Chat message ${id} not found`);
      return { ok: true as const, id, deletedAt: now.toISOString() };
    },
  );

  r.post(
    "/chat/moderate",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Mute or ban a user/IP for a finite or indefinite duration",
        body: ModerateBodySchema,
        response: { 200: ModerationRowSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const body = req.body as z.infer<typeof ModerateBodySchema>;
      const expiresAt =
        body.durationSecs && body.durationSecs > 0
          ? new Date(Date.now() + body.durationSecs * 1000)
          : null;
      const id = nanoid();
      const [row] = await db
        .insert(moderation)
        .values({
          id,
          subjectKind: body.subjectKind,
          subjectId: body.subjectId,
          action: body.action,
          reason: body.reason ?? null,
          expiresAt,
          createdBy: req.principal?.id ?? null,
        })
        .returning();
      return {
        id: row!.id,
        subjectKind: row!.subjectKind as "user" | "ip",
        subjectId: row!.subjectId,
        action: row!.action as "mute" | "ban",
        reason: row!.reason,
        expiresAt: row!.expiresAt?.toISOString() ?? null,
        createdAt: row!.createdAt.toISOString(),
        createdBy: row!.createdBy,
      };
    },
  );
}
