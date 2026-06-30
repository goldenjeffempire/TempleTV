import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { desc, eq, isNull, isNotNull, count, countDistinct } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { NotFoundError } from "../../shared/errors.js";
import { chatHub } from "../realtime/chat.hub.js";
import { TEMPLE_TV_LIVE_CHANNEL } from "../realtime/chat.types.js";
import type { ChatRole, ChatSettings } from "../realtime/chat.types.js";

const messages = schema.chatMessagesTable;
const moderation = schema.chatModerationTable;
const settings = schema.chatSettingsTable;

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
  role: z.string(),
  isHighlighted: z.boolean(),
});

const ChatStatsSchema = z.object({
  totalMessages: z.number(),
  activeUsers: z.number(),
  flaggedCount: z.number(),
});

const ChatSettingsSchema = z.object({
  channelId: z.string(),
  slowModeSecs: z.number().int().min(0).max(3600),
  subscriberOnly: z.boolean(),
  pinnedMessageId: z.string().nullable(),
  bannedKeywords: z.array(z.string()),
  updatedAt: z.string(),
});

const UpdateSettingsBodySchema = z.object({
  slowModeSecs: z.number().int().min(0).max(3600).optional(),
  subscriberOnly: z.boolean().optional(),
  bannedKeywords: z.array(z.string().max(100)).max(200).optional(),
});

