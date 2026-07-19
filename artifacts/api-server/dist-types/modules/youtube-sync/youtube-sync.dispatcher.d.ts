import { syncYouTubeChannel } from "./youtube-sync.service.js";
/**
 * Background YouTube channel sync dispatcher.
 *
 * Runs at a configurable interval (YOUTUBE_SYNC_INTERVAL_MINS env var,
 * default 15 minutes). Fetches all videos from the @TEMPLETVJCTM channel
 * via YouTube Data API v3 (RSS fallback when no API key is set) and
 * upserts them into the managed_videos table so every platform (TV,
 * mobile, admin) sees fresh content automatically.
 *
 * The PubSubHubbub webhook (youtube-webhook.routes.ts) supplements this
 * by triggering an immediate sync when YouTube notifies us of a new upload,
 * giving near-instant propagation without relying solely on the interval.
 * With the webhook active, 15-minute polling is purely a safety net —
 * new videos appear within seconds of the YouTube notification.
 */
declare class YouTubeSyncDispatcher {
    get intervalMs(): number;
    /**
     * Single sync pass — called by the supervisor on each interval tick.
     *
     * Uses the service-level semaphore (`isSyncInProgress`) so the scheduled
     * path and the manual `triggerNow` path share the same concurrency guard
     * and can never run simultaneously. Errors are re-thrown so the supervisor
     * can count consecutive failures for circuit-breaking; the warn log here
     * provides structured context before the supervisor adds its own entry.
     */
    runOnce(): Promise<void>;
    /**
     * Trigger an immediate out-of-band sync (e.g. from the admin panel or
     * a PubSubHubbub webhook notification for a new upload).
     * Throws if a sync is already running (caller should check isSyncInProgress()
     * first or catch the error and surface it as a 409).
     */
    triggerNow(): Promise<Awaited<ReturnType<typeof syncYouTubeChannel>>>;
}
export declare const youtubeSyncDispatcher: YouTubeSyncDispatcher;
/**
 * Register the YouTube sync dispatcher with WorkerSupervisor.
 *
 * Called from startSupervisedWorkers() in broadcast-v2/index.ts when
 * YOUTUBE_SYNC_DISABLE is not set. The supervisor provides circuit breaking
 * (5 consecutive failures → 10-min open), deadman timeouts, and health
 * metrics — replacing the old manual setTimeout approach.
 */
export declare function startYoutubeSyncDispatcher(): void;
export {};
