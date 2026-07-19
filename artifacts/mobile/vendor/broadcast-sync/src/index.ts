/**
 * @workspace/broadcast-sync
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared React hook for real-time broadcast synchronisation.
 *
 * Architecture (rebuilt from scratch):
 *
 *   BroadcastEngine (orchestrator)
 *   ├── StateSyncService     — WebSocket + HTTP snapshot + SSE sidecar + OMEGA signals
 *   │     SSE sidecar: opens an EventSource on /api/broadcast/events and listens for the
 *   │     "videos-library-updated" named event to bump libraryRevision so catalog consumers
 *   │     trigger an immediate refetch without a full page reload.
 *   ├── QueueManager         — FIFO queue state projection (current/next/nextNext/timing)
 *   ├── LiveStreamController — YouTube live detection (server push + client poll) + override
 *   └── FailoverHandler      — error recovery chain (per-platform, not used here)
 *
 * Public surface:
 *   useBroadcastSync(options) → BroadcastSyncState
 *
 * All existing consumers (TV's useLiveSync, Mobile's useBroadcastSync adapter)
 * continue to work without modification — the hook contract is unchanged.
 *
 * Platform-specific playback (video elements, hls.js, A/B dual-buffer) lives
 * in each surface's own player component:
 *   TV:     artifacts/tv/src/components/LiveBroadcastV2.tsx
 *   Mobile: artifacts/mobile/components/V2PlayerContainer.tsx
 *   Admin:  artifacts/admin/src/playback/BroadcastPreviewV2.tsx
 */

export { useBroadcastSync } from "./useBroadcastSync";
export type { BroadcastSyncOptions } from "./useBroadcastSync";
export type { BroadcastSyncState } from "@workspace/broadcast-types";

// Engine classes — exported for platforms that want direct (non-hook) access.
export { BroadcastEngine }    from "./engine/BroadcastEngine";
export { QueueManager }       from "./engine/QueueManager";
export { StateSyncService }   from "./engine/StateSyncService";
export { LiveStreamController } from "./engine/LiveStreamController";
export { FailoverHandler }    from "./engine/FailoverHandler";
export { resolveSource, resolveUrl, isPlainVideoUrl } from "./engine/StreamResolver";
export type { ResolvedSource, ResolvedSourceKind } from "./engine/StreamResolver";
export type { QueueState }    from "./engine/QueueManager";
export type { LiveControllerState, LiveMode } from "./engine/LiveStreamController";
export type { FailoverState, FailoverHandlerOptions } from "./engine/FailoverHandler";
export type { BroadcastEngineOptions } from "./engine/types";