export async function adminChatRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── GET /admin/chat ──────────────────────────────────────────────────────────
  r.get(
    "/chat",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "List recent chat messages with moderation stats",
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
        response: {
          200: z.object({ messages: z.array(ChatMessageSchema), stats: ChatStatsSchema }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const limit = req.query.limit ?? 100;
      const offset = req.query.offset ?? 0;
      const rows = await db
        .select()
        .from(messages)
        .orderBy(desc(messages.createdAt))
        .limit(limit)
        .offset(offset);

      const [totalRow] = await db
        .select({ total: count() })
        .from(messages)
        .where(isNull(messages.deletedAt));
      const [activeUsersRow] = await db
        .select({ count: countDistinct(messages.userId) })
        .from(messages)
        .where(isNull(messages.deletedAt));
      const [flaggedRow] = await db
        .select({ count: count() })
        .from(messages)
        .where(isNotNull(messages.deletedAt));

      return {
        messages: rows.map((m) => ({
          id: m.id,
          userId: m.userId,
          userName: m.displayName,
          message: m.body,
          createdAt: m.createdAt.toISOString(),
          isFlagged: m.deletedAt != null,
          role: m.role ?? "user",
          isHighlighted: m.isHighlighted,
        })),
        stats: {
          totalMessages: totalRow?.total ?? rows.length,
          activeUsers: activeUsersRow?.count ?? 0,
          flaggedCount: flaggedRow?.count ?? 0,
        },
      };
    },
  );

  // ── GET /admin/chat/settings ─────────────────────────────────────────────────
  r.get(
    "/chat/settings",
    {
      preHandler: requireAuth("editor"),
      schema: {
        tags: ["admin"],
        summary: "Get broadcast chat settings for the live channel",
        querystring: z.object({
          channelId: z.string().default(TEMPLE_TV_LIVE_CHANNEL),
        }),
        response: { 200: ChatSettingsSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const channelId = req.query.channelId;
      const rows = await db
        .select()
        .from(settings)
        .where(eq(settings.channelId, channelId))
        .limit(1);
      if (rows[0]) {
        return {
          channelId: rows[0].channelId,
          slowModeSecs: rows[0].slowModeSecs,
          subscriberOnly: rows[0].subscriberOnly,
          pinnedMessageId: rows[0].pinnedMessageId,
          bannedKeywords: (rows[0].bannedKeywords as string[]) ?? [],
          updatedAt: rows[0].updatedAt?.toISOString() ?? new Date().toISOString(),
        };
      }
      return {
        channelId,
        slowModeSecs: 0,
        subscriberOnly: false,
        pinnedMessageId: null,
        bannedKeywords: [],
        updatedAt: new Date().toISOString(),
      };
    },
  );

  // ── PATCH /admin/chat/settings ───────────────────────────────────────────────
  r.patch(
    "/chat/settings",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Update broadcast chat settings (slow mode, subscriber-only, keyword bans)",
        querystring: z.object({ channelId: z.string().default(TEMPLE_TV_LIVE_CHANNEL) }),
        body: UpdateSettingsBodySchema,
        response: { 200: ChatSettingsSchema, 429: z.object({ error: z.string() }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const channelId = req.query.channelId;
      const now = new Date();

      // Upsert
      const existing = await db
        .select()
        .from(settings)
        .where(eq(settings.channelId, channelId))
        .limit(1);

      let updated: typeof settings.$inferSelect;
      if (existing[0]) {
        const [row] = await db
          .update(settings)
          .set({
            ...(req.body.slowModeSecs !== undefined && { slowModeSecs: req.body.slowModeSecs }),
            ...(req.body.subscriberOnly !== undefined && { subscriberOnly: req.body.subscriberOnly }),
            ...(req.body.bannedKeywords !== undefined && { bannedKeywords: req.body.bannedKeywords }),
            updatedAt: now,
          })
          .where(eq(settings.channelId, channelId))
          .returning();
        updated = row!;
      } else {
        const [row] = await db
          .insert(settings)
          .values({
            channelId,
            slowModeSecs: req.body.slowModeSecs ?? 0,
            subscriberOnly: req.body.subscriberOnly ?? false,
            bannedKeywords: req.body.bannedKeywords ?? [],
            updatedAt: now,
          })
          .returning();
        updated = row!;
      }

      const newSettings: ChatSettings = {
        slowModeSecs: updated.slowModeSecs,
        subscriberOnly: updated.subscriberOnly,
        pinnedMessageId: updated.pinnedMessageId,
        bannedKeywords: (updated.bannedKeywords as string[]) ?? [],
      };
      // Update hub cache and broadcast to all connected clients
      chatHub.updateSettings(channelId, newSettings, true);

      return {
        channelId: updated.channelId,
        slowModeSecs: updated.slowModeSecs,
        subscriberOnly: updated.subscriberOnly,
        pinnedMessageId: updated.pinnedMessageId,
        bannedKeywords: (updated.bannedKeywords as string[]) ?? [],
        updatedAt: updated.updatedAt.toISOString(),
      };
    },
  );

  // ── DELETE /admin/chat/:id (RESTful soft-delete alias) ──────────────────────
  r.delete(
    "/chat/:id",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Soft-delete a chat message (RESTful alias)",
        params: z.object({ id: z.string().min(1) }),
        response: {
          200: z.object({ ok: z.literal(true), id: z.string(), deletedAt: z.string() }),
          429: z.object({ error: z.string() }),
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
      chatHub.publishDelete(TEMPLE_TV_LIVE_CHANNEL, id);
      return { ok: true as const, id, deletedAt: now.toISOString() };
    },
  );

  // ── POST /admin/chat/messages/:id/delete ────────────────────────────────────
  r.post(
    "/chat/messages/:id/delete",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Soft-delete a chat message",
        params: z.object({ id: z.string().min(1) }),
        response: {
          200: z.object({ ok: z.literal(true), id: z.string(), deletedAt: z.string() }),
          429: z.object({ error: z.string() }),
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
      chatHub.publishDelete(TEMPLE_TV_LIVE_CHANNEL, id);
      return { ok: true as const, id, deletedAt: now.toISOString() };
    },
  );

  // ── POST /admin/chat/messages/:id/pin ────────────────────────────────────────
  r.post(
    "/chat/messages/:id/pin",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Pin a message so it appears prominently for all viewers",
        params: z.object({ id: z.string().min(1) }),
        querystring: z.object({ channelId: z.string().default(TEMPLE_TV_LIVE_CHANNEL) }),
        response: {
          200: z.object({ ok: z.literal(true), pinnedMessageId: z.string() }),
          404: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params;
      const channelId = req.query.channelId;

      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.id, id))
        .limit(1);
      if (!rows[0] || rows[0].deletedAt) throw new NotFoundError(`Chat message ${id} not found or deleted`);

      const msg = rows[0];
      const dto = {
        id: msg.id,
        channelId: msg.channelId,
        userId: msg.userId,
        displayName: msg.displayName,
        body: msg.body,
        createdAtMs: msg.createdAt.getTime(),
        broadcastItemId: msg.broadcastItemId,
        broadcastItemTitle: msg.broadcastItemTitle,
        role: (msg.role ?? "user") as ChatRole,
        isHighlighted: msg.isHighlighted,
        reactions: chatHub.getReactions(id),
      };

      // Update settings row with the new pinned message ID
      const now = new Date();
      await db
        .insert(settings)
        .values({ channelId, pinnedMessageId: id, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.channelId,
          set: { pinnedMessageId: id, updatedAt: now },
        });

      // Update hub cache, broadcast pin frame to all clients
      chatHub.setPinnedMessage(channelId, dto, true);
      // Also update hub's settings cache
      const currentSettings = chatHub.getSettings(channelId);
      chatHub.updateSettings(channelId, { ...currentSettings, pinnedMessageId: id }, false);

      return { ok: true as const, pinnedMessageId: id };
    },
  );

  // ── DELETE /admin/chat/messages/pin ─────────────────────────────────────────
  r.delete(
    "/chat/messages/pin",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Unpin the current pinned message",
        querystring: z.object({ channelId: z.string().default(TEMPLE_TV_LIVE_CHANNEL) }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const channelId = req.query.channelId;
      const now = new Date();
      await db
        .insert(settings)
        .values({ channelId, pinnedMessageId: null, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.channelId,
          set: { pinnedMessageId: null, updatedAt: now },
        });

      chatHub.setPinnedMessage(channelId, null, true);
      const currentSettings = chatHub.getSettings(channelId);
      chatHub.updateSettings(channelId, { ...currentSettings, pinnedMessageId: null }, false);

      return { ok: true as const };
    },
  );

  // ── POST /admin/chat/messages/:id/highlight ──────────────────────────────────
  r.post(
    "/chat/messages/:id/highlight",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Toggle the highlighted state of a message",
        params: z.object({ id: z.string().min(1) }),
        body: z.object({ highlighted: z.boolean() }),
        response: {
          200: z.object({ ok: z.literal(true), id: z.string(), isHighlighted: z.boolean() }),
          404: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params;
      const updated = await db
        .update(messages)
        .set({ isHighlighted: req.body.highlighted })
        .where(eq(messages.id, id))
        .returning({ id: messages.id, channelId: messages.channelId, isHighlighted: messages.isHighlighted });
      if (updated.length === 0) throw new NotFoundError(`Chat message ${id} not found`);
      const row = updated[0]!;

      // Broadcast the updated message to refresh clients. Load full row.
      try {
        const fullRows = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
        if (fullRows[0]) {
          const dto = {
            id: fullRows[0].id,
            channelId: fullRows[0].channelId,
            userId: fullRows[0].userId,
            displayName: fullRows[0].displayName,
            body: fullRows[0].body,
            createdAtMs: fullRows[0].createdAt.getTime(),
            broadcastItemId: fullRows[0].broadcastItemId,
            broadcastItemTitle: fullRows[0].broadcastItemTitle,
            role: (fullRows[0].role ?? "user") as ChatRole,
            isHighlighted: fullRows[0].isHighlighted,
            reactions: chatHub.getReactions(id),
          };
          // Re-publish as a message frame so clients can update the row in place
          chatHub.publishMessage(row.channelId, dto);
        }
      } catch { /* noop — highlight still saved */ }

      return { ok: true as const, id: row.id, isHighlighted: row.isHighlighted };
    },
  );

  // ── POST /admin/chat/moderate ────────────────────────────────────────────────
  r.post(
    "/chat/moderate",
    {
      preHandler: requireAuth("editor"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["admin"],
        summary: "Mute or ban a user/IP for a finite or indefinite duration",
        body: ModerateBodySchema,
        response: { 200: ModerationRowSchema, 429: z.object({ error: z.string() }) },
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
