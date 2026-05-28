/**
 * viewer-slope-monitor — slope-based stream-health detector.
 *
 * Samples `broadcastEngine.getViewerCount()` every minute and keeps a rolling
 * ring buffer of the last MAX_SAMPLES data points.  When the viewer count drops
 * by more than DROP_THRESHOLD viewers/minute for CONSECUTIVE_THRESHOLD
 * consecutive intervals the monitor emits a `stream-health-degraded` admin
 * event and sets the `degraded` flag.  The flag clears automatically once the
 * slope becomes non-negative (recovery).
 *
 * Thread safety: Node.js is single-threaded — no locking needed.
 */
export interface ViewerSample {
    ts: number;
    count: number;
}
export interface ViewerSlopeStatus {
    degraded: boolean;
    degradedSince: number | null;
    consecutiveDrops: number;
    samples: ViewerSample[];
    viewerDeltaPerMin: number | null;
    checkedAt: string;
}
export declare function getViewerSlopeStatus(): ViewerSlopeStatus;
export declare function startViewerSlopeMonitor(): void;
export declare function stopViewerSlopeMonitor(): void;
