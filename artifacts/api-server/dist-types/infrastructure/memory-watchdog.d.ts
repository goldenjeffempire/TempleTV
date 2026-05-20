/**
 * F17: Memory pressure watchdog.
 *
 * Samples process.memoryUsage().rss on a fixed interval and emits a
 * structured "ops-alert" SSE event via the broadcastEngine when RSS
 * exceeds the MEMORY_WARN_RSS_MB threshold. The admin console receives
 * these events and can surface a warning banner so operators know about
 * impending OOM before the process is killed.
 *
 * The watchdog also maintains module-level state that the
 * GET /admin/diagnostics/memory endpoint reads to populate the
 * `watchdog` section of the response (replacing the previous
 * hardcoded `enabled: false`).
 */
export interface WatchdogState {
    enabled: boolean;
    sampleIntervalMs: number;
    thresholds: {
        rssAlertMb: number;
        rssRecoveryMb: number;
    };
    current: {
        rssMb: number;
        consecutiveRssOver: number;
    };
    alerts: {
        rssAlertActive: boolean;
    };
}
export declare function startMemoryWatchdog(): void;
export declare function stopMemoryWatchdog(): void;
export declare function getWatchdogState(): WatchdogState;
