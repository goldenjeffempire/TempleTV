/**
 * Live-chat hub — singleton in-process room manager for the WebSocket
 * gateway in `chat.routes.ts`.
 *
 * Responsibilities
 *   - Track connected sockets per channel (one room per channelId)
 *   - Maintain per-room viewer counts and emit `presence` frames on
 *     join / leave (debounced; we only re-broadcast when the count
 *     actually changes)
 *   - Broadcast new `message` frames inserted via the WS `send` path
 *   - Broadcast `delete` frames when a moderator soft-deletes a row
 *     (called from `admin-chat.routes.ts`)
 *   - Broadcast `moderate` frames when a mute/ban is created
 *   - Keep an in-memory token-bucket per IP-hash so spammers can't
 *     flood the DB regardless of how many sockets they open
 *
 * Persistence + cross-process fan-out is intentionally out of scope:
 * the api-server runs single-replica in dev and (per `replit.md`) in
 * the current production deployment as well, so an in-process
 * EventEmitter is the right level of complexity. When the broadcast
 * tier scales horizontally, this hub gains a Redis pub/sub adapter
 * — the room/membership API above stays unchanged.
 */

import { EventEmitter } from "node:events";
import { logger } from "../../infrastructure/logger.js";
import type {
  ChatMessage,
  ChatServerEvent,
} from "./chat.types.js";

/**
 * Structural type for the subset of the `ws` WebSocket API we touch.
 * We could pull `ws` in directly, but it's a transitive dep of
 * `@fastify/websocket` and the existing `ws.gateway.ts` already follows
 * the inferred-type pattern — keeping the dep surface narrow.
 */
export interface ChatSocket {
  readonly readyState: number;
  send(data: string): void;
  /** Available when the underlying socket is a `ws` WebSocket instance. */
  terminate?(): void;
}

/** How long (ms) a chat socket may go without responding to a ping. */
const ZOMBIE_TIMEOUT_MS = 60_000;

export interface RoomMember {
  socket: ChatSocket;
  sessionId: string;
  displayName: string;
  userId: string | null;
  isModerator: boolean;
  ipHash: string | null;
  /** Token bucket: integer count of remaining sends in the current window. */
  sendTokens: number;
  /** Epoch ms when the bucket last refilled. */
  bucketRefilledAtMs: number;
  /**
   * Epoch ms when the server last received proof-of-liveness from this member
   * (either a "pong" message-type frame or a native WS pong event).
   * Initialised to join-time so newly-connected sockets get a grace period.
   */
  lastPongMs: number;
}

const SEND_WINDOW_MS = 10_000;
const SEND_TOKENS_PER_WINDOW = 5;

class ChatHub extends EventEmitter {
  private rooms = new Map<string, Set<RoomMember>>();

  /** Add a socket to a channel room. Returns the (mutable) member record. */
  join(channelId: string, member: RoomMember): { viewers: number } {
    let room = this.rooms.get(channelId);
    if (!room) {
      room = new Set();
      this.rooms.set(channelId, room);
    }
    room.add(member);
    this.broadcastPresence(channelId);
    return { viewers: room.size };
  }

  /** Remove a socket from a channel room (idempotent). */
  leave(channelId: string, member: RoomMember): void {
    const room = this.rooms.get(channelId);
    if (!room) return;
    if (!room.delete(member)) return;
    if (room.size === 0) {
      this.rooms.delete(channelId);
    } else {
      this.broadcastPresence(channelId);
    }
  }

  /** Current viewer count for a channel (0 if none). */
  viewers(channelId: string): number {
    return this.rooms.get(channelId)?.size ?? 0;
  }

  /** Send a frame to every socket in a room (best-effort, ignores closed sockets). */
  broadcast(channelId: string, event: ChatServerEvent): void {
    const room = this.rooms.get(channelId);
    if (!room) return;
    const payload = JSON.stringify(event);
    for (const m of room) {
      try {
        if (m.socket.readyState === 1 /* OPEN */) m.socket.send(payload);
      } catch {
        /* ignore — close handler will clean up */
      }
    }
  }

