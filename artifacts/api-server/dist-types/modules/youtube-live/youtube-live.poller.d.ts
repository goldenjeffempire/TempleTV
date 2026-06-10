/**
 * YouTube Live Status Poller
 *
 * Detection strategy (in priority order):
 *   1. YouTube Data API v3 — when YOUTUBE_API_KEY + YOUTUBE_CHANNEL_ID are set.
 *      Calls /search?part=snippet&channelId=…&eventType=live&type=video.
 *      Cost: 100 quota units per call; default poll interval 90 s.
 *   2. RSS + yt:liveBroadcastContent — when no API key but YOUTUBE_CHANNEL_ID set.
 *      Parses https://www.youtube.com/feeds/videos.xml?channel_id=…
 *      Quota-free but only detects YouTube-native live events (not HLS overrides).
 *   3. Disabled — neither env var set. Returns { isLive: false, detectionMethod: "no-channel-configured" }.
 *
 * The singleton `ytPoller` is started by youtube-live.routes.ts on first SSE
 * connection and stopped on server shutdown (future). Routes call `ytPoller.getState()`
 * for REST responses and subscribe via `ytPoller.subscribe()` for SSE push.
 */
import EventEmitter from "node:events";
export interface YtLiveState {
    isLive: boolean;
    videoId: string | null;
    title: string | null;
    viewerCount: number | null;
    checkedAt: number;
    detectionMethod: "youtube-api-v3" | "youtube-rss" | "no-channel-configured" | "youtube-live-poller-disabled-in-build" | "api-error" | "rss-error";
}
type Listener = (state: YtLiveState) => void;
declare class YtLivePoller extends EventEmitter {
    private state;
    private timer;
    private running;
    private _subs;
    private _lastSafetyNetMs;
    private _searchCooldownUntilMs;
    private _enrichCooldownUntilMs;
    getState(): YtLiveState;
    subscribe(fn: Listener): () => void;
    start(): void;
    stop(): void;
    private poll;
    /**
     * Fetch concurrent viewer count for a live video via videos.list
     * (liveStreamingDetails part).  Cost: 1 quota unit per call.
     *
     * On error, sets a 30-minute backoff so a transient API problem does not
     * silently consume quota units every 60 seconds for the rest of the broadcast.
     * Returns null on any error; callers fall back to the RSS-derived state.
     */
    private fetchViewerCount;
    /**
     * Safety-net search.list call (100 quota units).
     * Only invoked by poll() at most once per SAFETY_NET_INTERVAL_MS (2 h)
     * to catch streams RSS has not yet indexed.
     */
    private pollApi;
    private pollRss;
    private setState;
}
export declare const ytPoller: YtLivePoller;
export {};
