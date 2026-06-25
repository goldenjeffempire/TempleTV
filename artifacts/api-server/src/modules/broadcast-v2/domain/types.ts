/**
 * Broadcast v2 — canonical wire and domain types.
 *
 * These types are the single source of truth for the v2 protocol. They are
 * imported by the orchestrator, the IO gateways (WS/SSE/REST), and (via
 * `lib/player-core`) by every client surface. Any change here is a wire
 * protocol change.
 */

export type V2Mode = "queue" | "override" | "failover" | "offline_hold";

export type V2SourceKind = "hls" | "mp4" | "dash" | "youtube";

export interface V2Source {
  kind: V2SourceKind;
  url: string;
  /** Epoch-ms when a signed URL stops working; null if not signed. */
  expiresAtMs: number | null;
}

export type V2SourceQuality = "hls" | "mp4_faststart" | "mp4_raw";

export interface V2Item {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  durationSecs: number;
  source: V2Source;
  /** Optional MP4/HLS fallback if the primary source fails. */
  failoverSource: { kind: "hls" | "mp4"; url: string } | null;
  /** Wall-clock epoch-ms when this item starts on every client. */
  startsAtMs: number;
  /** Wall-clock epoch-ms when this item ends. */
  endsAtMs: number;
  /**
   * Source quality classification populated by the orchestrator.
   * 'hls'           — adaptive HLS stream (preferred)
   * 'mp4_faststart' — moov-at-byte-0 range-seekable MP4
   * 'mp4_raw'       — sequential-only MP4 (may buffer slowly on seek)
   */
  sourceQuality?: V2SourceQuality;
}

export interface V2Override {
  id: string;
  kind: "youtube" | "hls" | "rtmp";
  url: string;
  title: string;
  startedAtMs: number;
  endsAtMs: number | null;
  /** When true, the orchestrator restores the queue position when override ends. */
  resumeQueueOnEnd: boolean;
}

export interface V2Snapshot {
  channelId: string;
  /** Monotonic per-channel sequence number; clients use this for resume. */
  sequence: number;
  serverTimeMs: number;
  mode: V2Mode;
  current: V2Item | null;
  next: V2Item | null;
  nextNext: V2Item | null;
  override: V2Override | null;
  /** Position checkpoint of the queue item paused under an override. */
  checkpoint: { itemId: string; positionMs: number } | null;
  failover: { active: boolean; reason: string | null };
  /**
   * Why the broadcast is off-air when `current` is null and mode is "queue".
   * - "empty"       — no items in the queue (library empty or sync not run)
   * - "all_blocked" — items exist but every URL is in the bad-URL cache
   * - null          — not off-air (item is playing or mode is override)
   */
  offAirReason: "empty" | "all_blocked" | null;
  /**
   * YouTube video ID of the NEXT video in the shuffle playlist.
   * Only populated when the YouTube shuffle fallback is active (mode=override,
   * override.kind="youtube"). Clients use this to preload the next YouTube
   * iframe before the current one ends, enabling seamless gapless transitions.
   * Null when shuffle is inactive, the playlist has only one entry, or the
   * next entry is unknown.
   */
  nextYtVideoId?: string | null;
  /**
   * Source quality of the currently-playing item.
   * 'hls'           — adaptive HLS stream (preferred)
   * 'mp4_faststart' — moov-at-byte-0 range-seekable MP4
   * 'mp4_raw'       — sequential-only MP4 (may buffer slowly)
   * 'live_override' — operator HLS/RTMP live override
   * 'youtube'       — YouTube live override
   * null            — off-air
   */
  sourceQuality: V2SourceQuality | "live_override" | "youtube" | null;
}

/** Server → client WebSocket / SSE frames. */
export type V2ServerFrame =
  | { type: "hello"; serverTimeMs: number; sequence: number }
  | { type: "snapshot"; sequence: number; state: V2Snapshot }
  | { type: "event"; sequence: number; eventType: V2EventType; payload: unknown }
  | { type: "preload"; sequence: number; item: V2Item; leadMs: number }
  | { type: "takeover"; sequence: number; override: V2Override }
  | { type: "recover"; fromSequence: number; events: V2ServerFrame[] }
  | { type: "heartbeat"; serverTimeMs: number; sequence: number; lastAdvancedAtMs?: number }
  | { type: "error"; code: string; message: string }
  /**
   * Graceful-restart hint.  Sent by the server immediately after receiving
   * SIGTERM, while connections are still live (before the preclose drain).
   * `retryAfterMs` is the recommended minimum delay before the client makes
   * its first reconnect attempt — approximately the server's preclose drain
   * window plus a small restart-boot buffer.
   *
   * Clients should:
   *   1. Cancel any existing backoff timer.
   *   2. Schedule a single reconnect attempt after `retryAfterMs`.
   *   3. After that attempt, use normal exponential backoff if the server
   *      is not yet up.
   * This prevents a reconnect storm during the SHUTDOWN_PRECLOSE_DELAY_MS
   * window and gives the new process time to boot before the first attempt.
   */
  | { type: "reconnect"; retryAfterMs: number };

/** Client → server WebSocket frames. */
export type V2ClientFrame =
  | { type: "subscribe"; channel: string; lastSequence?: number }
  | { type: "ack"; sequence: number }
  | { type: "resume"; lastSequence: number }
  | { type: "pong" };

export type V2EventType =
  | "queue.changed"
  | "item.advanced"
  | "item.skipped"
  | "override.started"
  | "override.ended"
  | "failover.engaged"
  | "failover.cleared"
  | "checkpoint.updated"
  | "dead_air.detected"
  | "all_sources_blocked"
  /**
   * Emitted by the orchestrator when the currently-playing item's source URL
   * upgrades (e.g. MP4 → HLS after transcoding completes) without an item
   * boundary crossing. Clients should switch to the new source at the next
   * segment boundary for HLS (gapless) or immediately if the current
   * playback position can be preserved.
   *
   * Payload: { itemId: string; newSource: V2Source; oldKind: V2SourceKind }
   */
  | "source.upgraded";
