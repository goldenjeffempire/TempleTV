/**
 * In-memory ring-buffer analytics store for broadcast playback events.
 *
 * Records stalls, skips, natural ends, recoveries, preloads, and
 * session lifecycle events with millisecond timestamps. No DB persistence
 * — the orchestrator event log already stores business events; this store
 * is a fast in-process aggregation layer for the /analytics REST endpoint.
 *
 * Ring buffer: once capacity (RING_SIZE) is reached, oldest events are
 * overwritten. getReport(windowMs) filters to a configurable time window
 * so consumers only see recent activity regardless of buffer fill level.
 */
export type AnalyticsEventType = "stall" | "skip" | "natural_end" | "recovery" | "preload_fired" | "session_open" | "session_close" | "url_blocked" | "url_cleared" | "reload" | "item_advanced";
export interface AnalyticsEvent {
    type: AnalyticsEventType;
    itemId: string | null;
    itemTitle: string | null;
    ts: number;
    meta?: Record<string, unknown>;
}
export interface ItemAnalyticsStats {
    itemId: string;
    itemTitle: string | null;
    stalls: number;
    skips: number;
    naturalEnds: number;
    recoveries: number;
    preloadsFired: number;
    advances: number;
    lastEventAtMs: number | null;
}
export interface SessionCounters {
    active: number;
    peakInLast5Min: number;
    total: number;
}
export interface AnalyticsReport {
    windowMs: number;
    from: number;
    to: number;
    totalEvents: number;
    counts: Partial<Record<AnalyticsEventType, number>>;
    byItem: ItemAnalyticsStats[];
    sessions: SessionCounters;
    lastEventAtMs: number | null;
    bufferUtilizationPct: number;
}
declare class PlaybackAnalyticsStore {
    private readonly ring;
    private head;
    private filled;
    private activeSessions;
    private totalSessions;
    private peakSessions;
    private peakResetAtMs;
    record(ev: AnalyticsEvent): void;
    getReport(windowMs?: number): AnalyticsReport;
    getActiveSessions(): number;
}
export declare const playbackAnalytics: PlaybackAnalyticsStore;
export {};
