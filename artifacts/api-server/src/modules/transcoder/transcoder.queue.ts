import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";

const jobs = schema.transcodingJobsTable;
const videos = schema.videosTable;

// F24: extended job row with denormalized video metadata from LEFT JOIN
export type TranscodingJobWithVideo = (typeof schema.transcodingJobsTable.$inferSelect) & {
  videoTitle: string | null;
  videoThumbnail: string | null;
  transcodingErrorCode: string | null;
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
/**
 * Normalise a video source reference to a raw storage key.
 *
 * `localVideoUrl` stores the API-serving path   →  /api/v1/uploads/2026/…/uuid.mp4
 * `objectPath`    stores the raw storage key     →  uploads/2026/…/uuid.mp4
 *
 * The transcoder's downloadSourceToTempFile expects either a bare storage key
 * or an http(s):// URL (for prod-sync remote items). Passing the API URL path
 * produces an "Object not found in storage" error because the storage table is
 * keyed by the bare path, not the API route.
 *
 * Remote http(s):// URLs are returned unchanged so prod-sync items keep working.
 */
function normaliseVideoPath(ref: string): string {
  if (/^https?:\/\//i.test(ref)) return ref;
  if (ref.startsWith("/")) {
    // Strip /api/v1/ or /api/ prefix, then any remaining leading slash.
    return ref.replace(/^\/(?:api\/(?:v\d+\/)?)?/, "");
  }
  return ref;
}

export async function enqueueTranscode(args: {
  videoId: string;
  videoPath: string;
  priority?: number;
}): Promise<{ id: string; reused: boolean }> {
  const priority = args.priority ?? 0;
  // Normalise at the point of DB write so every caller is covered regardless
  // of whether it passed objectPath (bare key) or localVideoUrl (API path).
  const videoPath = normaliseVideoPath(args.videoPath);

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
      // Atomically reset the job and flip the video status so a DB failure
      // between the two writes cannot leave them in inconsistent states.
      await db.transaction(async (tx) => {
        await tx.update(jobs)
          .set({
            status: "queued",
            attempts: 0,
            progress: 0,
            errorMessage: null,
            nextRetryAt: null,
            startedAt: null,
            completedAt: null,
            videoPath,
            priority,
          })
          .where(eq(jobs.id, row.id));
        // Clear all failure state on managed_videos — previous error code/message
        // are no longer current once a fresh attempt is scheduled.
        await tx.update(videos)
          .set({ transcodingStatus: "queued", transcodingErrorMessage: null, transcodingErrorCode: null })
          .where(eq(videos.id, args.videoId));
      });
      logger.info({ jobId: row.id, videoId: args.videoId }, "transcoder: re-armed failed job");
      return { id: row.id, reused: true };
    }
    // queued or processing — leave as-is.
    return { id: row.id, reused: true };
  }

  const id = randomUUID();
  // Atomically insert the job and flip the video status so a DB failure
  // between the two writes cannot leave them in inconsistent states.
  await db.transaction(async (tx) => {
    await tx.insert(jobs).values({
      id,
      videoId: args.videoId,
      videoPath,
      status: "queued",
      priority,
    });
    // Clear all previous failure state when a fresh job is created.
    await tx.update(videos)
      .set({ transcodingStatus: "queued", transcodingErrorMessage: null, transcodingErrorCode: null })
      .where(eq(videos.id, args.videoId));
  });
  logger.info({ jobId: id, videoId: args.videoId, videoPath }, "transcoder: enqueued");
  return { id, reused: false };
}

// F24: listJobs LEFT JOINs managed_videos to populate videoTitle + videoThumbnail
// without an N+1 query, eliminating the film-icon placeholder in the admin queue UI.
export async function listJobs(opts: { limit?: number; status?: string } = {}): Promise<TranscodingJobWithVideo[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);

  type RawRow = typeof schema.transcodingJobsTable.$inferSelect & {
    videoTitle: string | null;
    videoThumbnail: string | null;
    transcodingErrorCode: string | null;
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
      lastProgressAt: jobs.lastProgressAt,
      videoTitle: videos.title,
      videoThumbnail: videos.thumbnailUrl,
      transcodingErrorCode: videos.transcodingErrorCode,
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
    transcodingErrorCode: r.transcodingErrorCode ?? null,
  }));
}

