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
import type { ChatMessage, ChatServerEvent } from "./chat.types.js";
/**
 * Structural type for the subset of the `ws` WebSocket API we touch.
 * We could pull `ws` in directly, but it's a transitive dep of
 * `@fastify/websocket` and the existing `ws.gateway.ts` already follows
 * the inferred-type pattern — keeping the dep surface narrow.
 */
export interface ChatSocket {
    readonly readyState: number;
    send(data: string): void;
}
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
}
declare class ChatHub extends EventEmitter {
    private rooms;
    /** Add a socket to a channel room. Returns the (mutable) member record. */
    join(channelId: string, member: RoomMember): {
        viewers: number;
    };
    /** Remove a socket from a channel room (idempotent). */
    leave(channelId: string, member: RoomMember): void;
    /** Current viewer count for a channel (0 if none). */
    viewers(channelId: string): number;
    /** Send a frame to every socket in a room (best-effort, ignores closed sockets). */
    broadcast(channelId: string, event: ChatServerEvent): void;
    /** Called from chat.routes.ts after a successful DB insert. */
    publishMessage(channelId: string, message: ChatMessage): void;
    /**
     * Called from admin-chat.routes.ts after a soft-delete. Idempotent —
     * sockets that don't have the message just ignore the frame.
     */
    publishDelete(channelId: string, messageId: string): void;
    /** Called from admin-chat.routes.ts after a mute/ban. */
    publishModeration(channelId: string, action: "mute" | "ban", subjectKind: "user" | "ip", subjectId: string, expiresAtMs: number | null): void;
    /**
     * Token-bucket check. Returns `true` if the send is allowed and the
     * bucket has been decremented. Returns `false` if the member is over
     * their per-window quota.
     */
    consumeSendToken(member: RoomMember): boolean;
    /** ms until a member's bucket next refills (for retryAtMs in error frames). */
    retryAtMs(member: RoomMember): number;
    /** Internal: emit a `presence` frame after join/leave. */
    private broadcastPresence;
    /** Send a server-initiated `ping` to every socket in every room. */
    pingAll(): void;
}
export declare const chatHub: ChatHub;
export declare function createMember(args: {
    socket: ChatSocket;
    sessionId: string;
    displayName: string;
    userId: string | null;
    isModerator: boolean;
    ipHash: string | null;
}): RoomMember;
export {};
