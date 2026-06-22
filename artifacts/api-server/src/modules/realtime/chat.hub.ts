/**
 * Live-chat hub — singleton in-process room manager.
 *
 * Enhancements over the basic version:
 *   • Slow-mode enforcement (per-channel, bypassed for admin/mod)
 *   • Subscriber-only gate (checked by routes before calling publishMessage)
 *   • Keyword-ban filter
 *   • Duplicate-message + ALL-CAPS normalisation
 *   • In-memory reaction store (ephemeral; resets on restart)
 *   • Per-channel settings cache (populated from DB on first connect;
 *     updated and broadcast on admin PATCH /settings)
 *   • Pinned-message cache (populated from DB, broadcast on pin/unpin)
 *   • 100 ms batch-flush: queues outgoing messages and flushes as either
 *     a single `message` frame (1 msg) or a `batch` frame (>1 msg), keeping
 *     the per-socket write count low under high-volume bursts
 *   • Backpressure guard: skips sockets whose TX buffer exceeds 64 KiB so
 *     a slow client never stalls the main event loop
 */

import { EventEmitter } from "node:events";
import { logger } from "../../infrastructure/logger.js";
import type {
  ChatMessage,
  ChatRole,
  ChatServerEvent,
  ChatSettings,
} from "./chat.types.js";

export interface ChatSocket {
  readonly readyState: number;
  send(data: string): void;
  terminate?(): void;
  /** Available on ws.WebSocket — bytes queued but not yet sent. */
  readonly bufferedAmount?: number;
}

const ZOMBIE_TIMEOUT_MS = 60_000;
const BATCH_FLUSH_MS = 100;
const BACKPRESSURE_BYTES = 65_536;
const DUPLICATE_WINDOW_MS = 5_000;

export const DEFAULT_SETTINGS: ChatSettings = {
  slowModeSecs: 0,
  subscriberOnly: false,
  pinnedMessageId: null,
  bannedKeywords: [],
};

export interface RoomMember {
  socket: ChatSocket;
  sessionId: string;
  displayName: string;
  userId: string | null;
  isModerator: boolean;
  role: ChatRole;
  ipHash: string | null;
  sendTokens: number;
  bucketRefilledAtMs: number;
  lastPongMs: number;
  /** When the member last successfully sent a message (epoch ms). */
  lastSentAtMs: number;
  /** Body of the last message sent — used for duplicate detection. */
  lastMsgBody: string;
}

const SEND_WINDOW_MS = 10_000;
const SEND_TOKENS_PER_WINDOW = 5;
const MAX_ROOMS = 256;

