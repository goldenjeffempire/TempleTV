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
    resumeSeconds?: number;
}) => Promise<V2Override>;
type StopOverrideFn = () => Promise<void>;
export interface YtShuffleFallbackInfo {
    enabled: boolean;
    active: boolean;
    videoId: string | null;
    videoTitle: string | null;
    activatedAtMs: number | null;
    /** Wall-clock ms when the currently-playing video started (set on activate/advance). */
    currentVideoStartedAtMs: number | null;
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
    /**
     * Wall-clock ms when the currently-playing video started.
     * Set in both activate() and advance(). Used by the /yt-playback-error
     * handler to enforce a minimum-play-time guard before triggering an advance,
     * preventing cascade skips through buffering or briefly-unresolvable videos.
     */
    private _currentVideoStartedAtMs;
    /**
     * Timestamp (ms) of the last activate() call that found an empty catalog.
     * Used to enforce EMPTY_CATALOG_RECHECK_MS cooldown and suppress repeat
     * no-op DB queries on every self-heal-empty tick.
     */
    private _catalogEmptyLastCheckedMs;
    /** Full shuffled playlist (populated by activate(), re-shuffled on wraparound). */
    private _shuffledPlaylist;
    /** Current index in the shuffled playlist. */
    private _playlistIndex;
    /**
     * Persisted state loaded by hydrate() at boot. Consumed exactly once by the
     * first activate() call after a restart — either it produces a successful
     * resume (same video, correct elapsed position) or it is discarded and a
     * normal fresh activation proceeds.
     */
    private _hydratedState;
    private _hydrateAttempted;
    get isActive(): boolean;
    /**
     * True when hydrate() loaded valid persisted shuffle state that has not yet
     * been consumed by activate(). The orchestrator uses this at boot to decide
     * whether to fast-path into yt-shuffle activation immediately (skipping the
     * 30-75 s empty-poll accumulation cycle) so a YouTube-only deployment resumes
     * broadcasting within milliseconds of daemon restart instead of going dark.
     */
    get hasHydratedState(): boolean;
    /**
     * Load the persisted shuffle-fallback state from the DB. Called once during
     * orchestrator boot, before the first activate(). Never throws — a failed
     * load just means the next activate() starts a fresh shuffle, which is the
     * pre-existing (safe) behaviour.
     */
    hydrate(): Promise<void>;
    /**
     * Persist the current shuffle-fallback state so a restart can resume the
     * same video at the correct elapsed position. Fire-and-forget; failures are
     * logged but never block playback.
     */
    private persistState;
    /**
     * Attempt to resume the exact video + elapsed position from a previous
     * process's persisted state (loaded by hydrate()). One-shot: the hydrated
     * state is consumed (cleared) on the first call regardless of outcome, so a
     * failed/stale resume always falls through to a normal fresh activation.
     *
     * Returns true when the resume succeeded and the caller (activate()) should
     * return immediately; false when the caller should proceed with a fresh
     * catalog query + shuffle.
     */
    private tryResumeFromHydratedState;
    /** Override ID applied by this module — used by the orchestrator to check before stopping. */
    get activeOverrideId(): string | null;
    /**
     * Activate the YouTube shuffle fallback.
     *
     * Queries managed_videos for YouTube catalog entries, Fisher-Yates shuffles
     * them, and starts the first video with a 20-minute finite-duration override.
     * Idempotent: silently no-ops when already active or when YOUTUBE_SHUFFLE_FALLBACK_DISABLE=true.
     *
     * Empty-catalog backoff: when the DB query returns 0 rows the result is
     * cached for EMPTY_CATALOG_RECHECK_MS (60 s).  The selfHealEmptyTimer calls
     * activate() every 5 s; without this guard that produces 12 no-op SELECT
     * queries/min and Drizzle query-builder object churn during the V8 JIT
     * warm-up window, amplifying the startup heap-slope alert.
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
    /**
     * Refresh the in-memory YouTube catalog playlist after a sync has added or
     * updated videos.  Called by youtube-sync.service after a successful sync.
     *
     * Behaviour:
     *   - Not active: silently no-ops; activate() already queries fresh on activation.
     *   - Active + activating: no-op to avoid concurrent catalog loads.
     *   - Active: queries the full YouTube catalog from DB, finds entries not
     *     already in the shuffled playlist (by youtubeId), and inserts them at
     *     a random position AFTER the current playlistIndex.  Current playback
     *     is not interrupted.  On the next wraparound the full catalog is
     *     re-shuffled, so new videos naturally enter the rotation.
     */
    refreshCatalog(): Promise<void>;
    /**
     * Return the next playlist entry (the video AFTER the currently-playing one)
     * without advancing the index.  Used by the orchestrator to include
     * `nextYtVideoId` in V2Snapshot so clients can preload the next YouTube
     * iframe before the current one ends.
     *
     * Returns null when the shuffle is not active, the playlist is empty, or
     * the playlist has only one entry (next === current).
     */
    peekNext(): {
        youtubeId: string;
        title: string;
    } | null;
    /**
     * Explicitly persist the current YouTube shuffle state to the DB and await
     * the result. Called from the orchestrator's graceful-shutdown path
     * (flushCheckpointForShutdown) so a process exit within milliseconds of a
     * video advance cannot leave the DB with stale ytShuffleState.
     *
     * The periodic persistState() calls in advance() are fire-and-forget for
     * performance; this method is the one synchronous save that runs exactly
     * once, just before the process exits.  Always resolves (never throws) —
     * errors are logged and swallowed so a DB hiccup cannot block shutdown.
     *
     * No-ops immediately when the shuffle is not active (nothing useful to save).
     */
    flushStateForShutdown(): Promise<void>;
    /** Snapshot for the /health endpoint and admin observability. */
    getInfo(): YtShuffleFallbackInfo;
}
export declare const ytShuffleFallback: YtShuffleFallback;
export {};