export async function getJob(id: string): Promise<TranscodingJobWithVideo | null> {
  const rows = await db
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
      lastProgressAt: jobs.lastProgressAt,
      videoTitle: videos.title,
      videoThumbnail: videos.thumbnailUrl,
      transcodingErrorCode: videos.transcodingErrorCode,
    })
    .from(jobs)
    .leftJoin(videos, eq(videos.id, jobs.videoId))
    .where(eq(jobs.id, id))
    .limit(1);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    ...r,
    videoTitle: r.videoTitle ?? null,
    videoThumbnail: r.videoThumbnail ?? null,
    transcodingErrorCode: r.transcodingErrorCode ?? null,
  };
}

export async function deleteJob(id: string): Promise<boolean> {
  // Safety guard: never delete a queued or processing job — doing so orphans
  // the live FFmpeg child process (it keeps running but has no DB record to
  // update) and leaves the associated managed_videos row stuck at "encoding"
  // or "processing" indefinitely until the next watchdog sweep or server
  // restart.  Callers that need to abort an active job must first cancel it
  // through the dispatcher (which kills the FFmpeg process), then delete.
  const [existing] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!existing) return false;
  if (existing.status === "queued" || existing.status === "processing") return false;
  const out = await db.delete(jobs).where(eq(jobs.id, id)).returning({ id: jobs.id });
  return out.length > 0;
}

// Active job statuses that must NEVER be deleted — deleting a "queued" or
// "processing" row while the dispatcher has claimed it orphans the live FFmpeg
// child process (it keeps running but has no DB record to update, and its
// video row is left stuck at "encoding" or "processing" forever).
const ACTIVE_JOB_STATUSES = ["queued", "processing"] as const;

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
export async function clearJobsByStatus(status: "done" | "failed" | "cancelled" | "all"): Promise<number> {
  if (status === "all") {
    // Delete every non-active row (done, failed, cancelled).
    // Active (queued + processing) rows are explicitly preserved.
    const out = await db
      .delete(jobs)
      .where(notInArray(jobs.status, [...ACTIVE_JOB_STATUSES]))
      .returning({ id: jobs.id });
    if (out.length > 0) {
      logger.info({ cleared: out.length }, "transcoder: cleared all finished jobs (active jobs preserved)");
    }
    return out.length;
  }
  // Status-specific delete — still guard against accidentally targeting active statuses.
  if ((ACTIVE_JOB_STATUSES as readonly string[]).includes(status)) {
    logger.warn({ status }, "transcoder: clearJobsByStatus called with active status — skipped to protect running jobs");
    return 0;
  }
  const out = await db.delete(jobs).where(eq(jobs.status, status)).returning({ id: jobs.id });
  return out.length;
}

/**
 * Re-arm ALL failed transcoding jobs whose source blob is still available.
 * Returns the number of jobs reset to "queued".
 * Wrapped in a transaction so the jobs and managed_videos tables are updated
 * atomically — a crash between the two updates cannot leave jobs "queued"
 * while their videos still report "failed" (or vice-versa).
 */
export async function retryAllFailed(): Promise<number> {
  return db.transaction(async (tx) => {
    // Exclusion rules:
    //   SOURCE_MISSING — source blob is gone from storage; re-queuing always fails.
    //   CORRUPT_SOURCE + objectPath IS NULL — no source to transcode.
    //
    // CORRUPT_SOURCE jobs WHERE objectPath IS NOT NULL are intentionally included.
    // The CORRUPT_SOURCE classification can be a false positive when the moov atom
    // is large (>64 KiB, common for 30-min+ H.264 recordings) and was previously
    // missed by the tail-scan heuristic. Allowing retry gives those jobs a chance
    // to succeed with the fixed full-file ffprobe detection. Truly corrupt files
    // (no moov at all) will simply fail again and keep their CORRUPT_SOURCE code.
    //
    // DISK_FULL jobs ARE re-queued so they run after the operator frees storage.
    const out = await tx.update(jobs)
      .set({
        status: "queued",
        attempts: 0,
        progress: 0,
        errorMessage: null,
        nextRetryAt: null,
        startedAt: null,
        completedAt: null,
      })
      .where(and(
        eq(jobs.status, "failed"),
        sql`NOT EXISTS (
          SELECT 1 FROM managed_videos mv
          WHERE mv.id = ${jobs.videoId}
            AND (
              mv.transcoding_error_code = 'SOURCE_MISSING'
              OR (mv.transcoding_error_code = 'CORRUPT_SOURCE' AND mv.object_path IS NULL)
            )
        )`,
      ))
      .returning({ id: jobs.id, videoId: jobs.videoId });

    if (out.length > 0) {
      const videoIds = out.map((r) => r.videoId).filter(Boolean) as string[];
      if (videoIds.length > 0) {
        // Clear error state so the admin UI shows a clean "queued" badge.
        await tx.update(videos)
          .set({ transcodingStatus: "queued", transcodingErrorMessage: null, transcodingErrorCode: null })
          .where(inArray(videos.id, videoIds));
      }
      logger.info({ count: out.length }, "transcoder: batch-retried all failed jobs");
    }
    return out.length;
  });
}

