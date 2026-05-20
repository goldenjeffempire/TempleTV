import { EventEmitter } from "node:events";
export interface BroadcastItem {
    id: string;
    videoId: string | null;
    youtubeId: string;
    title: string;
    thumbnailUrl: string;
    durationSecs: number;
    localVideoUrl: string | null;
    /**
     * HLS master playlist URL from the transcoder. Populated via a LEFT JOIN
     * with the `managed_videos` table on `video_id`. Players should prefer
     * this over `localVideoUrl` (raw MP4) because HLS supports adaptive
     * bitrate, mid-stream joining, and proper seeking — all critical for live
     * broadcast playback.
     */
    hlsMasterUrl?: string | null;
    videoSource: string;
    /** ISO timestamp when this item starts playing in viewers' clients. */
    startsAt: string;
    /** ISO timestamp when this item ends. `startsAt + durationSecs`. */
    endsAt: string;
}
export interface BroadcastSnapshot {
    channelId: string;
    generatedAt: string;
    current: BroadcastItem | null;
    next: BroadcastItem | null;
    upcoming: BroadcastItem[];
    preloadAt: string | null;
    failoverHlsUrl: string | null;
}
export type BroadcastEvent = {
    type: "snapshot";
    data: BroadcastSnapshot;
} | {
    type: "preload";
    data: {
        channelId: string;
        next: BroadcastItem;
    };
} | {
    type: "advance";
    data: {
        channelId: string;
        current: BroadcastItem;
    };
} | {
    type: "viewer-count";
    data: {
        channelId: string;
        count: number;
    };
};
/**
 * Continuous-broadcast queue engine.
 *
 * Treats `broadcast_queue` as a circular buffer of programs ordered by
 * `(is_active, sort_order)`. The engine maintains a wall-clock view of
 * which item is currently airing across all clients so that a phone
 * tuning in at second 1782 of a 30-minute sermon joins at second 1782,
 * not from the beginning.
 *
 * Zero-delay transitions:
 *   • A `preload` event is broadcast `BROADCAST_PRELOAD_LEAD_MS` before
 *     the current item ends, giving every connected client time to
 *     warm an A/B inactive video element with the next item's source.
 *   • At transition the `advance` event flips the active slot.
 *   • Both events ride the same in-process EventEmitter, which the SSE
 *     and WS gateways subscribe to.
 *
 * Self-recovery:
 *   • A 30-second watchdog interval checks whether the scheduleNext()
 *     timer chain is still alive. If the chain died (timer = null while
 *     items are queued), it restarts scheduleNext() automatically.
 *   • When the queue is empty at start, the engine polls the DB every
 *     30 seconds and auto-starts the moment items are added.
 *   • reload() restarts a stopped engine whenever the queue goes from
 *     empty → populated (e.g., after an admin adds the first video).
 *
 * Failover: any client may render the configured `failoverHlsUrl` if
 * its primary playback errors. The URL travels in every snapshot.
 */
declare class BroadcastEngine extends EventEmitter {
    private items;
    private cycleStartedAt;
    private cycleDurationMs;
    private timer;
    private preloadTimer;
    /** Periodic watchdog — detects a dead scheduleNext() chain and restarts it. */
    private watchdogInterval;
    /** Polls the DB when the queue is empty so the engine auto-starts on first add. */
    private emptyQueueRetryInterval;
    /**
     * Persists cycle position to DB.
     * Raised from 10 s to 30 s — reduces idle DB writes 3× with no impact on
     * restart accuracy (v2 orchestrator owns precision state; v1 checkpoint is
     * a coarse fallback used only by the legacy overlay surfaces).
     */
    private checkpointInterval;
    /** Wall-clock ms of the last emitSnapshot() call — used by the watchdog. */
    private lastSnapshotMs;
    private viewerCount;
    readonly channelId = "temple-tv-live";
    constructor();
    /** How long the watchdog waits before considering the engine stale. */
    private static readonly WATCHDOG_STALE_MS;
    /** Watchdog + empty-queue retry poll interval. */
    private static readonly WATCHDOG_INTERVAL_MS;
    start(): Promise<void>;
    stop(): void;
    /**
     * Re-read the queue from the database. Called on start, on admin
     * mutation, and on schedule failure recovery.
     *
     * Self-heal: if the engine was idle (timer = null) and the reload brings
     * in items, automatically start the schedule chain. This covers the case
     * where an admin adds the first video after the server started with an
     * empty queue.
     */
    reload(): Promise<void>;
    snapshot(): BroadcastSnapshot;
    setViewerCount(n: number): void;
    getViewerCount(): number;
    /** Milliseconds since the last snapshot was emitted. Used by /health/live. */
    getLastSnapshotAgeMs(): number;
    /** True if the schedule chain is running (timer is set or items.length === 0). */
    isRunning(): boolean;
    /**
     * Push a fresh snapshot event to all subscribed SSE/WS listeners without
     * touching the schedule chain or reloading from the DB. Used by the SSE
     * gateway when the override bus signals a change so SSE clients get an
     * immediate "something changed" ping and can refetch /live/status.
     */
    pushSnapshot(): void;
    /**
     * Returns internal cycle timing state for the `/admin/broadcast/continuity`
     * probe. Exposes the wall-clock anchor and derived cycle metrics so operators
     * can verify that admin queue mutations preserved the broadcast position.
     *
     * All timestamps are ISO-8601 strings; all durations are milliseconds unless
     * a `Secs` suffix indicates seconds.
     */
    getContinuityState(): {
        cycleStartedAt: string;
        cycleDurationMs: number;
        cycleElapsedMs: number;
        cycleProgressPercent: number;
        itemCount: number;
        engineRunning: boolean;
        lastSnapshotAgeMs: number;
        timerArmed: boolean;
        preloadTimerArmed: boolean;
    };
    private _scheduleNext;
    private _emitSnapshot;
    /**
     * Self-healing watchdog. Runs every 30 s; if the schedule chain has been
     * silent for > 90 s while items are queued, it restarts _scheduleNext().
     * This guards against the (rare) case where a setTimeout callback throws
     * an uncaught error that prevents the chain from re-arming itself.
     */
    private _startWatchdog;
    /**
     * Polls the DB every 30 s when the queue is empty so the engine
     * auto-starts the moment an admin adds the first video.
     */
    private _startEmptyQueueRetry;
    /**
     * Starts a periodic interval that saves the current broadcast position to
     * the checkpoint table every 10 s. On server restart, reload() reads this
     * checkpoint and restores cycleStartedAt so the broadcast resumes at the
     * correct real-time position rather than jumping to item 0.
     */
    private _startCheckpointSave;
    private _saveCheckpoint;
}
export declare const broadcastEngine: BroadcastEngine;
export {};
