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
import type { ChatMessage, ChatRole, ChatServerEvent, ChatSettings } from "./chat.types.js";
export interface ChatSocket {
    readonly readyState: number;
    send(data: string): void;
    terminate?(): void;
    /** Available on ws.WebSocket — bytes queued but not yet sent. */
    readonly bufferedAmount?: number;
}
export declare const DEFAULT_SETTINGS: ChatSettings;
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
declare class ChatHub extends EventEmitter {
    private rooms;
    private _settings;
    private _pinnedMessages;
    /** messageId → { emoji → count } */
    private _reactions;
    /** `${messageId}:${userKey}` → emoji reacted with (one per user per message) */
    private _reactionUsers;
    private _batchQueues;
    private _batchTimer;
    constructor();
    private _flushBatches;
    join(channelId: string, member: RoomMember): {
        viewers: number;
    };
    leave(channelId: string, member: RoomMember): void;
    viewers(channelId: string): number;
    /** Raw broadcast — bypasses batch queue (used for control frames). */
    broadcast(channelId: string, event: ChatServerEvent): void;
    private _broadcastRaw;
    /**
     * Enqueue a message for the next 100 ms batch flush.
     * Use this for every viewer-facing chat message so high-volume
     * bursts are coalesced into a single WS write per client.
     */
    publishMessage(channelId: string, message: ChatMessage): void;
    publishDelete(channelId: string, messageId: string): void;
    publishModeration(channelId: string, action: "mute" | "ban", subjectKind: "user" | "ip", subjectId: string, expiresAtMs: number | null): void;
    getSettings(channelId: string): ChatSettings;
    /**
     * Update the in-memory settings cache.
     * Pass `broadcast = true` (default) when admin changes settings — sends a
     * `settings` frame to all connected clients.
     * Pass `broadcast = false` on first WS-connect load — just warms the cache.
     */
    updateSettings(channelId: string, settings: ChatSettings, broadcast?: boolean): void;
    getPinnedMessage(channelId: string): ChatMessage | null;
    /**
     * Set (or clear) the pinned message for a channel and broadcast a `pin` frame.
     * Pass `broadcast = false` when warming the cache on first connect.
     */
    setPinnedMessage(channelId: string, message: ChatMessage | null, broadcast?: boolean): void;
    getReactions(messageId: string): Record<string, number>;
    /**
     * Toggle a reaction emoji for a user on a message.
     * One emoji per user per message — selecting a different emoji removes the
     * previous one. Anonymous users are keyed by sessionId.
     * Returns the updated reactions snapshot.
     */
    toggleReaction(channelId: string, messageId: string, emoji: string, userKey: string): Record<string, number>;
    consumeSendToken(member: RoomMember): boolean;
    retryAtMs(member: RoomMember): number;
    /**
     * Returns how many seconds remain before the member can send again
     * (0 = not throttled). Admins and mods bypass slow mode.
     */
    slowModeRemainingS(member: RoomMember, slowModeSecs: number): number;
    /**
     * Returns true if the member just sent the identical message within the
     * duplicate detection window. Mods/admins are exempt.
     */
    isDuplicate(member: RoomMember, body: string): boolean;
    /**
     * Checks body against the channel's keyword ban list.
     * Returns the matched keyword (lower-cased) or null.
     */
    matchesBannedKeyword(body: string, bannedKeywords: string[]): string | null;
    /**
     * Normalises a message body: if >70 % of alphabetic characters are
     * uppercase and the body is longer than 10 chars, convert to lower-case.
     * This reduces ALL-CAPS spam without outright rejecting the message.
     */
    normaliseCaps(body: string): string;
    /** Record a successful send. Updates slow-mode and duplicate-detection state. */
    recordSend(member: RoomMember, body: string): void;
    private _broadcastPresence;
    pingAll(): void;
}
export declare const chatHub: ChatHub;
export declare function createMember(args: {
    socket: ChatSocket;
    sessionId: string;
    displayName: string;
    userId: string | null;
    isModerator: boolean;
    role: ChatRole;
    ipHash: string | null;
}): RoomMember;
export {};
