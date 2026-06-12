/**
 * Rolling-window viewer drift aggregator for broadcast sync telemetry.
 *
 * Every connected player calls POST /report-position every ~30 s while
 * content is playing.  The server computes
 *
 *   driftMs = expectedPositionMs − reportedPositionMs
 *
 * and records it here.  Positive driftMs means the viewer is *behind*
 * the server's authoritative position (common on slow networks or cold
 * CPU).  Negative means the viewer is *ahead* (rare; occurs when the
 * client's clock offset is slightly over-corrected).
 *
 * The ring buffer holds RING_SIZE samples.  getStats(windowMs) filters
 * to the most recent windowMs of samples so stale data from paused or
 * closed viewers automatically falls off the stats.
 *
 * This module is intentionally free of DB I/O and external dependencies
 * — all state is in-process so it cannot block or fail the broadcast path.
 */
export interface DriftSample {
    itemId: string;
    driftMs: number;
    ts: number;
}
export interface ViewerDriftStats {
    sampleCount: number;
    windowMs: number;
    /** Median drift across viewers in the window.  Positive = behind. */
    p50Ms: number | null;
    /** 95th-percentile drift — worst-tail viewer experience. */
    p95Ms: number | null;
    /** Maximum absolute drift observed in the window. */
    maxMs: number | null;
    /** Minimum (most-ahead) drift observed in the window. */
    minMs: number | null;
    /** Mean drift across all samples in the window. */
    avgMs: number | null;
    /** Wall-clock ms of the most recent sample, or null if ring is empty. */
    lastSampleAtMs: number | null;
}
declare class DriftAggregator {
    private readonly ring;
    private head;
    private filled;
    record(itemId: string, driftMs: number): void;
    getStats(windowMs?: number): ViewerDriftStats;
    /** Total number of samples recorded since process start (for debugging). */
    getTotalRecorded(): number;
}
export declare const driftAggregator: DriftAggregator;
export {};
