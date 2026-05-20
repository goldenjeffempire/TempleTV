import { EventEmitter } from "node:events";
export interface ChannelQueueItem {
    id: string;
    channelId: string;
    videoId: string | null;
    youtubeId: string;
    title: string;
    thumbnailUrl: string;
    durationSecs: number;
    localVideoUrl: string | null;
    hlsMasterUrl: string | null;
    videoSource: string;
    startsAt: string;
    endsAt: string;
}
export interface ChannelSnapshot {
    channelId: string;
    generatedAt: string;
    current: ChannelQueueItem | null;
    next: ChannelQueueItem | null;
    upcoming: ChannelQueueItem[];
    preloadAt: string | null;
    failoverHlsUrl: string | null;
}
export type ChannelBroadcastEvent = {
    type: "snapshot";
    data: ChannelSnapshot;
} | {
    type: "preload";
    data: {
        channelId: string;
        next: ChannelQueueItem;
    };
} | {
    type: "advance";
    data: {
        channelId: string;
        current: ChannelQueueItem;
    };
} | {
    type: "viewer-count";
    data: {
        channelId: string;
        count: number;
    };
};
/**
 * Per-channel broadcast engine for non-primary Temple TV channels.
 * Mirrors the behavior of the primary BroadcastEngine but queries
 * `channel_queue` filtered by channelId.
 */
export declare class ChannelEngine extends EventEmitter {
    readonly channelId: string;
    private items;
    private cycleStartedAt;
    private cycleDurationMs;
    private timer;
    private preloadTimer;
    private watchdogInterval;
    private emptyQueueRetryInterval;
    private lastSnapshotMs;
    private viewerCount;
    constructor(channelId: string);
    start(): Promise<void>;
    stop(): void;
    reload(): Promise<void>;
    snapshot(): ChannelSnapshot;
    setViewerCount(n: number): void;
    getViewerCount(): number;
    isRunning(): boolean;
    pushSnapshot(): void;
    private _scheduleNext;
    private _emitSnapshot;
    private _startWatchdog;
    private _startEmptyQueueRetry;
}
