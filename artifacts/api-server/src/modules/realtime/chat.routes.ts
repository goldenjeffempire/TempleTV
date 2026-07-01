import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, desc, eq, isNull, lt, gt, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "../../infrastructure/db.js";
import { requireAuth, safeStringEqual } from "../../middleware/auth.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { verifyAccessToken } from "../auth/jwt.js";
import { env } from "../../config/env.js";
import {
  chatHub,
  createMember,
  type ChatSocket,
  type RoomMember,
} from "./chat.hub.js";
import type {
  ChatClientFrame,
  ChatMessage as ChatMessageDto,
  ChatRole,
  ChatServerEvent,
  ChatSettings,
} from "./chat.types.js";

const chat = schema.chatMessagesTable;
const moderation = schema.chatModerationTable;

const ChatMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  userId: z.string().nullable(),
  displayName: z.string(),
  body: z.string(),
  createdAtMs: z.number().int().nonnegative(),
  broadcastItemId: z.string().nullable(),
  broadcastItemTitle: z.string().nullable(),
  role: z.string(),
  isHighlighted: z.boolean(),
  reactions: z.record(z.number()),
});

const PostChatBodySchema = z.object({
  body: z.string().min(1).max(500),
});

const ChatHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).default(50).catch(50).transform((v) => Math.min(v, 200)),
  before: z.string().datetime().optional(),
});

function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

function guestName(sessionId: string): string {
  return `Guest-${sessionId.slice(0, 4).toUpperCase()}`;
}

/** Map JWT role to the ChatRole discriminant used in frame DTOs. */
function jwtRoleToChatRole(jwtRole: string | null | undefined): ChatRole {
  if (!jwtRole) return "guest";
  if (jwtRole === "system" || jwtRole === "admin" || jwtRole === "editor") return "admin";
  if (jwtRole === "moderator") return "mod";
  return "user";
}

async function lookupActiveModeration(
  userId: string | null,
  ipHash: string | null,
): Promise<{ action: "mute" | "ban"; expiresAtMs: number | null } | null> {
  const subjects: { kind: "user" | "ip"; id: string }[] = [];
  if (userId) subjects.push({ kind: "user", id: userId });
  if (ipHash) subjects.push({ kind: "ip", id: ipHash });
  if (subjects.length === 0) return null;

  const subjectFilters = subjects.map((s) =>
    and(eq(moderation.subjectKind, s.kind), eq(moderation.subjectId, s.id)),
  );
  const subjectOr = subjectFilters.length === 1 ? subjectFilters[0] : or(...subjectFilters);
  const now = new Date();
  const rows = await db
    .select({ action: moderation.action, expiresAt: moderation.expiresAt })
    .from(moderation)
    .where(and(subjectOr, or(isNull(moderation.expiresAt), gt(moderation.expiresAt, now))));
  if (rows.length === 0) return null;
  const ban = rows.find((r) => r.action === "ban");
  const pick = ban ?? rows[0]!;
  return {
    action: pick.action as "mute" | "ban",
    expiresAtMs: pick.expiresAt ? pick.expiresAt.getTime() : null,
  };
}

async function resolveWsIdentity(token: string | null): Promise<{
  userId: string | null;
  email: string | null;
  isModerator: boolean;
  role: ChatRole;
  jwtRole: string | null;
}> {
  if (!token) return { userId: null, email: null, isModerator: false, role: "guest", jwtRole: null };
  if (env.ADMIN_API_TOKEN && safeStringEqual(token, env.ADMIN_API_TOKEN)) {
    return { userId: "system:admin-token", email: "system@temple.tv", isModerator: true, role: "admin", jwtRole: "admin" };
  }
  try {
    const decoded = await verifyAccessToken(token);
    const role = jwtRoleToChatRole(decoded.role);
    return {
      userId: decoded.sub,
      email: decoded.email,
      isModerator: role === "admin" || role === "mod",
      role,
      jwtRole: decoded.role ?? null,
    };
  } catch {
    return { userId: null, email: null, isModerator: false, role: "guest", jwtRole: null };
  }
}

function rowToDto(row: typeof chat.$inferSelect): ChatMessageDto {
  return {
    id: row.id,
    channelId: row.channelId,
    userId: row.userId,
    displayName: row.displayName,
    body: row.body,
    createdAtMs: row.createdAt.getTime(),
    broadcastItemId: row.broadcastItemId,
    broadcastItemTitle: row.broadcastItemTitle,
    role: (row.role ?? "user") as ChatRole,
    isHighlighted: row.isHighlighted,
    reactions: {},
  };
}

function safeSend(socket: ChatSocket, event: ChatServerEvent): void {
  try {
    if (socket.readyState === 1) socket.send(JSON.stringify(event));
  } catch { /* ignore — close handler runs */ }
}

