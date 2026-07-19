export type RecoveryTier = "already_present" | "reassembly_reenrolled" | "deactivated" | "not_found";
export interface RecoveryResult {
    ok: boolean;
    tier?: RecoveryTier;
    reason?: string;
}
export interface RecoveryStats {
    attempted: number;
    recovered: number;
    failed: number;
    itemsChecked: number;
    blobsVerified: number;
    gapsFound: number;
    recoveries: number;
    orphanedBlobCount: number;
    deletedOrphanBlobCount: number;
    consecutiveErrors: number;
    lastRunAt: number | null;
    lastPassElapsedMs: number | null;
}
export interface GapRecord {
    queueId: string;
    videoId: string | null;
    reason: string;
}
export interface FailureRecord {
    consecutiveGaps: number;
    lastGapAtMs: number | null;
    reason: string | null;
}
declare class StorageBlobRecoveryServiceImpl {
    private stats;
    private failures;
    /**
     * Attempt recovery for a single video or active-queue-item id.
     * Accepts either a `videos.id` or a `broadcast_queue.id` — whichever
     * resolves is used.
     */
    runWaterfall(idOrQueueId: string): Promise<RecoveryResult>;
    runBulkWaterfall(queueIds: string[]): Promise<RecoveryStats>;
    /**
     * Track blob-existence checks driven by an external caller (e.g. the
     * periodic storage-reconciliation worker) so the dashboard stats reflect
     * activity even when no gap requires waterfall recovery.
     */
    recordScan(itemsChecked: number, blobsVerified: number, elapsedMs: number, errored: boolean): void;
    /**
     * Bounded scan for storage_blobs rows with no referencing videos.objectPath.
     * Read-only telemetry only — does not delete (deletion is handled by the
     * dedicated orphaned-parts/blob GC passes in upload-integrity-monitor).
     */
    scanOrphanedBlobs(): Promise<void>;
    getStats(): RecoveryStats;
    getFailureRegistry(): Map<string, FailureRecord>;
}
export declare const storageBlobRecoveryService: StorageBlobRecoveryServiceImpl;
export {};
