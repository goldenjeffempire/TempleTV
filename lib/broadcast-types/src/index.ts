/**
 * @workspace/broadcast-types
 * ─────────────────────────────────────────────────────────────────────────────
 * Canonical, runtime-free type definitions for all broadcast-layer data shapes
 * shared across Temple TV platform surfaces: Smart TV, Mobile, Web Admin.
 *
 * Design rules:
 *
 * 1. NO runtime code — interfaces and type aliases only.
 *    TypeScript erases all exports at compile time, so importing this package
 *    adds zero bytes to any bundle regardless of target (hls.js TV build,
 *    Expo native, Node/SSR).
 *
 * 2. Fields are the SUPERSET of all platform implementations.
 *    Where TV and Mobile historically differed (e.g. `videoId` vs `id`,
 *    required vs optional `thumbnailUrl`) the canonical field is optional.
 *    Platform-specific extension types (TV's mapped `VideoItem`, Mobile's
 *    expo-mapped `Sermon`) remain in their respective packages and may narrow
 *    these optional fields to required where the platform guarantees them.
 *
 * 3. Backward-compat aliases for historical names are re-exported at the
 *    bottom of the file. Prefer the canonical names in new code.
 */

// ── Video library ─────────────────────────────────────────────────────────────

/**
 * Raw API response shape from GET /api/videos (DB row projection).
 * Both TV (mapped to VideoItem) and Mobile (mapped to Sermon) read this
 * from the same endpoint — keeping the raw shape here ensures that when
 * the server adds or removes a field, both mapping functions are updated.
 */
export interface VideoLibraryItem {
  id: string;
  youtubeId?: string;
  title: string;
  description?: string;
  thumbnailUrl?: string | null;
  duration?: string;
  category?: string;
  preacher?: string;
  publishedAt?: string | null;
  importedAt?: string;
  viewCount?: number;
  videoSource: "youtube" | "local";
  localVideoUrl?: string | null;
  /**
   * HLS master playlist URL from the transcoder. When present, players
   * prefer this over `localVideoUrl` (raw MP4) for adaptive bitrate,
   * reliable seeking, and broad codec compatibility.
   */
  hlsMasterUrl?: string | null;
}

// ── Live status ───────────────────────────────────────────────────────────────

/** Response from GET /api/youtube/live/status */
export interface LiveStatus {
  isLive: boolean;
  videoId: string | null;
  title: string | null;
  checkedAt: number;
  detectionMethod?: string;
  /** True when a YouTube broadcast is scheduled but not yet live. Mutually exclusive with isLive. */
  isUpcoming?: boolean;
  /** YouTube video ID of the upcoming (not yet live) broadcast. */
  upcomingVideoId?: string | null;
  /** Title of the upcoming broadcast, if available. */
  upcomingTitle?: string | null;
}

// ── Broadcast item ────────────────────────────────────────────────────────────

/**
 * A single item in the broadcast queue or playback state.
 *
 * Field notes:
 * - `id`        — always present; the canonical DB/queue identifier.
 * - `videoId`   — TV maps this to `id`; present for backward compat.
 *                 New code should use `id`.
 * - `youtubeId` — absent on local-only videos; present on YouTube items.
 * - `thumbnailUrl` — optional/nullable; may be absent for newly ingested items.
 * - `videoSource`  — "youtube" | "local"; optional for legacy payloads that
 *                    pre-date the field.
 * - `startedAt`  — ISO-8601 wall-clock time when this item began playing;
 *                  TV-specific timing field, absent in Mobile payloads.
 */
export interface BroadcastItem {
  id: string;
  /** @deprecated Duplicates `id` — present in some TV-side mappings. Prefer `id`. */
  videoId?: string;
  youtubeId?: string;
  title: string;
  thumbnailUrl?: string | null;
  durationSecs: number;
  localVideoUrl?: string | null;
  /**
   * HLS master playlist URL from the transcoder. Preferred over
   * `localVideoUrl` (raw MP4) for adaptive bitrate, reliable seeking,
   * and broad codec compatibility.
   */
  hlsMasterUrl?: string | null;
  videoSource?: string;
  /** ISO-8601 timestamp when the item started playing. TV-only field. */
  startedAt?: string;
}

// ── Broadcast current state ───────────────────────────────────────────────────

/**
 * Snapshot of the current broadcast state.
 *
 * Returned by:
 *   GET /api/broadcast/current   (Mobile; legacy broadcast engine)
 *   GET /api/playback/state      (TV; new playback engine, signed URLs)
 *
 * Both endpoints project to this shape. Fields present in one engine but
 * not the other are marked optional.
 */
