/**
 * Server-side canonical chat WebSocket frame contract.
 *
 * Three hand-mirrored copies must stay in lock-step with this file:
 *   • artifacts/mobile/lib/chat/types.ts
 *   • artifacts/admin/src/chat/types.ts
 *   • artifacts/tv/src/chat/types.ts
 *
 * Changing a type here without updating all mirrors silently breaks live
 * chat on that surface (frames cross a process boundary with no runtime
 * schema validation).
 */

export const TEMPLE_TV_LIVE_CHANNEL = "temple-tv-live";

/** Sender role — determines badge colour and moderation bypass rules. */
export type ChatRole = "admin" | "mod" | "user" | "guest";

/** Per-channel broadcast chat configuration. */
export interface ChatSettings {
  /** Seconds between sends for regular users (0 = off). Mods/admins bypass. */
  slowModeSecs: number;
  /** When true only authenticated users can post. */
  subscriberOnly: boolean;
  /** ID of the currently pinned message, or null. */
  pinnedMessageId: string | null;
  /** Lower-cased keyword strings; a message containing any is rejected. */
  bannedKeywords: string[];
}

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
  /** Sender role at time of posting. */
  role: ChatRole;
  /** True when a moderator has highlighted this message. */
  isHighlighted: boolean;
  /**
   * Live reaction counts — ephemeral (in-memory only, resets on server
   * restart). History messages always arrive with `{}`.
   */
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
