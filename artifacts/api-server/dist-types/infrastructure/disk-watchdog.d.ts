/**
 * Disk usage watchdog for the scratch partition.
 *
 * Periodically samples statfs(storagePaths.scratch) and:
 *   1. Logs a structured warning when usage > SCRATCH_WARN_PERCENT (default 70 %)
 *   2. Fires an ops-alert + emergency stale-dir sweep when > SCRATCH_ALERT_PERCENT (default 85 %)
 *   3. Exports isDiskConstrained() so transcoder / faststart can abort pre-flight
 *      rather than starting a job that will exhaust the filesystem mid-encode.
 *
 * The watchdog is intentionally non-fatal: a statfs failure degrades to a warn
 * log and clears the constrained flag so jobs are not permanently blocked by a
 * momentary filesystem error.
 */
/**
 * Returns true when scratch disk usage is at or above SCRATCH_ALERT_PERCENT.
 * Callers use this as a pre-flight gate before starting disk-heavy operations.
 */
export declare function isDiskConstrained(): boolean;
export interface DiskWatchdogState {
    scratchPath: string;
    usedPercent: number;
    totalMb: number;
    freeMb: number;
    constrained: boolean;
    warnPercent: number;
    alertPercent: number;
    sampleCount: number;
}
export declare function getDiskWatchdogState(): DiskWatchdogState;
export declare function startDiskWatchdog(): void;
export declare function stopDiskWatchdog(): void;
