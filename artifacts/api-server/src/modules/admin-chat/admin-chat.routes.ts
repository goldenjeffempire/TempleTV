import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { desc, eq, isNull, count } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { NotFoundError } from "../../shared/errors.js";
import { chatHub } from "../realtime/chat.hub.js";
import { TEMPLE_TV_LIVE_CHANNEL } from "../realtime/chat.types.js";

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

const ChatMessageSchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  userName: z.string(),
  message: z.string(),
  createdAt: z.string(),
  isFlagged: z.boolean(),
});

const ChatStatsSchema = z.object({
  totalMessages: z.number(),
  activeUsers: z.number(),
  flaggedCount: z.number(),
});

export async function adminChatRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── GET /admin/chat ─────────────────────────────────────────────────────────
  r.get(
    "/chat",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "List recent chat messages with moderation stats",
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(500).optional(),
        }),
        response: {
          200: z.object({
            messages: z.array(ChatMessageSchema),
            stats: ChatStatsSchema,
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const limit = req.query.limit ?? 100;
      const rows = await db
        .select()
        .from(messages)
        .orderBy(desc(messages.createdAt))
        .limit(limit);

      const [totalRow] = await db
        .select({ total: count() })
        .from(messages)
        .where(isNull(messages.deletedAt));

      const activeUserSet = new Set(rows.filter(r => r.deletedAt == null).map(r => r.userId ?? r.displayName));
      const flaggedCount = rows.filter(r => r.deletedAt != null).length;

      return {
        messages: rows.map((m) => ({
          id: m.id,
          userId: m.userId,
          userName: m.displayName,
          message: m.body,
          createdAt: m.createdAt.toISOString(),
          isFlagged: m.deletedAt != null,
        })),
        stats: {
          totalMessages: totalRow?.total ?? rows.length,
          activeUsers: activeUserSet.size,
          flaggedCount,
        },
      };
    },
  );

  // ── DELETE /admin/chat/:id ───────────────────────────────────────────────────
  r.delete(
    "/chat/:id",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Soft-delete a chat message (DELETE alias)",
        params: z.object({ id: z.string().min(1) }),
        response: { 200: z.object({ ok: z.literal(true), id: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params;
      const now = new Date();
      const updated = await db
        .update(messages)
        .set({ deletedAt: now, deletedBy: req.principal?.id ?? null })
        .where(eq(messages.id, id))
        .returning({ id: messages.id });
      if (updated.length === 0) throw new NotFoundError(`Chat message ${id} not found`);
      chatHub.publishDelete(TEMPLE_TV_LIVE_CHANNEL, id);
      return { ok: true as const, id };
    },
  );

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
      const { id } = req.params;
      const now = new Date();
      const updated = await db
        .update(messages)
        .set({ deletedAt: now, deletedBy: req.principal?.id ?? null })
        .where(eq(messages.id, id))
        .returning({ id: messages.id });
      if (updated.length === 0) throw new NotFoundError(`Chat message ${id} not found`);
      // Fan out to live WS subscribers so the deleted message disappears
      // instantly across every connected admin / TV / web surface.
      chatHub.publishDelete(TEMPLE_TV_LIVE_CHANNEL, id);
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
      const body = req.body;
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
      // Fan out to live WS subscribers so any open client tabs can
      // surface the moderation action without a refresh.
      chatHub.publishModeration(
        TEMPLE_TV_LIVE_CHANNEL,
        body.action,
        body.subjectKind,
        body.subjectId,
        expiresAt ? expiresAt.getTime() : null,
      );
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
