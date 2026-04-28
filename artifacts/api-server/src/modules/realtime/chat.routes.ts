import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth } from "../../middleware/auth.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";

const chat = schema.chatMessagesTable;

const ChatMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  userId: z.string().nullable(),
  displayName: z.string(),
  body: z.string(),
  broadcastItemId: z.string().nullable(),
  broadcastItemTitle: z.string().nullable(),
  createdAt: z.string(),
});

const PostChatBodySchema = z.object({
  body: z.string().min(1).max(500),
});

const ChatHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(),
});

export async function chatRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/:channelId/history",
    {
      schema: {
        tags: ["chat"],
        summary: "Recent chat messages for a channel",
        params: z.object({ channelId: z.string() }),
        querystring: ChatHistoryQuerySchema,
        response: {
          200: z.object({
            messages: z.array(ChatMessageSchema),
          }),
        },
      },
    },
    async (req) => {
      const conditions = [
        eq(chat.channelId, req.params.channelId),
        isNull(chat.deletedAt),
      ];
      if (req.query.before) {
        conditions.push(lt(chat.createdAt, new Date(req.query.before)));
      }
      const rows = await db
        .select()
        .from(chat)
        .where(and(...conditions))
        .orderBy(desc(chat.createdAt))
        .limit(req.query.limit);

      return {
        messages: rows.map((m) => ({
          id: m.id,
          channelId: m.channelId,
          userId: m.userId,
          displayName: m.displayName,
          body: m.body,
          broadcastItemId: m.broadcastItemId,
          broadcastItemTitle: m.broadcastItemTitle,
          createdAt: m.createdAt.toISOString(),
        })),
      };
    },
  );

  r.post(
    "/:channelId/messages",
    {
      preHandler: requireAuth("user"),
      schema: {
        tags: ["chat"],
        summary: "Post a chat message to a channel",
        params: z.object({ channelId: z.string() }),
        body: PostChatBodySchema,
        security: [{ bearerAuth: [] }],
        response: { 201: ChatMessageSchema },
      },
    },
    async (req, reply) => {
      const principal = req.principal!;
      const snap = broadcastEngine.snapshot();
      const inserted = await db
        .insert(chat)
        .values({
          id: nanoid(),
          channelId: req.params.channelId,
          userId: principal.id,
          displayName: principal.email.split("@")[0] ?? "viewer",
          body: req.body.body,
          broadcastItemId: snap.current?.id ?? null,
          broadcastItemTitle: snap.current?.title ?? null,
        })
        .returning();
      const m = inserted[0]!;
      reply.code(201);
      return {
        id: m.id,
        channelId: m.channelId,
        userId: m.userId,
        displayName: m.displayName,
        body: m.body,
        broadcastItemId: m.broadcastItemId,
        broadcastItemTitle: m.broadcastItemTitle,
        createdAt: m.createdAt.toISOString(),
      };
    },
  );
}
