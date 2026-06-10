/**
 * Database connection pool health monitor.
 *
 * Periodically samples the pg pool's utilization (active connections,
 * idle connections, waiting queue depth) and emits an "ops-alert" SSE event
 * when the pool exceeds the configured warning threshold.  This gives operators
 * early warning of connection exhaustion before queries start timing out or
 * piling up behind a blocked pool.
 *
 * Follows the same pattern as memory-watchdog.ts and event-loop-lag.ts:
 *   • installDbPoolHealthMonitor() / uninstallDbPoolHealthMonitor() for lifecycle
 *   • getDbPoolHealthStatus() exposes live state for /health / /diagnostics
 *
 * Alert tiers
 * ───────────
 *   1. HIGH utilization (active/max > DB_POOL_WARN_UTILIZATION, default 80%):
 *      emits ops-alert with level="warn" when sustained for SUSTAIN_SAMPLES
 *      consecutive readings.  Clears when utilization drops below 60%.
 *
 *   2. WAITING connections (pool.waitingCount > 0):
 *      emits ops-alert with level="critical" immediately (no sustain buffer)
 *      because waiting queries mean callers are already stalling.
 *
 * No DB queries are made by this monitor — it reads synchronous counters
 * directly from the pg Pool instance.
 */
export declare function installDbPoolHealthMonitor(): void;
export declare function uninstallDbPoolHealthMonitor(): void;
export interface DbPoolHealthStatus {
    active: number;
    idle: number;
    waiting: number;
    max: number;
    utilizationRatio: number;
    utilizationPct: number;
    highUtilAlertActive: boolean;
    waitingAlertActive: boolean;
    highUtilAlertCount: number;
    waitingAlertCount: number;
    lastSampleAtMs: number;
    warnThreshold: number;
}
export declare function getDbPoolHealthStatus(): DbPoolHealthStatus;