let pingInterval: ReturnType<typeof setInterval> | null = null;
function ensurePingLoop(): void {
  if (pingInterval) return;
  pingInterval = setInterval(() => chatHub.pingAll(), 25_000);
  pingInterval.unref?.();
}

export function stopChatPingInterval(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

/** Load channel settings from DB and warm the ChatHub cache (no broadcast). */
async function loadChannelSettings(channelId: string): Promise<ChatSettings> {
  try {
    const rows = await db
      .select()
      .from(schema.chatSettingsTable)
      .where(eq(schema.chatSettingsTable.channelId, channelId))
      .limit(1);
    if (rows[0]) {
      const s: ChatSettings = {
        slowModeSecs: rows[0].slowModeSecs,
        subscriberOnly: rows[0].subscriberOnly,
        pinnedMessageId: rows[0].pinnedMessageId,
        bannedKeywords: (rows[0].bannedKeywords as string[]) ?? [],
      };
      chatHub.updateSettings(channelId, s, false);
      return s;
    }
  } catch {
    /* table may not exist pre-migration — use defaults */
  }
  return chatHub.getSettings(channelId);
}

/** Load pinned message from DB and warm the ChatHub cache (no broadcast). */
async function loadPinnedMessage(
  channelId: string,
  pinnedMessageId: string | null,
): Promise<ChatMessageDto | null> {
  if (!pinnedMessageId) return chatHub.getPinnedMessage(channelId);
  const cached = chatHub.getPinnedMessage(channelId);
  if (cached?.id === pinnedMessageId) return cached;
  try {
    const rows = await db
      .select()
      .from(chat)
      .where(and(eq(chat.id, pinnedMessageId), isNull(chat.deletedAt)))
      .limit(1);
    if (rows[0]) {
      const dto = rowToDto(rows[0]);
      chatHub.setPinnedMessage(channelId, dto, false);
      return dto;
    }
  } catch { /* noop */ }
  return null;
}

export async function chatRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/:channelId/history",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["chat"],
        summary: "Recent chat messages for a channel",
        params: z.object({ channelId: z.string().min(1).max(128) }),
        querystring: ChatHistoryQuerySchema,
        response: {
          200: z.object({ messages: z.array(ChatMessageSchema) }),
          429: z.object({ error: z.string() }),
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
      return { messages: rows.map(rowToDto) };
    },
  );

  r.post(
    "/:channelId/messages",
    {
      preHandler: requireAuth("user"),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["chat"],
        summary: "Post a chat message to a channel",
        params: z.object({ channelId: z.string().min(1).max(128) }),
        body: PostChatBodySchema,
        security: [{ bearerAuth: [] }],
        response: { 201: ChatMessageSchema, 429: z.object({ error: z.string() }) },
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
          role: "user",
          isHighlighted: false,
        })
        .returning();
      const m = inserted[0]!;
      chatHub.publishMessage(m.channelId, rowToDto(m));
      reply.code(201);
      return rowToDto(m);
    },
  );

  // ── WebSocket gateway ──────────────────────────────────────────────────────
  app.get(
    "/ws",
    { websocket: true },
    async (socket, req: FastifyRequest) => {
      ensurePingLoop();

      const url = new URL(req.url ?? "/", "http://localhost");
      const channelId = url.searchParams.get("channel") || "temple-tv-live";
      const token = url.searchParams.get("token");

      const identity = await resolveWsIdentity(token);
      const sessionId = nanoid(12);
      const ipHash = hashIp(req.ip);
      const displayName = identity.email?.split("@")[0] || guestName(sessionId);

      // Load channel settings (warms hub cache; no broadcast)
      const settings = await loadChannelSettings(channelId);
      // Load pinned message (warms hub cache; no broadcast)
      const pinnedMessage = await loadPinnedMessage(channelId, settings.pinnedMessageId);

      const member: RoomMember = createMember({
        socket,
        sessionId,
        displayName,
        userId: identity.userId,
        isModerator: identity.isModerator,
        role: identity.role,
        ipHash,
      });

      // Load recent history
      let recent: ChatMessageDto[] = [];
      try {
        const rows = await db
          .select()
          .from(chat)
          .where(and(eq(chat.channelId, channelId), isNull(chat.deletedAt)))
          .orderBy(desc(chat.createdAt))
          .limit(50);
        recent = rows.reverse().map(rowToDto);
      } catch (err) {
        req.log.error({ err }, "chat ws: failed to load history");
      }

      const cleanup = () => { chatHub.leave(channelId, member); };
      socket.on("close", cleanup);
      socket.on("error", cleanup);

      let viewers: number;
      try {
        ({ viewers } = chatHub.join(channelId, member));
      } catch {
        socket.close(1013);
        req.log.warn({ channelId }, "chat ws: hub at capacity, rejecting join");
        return;
      }

      safeSend(socket, {
        type: "state",
        channelId,
        recent,
        viewers,
        serverTimeMs: Date.now(),
        settings,
        pinnedMessage,
        you: {
          sessionId: member.sessionId,
          displayName: member.displayName,
          isModerator: member.isModerator,
          role: member.role,
        },
      });

      socket.on("message", async (raw: Buffer | string) => {
        let frame: ChatClientFrame;
        try {
          frame = JSON.parse(raw.toString()) as ChatClientFrame;
        } catch { return; }

        // ── pong ──────────────────────────────────────────────────────────────
        if (frame.type === "pong") {
          member.lastPongMs = Date.now();
          return;
        }

        // ── react ─────────────────────────────────────────────────────────────
        if (frame.type === "react") {
          const { messageId, emoji } = frame;
          if (!messageId || !emoji || emoji.length > 8) return;
          const userKey = member.userId ?? member.sessionId;
          chatHub.toggleReaction(channelId, messageId, emoji, userKey);
          return;
        }

        if (frame.type !== "send") return;

        // ── send ──────────────────────────────────────────────────────────────
        let body = (frame.body ?? "").trim();
        if (!body) {
          safeSend(socket, { type: "error", code: "empty", message: "Message body is empty." });
          return;
        }
        if (body.length > 500) {
          safeSend(socket, { type: "error", code: "too_long", message: "Message exceeds 500 characters." });
          return;
        }

        // Normalise ALL-CAPS before any other check
        body = chatHub.normaliseCaps(body);

        // Subscriber-only gate
        const ch = chatHub.getSettings(channelId);
        if (ch.subscriberOnly && !member.userId) {
          safeSend(socket, {
            type: "error",
            code: "subscriber_only",
            message: "Only signed-in viewers can chat right now.",
          });
          return;
        }

        // Slow-mode check
        const slowRemaining = chatHub.slowModeRemainingS(member, ch.slowModeSecs);
        if (slowRemaining > 0) {
          safeSend(socket, {
            type: "error",
            code: "slow_mode",
            message: `Slow mode is on — wait ${slowRemaining}s before sending again.`,
            retryAtMs: member.lastSentAtMs + ch.slowModeSecs * 1000,
          });
          return;
        }

        // Keyword ban
        const matchedKw = chatHub.matchesBannedKeyword(body, ch.bannedKeywords);
        if (matchedKw) {
          safeSend(socket, {
            type: "error",
            code: "blocked",
            message: "Your message contains a blocked word.",
          });
          return;
        }

        // Duplicate detection
        if (chatHub.isDuplicate(member, body)) {
          safeSend(socket, {
            type: "error",
            code: "duplicate",
            message: "Please don't repeat the same message.",
          });
          return;
        }

        // Token-bucket rate limit
        if (!chatHub.consumeSendToken(member)) {
          safeSend(socket, {
            type: "error",
            code: "rate_limited",
            message: "You're sending messages too quickly.",
            retryAtMs: chatHub.retryAtMs(member),
          });
          return;
        }

        // Active mute / ban
        try {
          const block = await lookupActiveModeration(member.userId, member.ipHash);
          if (block) {
            safeSend(socket, {
              type: "error",
              code: block.action === "ban" ? "banned" : "muted",
              message:
                block.action === "ban"
                  ? "You have been banned from this chat."
                  : "You are currently muted in this chat.",
              retryAtMs: block.expiresAtMs ?? undefined,
            });
            return;
          }
        } catch (err) {
          req.log.error({ err }, "chat ws: moderation lookup failed");
        }

        const snap = broadcastEngine.snapshot();
        const id = nanoid();
        try {
          const inserted = await db
            .insert(chat)
            .values({
              id,
              channelId,
              userId: member.userId,
              displayName: member.displayName,
              body,
              broadcastItemId: snap.current?.id ?? null,
              broadcastItemTitle: snap.current?.title ?? null,
              ipHash: member.ipHash,
              role: member.role,
              isHighlighted: false,
            })
            .returning();
          const row = inserted[0]!;
          const dto = rowToDto(row);
          chatHub.recordSend(member, body);
          safeSend(socket, { type: "ack", clientMsgId: frame.clientMsgId, messageId: row.id });
          chatHub.publishMessage(channelId, dto);
        } catch (err) {
          req.log.error({ err }, "chat ws: insert failed");
          safeSend(socket, {
            type: "error",
            code: "internal",
            message: "Could not save your message — please try again.",
          });
        }
      });
    },
  );
}
