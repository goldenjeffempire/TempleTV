import type { QueueAssetHealthState, RepairLogEntry } from "@workspace/db";
export interface AssetHealthRow {
    id: string;
    queueItemId: string;
    videoId: string | null;
    state: QueueAssetHealthState;
    repairAttempts: number;
    lastRepairAt: Date | null;
    nextRetryAt: Date | null;
    lastErrorCode: string | null;
    lastError: string | null;
    suggestedFix: string | null;
    sourceHash: string | null;
    autoRepairPaused: boolean;
    repairLog: RepairLogEntry[];
    createdAt: Date;
    updatedAt: Date;
}
export declare const assetHealthRepo: {
    /**
     * Get or create a health row for a queue item.
     * Creates as "healthy" with zero attempts if not yet tracked.
     */
    getOrCreate(queueItemId: string, videoId?: string | null): Promise<AssetHealthRow>;
    /** Fetch by queue item ID. Returns null if not tracked yet. */
    getByQueueItemId(queueItemId: string): Promise<AssetHealthRow | null>;
    /** List all health rows, optionally filtered by state. */
    list(opts?: {
        state?: QueueAssetHealthState;
        limit?: number;
    }): Promise<AssetHealthRow[]>;
    /**
     * List items due for repair (quarantined, nextRetryAt ≤ now, autoRepairPaused = false).
     */
    listDueForRepair(): Promise<AssetHealthRow[]>;
    /**
     * Transition a queue item to "quarantined" state.
     * If already quarantined or blocked, only updates error info.
     */
    markQuarantined(queueItemId: string, opts: {
        errorCode: string;
        error: string;
        suggestedFix?: string;
        actor?: "system" | "operator";
        sourceHash?: string;
    }): Promise<AssetHealthRow>;
    /**
     * Mark as "repairing" — worker is now actively attempting to fix this item.
     */
    markRepairing(queueItemId: string): Promise<AssetHealthRow>;
    /**
     * Record a repair attempt outcome.
     *
     * - success → transitions to "approved"
     * - failure with attempts < MAX → back to "quarantined" with back-off
     * - failure with attempts >= MAX → "blocked"
     */
    recordRepairOutcome(queueItemId: string, outcome: "success" | "failure", detail: string): Promise<AssetHealthRow>;
    /**
     * Mark as healthy (clears repair state).
     */
    markHealthy(queueItemId: string, opts?: {
        actor?: "system" | "operator";
        detail?: string;
    }): Promise<AssetHealthRow>;
    /**
     * Manual operator approval — force state to "approved".
     */
    manualApprove(queueItemId: string, actor: string, reason?: string): Promise<AssetHealthRow>;
    /**
     * Manual operator quarantine.
     */
    manualQuarantine(queueItemId: string, actor: string, reason: string): Promise<AssetHealthRow>;
    /**
     * Reset repair state — clears attempts, error, and transitions to quarantined
     * so the worker will retry from scratch.
     */
    resetRepair(queueItemId: string, actor: string): Promise<AssetHealthRow>;
    /**
     * Toggle autoRepairPaused for a queue item.
     */
    setPaused(queueItemId: string, paused: boolean, actor: string): Promise<AssetHealthRow>;
    /**
     * Bulk upsert: ensure every active queue item ID has a health row.
     * Safe to call on every worker scan cycle.
     */
    ensureRowsForItems(items: Array<{
        id: string;
        videoId?: string | null;
    }>): Promise<void>;
    /**
     * List items stuck in "repairing" state (e.g. after a process restart
     * left them mid-repair). Any item that has been in "repairing" state for
     * longer than thresholdMs with no update is considered stuck and will be
     * recovered back to "quarantined" at the start of the next scan.
     */
    listStuckRepairing(thresholdMs: number): Promise<AssetHealthRow[]>;
    /**
     * Auto-clear blocked items that have been blocked longer than ttlMs.
     * Resets them to "quarantined" with repairAttempts=0 so the worker
     * will retry them on the next scan cycle.
     *
     * This is the key mechanism for unattended 24/7 operation — blocked
     * items will automatically re-enter the repair cycle after the TTL
     * expires rather than requiring manual operator intervention forever.
     *
     * Returns the number of items reset.
     */
    clearExpiredBlocked(ttlMs: number): Promise<number>;
    /**
     * Bulk reset — restart the repair cycle for multiple items at once.
     * Used when a transient CDN outage blocks many items simultaneously.
     * Returns the number of items successfully reset.
     */
    bulkReset(queueItemIds: string[], actor: string): Promise<number>;
    /**
     * Bulk approve — manually approve multiple items at once.
     * Clears quarantine / blocked state so items re-enter broadcast rotation.
     * Returns the number of items approved.
     */
    bulkApprove(queueItemIds: string[], actor: string): Promise<number>;
    /**
     * Remove orphaned health rows for queue items that no longer exist.
     */
    pruneOrphans(): Promise<number>;
    /**
     * Summary stats for the health dashboard.
     */
    getSummary(): Promise<{
        healthy: number;
        quarantined: number;
        repairing: number;
        approved: number;
        blocked: number;
        total: number;
    }>;
    MAX_REPAIR_ATTEMPTS: number;
    MAX_LIFETIME_BLOCKS: number;
    REPAIR_BACKOFF_MS: number[];
};