export interface BroadcastCurrentState {
  item: BroadcastItem | null;
  nextItem: BroadcastItem | null;
  /**
   * The next few items after `item`, in air order (server caps at 3).
   * Optional for backwards-compat with API responses that pre-date the field;
   * treat `undefined` and `[]` identically.
   */
  upcomingItems?: BroadcastItem[];
  /** Position in the current item's queue slot (0-based). */
  index?: number;
  positionSecs: number;
  totalSecs: number;
  queueLength: number;
  progressPercent?: number;
  syncedAt?: string;
  serverTimeMs?: number;
  /** Epoch ms when the current item ends and the next one begins. */
  currentItemEndsAtMs?: number | null;
  /** Epoch seconds when the current item's playback started. */
  itemStartEpochSecs?: number | null;
  failoverReason?: string | null;
  /**
   * Backup HLS URL to switch to when primary playback fails.
   * Propagated from the server's BROADCAST_FAILOVER_HLS_URL env var
   * through both the REST and WebSocket paths.
   */
  failoverHlsUrl?: string | null;
  activeSchedule?: {
    id?: string;
    title?: string;
    contentType: "live" | "playlist" | "video" | string;
    contentId?: string | null;
    /** ISO-8601 schedule start — used by useLiveCountdown for "Starts in MM:SS". */
    startTime?: string;
    endTime?: string | null;
  } | null;
  /**
   * Admin-driven live override. When set, wins over the 24/7 queue and the
   * YouTube channel auto-detect. Both `youtubeVideoId` and `hlsStreamUrl`
   * are surfaced so REST-poll and SSE consumers share the same fields.
   */
  liveOverride?: {
    id?: string;
    title: string;
    startedAt?: string;
    endsAt?: string | null;
    hlsStreamUrl?: string | null;
    youtubeVideoId?: string | null;
  } | null;
  /** YouTube channel went live organically (no admin override). */
  ytLive?: boolean;
  ytVideoId?: string | null;
  ytTitle?: string | null;
}

// ── Guide ─────────────────────────────────────────────────────────────────────

/**
 * A single entry in the broadcast guide (upcoming queue).
 * Shape is identical between TV (`/api/broadcast/guide`) and Mobile.
 */
export interface GuideItem {
  id: string;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  durationSecs: number;
  localVideoUrl: string | null;
  /**
   * HLS master playlist URL from the transcoder. Preferred over `localVideoUrl`
   * for adaptive bitrate, reliable seeking, and broad codec compatibility.
   */
  hlsMasterUrl?: string | null;
  videoSource: string;
  startMs: number;
  endMs: number;
  isCurrent: boolean;
  positionSecs: number;
  progressPercent: number;
}

/** Response from GET /api/broadcast/guide */
export interface GuideResponse {
  items: GuideItem[];
  liveOverride?: { title: string } | null;
}

// ── Real-time event channel ───────────────────────────────────────────────────

/**
 * All named event types carried by the server's SSE channel
 * (GET /api/broadcast/events).
 *
 * OMEGA signals (`omega-signal`) are also delivered via the WebSocket
 * channel (/api/playback/ws) as typed `signal` frames — both transports
 * share this event vocabulary.
 */
export type BroadcastRealtimeEvent =
  | "broadcast-current-updated"
  | "broadcast-queue-updated"
  | "broadcast-schedule-updated"
  | "broadcast-control-updated"
  /**
   * Fired whenever the public video library changes (admin upload finalize,
   * edit, delete, transcoding completion, YouTube sync). Both TV
   * (via useLiveSync SSE sidecar) and Mobile (via subscribeBroadcastEvents)
   * watch this to trigger an immediate catalogue refetch.
   */
  | "videos-library-updated"
  | "status"
  | "override-expired"
  | "yt-status"
  | "live-reaction"
  /**
   * Per-second stream-health snapshot. Mobile reads `viewerCount` for the
   * live-interaction bar; Admin reads the full payload for the Live Monitor.
   */
  | "stream-health"
  /**
   * OMEGA Signal Bus: typed network signals from the broadcast engine
   * (EMERGENCY_BROADCAST, PROGRAM_CHANGED, SYNC_REQUIRED, FAILOVER_ACTIVATED,
   * STREAM_FAILED, …). Delivered to all SSE subscribers immediately.
   */
  | "omega-signal";

// ── Reactions ─────────────────────────────────────────────────────────────────

export type ReactionType = "amen" | "fire" | "hallelujah";

// ── WebSocket sync state ──────────────────────────────────────────────────────