export async function retryJob(id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Guard: SOURCE_MISSING jobs are permanently unrecoverable — the blob is
    // gone from storage and re-queuing will always fail. Also block CORRUPT_SOURCE
    // when objectPath IS NULL (no source to transcode). CORRUPT_SOURCE jobs that
    // still have their source blob (objectPath IS NOT NULL) are allowed through:
    // the classification can be a false positive for recordings with large moov
    // atoms (>64 KiB) that the old tail-scan heuristic missed. The retry will
    // either succeed with the fixed ffprobe detection or fail again cleanly.
    const existing = await tx
      .select({ id: jobs.id, videoId: jobs.videoId })
      .from(jobs)
      .innerJoin(videos, and(
        eq(videos.id, jobs.videoId),
        or(
          eq(videos.transcodingErrorCode, "SOURCE_MISSING"),
          and(
            eq(videos.transcodingErrorCode, "CORRUPT_SOURCE"),
            isNull(videos.objectPath),
          ),
        ),
      ))
      .where(eq(jobs.id, id))
      .limit(1);
    if (existing.length > 0) {
      logger.warn(
        { jobId: id, videoId: existing[0]!.videoId },
        "transcoder: retryJob rejected — video source is missing or corrupt with no stored blob; re-upload the source file to fix",
      );
      return false;
    }

    const out = await tx.update(jobs)
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
      .returning({ id: jobs.id, videoId: jobs.videoId });
    if (out.length > 0 && out[0]!.videoId) {
      // Clear all failure state so the admin UI shows a clean "queued" badge.
      await tx.update(videos)
        .set({ transcodingStatus: "queued", transcodingErrorMessage: null, transcodingErrorCode: null })
        .where(eq(videos.id, out[0]!.videoId));
    }
    return out.length > 0;
  });
}

/**
 * Cancel a transcoding job that is in a cancellable state (queued or failed).
 * Jobs that are currently processing cannot be cancelled here — the FFmpeg
 * process must finish or time out naturally (or the process must be killed).
 * Returns true when the job was found and successfully cancelled, false otherwise.
 */
export async function cancelJob(id: string): Promise<{ ok: boolean; reason?: string }> {
  return db.transaction(async (tx) => {
    // Read current state inside the transaction so the status check and the
    // update are atomic — no concurrent request can flip the status between
    // our read (lines below) and our write (update jobs below).
    const existing = await tx
      .select({ id: jobs.id, status: jobs.status, videoId: jobs.videoId })
      .from(jobs)
      .where(eq(jobs.id, id))
      .limit(1);
    const job = existing[0];
    if (!job) return { ok: false, reason: "not_found" };
    if (job.status === "processing") return { ok: false, reason: "processing" };
    if (job.status === "done" || job.status === "cancelled") return { ok: false, reason: "terminal" };

    const out = await tx
      .update(jobs)
      .set({ status: "cancelled", completedAt: new Date(), errorMessage: "Cancelled by operator" })
      .where(and(eq(jobs.id, id), inArray(jobs.status, ["queued", "failed"])))
      .returning({ id: jobs.id, videoId: jobs.videoId });

    if (out.length > 0) {
      // Determine the correct restored transcodingStatus.
      // Setting 'none' unconditionally is wrong when faststart already ran:
      // 'none' signals "raw upload, never processed" and causes the auto-enqueue
      // service to immediately re-queue this video for HLS transcoding, creating
      // a silent re-enqueue loop on every cancel for faststart-applied videos.
      //
      // Correct mapping:
      //   faststartApplied=true + no hlsMasterUrl → 'ready'  (faststart done, no HLS)
      //   otherwise                               → 'none'   (raw or HLS already present)
      const videoState = await tx
        .select({ faststartApplied: videos.faststartApplied, hlsMasterUrl: videos.hlsMasterUrl })
        .from(videos)
        .where(eq(videos.id, out[0]!.videoId!))
        .limit(1)
        .then((r) => r[0]);
      const restoredStatus =
        videoState?.faststartApplied === true && !videoState?.hlsMasterUrl
          ? "ready"
          : "none";
      await tx
        .update(videos)
        .set({ transcodingStatus: restoredStatus })
        .where(eq(videos.id, out[0]!.videoId!));
      logger.info(
        { jobId: id, videoId: out[0]!.videoId, restoredStatus },
        "transcoder: job cancelled by operator",
      );
    }
    return { ok: out.length > 0 };
  });
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
