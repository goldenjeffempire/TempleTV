/**
 * Live-chat WebSocket gateway.
 *
 * Mirrors the structure of `playback/wsGateway.ts`: `noServer` mode plugged
 * into the shared http.Server `upgrade` event in `index.ts` so /api/chat/ws
 * shares port, CORS, mTLS and Render's allocation with the REST API.
 *
 * Authentication
 *   Browsers cannot set custom headers on WebSocket open, so we accept the
 *   bearer credential as a query param:
 *     ws://…/api/chat/ws?channel=temple-tv-live&token=<JWT|admin-token>
 *
 *   Resolution order:
 *     1. JWT → signed-in user. `userId` becomes the moderation subject.
 *     2. ADMIN_API_TOKEN → admin/moderator socket; can post + receives
 *        every event but is NEVER rate-limited or duplicate-checked.
 *     3. Anonymous viewer → assigned a random session id and a friendly
 *        "Viewer-XXXX" display name. Moderation subject is the IP hash.
 *
 * Per-client behaviour
 *   1. On open, send `state` frame (recent history + viewer count + your
 *      own identity) so the client paints without a REST round-trip.
 *   2. Subscribe the socket to the chat bus.
 *   3. Inbound `send` frames go through sanitize → profanity-mask →
 *      mute/ban check → rate-limit → dup-check → DB insert → bus publish
 *      → ack.
 *   4. 25s ping/pong heartbeat (Render LB drops idle WS at 60s).
 *   5. Close → unsubscribe, deregister presence, clean timers.
 *
 * Capacity is bounded by `MAX_CHAT_WS_CLIENTS` (default 5000).
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { WebSocketServer, type WebSocket } from "ws";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { buildPlaybackState } from "../playback/playbackEngine";
import { getChatBus } from "./eventBus";
import {
  hashIp,
  isDuplicate,
  lookupModeration,
  maskProfanity,
  sanitizeBody,
  tryConsumeToken,
} from "./moderation";
import { registerPresence, unregisterPresence, getViewerCount } from "./presence";
import { fetchHistory, insertMessage } from "./chatStore";
import { TEMPLE_TV_LIVE_CHANNEL } from "./types";
import type { ChatClientFrame, ChatServerEvent } from "./types";

const MAX_CLIENTS = Math.max(
  16,
  Number(process.env.MAX_CHAT_WS_CLIENTS ?? "5000"),
);
const HEARTBEAT_MS = 25_000;
const PATH = "/api/chat/ws";
const HISTORY_ON_CONNECT = 50;
// Hard-cap inbound frame size so a malicious client can't OOM us with a
// 100 MB "message". 16 KB easily holds a 500-char body with framing.
const MAX_FRAME_BYTES = 16 * 1024;

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: MAX_FRAME_BYTES,
});
let connectedCount = 0;

interface ClientCtx {
  sessionId: string;
  channelId: string;
  userId: string | null;
  displayName: string;
  isModerator: boolean;
  ipHash: string | null;
}

function safeSend(ws: WebSocket, frame: ChatServerEvent): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "chat.ws send failed (client likely gone)",
    );
  }
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function safeAdminTokenEqual(presented: string, configured: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function resolveIdentity(
  req: IncomingMessage,
  url: URL,
): Promise<ClientCtx> {
  const token = url.searchParams.get("token") ?? "";
  const ip = getClientIp(req);
  const ipHash = hashIp(ip);
  const sessionId = randomUUID();
  const channelId = url.searchParams.get("channel") ?? TEMPLE_TV_LIVE_CHANNEL;

  // 2. Admin/moderator token.
  const adminToken = process.env.ADMIN_API_TOKEN?.trim() ?? "";
  if (token && adminToken && safeAdminTokenEqual(token, adminToken)) {
    return {
      sessionId,
      channelId,
      userId: null,
      displayName: "Moderator",
      isModerator: true,
      ipHash,
    };
  }

  // 1. JWT (signed-in user).
  if (token) {
    const secret = process.env.JWT_SECRET;
    if (secret) {
      try {
        const payload = jwt.verify(token, secret) as {
          userId: string;
          typ?: string;
        };
        if (!payload.typ || payload.typ === "access") {
          const [user] = await db
            .select({
              id: usersTable.id,
              displayName: usersTable.displayName,
            })
            .from(usersTable)
            .where(eq(usersTable.id, payload.userId))
            .limit(1);
          if (user) {
            return {
              sessionId,
              channelId,
              userId: user.id,
              displayName: user.displayName ?? "Member",
              isModerator: false,
              ipHash,
            };
          }
        }
      } catch {
        // Fall through to anonymous.
      }
    }
  }

  // 3. Anonymous viewer.
  const tag = sessionId.split("-")[0]!.toUpperCase().slice(0, 4);
  return {
    sessionId,
    channelId,
    userId: null,
    displayName: `Viewer-${tag}`,
    isModerator: false,
    ipHash,
  };
}

async function handleSendFrame(
  ws: WebSocket,
  ctx: ClientCtx,
  frame: Extract<ChatClientFrame, { type: "send" }>,
): Promise<void> {
  // 1. Sanitize.
  const sanitized = sanitizeBody(frame.body);
  if (sanitized.reason === "empty") {
    safeSend(ws, { type: "error", code: "empty", message: "Message is empty." });
    return;
  }
  if (sanitized.reason === "too_long") {
    safeSend(ws, {
      type: "error",
      code: "too_long",
      message: "Message exceeded 500 characters and was clipped.",
    });
    // Still proceed with the clipped body — the spammer-feedback principle
    // says "don't reject, just trim".
  }

  // 2. Profanity mask.
  const body = maskProfanity(sanitized.body);

  // 3. Active mute/ban (skip for moderators).
  if (!ctx.isModerator) {
    const subjectKind: "user" | "ip" = ctx.userId ? "user" : "ip";
    const subjectId = ctx.userId ?? ctx.ipHash ?? ctx.sessionId;
    const decision = await lookupModeration(subjectKind, subjectId);
    if (!decision.ok) {
      safeSend(ws, {
        type: "error",
        code: decision.action === "ban" ? "banned" : "muted",
        message:
          decision.action === "ban"
            ? "Your account has been banned from chat."
            : "You are temporarily muted.",
        retryAtMs: decision.expiresAtMs ?? undefined,
      });
      return;
    }
  }

  // 4. Rate-limit (skip for moderators).
  if (!ctx.isModerator) {
    const bucket = tryConsumeToken(ctx.sessionId);
    if (!bucket.ok) {
      safeSend(ws, {
        type: "error",
        code: "rate_limited",
        message: "You're sending messages too quickly. Slow down.",
        retryAtMs: bucket.retryAtMs,
      });
      return;
    }
    // 5. Duplicate guard.
    if (isDuplicate(ctx.sessionId, body)) {
      safeSend(ws, {
        type: "error",
        code: "duplicate",
        message: "Please don't repeat the same message.",
      });
      return;
    }
  }

  // 6. Snapshot the currently-airing playback item (broadcast-aware context).
  let broadcastItemId: string | null = null;
  let broadcastItemTitle: string | null = null;
  try {
    const state = await buildPlaybackState();
    if (state.current) {
      broadcastItemId = state.current.id;
      broadcastItemTitle = state.current.title;
    }
  } catch {
    // Non-fatal — chat works without a known current item.
  }

  // 7. Insert + fanout.
  try {
    const message = await insertMessage({
      channelId: ctx.channelId,
      userId: ctx.userId,
      displayName: ctx.displayName,
      body,
      broadcastItemId,
      broadcastItemTitle,
      ipHash: ctx.ipHash,
    });
    getChatBus().publish({ type: "message", channelId: ctx.channelId, message });
    safeSend(ws, {
      type: "ack",
      clientMsgId: frame.clientMsgId,
      messageId: message.id,
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "chat.ws insert failed",
    );
    safeSend(ws, {
      type: "error",
      code: "internal",
      message: "Could not deliver your message. Please try again.",
    });
  }
}

wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
  connectedCount += 1;
  let alive = true;

  // Identity.
  const url = new URL(req.url ?? "/", "http://localhost");
  let ctx: ClientCtx;
  try {
    ctx = await resolveIdentity(req, url);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "chat.ws identity resolution failed",
    );
    safeSend(ws, { type: "error", code: "internal", message: "Auth failure." });
    try { ws.close(1011, "auth failure"); } catch { /* noop */ }
    connectedCount -= 1;
    return;
  }

  registerPresence(ctx.channelId, ctx.sessionId);

  // Initial state frame (history + presence + identity echo).
  try {
    const recent = await fetchHistory(ctx.channelId, HISTORY_ON_CONNECT);
    safeSend(ws, {
      type: "state",
      channelId: ctx.channelId,
      recent,
      viewers: getViewerCount(ctx.channelId),
      serverTimeMs: Date.now(),
      you: {
        sessionId: ctx.sessionId,
        displayName: ctx.displayName,
        isModerator: ctx.isModerator,
      },
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "chat.ws initial-state send failed",
    );
  }

  // Subscribe — chat bus events get filtered by channel.
  const unsub = getChatBus().subscribe((event) => {
    // Only forward events for this socket's channel (or unsoped pings/errors).
    if ("channelId" in event && event.channelId !== ctx.channelId) return;
    safeSend(ws, event);
  });

  // Heartbeat.
  const heartbeat = setInterval(() => {
    if (!alive) {
      try { ws.terminate(); } catch { /* noop */ }
      return;
    }
    alive = false;
    try { ws.ping(); } catch { /* noop */ }
    safeSend(ws, { type: "ping", serverTimeMs: Date.now() });
  }, HEARTBEAT_MS);
  heartbeat.unref();

  ws.on("pong", () => {
    alive = true;
  });

  ws.on("message", (raw) => {
    void (async () => {
      let frame: ChatClientFrame;
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        if (text.length > MAX_FRAME_BYTES) {
          safeSend(ws, {
            type: "error",
            code: "too_long",
            message: "Frame exceeds maximum size.",
          });
          return;
        }
        frame = JSON.parse(text) as ChatClientFrame;
      } catch {
        safeSend(ws, {
          type: "error",
          code: "invalid",
          message: "Malformed frame.",
        });
        return;
      }
      if (frame.type === "pong") {
        alive = true;
        return;
      }
      if (frame.type === "send") {
        await handleSendFrame(ws, ctx, frame);
        return;
      }
      safeSend(ws, {
        type: "error",
        code: "invalid",
        message: "Unknown frame type.",
      });
    })();
  });

  ws.on("error", (err) => {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "chat.ws client error",
    );
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    unsub();
    unregisterPresence(ctx.channelId, ctx.sessionId);
    connectedCount -= 1;
  });
});

export function attachChatWs(server: import("node:http").Server): void {
  server.on(
    "upgrade",
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = req.url ?? "";
      const pathOnly = url.split("?")[0];
      if (pathOnly !== PATH) return;

      if (connectedCount >= MAX_CLIENTS) {
        try {
          socket.write(
            "HTTP/1.1 503 Service Unavailable\r\n" +
              "Retry-After: 30\r\n" +
              "Content-Length: 0\r\n" +
              "Connection: close\r\n\r\n",
          );
          socket.destroy();
        } catch { /* noop */ }
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    },
  );
  logger.info(
    { path: PATH, maxClients: MAX_CLIENTS },
    "Chat WebSocket gateway mounted",
  );
}

export function getChatWsStats(): {
  connected: number;
  max: number;
  presence: Record<string, number>;
} {
  return {
    connected: connectedCount,
    max: MAX_CLIENTS,
    presence: getAllPresenceCount(),
  };
}

// Re-export for the diagnostics route.
import { getAllPresence as getAllPresenceCount } from "./presence";
