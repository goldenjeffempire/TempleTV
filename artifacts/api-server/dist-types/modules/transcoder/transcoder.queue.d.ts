import { schema } from "../../infrastructure/db.js";
export type TranscodingJobWithVideo = (typeof schema.transcodingJobsTable.$inferSelect) & {
    videoTitle: string | null;
    videoThumbnail: string | null;
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
export declare function getJob(id: string): Promise<{
    id: string;
    videoId: string;
    videoPath: string;
    status: string;
    priority: number;
    progress: number;
    errorMessage: string | null;
    attempts: number;
    maxAttempts: number;
    nextRetryAt: Date | null;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
}>;
export declare function deleteJob(id: string): Promise<boolean>;
export declare function clearJobsByStatus(status: "done" | "failed" | "cancelled" | "all"): Promise<number>;
/**
 * Re-arm ALL failed transcoding jobs whose source blob is still available.
 * Returns the number of jobs reset to "queued".
 * Safe to call concurrently — uses a single UPDATE statement.
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
export declare function boostTranscodePriority(videoId: string, priority: number): Promise<boolean>;
