/**
 * Re-admit system-deactivated queue items that are now admissible under
 * the current broadcast-eligibility policy.
 *
 * Uses a JOIN to managed_videos so we only re-enable items that:
 *   • have at least one playable URL (on the queue row OR the video row)
 *   • have a confirmed blob (s3_mirrored_at IS NOT NULL) — raw MP4 is
 *     broadcast-eligible immediately once the blob is committed; faststart
 *     status is NOT an admission gate in the MP4-only pipeline.
 *   • are NOT CORRUPT_SOURCE / SOURCE_MISSING / ASSEMBLY_FAILED
 *     (those are the only codes that warrant DB-level deactivation; they
 *     are re-deactivated by the validator on the next cycle and re-enabling
 *     them here would just create a pointless oscillation).
 *
 * Operator-deactivated items (validatorDeactivatedReason IS NULL) are
 * intentionally left alone — this function only touches rows that the
 * validator or a prior automated process disabled.
 *
 * This function is exported so the sync-library endpoint can run an
 * immediate re-activation pass without waiting for the 10-minute
 * workerSupervisor interval.
 */
export declare function reactivateSystemDeactivated(): Promise<number>;
export interface QueueHealthGuardStatus {
    lastCheckAtMs: number | null;
    lastActiveCount: number | null;
    lastRebuildAtMs: number | null;
    totalRebuilds: number;
    lastRebuildAdded: number;
    belowThreshold: boolean;
    threshold: number;
}
declare class QueueHealthGuardImpl {
    private lastCheckAtMs;
    private lastActiveCount;
    private lastRebuildAtMs;
    private totalRebuilds;
    private lastRebuildAdded;
    private belowThreshold;
    private lastOpsAlertAtMs;
    private adaptiveTimer;
    getStatus(): QueueHealthGuardStatus;
    scan(): Promise<void>;
}
export declare const queueHealthGuard: QueueHealthGuardImpl;
export declare function getQueueHealthGuardStatus(): QueueHealthGuardStatus;
export {};
