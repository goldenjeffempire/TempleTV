/**
 * Mirror of `artifacts/api-server/src/modules/realtime/chat.types.ts`.
 * Hand-mirrored — keep in lock-step with the server file and with
 * `artifacts/admin/src/chat/types.ts` and `artifacts/tv/src/chat/types.ts`.
 */

export const TEMPLE_TV_LIVE_CHANNEL = "temple-tv-live";

export type ChatRole = "admin" | "mod" | "user" | "guest";

export interface ChatSettings {
  slowModeSecs: number;
  subscriberOnly: boolean;
  pinnedMessageId: string | null;
  bannedKeywords: string[];
}

export interface ChatMessage {
  id: string;
  channelId: string;
  userId: string | null;
  displayName: string;
  body: string;
  createdAtMs: number;
  broadcastItemId: string | null;
  broadcastItemTitle: string | null;
  role: ChatRole;
  isHighlighted: boolean;
  reactions: Record<string, number>;
}

export type ChatServerEvent =
  | {
      type: "state";
      channelId: string;
      recent: ChatMessage[];
      viewers: number;
      serverTimeMs: number;
      settings: ChatSettings;
      pinnedMessage: ChatMessage | null;
      you: {
        sessionId: string;
        displayName: string;
        isModerator: boolean;
        role: ChatRole;
      };
    }
  | { type: "message"; channelId: string; message: ChatMessage }
  | { type: "batch"; channelId: string; messages: ChatMessage[] }
  | { type: "delete"; channelId: string; messageId: string }
  | {
      type: "moderate";
      channelId: string;
      action: "mute" | "ban";
      subjectKind: "user" | "ip";
      subjectId: string;
      expiresAtMs: number | null;
    }
  | { type: "pin"; channelId: string; message: ChatMessage | null }
  | { type: "settings"; channelId: string; settings: ChatSettings }
  | {
      type: "reaction";
      channelId: string;
      messageId: string;
      reactions: Record<string, number>;
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
        | "blocked"
        | "slow_mode"
        | "subscriber_only"
        | "invalid"
        | "unauthorized"
        | "internal";
      message: string;
      retryAtMs?: number;
    };

export type ChatClientFrame =
  | { type: "send"; clientMsgId: string; body: string }
  | { type: "react"; messageId: string; emoji: string }
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
  role: ChatRole;
}
