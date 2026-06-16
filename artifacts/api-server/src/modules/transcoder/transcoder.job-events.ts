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

import { randomUUID } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";

const events = schema.transcodingJobEventsTable;

export interface EmitJobEventOpts {
  jobId: string;
  workerId?: string | null;
  eventType: string;
  stage?: string | null;
  payload?: Record<string, unknown> | null;
}

export async function emitJobEvent(opts: EmitJobEventOpts): Promise<void> {
  try {
    await db.insert(events).values({
      id: randomUUID(),
      jobId: opts.jobId,
      workerId: opts.workerId ?? null,
      eventType: opts.eventType,
      stage: opts.stage ?? null,
      payload: opts.payload ?? null,
      createdAt: new Date(),
    });
  } catch (err) {
    logger.debug({ err, jobId: opts.jobId, eventType: opts.eventType }, "job-events: emit failed (non-fatal)");
  }
}

export async function getJobEvents(jobId: string, limit = 50): Promise<typeof schema.transcodingJobEventsTable.$inferSelect[]> {
  try {
    const rows = await db
      .select()
      .from(events)
      .where(eq(events.jobId, jobId))
      .orderBy(events.createdAt)
      .limit(limit);
    return rows;
  } catch (err) {
    logger.warn({ err, jobId }, "job-events: getJobEvents failed");
    return [];
  }
}

export async function purgeOldEvents(olderThanDays = 30): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 3_600_000);
    const out = await db.delete(events)
      .where(lt(events.createdAt, cutoff))
      .returning({ id: events.id });
    return out.length;
  } catch (err) {
    logger.warn({ err }, "job-events: purgeOldEvents failed (non-fatal)");
    return 0;
  }
}
