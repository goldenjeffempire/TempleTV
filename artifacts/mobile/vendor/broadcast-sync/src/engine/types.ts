/**
 * Broadcast Engine — Internal Types
 *
 * Wire-level types from /api/playback/ws exactly match the server's emission
 * contract and are intentionally kept private to this package. External
 * consumers depend on BroadcastSyncState from @workspace/broadcast-types.
 */

// ── Wire protocol (server → client) ──────────────────────────────────────────

export interface WirePlaybackSource {
  kind: "hls" | "mp4" | "youtube";
  url: string;
  expiresAtMs: number | null;
}

export interface WirePlaybackItem {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  durationSecs: number;
  source: WirePlaybackSource;
  startsAtMs: number;
  endsAtMs: number;
}

export interface WirePlaybackState {
  serverTimeMs: number;
  current: WirePlaybackItem | null;
  next: WirePlaybackItem | null;
  nextNext: WirePlaybackItem | null;
  liveOverride: {
    title: string;
    startedAtMs: number;
    endsAtMs: number | null;
  } | null;
  source: "override" | "schedule" | "queue" | "empty";
  failoverHlsUrl?: string | null;
}

export interface OmegaSignal {
  type: string;
  channelId: string;
  serverTimeMs: number;
  message?: string;
  payload?: Record<string, unknown>;
}

export type WirePlaybackFrame =
  | { type: "state";   reason: string;         state: WirePlaybackState }
  | { type: "preload"; leadMs: number;          state: WirePlaybackState }
  | { type: "ping";    serverTimeMs: number                              }
  | { type: "signal";  signal: OmegaSignal                              }
  | { type: "library-updated"; revision: number                         };

// ── Engine events (inter-module) ──────────────────────────────────────────────

/** Posted by StateSyncService whenever a fresh WirePlaybackState arrives. */
export interface StateUpdateEvent {
  wire: WirePlaybackState;
  /** "transition" | "preload" | other server reason string */
  reason: string;
  /** ms lead time for preload hints (only present for type="preload" frames) */
  leadMs?: number;
}

/** Posted by StateSyncService on OMEGA signals. */
export interface OmegaSignalEvent {
  signal: OmegaSignal;
}

/** Connection lifecycle events emitted by StateSyncService. */
export type ConnectionStatus = "connecting" | "connected" | "disconnected";

// ── Options ───────────────────────────────────────────────────────────────────

export interface BroadcastEngineOptions {
  /** Full WebSocket URL. Pass "" to skip WS and use HTTP-only polling. */
  wsUrl: string;
  /** Full HTTP URL for snapshot endpoint (/api/playback/state). */
  stateUrl: string;
  /** Full HTTP URL for YouTube live status (/api/youtube/live/status). */
  liveStatusUrl?: string;
  /** Full SSE URL for library/schedule revision bumps. */
  sseUrl?: string;
  /** Applied to every URL field in projected items (mobile relative→absolute). */
  normalizeUrl?: (url: string) => string;
}
