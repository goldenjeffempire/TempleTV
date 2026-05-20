/**
 * Server-side mirror of the chat WebSocket frame contract.
 *
 * The browser-side mirror lives in
 * `artifacts/admin/src/chat/types.ts` and `artifacts/tv/src/chat/types.ts`.
 * Both must stay in lock-step — these frames cross a process boundary
 * (so changing one without the other will silently break live chat).
 *
 * The types are intentionally hand-mirrored rather than emitted from
 * the OpenAPI spec because OpenAPI 3.0 has no first-class WebSocket
 * channel description and the chat contract is small and stable.
 */
export declare const TEMPLE_TV_LIVE_CHANNEL = "temple-tv-live";
export interface ChatMessage {
    id: string;
    channelId: string;
    userId: string | null;
    displayName: string;
    body: string;
    /** ms since epoch — matches `createdAt.getTime()`. */
    createdAtMs: number;
    broadcastItemId: string | null;
    broadcastItemTitle: string | null;
}
export type ChatServerEvent = {
    type: "state";
    channelId: string;
    recent: ChatMessage[];
    viewers: number;
    serverTimeMs: number;
    you: {
        sessionId: string;
        displayName: string;
        isModerator: boolean;
    };
} | {
    type: "message";
    channelId: string;
    message: ChatMessage;
} | {
    type: "delete";
    channelId: string;
    messageId: string;
} | {
    type: "moderate";
    channelId: string;
    action: "mute" | "ban";
    subjectKind: "user" | "ip";
    subjectId: string;
    expiresAtMs: number | null;
} | {
    type: "presence";
    channelId: string;
    viewers: number;
} | {
    type: "ping";
    serverTimeMs: number;
} | {
    type: "ack";
    clientMsgId: string;
    messageId: string;
} | {
    type: "error";
    code: "rate_limited" | "muted" | "banned" | "empty" | "too_long" | "duplicate" | "invalid" | "unauthorized" | "internal";
    message: string;
    retryAtMs?: number;
};
export type ChatClientFrame = {
    type: "send";
    clientMsgId: string;
    body: string;
} | {
    type: "pong";
};
