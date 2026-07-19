/**
 * Production-grade video deep recovery service — MP4-only pipeline.
 *
 * Scans every locally-uploaded video for pipeline issues, classifies the root
 * cause, applies the appropriate idempotent recovery action, and returns a
 * structured report. Safe to run multiple times — videos already in a healthy
 * state are counted and skipped; no duplicate jobs or queue entries are created.
 *
 * Issue taxonomy (MP4-only pipeline — TRANSCODER_DISABLE=1):
 *   STORAGE_LOST        — s3MirroredAt set (blob confirmed) but blob is now absent → quarantine
 *   MISSING_FROM_QUEUE  — MP4-ready video not in active broadcast queue → re-enqueue
 *   FAILED_SOURCE_GONE  — transcoding_status='failed', source blob confirmed absent → quarantine
 *   FAILED_RETRYABLE    — transcoding_status='failed', blob still present (transcoder disabled — log only)
 *   ORPHAN_ENCODING     — status='encoding' with no active job for >90 min → reset + re-enqueue
 *   STUCK_QUEUED        — status='queued' with no job progress for >60 min → reset + re-enqueue
 *   NEVER_PROCESSED     — status='none', has objectPath but no localVideoUrl (HLS-era legacy)
 *   DEAD_LETTER         — latest job is in dead_letter (transcoder disabled — log only)
 *   HEALTHY             — stored, blob confirmed, queued for broadcast → skip
 *
 * Fixed bugs vs. previous version:
 *   • Removed mv.faststart_applied from snapshot SELECT — column no longer exists in schema
 *     (was "column managed_videos.faststart_applied does not exist" fatal SQL error)
 *   • Fixed ANY(${ids}::text[]) Drizzle array binding bug — Drizzle expands JS arrays
 *     as tuples ($1,$2…) not pg array literals → ERROR 42846 on multi-video recovery.
 *     All bulk UPDATE statements now use Drizzle ORM inArray() builder instead.
 *   • Added Phase 0: repairMissingS3MirroredAt() before snapshot so isMp4Ready
 *     classification is accurate (previously videos with valid blobs but null stamp
 *     were misclassified as "in-progress / healthy").
 *   • Added SET LOCAL statement_timeout (30 s) on the snapshot transaction to bound
 *     execution time on large catalogs and prevent DB pool exhaustion.
 *   • Fixed resetOrphaned / resetStuck counter double-counting (were incremented in
 *     both Phase 3/4 bulk-reset AND Phase 5 enqueue loop).
 *   • Fixed storage_lost classification gap — previously a video with st='failed' AND
 *     errCode='STORAGE_LOST' fell through to failed_source_gone, bypassing the
 *     storage_lost branch. Now blobConfirmedMissing always wins at highest priority.
 *   • Fixed buildReport quarantine count — now counts both quarantined_source_gone
 *     AND quarantined_storage_lost.
 *   • Added storageLostConfirmed to actions (was computed but not surfaced in report).
 *   • Replaced transcoding stub calls (enqueueTranscode, retryAllFailed, requeueFromDlq,
 *     transcoderDispatcher.nudge) with MP4-pipeline-appropriate actions.
 *   • Updated buildItem messages for MP4 pipeline accuracy (no HLS/FastStart references).
 *   • Added comprehensive per-phase structured logging with timing.
 */
type IssueKind = "healthy" | "failed_retryable" | "failed_source_gone" | "storage_lost" | "orphan_encoding" | "stuck_queued" | "never_processed" | "dead_letter" | "missing_from_queue";
type ActionTaken = "skipped_healthy" | "retried_transcoding" | "reset_orphan_and_requeued" | "reset_stuck_and_requeued" | "enqueued_unprocessed" | "requeued_from_dlq" | "enqueued_broadcast" | "quarantined_source_gone" | "quarantined_storage_lost" | "no_action_transcoding_disabled" | "error";
export interface RecoveryItem {
    videoId: string;
    title: string;
    issueKind: IssueKind;
    issueDetail: string;
    actionTaken: ActionTaken;
    actionDetail: string;
    previousStatus: string;
    previousErrorCode: string | null;
    blobVerified: boolean | null;
    rootCause: string | null;
}
export interface RecoveryReport {
    runAt: string;
    durationMs: number;
    totalLocalVideos: number;
    summary: {
        healthy: number;
        recovered: number;
        quarantined: number;
        errors: number;
    };
    actions: {
        retriedFailed: number;
        resetOrphaned: number;
        resetStuck: number;
        enqueuedUnprocessed: number;
        enqueuedBroadcast: number;
        requeuedDlq: number;
        sourceMissingConfirmed: number;
        storageLostConfirmed: number;
        badUrlCacheCleared: boolean;
        suspendedReEnabled: number;
        blobStampsRepaired: number;
    };
    items: RecoveryItem[];
    remainingActions: string[];
}
export declare function runDeepRecovery(): Promise<RecoveryReport>;
export {};
