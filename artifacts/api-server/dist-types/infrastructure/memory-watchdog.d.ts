/**
 * Memory pressure watchdog.
 *
 * Samples process.memoryUsage() on a fixed interval and:
 *
 *   1. RSS alert — emits a structured "ops-alert" SSE event when RSS
 *      exceeds MEMORY_WARN_RSS_MB for SUSTAIN_SAMPLES consecutive readings.
 *      Recovers when RSS drops 200 MB below the threshold.
 *
 *   2. External memory slope alert — tracks the rate of change of the
 *      `external` heap (native bindings, Buffer allocations) over a
 *      rolling SLOPE_WINDOW_SAMPLES window and alerts when sustained
 *      growth exceeds EXTERNAL_GROWTH_ALERT_MB_PER_MIN.
 *
 *   3. Critical escalation — in production only, voluntarily exits after
 *      CRITICAL_SAMPLES_FOR_EXIT consecutive over-threshold RSS samples so
 *      the supervisor (Replit, k8s) can restart cleanly.
 *
 * State is exposed via getWatchdogState() for the
 * GET /admin/diagnostics/memory endpoint.
 */
export interface WatchdogState {
    enabled: boolean;
    sampleIntervalMs: number;
    thresholds: {
        rssAlertMb: number;
        rssRecoveryMb: number;
        externalGrowthAlertMbPerMin: number;
        externalGrowthRecoveryMbPerMin: number;
        sustainSamples: number;
        slopeWindowSamples: number;
    };
    current: {
        rssMb: number;
        consecutiveRssOver: number;
        externalGrowthMbPerMin: number | null;
        consecutiveSlopeOver: number;
    };
    alerts: {
        rssAlertActive: boolean;
        slopeAlertActive: boolean;
    };
}
export declare function startMemoryWatchdog(): void;
export declare function stopMemoryWatchdog(): void;
export declare function getWatchdogState(): WatchdogState;
