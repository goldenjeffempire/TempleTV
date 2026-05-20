/**
 * stream-health — rolling in-memory telemetry aggregator for broadcast quality.
 *
 * Clients POST samples to /broadcast/playback-telemetry; this module keeps
 * a 5-minute sliding window of stall events, playback errors, buffer levels,
 * startup times, and per-platform breakdowns so the admin dashboard can
 * surface meaningful streaming KPIs without a database write per sample.
 *
 * Thread safety: Node.js is single-threaded — no locking needed.
 */
export interface TelemetrySample {
    platform?: string;
    stalls?: number;
    bufferedSecs?: number;
    bitrateKbps?: number;
    droppedFrames?: number;
    sessionId?: string;
    startupMs?: number;
    event?: string;
    videoId?: string;
    errorType?: string;
}
export interface StreamHealthStats {
    windowMs: number;
    totalStalls: number;
    totalErrors: number;
    avgBufferedSecs: number | null;
    avgBitrateKbps: number | null;
    activeSessions: number;
    platformBreakdown: Record<string, number>;
    checkedAt: string;
}
export interface StreamHealthDetailedStats extends StreamHealthStats {
    /** Startup time percentiles in milliseconds */
    startupMs: {
        p50: number | null;
        p95: number | null;
        avg: number | null;
        sampleCount: number;
    };
    /** Total dropped frames across all sessions in the window */
    totalDroppedFrames: number;
    /** Error breakdown by category (network, media, fatal, etc.) */
    errorsByType: Record<string, number>;
    /** Errors grouped by client platform */
    errorsByPlatform: Record<string, number>;
    /** Stall rate: stalls per active session */
    stallsPerSession: number | null;
    /** Buffer health: % of samples above 10s buffered */
    bufferHealthPct: number | null;
    /** Total startup events tracked in this window */
    startupEventCount: number;
}
export declare const streamHealthAggregator: {
    record(sample: TelemetrySample): void;
    recordError(platform?: string, errorType?: string): void;
    getStats(): StreamHealthStats;
    getDetailedStats(): StreamHealthDetailedStats;
};
