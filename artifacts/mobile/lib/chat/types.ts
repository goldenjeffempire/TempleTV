/**
 * Mirror of the api-server's chat WS frame contract — see
 * `artifacts/api-server/src/modules/realtime/chat.types.ts` for the
 * canonical definition. Keep this file in lock-step with the server
 * (and with `artifacts/admin/src/chat/types.ts` and
 * `artifacts/tv/src/chat/types.ts`) — these frames cross a process
 * boundary, so a drift will silently break live chat.
 */

export const TEMPLE_TV_LIVE_CHANNEL = "temple-tv-live";

export interface ChatMessage {
  id: string;
  channelId: string;
  userId: string | null;
  displayName: string;
  body: string;
  createdAtMs: number;
  broadcastItemId: string | null;
  broadcastItemTitle: string | null;
}

export type ChatServerEvent =
  | {
      type: "state";
      channelId: string;
      recent: ChatMessage[];
      viewers: number;
      serverTimeMs: number;
      you: { sessionId: string; displayName: string; isModerator: boolean };
    }
  | { type: "message"; channelId: string; message: ChatMessage }
  | { type: "delete"; channelId: string; messageId: string }
  | {
      type: "moderate";
      channelId: string;
      action: "mute" | "ban";
      subjectKind: "user" | "ip";
      subjectId: string;
      expiresAtMs: number | null;
    }
  | { type: "presence"; channelId: string; viewers: number }
  | { type: "ping"; serverTimeMs: number }
  | { type: "ack"; clientMsgId: string; messageId: string }
  | {
      type: "error";
      code:
        | "rate_limited"
        | "muted"
        | "banned"
        | "empty"
        | "too_long"
        | "duplicate"
        | "invalid"
        | "unauthorized"
        | "internal";
      message: string;
      retryAtMs?: number;
    };

export type ChatClientFrame =
  | { type: "send"; clientMsgId: string; body: string }
  | { type: "pong" };

export type ChatConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface ChatIdentity {
  sessionId: string;
  displayName: string;
  isModerator: boolean;
}
