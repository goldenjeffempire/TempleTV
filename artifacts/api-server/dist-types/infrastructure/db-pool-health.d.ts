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
 *   • getPoolBackpressureLevel() lets workers self-throttle before saturation
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
 * Backpressure API
 * ────────────────
 *   getPoolBackpressureLevel() → 0 | 1 | 2
 *     0 = normal    — pool healthy, no throttling needed
 *     1 = elevated  — utilization > warn threshold; workers should reduce
 *                     concurrency (e.g. halve parallel chunk uploads)
 *     2 = saturated — waiting > 0; workers should pause non-critical ops
 *
 *   isPoolSaturated() → boolean
 *     Shorthand for level === 2.  Use in tight loops before spawning work.
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
/**
 * Returns the current pool backpressure level:
 *   0 = normal    — pool healthy (<= warn threshold), full concurrency OK
 *   1 = elevated  — utilization > warn threshold; workers should reduce
 *                   concurrent DB operations (e.g. halve parallel queries)
 *   2 = saturated — queries are waiting for a connection; workers should
 *                   pause non-critical background DB work entirely
 *
 * Workers check this before spawning concurrent batches:
 *
 *   const level = getPoolBackpressureLevel();
 *   if (level >= 2) return; // back off entirely
 *   const concurrency = level >= 1 ? 1 : MAX_CONCURRENCY;
 */
export declare function getPoolBackpressureLevel(): 0 | 1 | 2;
/**
 * Returns true when the pool is fully saturated (queries are waiting).
 * Shorthand for getPoolBackpressureLevel() === 2.
 *
 * Use inside tight worker loops to skip non-critical DB work:
 *
 *   if (isPoolSaturated()) {
 *     logger.warn("pool saturated — skipping this tick");
 *     return;
 *   }
 */
export declare function isPoolSaturated(): boolean;
