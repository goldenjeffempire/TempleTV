/**
 * Live-chat wire types.
 *
 * Source-of-truth contract between the chat WebSocket gateway and every
 * client (web admin, TV, mobile). Designed to be small, push-first, and
 * broadcast-aware: every message snapshots the currently-airing playback
 * item so chat stays semantically tied to what viewers are watching.
 */

export const TEMPLE_TV_LIVE_CHANNEL = "temple-tv-live";

export interface ChatMessage {
  id: string;
  channelId: string;
  /** Stable user id when a signed-in user posted; null for anonymous viewers. */
  userId: string | null;
  displayName: string;
  /** Already-sanitized body — clients may render this as plain text directly. */
  body: string;
  /** Epoch ms — clients format with their own locale. */
  createdAtMs: number;
  /** Snapshot of the playback engine's `current.id` at send time, when known. */
  broadcastItemId: string | null;
  broadcastItemTitle: string | null;
}

/** Discriminated event union pushed over the WS gateway. */
export type ChatServerEvent =
  | {
      type: "state";
      channelId: string;
      recent: ChatMessage[];
      viewers: number;
      /** Server's authoritative wall clock, ms. */
      serverTimeMs: number;
      /** Echoed back so the client knows how it appears to other viewers. */
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
  | {
      type: "ack";
      /** Echoes the client's optimistic id so it can swap-in the canonical message. */
      clientMsgId: string;
      messageId: string;
    }
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
      /** Optional retry hint (epoch ms). */
      retryAtMs?: number;
    };

/** Inbound frames the client may send. */
export type ChatClientFrame =
  | {
      type: "send";
      /** Client-generated id used for optimistic UI ↔ ack pairing. */
      clientMsgId: string;
      body: string;
    }
  | { type: "pong" };