/**
 * Wire-level source kind from the playback engine.
 * Carried in `BroadcastNextItem.sourceKind` so players can route correctly
 * without relying on URL extension detection (some API paths don't carry
 * a file extension but are MP4).
 */
export type PlaybackSourceKind = "hls" | "mp4" | "youtube";

/**
 * Next-in-queue item shape as projected by the WebSocket sync hook.
 * Richer than `BroadcastItem` — carries the wire-level `sourceKind` and
 * a triple-buffer `nextNextItem` slot. Used by TV's useLiveSync today;
 * Mobile will use the same shape when it migrates from SSE to WS sync.
 */
export interface BroadcastNextItem {
  id?: string;
  youtubeId?: string;
  title?: string;
  thumbnailUrl?: string | null;
  durationSecs?: number;
  videoSource?: string;
  /** HLS master playlist URL — preferred over `localVideoUrl` when present. */
  hlsMasterUrl?: string | null;
  /** Raw MP4 URL — only set when source is an MP4 file; HLS sources use `hlsMasterUrl`. */
  localVideoUrl?: string | null;
  /** Wire-level kind assigned by the playback server. */
  sourceKind?: PlaybackSourceKind | null;
}

/**
 * Full real-time broadcast state delivered by the WebSocket sync hook.
 *
 * Currently consumed by TV's `useLiveSync`. Mobile will adopt this shape
 * when it migrates from the SSE broadcast channel to the WebSocket sync
 * endpoint — at which point both platforms will share this exact interface.
 *
 * Notable fields:
 * - `libraryRevision`   — bumped on `videos-library-updated`; triggers catalogue refetch.
 * - `scheduleRevision`  — bumped on `broadcast-schedule-updated`.
 * - `emergencyBroadcast`— set by OMEGA EMERGENCY_BROADCAST signal; cleared by PROGRAM_CHANGED.
 */
export interface BroadcastSyncState {
  isLive: boolean;
  title: string | null;
  videoId: string | null;
  hlsStreamUrl: string | null;
  /**
   * HLS URL to fall back to when the primary stream fails.
   * From the server's `BROADCAST_FAILOVER_HLS_URL` env var.
   */
  failoverHlsUrl: string | null;
  liveOverride: {
    id: string;
    title: string;
    hlsStreamUrl?: string | null;
    youtubeVideoId?: string | null;
  } | null;
  ytLive: boolean;
  ytVideoId: string | null;
  ytTitle: string | null;
  syncedAt: string | null;
  serverTimeMs: number | null;
  connected: boolean;
  positionSecs: number | null;
  currentItemEndsAtMs: number | null;
  itemStartEpochSecs: number | null;
  index: number | null;
  totalSecs: number | null;
  queueLength: number | null;
  progressPercent: number | null;
  /**
   * The item currently on air. Typed as BroadcastNextItem (the canonical
   * WS-projected shape) rather than the legacy BroadcastItem so both TV
   * and Mobile can read it without casting. Populated by @workspace/broadcast-sync.
   */
  currentItem: BroadcastNextItem | null;
  nextItem: BroadcastNextItem | null;
  /** Triple-buffer slot — the item after `nextItem`. Exposed by the WS engine. */
  nextNextItem: BroadcastNextItem | null;
  viewerCount: number | null;
  payload: Record<string, unknown> | null;
  /**
   * Bumped whenever the server broadcasts `videos-library-updated`.
   * TV (`useData`) and Mobile (`useVideos`) watch this to trigger
   * an immediate video catalogue refetch instead of waiting on a poll timer.
   */
  libraryRevision: number;
  /**
   * Bumped whenever the server broadcasts `broadcast-schedule-updated`.
   * Schedule-grid consumers watch this.
   */
  scheduleRevision: number;
  /** OMEGA EMERGENCY_BROADCAST signal received. Cleared by PROGRAM_CHANGED. */
  emergencyBroadcast: boolean;
  /** Human-readable message from the EMERGENCY_BROADCAST signal payload. */
  emergencyMessage: string | null;
}

// ── Backward-compat aliases ───────────────────────────────────────────────────

/** @deprecated Use {@link BroadcastCurrentState} */
export type BroadcastCurrent = BroadcastCurrentState;

/** @deprecated Use {@link BroadcastCurrentState} */
export type BroadcastCurrentResult = BroadcastCurrentState;

/** @deprecated Use {@link GuideItem} */
export type BroadcastGuideItem = GuideItem;

/** @deprecated Use {@link GuideResponse} */
export type BroadcastGuideResult = GuideResponse;
