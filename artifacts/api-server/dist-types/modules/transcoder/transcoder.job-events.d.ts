/**
 * Transcoding Job Events — structured audit log for job lifecycle.
 *
 * Each stage transition, lease event, error, checkpoint save, and completion
 * is recorded here. The event log is served to the admin UI as a timeline
 * drawer for any selected job.
 *
 * Event types:
 *   stage_enter     — job entered a new stage
 *   stage_exit      — job exited a stage (with duration_ms)
 *   lease_claimed   — worker claimed the job's lease
 *   lease_renewed   — worker renewed the lease (periodic)
 *   lease_reclaimed — idle worker reclaimed a dead worker's expired lease
 *   retry_scheduled — job failed and re-queued with a backoff delay
 *   error           — error recorded at a specific stage
 *   checkpoint_saved — rendition checkpoint persisted (resumable processing)
 *   completed       — job reached terminal "done" state
 *   dead_lettered   — job moved to the dead-letter queue
 */
import { schema } from "../../infrastructure/db.js";
export interface EmitJobEventOpts {
    jobId: string;
    workerId?: string | null;
    eventType: string;
    stage?: string | null;
    payload?: Record<string, unknown> | null;
}
export declare function emitJobEvent(opts: EmitJobEventOpts): Promise<void>;
export declare function getJobEvents(jobId: string, limit?: number): Promise<typeof schema.transcodingJobEventsTable.$inferSelect[]>;
export declare function purgeOldEvents(olderThanDays?: number): Promise<number>;
