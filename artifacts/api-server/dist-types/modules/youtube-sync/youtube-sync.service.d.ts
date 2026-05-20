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
export declare function getQuotaStatus(): QuotaState;
/**
 * Restore quota state from app_config on startup.
 * Only restores if the snapshot is from today (UTC) — otherwise starts fresh.
 * Export so the dispatcher can call this once before its first sync.
 */
export declare function restoreQuota(): Promise<void>;
export interface SyncStatus {
    lastSyncId: string | null;
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
    lastSyncSource: string | null;
    videosFound: number | null;
    videosInserted: number | null;
    videosUpdated: number | null;
    errorMessage: string | null;
    totalYoutubeVideos: number;
    nextSyncAt: string | null;
}
export declare function setNextSyncAt(d: Date): void;
export declare function getSyncStatus(): Promise<SyncStatus>;
/**
 * Detect a category slug from a video's title and description.
 * Returns "sermon" as the default (maps to "Teachings" on client surfaces).
 *
 * Strategy: title-first classification. Titles are concise and specific
 * (e.g. "DELIVERANCE SERVICE | Sunday Night"). Generic descriptions often
 * contain filler text ("Subscribe for the glory of God", "praise the Lord")
 * that would produce false positives if given equal weight. Description is
 * only consulted as a fallback when the title has no match.
 */
export declare function detectCategory(title: string, description: string): string;
/**
 * Try to extract a preacher/speaker name from a video title.
 * Returns "" if no recognisable pattern is found.
 */
export declare function extractPreacher(title: string): string;
export interface SyncResult {
    syncId: string;
    inserted: number;
    updated: number;
    total: number;
    durationMs: number;
    source: "youtube_api" | "rss";
}
export declare function syncYouTubeChannel(triggeredBy?: "scheduler" | "manual"): Promise<SyncResult>;
export {};
