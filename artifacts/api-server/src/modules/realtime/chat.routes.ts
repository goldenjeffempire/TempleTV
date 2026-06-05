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
  ChatServerEvent,
} from "./chat.types.js";

const chat = schema.chatMessagesTable;
const moderation = schema.chatModerationTable;

const ChatMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  userId: z.string().nullable(),
  displayName: z.string(),
  body: z.string(),
  broadcastItemId: z.string().nullable(),
  broadcastItemTitle: z.string().nullable(),
  // `createdAtMs` (epoch ms) matches the shape sent over WebSocket via rowToDto().
  // Legacy field name was `createdAt` (ISO string) — normalized here so REST
  // and WS history have the same structure and mobile/TV clients don't need
  // format-branching logic.
  createdAtMs: z.number().int().nonnegative(),
});

const PostChatBodySchema = z.object({
  body: z.string().min(1).max(500),
});

const ChatHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(),
});

/** Truncated SHA-256 of the connecting IP — see schema doc for rationale. */
function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

/** Pick a friendly default name for anonymous viewers. */
function guestName(sessionId: string): string {
  return `Guest-${sessionId.slice(0, 4).toUpperCase()}`;
}

/**
 * Look up active moderation for any of (userId, ipHash). Returns the
 * most-restrictive action (`ban` > `mute`) currently in force, or null.
 */
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
    .select({
      action: moderation.action,
      expiresAt: moderation.expiresAt,
    })
    .from(moderation)
    .where(
      and(
        subjectOr,
        or(isNull(moderation.expiresAt), gt(moderation.expiresAt, now)),
      ),
    );
  if (rows.length === 0) return null;
  // Prefer ban over mute when both present.
  const ban = rows.find((r) => r.action === "ban");
  const pick = ban ?? rows[0]!;
  return {
    action: pick.action as "mute" | "ban",
    expiresAtMs: pick.expiresAt ? pick.expiresAt.getTime() : null,
  };
}

/** Resolve identity from a query-string `token` (JWT or admin token). */
async function resolveWsIdentity(token: string | null): Promise<{
  userId: string | null;
  email: string | null;
  isModerator: boolean;
}> {
  if (!token) return { userId: null, email: null, isModerator: false };
  if (env.ADMIN_API_TOKEN && safeStringEqual(token, env.ADMIN_API_TOKEN)) {
    return { userId: "system:admin-token", email: "system@temple.tv", isModerator: true };
  }
  try {
    const decoded = await verifyAccessToken(token);
    return {
      userId: decoded.sub,
      email: decoded.email,
      isModerator: decoded.role === "editor" || decoded.role === "admin" || decoded.role === "system",
    };
  } catch {
    return { userId: null, email: null, isModerator: false };
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
  };
}

function safeSend(socket: ChatSocket, event: ChatServerEvent): void {
  try {
    if (socket.readyState === 1) socket.send(JSON.stringify(event));
  } catch {
    /* ignore — close handler runs */
  }
}

/**
 * Server-initiated keep-alive ping fanout. Single shared interval rather
 * than one per socket — avoids leaking timers when sockets disconnect
 * uncleanly. Started lazily on first WS connect.
 *
 * chatHub.pingAll() also sweeps zombie members (no pong in >60 s) and calls
 * socket.terminate() on them, so the interval does double duty as a cleanup
 * sweep — preventing half-open sockets from accumulating without bound.
 */
let pingInterval: ReturnType<typeof setInterval> | null = null;
function ensurePingLoop(): void {
  if (pingInterval) return;
  pingInterval = setInterval(() => chatHub.pingAll(), 25_000);
  // Don't keep the event loop alive just for pings.
  pingInterval.unref?.();
}

/**
 * Stop the chat ping/sweep interval.
 * Called during graceful shutdown so the timer does not keep the event loop
 * alive after all other subsystems have stopped.
 */