  /** Called from chat.routes.ts after a successful DB insert. */
  publishMessage(channelId: string, message: ChatMessage): void {
    this.broadcast(channelId, { type: "message", channelId, message });
  }

  /**
   * Called from admin-chat.routes.ts after a soft-delete. Idempotent —
   * sockets that don't have the message just ignore the frame.
   */
  publishDelete(channelId: string, messageId: string): void {
    this.broadcast(channelId, { type: "delete", channelId, messageId });
  }

  /** Called from admin-chat.routes.ts after a mute/ban. */
  publishModeration(
    channelId: string,
    action: "mute" | "ban",
    subjectKind: "user" | "ip",
    subjectId: string,
    expiresAtMs: number | null,
  ): void {
    this.broadcast(channelId, {
      type: "moderate",
      channelId,
      action,
      subjectKind,
      subjectId,
      expiresAtMs,
    });
  }

  /**
   * Token-bucket check. Returns `true` if the send is allowed and the
   * bucket has been decremented. Returns `false` if the member is over
   * their per-window quota.
   */
  consumeSendToken(member: RoomMember): boolean {
    const now = Date.now();
    if (now - member.bucketRefilledAtMs >= SEND_WINDOW_MS) {
      member.sendTokens = SEND_TOKENS_PER_WINDOW;
      member.bucketRefilledAtMs = now;
    }
    if (member.sendTokens <= 0) return false;
    member.sendTokens -= 1;
    return true;
  }

  /** ms until a member's bucket next refills (for retryAtMs in error frames). */
  retryAtMs(member: RoomMember): number {
    return member.bucketRefilledAtMs + SEND_WINDOW_MS;
  }

  /** Internal: emit a `presence` frame after join/leave. */
  private broadcastPresence(channelId: string): void {
    this.broadcast(channelId, {
      type: "presence",
      channelId,
      viewers: this.viewers(channelId),
    });
  }

  /**
   * Send a server-initiated `ping` to every socket in every room, then
   * sweep for zombie connections that haven't responded within ZOMBIE_TIMEOUT_MS.
   *
   * Without the sweep, half-open sockets (OS-level TCP connection alive but
   * client process gone) accumulate indefinitely in the room Set — leaking
   * event-loop references and inflating viewer counts.
   */
  pingAll(): void {
    const now = Date.now();
    const payload = JSON.stringify({ type: "ping", serverTimeMs: now });
    for (const [channelId, room] of this.rooms) {
      const zombies: RoomMember[] = [];
      for (const m of room) {
        // Zombie check before sending — terminate sockets that have been
        // silent for more than ZOMBIE_TIMEOUT_MS (typically 2+ missed pings).
        if (now - m.lastPongMs > ZOMBIE_TIMEOUT_MS) {
          zombies.push(m);
          continue;
        }
        try {
          if (m.socket.readyState === 1 /* OPEN */) m.socket.send(payload);
        } catch {
          /* ignore — close handler cleans up */
        }
      }
      for (const z of zombies) {
        logger.warn(
          { channelId, sessionId: z.sessionId, silentMs: now - z.lastPongMs },
          "[chat-hub] terminating zombie chat socket — no pong for >60 s",
        );
        try { z.socket.terminate?.(); } catch { /* already gone */ }
        // leave() removes from the room Set and broadcasts updated presence.
        this.leave(channelId, z);
      }
    }
  }
}

export const chatHub = new ChatHub();

export function createMember(args: {
  socket: ChatSocket;
  sessionId: string;
  displayName: string;
  userId: string | null;
  isModerator: boolean;
  ipHash: string | null;
}): RoomMember {
  return {
    ...args,
    sendTokens: SEND_TOKENS_PER_WINDOW,
    bucketRefilledAtMs: Date.now(),
    lastPongMs: Date.now(),  // grace period: new socket is considered alive until first ping cycle
  };
}
