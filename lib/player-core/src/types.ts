/**
 * Player core wire types — mirror of the api-server v2 contract.
 * Kept in sync with `artifacts/api-server/src/modules/broadcast-v2/domain/types.ts`.
 */

export type V2Mode = "queue" | "override" | "failover" | "offline_hold";
export type V2SourceKind = "hls" | "mp4" | "dash" | "youtube";

export interface V2Source {
  kind: V2SourceKind;
  url: string;
  expiresAtMs: number | null;
}

export type V2SourceQuality = "hls" | "mp4_faststart" | "mp4_raw";

export interface V2Item {
  id: string;
  /**
   * The `managed_videos.id` for this queue item. Populated when the item
   * was auto-enqueued from an upload; null for manually-enqueued items that
   * pre-date the field. Present since broadcast-v2 queue.repo v2.1.
   */
  videoId?: string | null;
  title: string;
  thumbnailUrl: string | null;
  durationSecs: number;
  source: V2Source;
  failoverSource: { kind: "hls" | "mp4"; url: string } | null;
  startsAtMs: number;
  endsAtMs: number;
  /**
   * Source quality classification populated by the orchestrator.
   * 'hls'           — adaptive HLS stream (preferred)
   * 'mp4_faststart' — moov-at-byte-0 range-seekable MP4
   * 'mp4_raw'       — sequential-only MP4 (may buffer slowly on seek)
   * Optional for backward compatibility with older server versions.
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
  resumeQueueOnEnd: boolean;
}

export interface V2Snapshot {
  channelId: string;
  sequence: number;
  serverTimeMs: number;
  mode: V2Mode;
  current: V2Item | null;
  next: V2Item | null;
  nextNext: V2Item | null;
  override: V2Override | null;
  checkpoint: { itemId: string; positionMs: number } | null;
  failover: { active: boolean; reason: string | null };
  /**
   * Why the broadcast is off-air when `current` is null and mode is "queue".
   * Optional for back-compat with older server versions.
   */
  offAirReason?: "empty" | "all_blocked" | null;
  /**
   * Top-level source quality for the current broadcast state.
   * 'hls'           — adaptive HLS stream (preferred)
   * 'mp4_faststart' — moov-at-byte-0 range-seekable MP4
   * 'mp4_raw'       — sequential-only MP4 (may buffer slowly)
   * 'live_override' — operator HLS/RTMP live override
   * 'youtube'       — YouTube live override
   * null            — off-air or quality unknown
   * Optional for backward compatibility with older server versions.
   */
  sourceQuality?: "hls" | "mp4_faststart" | "mp4_raw" | "live_override" | "youtube" | null;
}

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
  | "source.upgraded";

export type V2ServerFrame =
  | { type: "hello"; serverTimeMs: number; sequence: number }
  | { type: "snapshot"; sequence: number; state: V2Snapshot }
  | { type: "event"; sequence: number; eventType: V2EventType; payload: unknown }
  | { type: "preload"; sequence: number; item: V2Item; leadMs: number }
  | { type: "takeover"; sequence: number; override: V2Override }
  | { type: "recover"; fromSequence: number; events: V2ServerFrame[] }
  | { type: "heartbeat"; serverTimeMs: number; sequence: number; lastAdvancedAtMs?: number }
  | { type: "error"; code: string; message: string }
  /** Graceful-restart hint — server is shutting down; reconnect after retryAfterMs. */
  | { type: "reconnect"; retryAfterMs: number };

// ── Player state machine ─────────────────────────────────────────────────

export type PlayerState =
  | "BOOTSTRAP"
  | "SYNCING"
  | "PREPARING_ACTIVE"
  | "PLAYING"
  | "PREPARING_NEXT"
  | "HANDOFF"
  | "LIVE_OVERRIDE_ACTIVE"
  | "OFFLINE_HOLD"
  | "RECOVERING_PRIMARY"
  | "RECOVERING_FAILOVER"
  | "SKIP_PENDING"
  | "FATAL";

export type PlayerEvent =
  | { type: "snapshot"; snapshot: V2Snapshot }
  | { type: "preload"; item: V2Item; leadMs: number }
  | { type: "takeover"; override: V2Override }
  | { type: "buffer-ready"; bufferId: "A" | "B" }
  | { type: "buffer-error"; bufferId: "A" | "B"; error: string }
  | { type: "buffer-stalled"; bufferId: "A" | "B" }
  | { type: "buffer-ended"; bufferId: "A" | "B" }
  | { type: "buffer-near-end"; bufferId: "A" | "B" }
  | { type: "online" }
  | { type: "offline" }
  | { type: "force-skip" };

export interface PlayerSnapshot {
  state: PlayerState;
  /** Which buffer is currently audible/visible. */
  activeBufferId: "A" | "B";
  /** Source bound to buffer A, if any. */
  bufferA: V2Item | V2Override | null;
  /** Source bound to buffer B, if any. */
  bufferB: V2Item | V2Override | null;
  /** Last-known server snapshot. */
  lastServerSnapshot: V2Snapshot | null;
  /** Last-applied server sequence. */
  lastSequence: number;
  /**
   * How many successive FATAL entries since the last successful PLAYING state.
   * Used by UI surfaces to compute the correct exponential-backoff countdown
   * (30 s × 2^(n-1), capped at 240 s) rather than showing a static "30 s".
   */
  fatalAttemptCount: number;
  /**
   * Wall-clock ms (Date.now()) when the machine last entered the FATAL state.
   * Null when the machine is not in FATAL. Combined with fatalAttemptCount,
   * UI surfaces can derive an accurate live countdown to the auto-retry.
   */
  fatalEnteredAtMs: number | null;
}
