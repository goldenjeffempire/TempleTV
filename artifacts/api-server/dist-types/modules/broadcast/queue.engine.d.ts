import { EventEmitter } from "node:events";
export interface BroadcastItem {
    id: string;
    videoId: string | null;
    youtubeId: string;
    title: string;
    thumbnailUrl: string;
    durationSecs: number;
    localVideoUrl: string | null;
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
 * Failover: any client may render the configured `failoverHlsUrl` if
 * its primary playback errors. The URL travels in every snapshot.
 */
declare class BroadcastEngine extends EventEmitter {
    private items;
    private currentIndex;
    private cycleStartedAt;
    private cycleDurationMs;
    private timer;
    private preloadTimer;
    private viewerCount;
    readonly channelId = "temple-tv-live";
    start(): Promise<void>;
    stop(): void;
    /**
     * Re-read the queue from the database. Called on start, on admin
     * mutation, and on schedule failure recovery.
     */
    reload(): Promise<void>;
    snapshot(): BroadcastSnapshot;
    setViewerCount(n: number): void;
    getViewerCount(): number;
    private scheduleNext;
    private emitSnapshot;
}
export declare const broadcastEngine: BroadcastEngine;
export {};
