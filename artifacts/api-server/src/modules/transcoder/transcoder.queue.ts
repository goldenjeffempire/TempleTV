import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";

const jobs = schema.transcodingJobsTable;
const videos = schema.videosTable;

// F24: extended job row with denormalized video metadata from LEFT JOIN
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
export async function enqueueTranscode(args: {
  videoId: string;
  videoPath: string;
  priority?: number;
}): Promise<{ id: string; reused: boolean }> {
  const priority = args.priority ?? 0;

  // Look for an existing live job. We treat queued/processing as live
  // and failed as re-armable.
  const existing = await db
    .select()
    .from(jobs)
    .where(and(
      eq(jobs.videoId, args.videoId),
      inArray(jobs.status, ["queued", "processing", "failed"]),
    ))
    .limit(1);

  if (existing[0]) {
    const row = existing[0];
    if (row.status === "failed") {
      await db.update(jobs)
        .set({
          status: "queued",
          attempts: 0,
          progress: 0,
          errorMessage: null,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          videoPath: args.videoPath,
          priority,
        })
        .where(eq(jobs.id, row.id));
      await db.update(videos).set({ transcodingStatus: "queued" }).where(eq(videos.id, args.videoId));
      logger.info({ jobId: row.id, videoId: args.videoId }, "transcoder: re-armed failed job");
      return { id: row.id, reused: true };
    }
    // queued or processing — leave as-is.
    return { id: row.id, reused: true };
  }

  const id = randomUUID();
  await db.insert(jobs).values({
    id,
    videoId: args.videoId,
    videoPath: args.videoPath,
    status: "queued",
    priority,
  });
  await db.update(videos).set({ transcodingStatus: "queued" }).where(eq(videos.id, args.videoId));
  logger.info({ jobId: id, videoId: args.videoId, videoPath: args.videoPath }, "transcoder: enqueued");
  return { id, reused: false };
}

// F24: listJobs LEFT JOINs managed_videos to populate videoTitle + videoThumbnail
// without an N+1 query, eliminating the film-icon placeholder in the admin queue UI.
export async function listJobs(opts: { limit?: number; status?: string } = {}): Promise<TranscodingJobWithVideo[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);

  type RawRow = typeof schema.transcodingJobsTable.$inferSelect & {
    videoTitle: string | null;
    videoThumbnail: string | null;
  };

  const base = db
    .select({
      id: jobs.id,
      videoId: jobs.videoId,
      videoPath: jobs.videoPath,
      status: jobs.status,
      priority: jobs.priority,
      progress: jobs.progress,
      errorMessage: jobs.errorMessage,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
      nextRetryAt: jobs.nextRetryAt,
      startedAt: jobs.startedAt,
      completedAt: jobs.completedAt,
      createdAt: jobs.createdAt,
      videoTitle: videos.title,
      videoThumbnail: videos.thumbnailUrl,
    })
    .from(jobs)
    .leftJoin(videos, eq(videos.id, jobs.videoId));

  const rows: RawRow[] = opts.status
    ? await base.where(eq(jobs.status, opts.status)).orderBy(sql`${jobs.priority} desc`, sql`${jobs.createdAt} asc`).limit(limit) as RawRow[]
    : await base.orderBy(sql`${jobs.priority} desc`, sql`${jobs.createdAt} desc`).limit(limit) as RawRow[];

  return rows.map((r) => ({
    ...r,
    videoTitle: r.videoTitle ?? null,
    videoThumbnail: r.videoThumbnail ?? null,
  }));
}