class ChatHub extends EventEmitter {
  private rooms = new Map<string, Set<RoomMember>>();
  private _settings = new Map<string, ChatSettings>();
  private _pinnedMessages = new Map<string, ChatMessage>();
  /** messageId → { emoji → count } */
  private _reactions = new Map<string, Record<string, number>>();
  /** `${messageId}:${userKey}` → emoji reacted with (one per user per message) */
  private _reactionUsers = new Map<string, string>();
  private _batchQueues = new Map<string, ChatMessage[]>();
  private _batchTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this._batchTimer = setInterval(() => this._flushBatches(), BATCH_FLUSH_MS);
    this._batchTimer.unref();
  }

  private _flushBatches(): void {
    for (const [channelId, queue] of this._batchQueues) {
      if (queue.length === 0) continue;
      const msgs = queue.splice(0);
      if (msgs.length === 1) {
        this._broadcastRaw(channelId, { type: "message", channelId, message: msgs[0]! });
      } else {
        this._broadcastRaw(channelId, { type: "batch", channelId, messages: msgs });
      }
    }
  }

  join(channelId: string, member: RoomMember): { viewers: number } {
    let room = this.rooms.get(channelId);
    if (!room) {
      if (this.rooms.size >= MAX_ROOMS) {
        throw new Error(`ChatHub at capacity (${MAX_ROOMS} rooms)`);
      }
      room = new Set();
      this.rooms.set(channelId, room);
    }
    room.add(member);
    this._broadcastPresence(channelId);
    return { viewers: room.size };
  }

  leave(channelId: string, member: RoomMember): void {
    const room = this.rooms.get(channelId);
    if (!room) return;
    if (!room.delete(member)) return;
    if (room.size === 0) {
      this.rooms.delete(channelId);
    } else {
      this._broadcastPresence(channelId);
    }
  }

  viewers(channelId: string): number {
    return this.rooms.get(channelId)?.size ?? 0;
  }

  /** Raw broadcast — bypasses batch queue (used for control frames). */
  broadcast(channelId: string, event: ChatServerEvent): void {
    this._broadcastRaw(channelId, event);
  }

  private _broadcastRaw(channelId: string, event: ChatServerEvent): void {
    const room = this.rooms.get(channelId);
    if (!room) return;
    const payload = JSON.stringify(event);
    for (const m of room) {
      try {
        if (m.socket.readyState !== 1 /* OPEN */) continue;
        if (
          m.socket.bufferedAmount !== undefined &&
          m.socket.bufferedAmount > BACKPRESSURE_BYTES
        ) {
          continue;
        }
        m.socket.send(payload);
      } catch {
        /* ignore — close handler cleans up */
      }
    }
  }

  /**
   * Enqueue a message for the next 100 ms batch flush.
   * Use this for every viewer-facing chat message so high-volume
   * bursts are coalesced into a single WS write per client.
   */
  publishMessage(channelId: string, message: ChatMessage): void {
    let q = this._batchQueues.get(channelId);
    if (!q) {
      q = [];
      this._batchQueues.set(channelId, q);
    }
    q.push(message);
  }

  publishDelete(channelId: string, messageId: string): void {
    this._broadcastRaw(channelId, { type: "delete", channelId, messageId });
  }

  publishModeration(
    channelId: string,
    action: "mute" | "ban",
    subjectKind: "user" | "ip",
    subjectId: string,
    expiresAtMs: number | null,
  ): void {
    this._broadcastRaw(channelId, {
      type: "moderate",
      channelId,
      action,
      subjectKind,
      subjectId,
      expiresAtMs,
    });
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  getSettings(channelId: string): ChatSettings {
    return this._settings.get(channelId) ?? DEFAULT_SETTINGS;
  }

  /**
   * Update the in-memory settings cache.
   * Pass `broadcast = true` (default) when admin changes settings — sends a
   * `settings` frame to all connected clients.
   * Pass `broadcast = false` on first WS-connect load — just warms the cache.
   */
  updateSettings(channelId: string, settings: ChatSettings, broadcast = true): void {
    this._settings.set(channelId, settings);
    if (broadcast) {
      this._broadcastRaw(channelId, { type: "settings", channelId, settings });
    }
  }

  // ── Pinned message ──────────────────────────────────────────────────────────

  getPinnedMessage(channelId: string): ChatMessage | null {
    return this._pinnedMessages.get(channelId) ?? null;
  }

  /**
   * Set (or clear) the pinned message for a channel and broadcast a `pin` frame.
   * Pass `broadcast = false` when warming the cache on first connect.
   */
  setPinnedMessage(
    channelId: string,
    message: ChatMessage | null,
    broadcast = true,
  ): void {
    if (message) {
      this._pinnedMessages.set(channelId, message);
    } else {
      this._pinnedMessages.delete(channelId);
    }
    if (broadcast) {
      this._broadcastRaw(channelId, { type: "pin", channelId, message });
    }
  }

  // ── Reactions ───────────────────────────────────────────────────────────────

  getReactions(messageId: string): Record<string, number> {
    return { ...(this._reactions.get(messageId) ?? {}) };
  }

  /**
   * Toggle a reaction emoji for a user on a message.
   * One emoji per user per message — selecting a different emoji removes the
   * previous one. Anonymous users are keyed by sessionId.
   * Returns the updated reactions snapshot.
   */
  toggleReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    userKey: string,
  ): Record<string, number> {
    const reactions = { ...(this._reactions.get(messageId) ?? {}) };
    const userReactionKey = `${messageId}:${userKey}`;
    const existing = this._reactionUsers.get(userReactionKey);

    if (existing === emoji) {
      // Remove reaction
      this._reactionUsers.delete(userReactionKey);
      const newCount = (reactions[emoji] ?? 1) - 1;
      if (newCount <= 0) delete reactions[emoji];
      else reactions[emoji] = newCount;
    } else {
      // Remove old emoji if switching
      if (existing) {
        const oldCount = (reactions[existing] ?? 1) - 1;
        if (oldCount <= 0) delete reactions[existing];
        else reactions[existing] = oldCount;
      }
      // Add new emoji
      this._reactionUsers.set(userReactionKey, emoji);
      reactions[emoji] = (reactions[emoji] ?? 0) + 1;
    }

    this._reactions.set(messageId, reactions);
    this._broadcastRaw(channelId, { type: "reaction", channelId, messageId, reactions });
    return reactions;
  }

  // ── Moderation helpers ──────────────────────────────────────────────────────

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

  retryAtMs(member: RoomMember): number {
    return member.bucketRefilledAtMs + SEND_WINDOW_MS;
  }

  /**
   * Returns how many seconds remain before the member can send again
   * (0 = not throttled). Admins and mods bypass slow mode.
   */
  slowModeRemainingS(member: RoomMember, slowModeSecs: number): number {
    if (slowModeSecs <= 0) return 0;
    if (member.role === "admin" || member.role === "mod") return 0;
    const elapsed = (Date.now() - member.lastSentAtMs) / 1000;
    const remaining = slowModeSecs - elapsed;
    return remaining > 0 ? Math.ceil(remaining) : 0;
  }

  /**
   * Returns true if the member just sent the identical message within the
   * duplicate detection window. Mods/admins are exempt.
   */
  isDuplicate(member: RoomMember, body: string): boolean {
    if (member.role === "admin" || member.role === "mod") return false;
    return (
      member.lastMsgBody === body &&
      Date.now() - member.lastSentAtMs < DUPLICATE_WINDOW_MS
    );
  }

  /**
   * Checks body against the channel's keyword ban list.
   * Returns the matched keyword (lower-cased) or null.
   */
  matchesBannedKeyword(body: string, bannedKeywords: string[]): string | null {
    if (bannedKeywords.length === 0) return null;
    const lower = body.toLowerCase();
    for (const kw of bannedKeywords) {
      if (kw && lower.includes(kw.toLowerCase())) return kw;
    }
    return null;
  }

  /**
   * Normalises a message body: if >70 % of alphabetic characters are
   * uppercase and the body is longer than 10 chars, convert to lower-case.
   * This reduces ALL-CAPS spam without outright rejecting the message.
   */
  normaliseCaps(body: string): string {
    if (body.length <= 10) return body;
    const alpha = [...body].filter((c) => /[a-zA-Z]/.test(c));
    if (alpha.length === 0) return body;
    const upper = alpha.filter((c) => c === c.toUpperCase()).length;
    return upper / alpha.length > 0.7 ? body.toLowerCase() : body;
  }

  /** Record a successful send. Updates slow-mode and duplicate-detection state. */
  recordSend(member: RoomMember, body: string): void {
    member.lastSentAtMs = Date.now();
    member.lastMsgBody = body;
  }

  // ── Keep-alive / zombie sweep ────────────────────────────────────────────────

  private _broadcastPresence(channelId: string): void {
    this._broadcastRaw(channelId, {
      type: "presence",
      channelId,
      viewers: this.viewers(channelId),
    });
  }

  pingAll(): void {
    const now = Date.now();
    const payload = JSON.stringify({ type: "ping", serverTimeMs: now });
    for (const [channelId, room] of this.rooms) {
      const zombies: RoomMember[] = [];
      for (const m of room) {
        if (now - m.lastPongMs > ZOMBIE_TIMEOUT_MS) {
          zombies.push(m);
          continue;
        }
        try {
          if (m.socket.readyState === 1) m.socket.send(payload);
        } catch { /* ignore */ }
      }
      for (const z of zombies) {
        logger.warn(
          { channelId, sessionId: z.sessionId, silentMs: now - z.lastPongMs },
          "[chat-hub] terminating zombie chat socket — no pong for >60 s",
        );
        try { z.socket.terminate?.(); } catch { /* already gone */ }
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
  role: ChatRole;
  ipHash: string | null;
}): RoomMember {
  return {
    ...args,
    sendTokens: SEND_TOKENS_PER_WINDOW,
    bucketRefilledAtMs: Date.now(),
    lastPongMs: Date.now(),
    lastSentAtMs: 0,
    lastMsgBody: "",
  };
}
