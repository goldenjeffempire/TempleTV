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
 *
 * Pattern mirrors transcoder.dispatcher.ts: start()/stop() lifecycle,
 * setTimeout chain (not setInterval), single-replica-safe.
 */
declare class YouTubeSyncDispatcher {
    private timer;
    private running;
    private stopped;
    get intervalMs(): number;
    start(): void;
    stop(): void;
    private scheduleNext;
    private runOnce;
    /**
     * Trigger an immediate out-of-band sync (e.g. from the admin panel or
     * a PubSubHubbub webhook notification for a new upload).
     * Returns the result or re-throws on failure.
     */
    triggerNow(): Promise<Awaited<ReturnType<typeof syncYouTubeChannel>>>;
}
export declare const youtubeSyncDispatcher: YouTubeSyncDispatcher;
export {};