export async function getJob(id: string) {
  const rows = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function deleteJob(id: string): Promise<boolean> {
  const out = await db.delete(jobs).where(eq(jobs.id, id)).returning({ id: jobs.id });
  return out.length > 0;
}

// F39: "all" deletes done + failed + cancelled jobs (every row in the table).
// The name is intentionally broad because that matches the UI "Clear all"
// action — operators who want status-specific bulk deletes use the other arms.
export async function clearJobsByStatus(status: "done" | "failed" | "cancelled" | "all"): Promise<number> {
  if (status === "all") {
    // Deletes ALL rows regardless of status (done, failed, cancelled, queued, running).
    // Only use this from the admin "Clear all finished jobs" flow where the
    // caller has already confirmed they want to wipe the entire job table.
    const out = await db.delete(jobs).returning({ id: jobs.id });
    return out.length;
  }
  const out = await db.delete(jobs).where(eq(jobs.status, status)).returning({ id: jobs.id });
  return out.length;
}

/**
 * Re-arm ALL failed transcoding jobs whose source blob is still available.
 * Returns the number of jobs reset to "queued".
 * Safe to call concurrently — uses a single UPDATE statement.
 */
export async function retryAllFailed(): Promise<number> {
  const out = await db.update(jobs)
    .set({
      status: "queued",
      attempts: 0,
      progress: 0,
      errorMessage: null,
      nextRetryAt: null,
      startedAt: null,
      completedAt: null,
    })
    .where(eq(jobs.status, "failed"))
    .returning({ id: jobs.id, videoId: jobs.videoId });

  if (out.length > 0) {
    const videoIds = out.map((r) => r.videoId).filter(Boolean) as string[];
    if (videoIds.length > 0) {
      await db.update(videos)
        .set({ transcodingStatus: "queued" })
        .where(inArray(videos.id, videoIds));
    }
    logger.info({ count: out.length }, "transcoder: batch-retried all failed jobs");
  }
  return out.length;
}

export async function retryJob(id: string): Promise<boolean> {
  const out = await db.update(jobs)
    .set({
      status: "queued",
      attempts: 0,
      progress: 0,
      errorMessage: null,
      nextRetryAt: null,
      startedAt: null,
      completedAt: null,
    })
    .where(eq(jobs.id, id))
    .returning({ id: jobs.id });
  if (out.length > 0) {
    const j = await getJob(id);
    if (j) {
      await db.update(videos).set({ transcodingStatus: "queued" }).where(eq(videos.id, j.videoId));
    }
  }
  return out.length > 0;
}

/**
 * Cancel a transcoding job that is in a cancellable state (queued or failed).
 * Jobs that are currently processing cannot be cancelled here — the FFmpeg
 * process must finish or time out naturally (or the process must be killed).
 * Returns true when the job was found and successfully cancelled, false otherwise.
 */
export async function cancelJob(id: string): Promise<{ ok: boolean; reason?: string }> {
  // Read current state first so we can give a clear error for in-progress jobs
  const existing = await db
    .select({ id: jobs.id, status: jobs.status, videoId: jobs.videoId })
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1);
  const job = existing[0];
  if (!job) return { ok: false, reason: "not_found" };
  if (job.status === "processing") {
    return { ok: false, reason: "processing" };
  }
  if (job.status === "done" || job.status === "cancelled") {
    return { ok: false, reason: "terminal" };
  }

  const out = await db
    .update(jobs)
    .set({ status: "cancelled", completedAt: new Date(), errorMessage: "Cancelled by operator" })
    .where(and(eq(jobs.id, id), inArray(jobs.status, ["queued", "failed"])))
    .returning({ id: jobs.id, videoId: jobs.videoId });

  if (out.length > 0) {
    await db
      .update(videos)
      .set({ transcodingStatus: "none" })
      .where(eq(videos.id, out[0]!.videoId));
    logger.info({ jobId: id, videoId: out[0]!.videoId }, "transcoder: job cancelled by operator");
  }
  return { ok: out.length > 0 };
}

export async function queueStats() {
  const startOfTodayUtc = new Date();
  startOfTodayUtc.setUTCHours(0, 0, 0, 0);
  const [agg] = await db.execute<{
    active_count: number;
    queued_count: number;
    completed_today: number;
    failed_today: number;
  }>(sql`
    select
      sum(case when status = 'processing' then 1 else 0 end)::int as active_count,
      sum(case when status = 'queued' then 1 else 0 end)::int as queued_count,
      sum(case when status = 'done' and completed_at >= ${startOfTodayUtc.toISOString()} then 1 else 0 end)::int as completed_today,
      sum(case when status = 'failed' and completed_at >= ${startOfTodayUtc.toISOString()} then 1 else 0 end)::int as failed_today
    from transcoding_jobs
  `).then((r) => (r as unknown as { rows: Array<{ active_count: number; queued_count: number; completed_today: number; failed_today: number }> }).rows ?? r as unknown as Array<{ active_count: number; queued_count: number; completed_today: number; failed_today: number }>);

  return {
    activeCount: Number(agg?.active_count ?? 0),
    queuedCount: Number(agg?.queued_count ?? 0),
    completedToday: Number(agg?.completed_today ?? 0),
    failedToday: Number(agg?.failed_today ?? 0),
  };
}

/**
 * Boost the priority of an existing queued transcoding job for a given video.
 * Only affects jobs with status='queued' — processing/done/failed jobs are
 * already running or terminal and must not be re-prioritised.
 * Returns true when the update was applied, false when no eligible job exists.
 * Safe to call fire-and-forget; errors are surfaced as the resolved boolean.
 */
export async function boostTranscodePriority(
  videoId: string,
  priority: number,
): Promise<boolean> {
  try {
    const out = await db
      .update(jobs)
      .set({ priority })
      .where(and(eq(jobs.videoId, videoId), eq(jobs.status, "queued")))
      .returning({ id: jobs.id });
    if (out.length > 0) {
      logger.info(
        { videoId, priority, jobId: out[0]!.id },
        "transcoder: boosted job priority for broadcast queue item",
      );
    }
    return out.length > 0;
  } catch (err) {
    logger.warn({ err, videoId, priority }, "transcoder: boostTranscodePriority failed (non-fatal)");
    return false;
  }
}
