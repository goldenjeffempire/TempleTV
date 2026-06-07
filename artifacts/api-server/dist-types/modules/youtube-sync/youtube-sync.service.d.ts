export declare function isSyncInProgress(): boolean;
interface QuotaState {
    used: number;
    total: number;
    resetsAt: string;
    operations: Array<{
        operation: string;
        cost: number;
        count: number;
    }>;
}
export declare function trackQuota(operation: string, cost: number): void;
/**
 * Returns true when the in-process quota counter has reached or exceeded the
 * configured daily limit.  Callers should fall back to RSS instead of making
 * further Data API calls — even though Google will ultimately enforce the limit
 * with a 403, skipping the call avoids a wasted round-trip and log noise.
 */
export declare function isQuotaExhausted(): boolean;
export declare function getQuotaStatus(): QuotaState;
export declare function restoreQuota(): Promise<void>;
export interface SyncStatus {
    lastSyncId: string | null;
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
    lastSyncSource: string | null;
    videosFound: number | null;
    videosInserted: number | null;
    videosUpdated: number | null;
    videosSkipped: number | null;
    videosDeleted: number | null;
    errorMessage: string | null;
    totalYoutubeVideos: number;
    nextSyncAt: string | null;
    contentWindowDays: number;
}
export declare function setNextSyncAt(d: Date): void;
export declare function getSyncStatus(): Promise<SyncStatus>;
export declare function detectCategory(title: string, description: string): string;
export declare function extractPreacher(title: string): string;
export interface IngestionResult {
    succeeded: number;
    failed: number;
    totalAttempts: number;
    errors: string[];
    warningRows: number;
    allWarnings: string[];
}
export interface SyncResult {
    syncId: string;
    inserted: number;
    updated: number;
    total: number;
    skipped: number;
    deleted: number;
    durationMs: number;
    source: "youtube_api" | "rss";
    rowErrors: number;
}
export declare function syncYouTubeChannel(triggeredBy?: "scheduler" | "manual"): Promise<SyncResult>;
export interface CategoryStat {
    category: string;
    count: number;
    pct: number;
}
export interface CategoryStatsResult {
    total: number;
    byCategory: CategoryStat[];
    liveServiceCount: number;
    uncategorizedCount: number;
}
export declare function getCategoryStats(): Promise<CategoryStatsResult>;
export interface RecategorizeResult {
    processed: number;
    changed: number;
    unchanged: number;
    durationMs: number;
    changesByCategory: Record<string, number>;
    errors: number;
}
export declare function isRecategorizeInProgress(): boolean;
export declare function recategorizeAllVideos(): Promise<RecategorizeResult>;
export {};
