/**
 * YouTube Catalog Shuffle Fallback
 *
 * Dead-air backstop that activates when the broadcast queue has no locally
 * playable content.  Queries managed_videos for YouTube catalog entries
 * (videoSource='youtube', youtubeId IS NOT NULL), Fisher-Yates shuffles them,
 * and applies a finite-duration YouTube override frame to the orchestrator so
 * viewers see content while local uploads are unavailable.
 *
 * Lifecycle:
 *   activate()   — called by the orchestrator self-heal timer after
 *                  scanLibraryAndEnqueue returns 0 and the queue stays empty.
 *                  Starts the first shuffled video with a 20-minute override.
 *   advance()    — called by the orchestrator self-heal timer when the shuffle
 *                  is active but the running override has ended (natural end).
 *                  Moves to the next playlist position immediately, re-shuffling
 *                  on wraparound for ongoing variety.
 *   deactivate() — called by the orchestrator reloadInner when at least one
 *                  locally-playable queue item is resolved.  Auto-clears the
 *                  running override (only if IDs match — never evicts operator
 *                  overrides).
 *
 * Design constraints:
 *   - No module-init import of broadcastOrchestrator (avoids circular dep).
 *     The orchestrator passes start/stop callbacks at call time.
 *   - Fisher-Yates shuffle for quality randomness with no native dependency.
 *   - Idempotent activate(): silently no-ops when already active or activating.
 *   - Safe advance()/deactivate(): silently no-ops when not active.
 *   - All DB / override calls are try/catch — errors never crash the orchestrator.
 *   - Emits "broadcast-dead-air-fallback" / "broadcast-dead-air-recovered" on
 *     adminEventBus so admin SSE clients and the activity log can surface state.
 */
import type { V2Override } from "../domain/types.js";
type StartOverrideFn = (opts: {
    kind: V2Override["kind"];
    url: string;
    title: string;
    endsAtMs: number | null;
    resumeQueueOnEnd: boolean;
}) => Promise<V2Override>;
type StopOverrideFn = () => Promise<void>;
export interface YtShuffleFallbackInfo {
    enabled: boolean;
    active: boolean;
    videoId: string | null;
    videoTitle: string | null;
    activatedAtMs: number | null;
    lastDeactivatedAtMs: number | null;
    activateCount: number;
    advanceCount: number;
    deactivateCount: number;
    catalogSize: number;
    playlistIndex: number;
    lastError: string | null;
}
declare class YtShuffleFallback {
    private _active;
    private _activating;
    private _activeOverrideId;
    private _currentVideoId;
    private _currentVideoTitle;
    private _activatedAtMs;
    private _lastDeactivatedAtMs;
    private _activateCount;
    private _advanceCount;
    private _deactivateCount;
    private _lastError;
    /** Full shuffled playlist (populated by activate(), re-shuffled on wraparound). */
    private _shuffledPlaylist;
    /** Current index in the shuffled playlist. */
    private _playlistIndex;
    get isActive(): boolean;
    /** Override ID applied by this module — used by the orchestrator to check before stopping. */
    get activeOverrideId(): string | null;
    /**
     * Activate the YouTube shuffle fallback.
     *
     * Queries managed_videos for YouTube catalog entries, Fisher-Yates shuffles
     * them, and starts the first video with a 20-minute finite-duration override.
     * Idempotent: silently no-ops when already active or when YOUTUBE_SHUFFLE_FALLBACK_DISABLE=true.
     */
    activate(startOverride: StartOverrideFn): Promise<void>;
    /**
     * Advance to the next video in the shuffled playlist.
     *
     * Called by the orchestrator self-heal timer when the shuffle fallback is
     * active but the running override has naturally ended (endsAtMs expired +
     * this.override === null).  Starts the next video immediately with a new
     * 20-minute finite override, re-shuffling the full catalog on wraparound.
     *
     * Idempotent: silently no-ops when not active or already activating.
     */
    advance(startOverride: StartOverrideFn): Promise<void>;
    /**
     * Deactivate the YouTube shuffle fallback and stop the override.
     * Idempotent: silently no-ops when not active.
     * Calls the provided stopOverride callback — caller should guard this with an
     * override-ID check so operator-applied overrides are never stopped.
     */
    deactivate(stopOverride: StopOverrideFn): Promise<void>;
    /** Snapshot for the /health endpoint and admin observability. */
    getInfo(): YtShuffleFallbackInfo;
}
export declare const ytShuffleFallback: YtShuffleFallback;
export {};
