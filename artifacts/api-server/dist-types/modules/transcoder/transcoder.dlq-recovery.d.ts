/**
 * Autonomous DLQ Recovery Worker
 *
 * Automatically requeues dead-lettered transcoding jobs on a 3-tier
 * exponential cooldown schedule, eliminating the need for manual operator
 * intervention on transient failures.
 *
 * Recovery tiers (measured from deadLetteredAt):
 *   Tier 1 (requeueCount = 0): requeue after 4 h
 *   Tier 2 (requeueCount = 1): requeue after 12 h
 *   Tier 3 (requeueCount = 2): requeue after 24 h
 *   Tier 4+ (requeueCount ≥ 3): mark permanentFailure=true, emit ops-alert
 *
 * Terminal error codes (CORRUPT_SOURCE, SOURCE_MISSING) are never
 * auto-requeued — they require a new source upload.
 *
 * When a requeued job fails again and returns to dead_letter status the
 * same DLQ entry is reused (the dispatcher's onConflictDoUpdate refreshes
 * the failure fields and clears requeuedAt) and the recovery worker picks
 * it up on the next sweep with an incremented requeueCount.
 */
export declare class DlqRecoveryWorker {
    private timer;
    private stopped;
    private sweeping;
    start(): void;
    stop(): void;
    /** Force an immediate sweep (e.g. after a manual requeue / on startup). */
    nudge(): void;
    private scheduleNext;
    private runSweepSafe;
    /**
     * Sweep the dead-letter table for entries eligible for auto-recovery.
     * Eligible = not permanently failed, not a terminal error code, and
     * either never requeued OR the requeued job has re-failed (status=dead_letter).
     */
    sweep(): Promise<void>;
    private processEntry;
    getStatus(): {
        enabled: boolean;
        intervalMs: number;
        tiers: readonly number[];
        stopped: boolean;
        sweeping: boolean;
    };
}
export declare const dlqRecoveryWorker: DlqRecoveryWorker;
