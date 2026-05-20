import { schema } from "../../infrastructure/db.js";
export type TranscodingJobWithVideo = (typeof schema.transcodingJobsTable.$inferSelect) & {
    videoTitle: string | null;
    videoThumbnail: string | null;
};
/**
 * Enqueue a transcoding job for an uploaded video.
 *
 * Idempotent: if there is already a queued/processing job for this
 * video the existing row is returned. If a previously-failed job
 * exists, it is re-armed (status='queued', attempts reset, error
 * cleared) instead of inserting a duplicate.
 *
 * Also flips `managed_videos.transcoding_status` to "queued" so the
 * admin UI shows the right badge immediately, before the dispatcher
 * picks the job up.
 */
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
export declare function retryJob(id: string): Promise<boolean>;
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
