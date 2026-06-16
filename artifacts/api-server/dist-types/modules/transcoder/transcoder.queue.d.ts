import { schema } from "../../infrastructure/db.js";
export type TranscodingJobWithVideo = (typeof schema.transcodingJobsTable.$inferSelect) & {
    videoTitle: string | null;
    videoThumbnail: string | null;
    transcodingErrorCode: string | null;
};
export declare function enqueueTranscode(args: {
    videoId: string;
    videoPath: string;
    priority?: number;
}): Promise<{
    id: string;
    reused: boolean;
}>;
export declare function listJobs(opts?: {
    limit?: number;
    status?: string;
}): Promise<TranscodingJobWithVideo[]>;
export declare function getJob(id: string): Promise<TranscodingJobWithVideo | null>;
export declare function deleteJob(id: string): Promise<boolean>;
/**
 * Bulk-delete transcoding jobs by status.
 *
 * SAFETY INVARIANT: "queued" and "processing" jobs are NEVER deleted,
 * regardless of the requested status.  Deleting an active job while the
 * dispatcher holds it orphans the FFmpeg child process and leaves the
 * associated managed_videos row stuck at "encoding" or "processing".
 *
 * For the "all" variant this means only done/failed/cancelled rows are
 * removed.  The caller receives the count of deleted rows; active rows
 * that were skipped are logged so operators know they must wait for the
 * current job to finish before the table is fully clear.
 */
export declare function clearJobsByStatus(status: "done" | "failed" | "dead_letter" | "cancelled" | "all"): Promise<number>;
/**
 * Re-arm ALL failed transcoding jobs whose source blob is still available.
 * Returns the number of jobs reset to "queued".
 * Wrapped in a transaction so the jobs and managed_videos tables are updated
 * atomically — a crash between the two updates cannot leave jobs "queued"
 * while their videos still report "failed" (or vice-versa).
 */
export declare function retryAllFailed(): Promise<number>;
export declare function retryJob(id: string): Promise<boolean>;
/**
 * Cancel a transcoding job that is in a cancellable state (queued or failed).
 * Jobs that are currently processing cannot be cancelled here — the FFmpeg
 * process must finish or time out naturally (or the process must be killed).
 * Returns true when the job was found and successfully cancelled, false otherwise.
 */
export declare function cancelJob(id: string): Promise<{
    ok: boolean;
    reason?: string;
}>;
export declare function queueStats(): Promise<{
    activeCount: number;
    queuedCount: number;
    completedToday: number;
    failedToday: number;
}>;
/**
 * Boost the priority of an existing queued transcoding job for a given video.
 * Only affects jobs with status='queued' — processing/done/failed jobs are
 * already running or terminal and must not be re-prioritised.
 * Returns true when the update was applied, false when no eligible job exists.
 * Safe to call fire-and-forget; errors are surfaced as the resolved boolean.
 */
/**
 * Route a permanently-failed transcoding job to the Dead-Letter Queue.
 *
 * Inserts a row in `transcoding_dead_letter` and emits an ops-alert SSE
 * event so operators are notified via the admin dashboard.  Idempotent —
 * if the job is already in the DLQ the row is silently left unchanged.
 *
 * The DLQ is specifically for jobs that exhausted their retry budget on
 * transient errors (disk-full, timeout, network outage).  Jobs that fail
 * permanently with CORRUPT_SOURCE or SOURCE_MISSING are tracked only in
 * `managed_videos.transcodingErrorCode` and excluded from the DLQ so
 * operators get a clear signal: DLQ = "fixable, needs intervention".
 */
export declare function moveToDlq(args: {
    jobId: string;
    videoId?: string;
    videoPath?: string;
    attempts: number;
    lastError: string;
    errorCode: string;
}): Promise<void>;
/**
 * Re-queue a dead-letter entry so the dispatcher picks it up again.
 *
 * Resets the matching transcoding_jobs row to status='queued' (clearing
 * attempts so a fresh retry budget is applied), stamps requeued_at on the
 * DLQ row, and fires a broadcast-queue-updated notification so any in-flight
 * orchestrator state refreshes immediately.
 */
export declare function requeueFromDlq(dlqId: string): Promise<{
    jobId: string;
}>;
/**
 * Purge a dead-letter entry permanently (no re-queue).
 *
 * Atomically deletes the DLQ row and — if the corresponding transcoding job
 * still carries status="dead_letter" — resets it to status="failed" so it
 * appears in the normal failed-jobs list rather than disappearing silently.
 * Wrapped in a transaction so the two writes are always consistent.
 */
export declare function purgeDlqEntry(dlqId: string): Promise<void>;
/**
 * Bulk-purge all non-requeued dead-letter entries.
 * Atomically resets all matching jobs from dead_letter → failed.
 * Returns the number of DLQ rows deleted.
 */
export declare function purgeDlqAll(): Promise<number>;
export declare function boostTranscodePriority(videoId: string, priority: number): Promise<boolean>;