export function stopChatPingInterval(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

export async function chatRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/:channelId/history",
    {
      schema: {
        tags: ["chat"],
        summary: "Recent chat messages for a channel",
        params: z.object({ channelId: z.string().min(1).max(128) }),
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
          // Normalized to epoch-ms to match the `createdAtMs` field sent
          // over WebSocket. Previously this returned ISO string `createdAt`.
          createdAtMs: m.createdAt.getTime(),
        })),
      };
    },
  );

  r.post(
    "/:channelId/messages",
    {
      preHandler: requireAuth("user"),
      // 20/min per user prevents chat spam while staying comfortable for
      // legitimate rapid-fire responses during a live service.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["chat"],
        summary: "Post a chat message to a channel",
        params: z.object({ channelId: z.string().min(1).max(128) }),
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
      // Mirror to any live WS subscribers so REST-posted messages also
      // appear in real time.
      chatHub.publishMessage(m.channelId, rowToDto(m));
      reply.code(201);
      return {
        id: m.id,
        channelId: m.channelId,
        userId: m.userId,
        displayName: m.displayName,
        body: m.body,
        broadcastItemId: m.broadcastItemId,
        broadcastItemTitle: m.broadcastItemTitle,
        createdAtMs: m.createdAt.getTime(),
      };
    },
  );

  // ── WebSocket gateway ────────────────────────────────────────────────────
  // Persistent two-way chat channel. The browser-side `ChatClient`
  // (admin + TV) connects to `/api/chat/ws?channel=...&token=...`.
  // Frame contract lives in `chat.types.ts` and is mirrored verbatim in
  // both SPAs.
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
      const displayName =
        identity.email?.split("@")[0] || guestName(sessionId);

      const member: RoomMember = createMember({
        socket,
        sessionId,
        displayName,
        userId: identity.userId,
        isModerator: identity.isModerator,
        ipHash,
      });

      // Read recent history once on connect so the client doesn't need
      // a separate REST round-trip.
      let recent: ChatMessageDto[] = [];
      try {
        const rows = await db
          .select()
          .from(chat)
          .where(and(eq(chat.channelId, channelId), isNull(chat.deletedAt)))
          .orderBy(desc(chat.createdAt))
          .limit(50);
        // Oldest → newest so the client renders in natural order.
        recent = rows.reverse().map(rowToDto);
      } catch (err) {
        req.log.error({ err }, "chat ws: failed to load history");
      }

      // Register cleanup BEFORE joining the hub so that if the socket fires
      // a close/error event during or after the async DB history query (above),
      // the member is always removed from the room — preventing a permanent
      // viewer-count leak when clients drop during the connection handshake.
      const cleanup = () => {
        chatHub.leave(channelId, member);
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);

      const { viewers } = chatHub.join(channelId, member);

      safeSend(socket, {
        type: "state",
        channelId,
        recent,
        viewers,
        serverTimeMs: Date.now(),
        you: {
          sessionId: member.sessionId,
          displayName: member.displayName,
          isModerator: member.isModerator,
        },
      });

      socket.on("message", async (raw: Buffer | string) => {
        let frame: ChatClientFrame;
        try {
          frame = JSON.parse(raw.toString()) as ChatClientFrame;
        } catch {
          return;
        }
        if (frame.type === "pong") {
          // Update liveness timestamp so the zombie sweep in pingAll() does
          // not terminate this member before the next cleanup cycle.
          member.lastPongMs = Date.now();
          return;
        }
        if (frame.type !== "send") return;

        const body = (frame.body ?? "").trim();
        if (!body) {
          safeSend(socket, {
            type: "error",
            code: "empty",
            message: "Message body is empty.",
          });
          return;
        }
        if (body.length > 500) {
          safeSend(socket, {
            type: "error",
            code: "too_long",
            message: "Message exceeds 500 characters.",
          });
          return;
        }

        // Token-bucket per socket. Cheap first line of defense; the DB-
        // backed moderation check below is the durable one.
        if (!chatHub.consumeSendToken(member)) {
          safeSend(socket, {
            type: "error",
            code: "rate_limited",
            message: "You're sending messages too quickly.",
            retryAtMs: chatHub.retryAtMs(member),
          });
          return;
        }

        // Active mute / ban check.
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
            })
            .returning();
          const row = inserted[0]!;
          const dto = rowToDto(row);
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
