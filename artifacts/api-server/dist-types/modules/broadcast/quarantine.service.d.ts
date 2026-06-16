export interface QuarantineOptions {
    /** Machine-readable reason code (e.g. CORRUPT_SOURCE, SOURCE_MISSING, MOOV_ABSENT). */
    errorCode: string;
    /** Human-readable description of why the video is being quarantined. */
    reason: string;
    /** What triggered this quarantine (finalize-route, integrity-validator, manual). */
    triggeredBy?: string;
    /** Extra key/value metadata stored in the audit log JSON column. */
    metadata?: Record<string, unknown>;
}
export interface QuarantineResult {
    queueItemsDeactivated: number;
    playlistEntriesRemoved: number;
    auditLogId: string | null;
}
/**
 * Quarantine a corrupt/unplayable video.
 *
 * Safe to call from background tasks — never throws; all errors are logged
 * and swallowed so a quarantine failure does not crash the calling process.
 */
export declare function quarantineVideo(videoId: string, opts: QuarantineOptions): Promise<QuarantineResult>;
/**
 * Write a PURGE entry to media_audit_log when an admin hard-deletes a video.
 */
export declare function logPurge(videoId: string, opts: {
    reason: string;
    triggeredBy: string;
    metadata?: Record<string, unknown>;
}): Promise<void>;
/**
 * Query corrupt-media inventory for the admin API.
 */
export declare function getCorruptMediaInventory(opts: {
    page?: number;
    limit?: number;
    errorCode?: string;
}): Promise<{
    items: Array<{
        videoId: string | null;
        title: string | null;
        originalFilename: string | null;
        errorCode: string | null;
        errorMessage: string | null;
        transcodingStatus: string | null;
        detectedAt: Date | null;
        auditId: string;
        reason: string | null;
        triggeredBy: string;
        queueItemsRemoved: number;
        playlistEntriesRemoved: number;
    }>;
    total: number;
    page: number;
    limit: number;
}>;
/**
 * Get a corruptMedia health summary for the /health endpoint.
 */
export declare function getCorruptMediaHealthSummary(): Promise<{
    last24h: number;
    quarantinedTotal: number;
    lastDetectedAt: string | null;
}>;
