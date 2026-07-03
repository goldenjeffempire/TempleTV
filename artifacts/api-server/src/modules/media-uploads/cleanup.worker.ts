/**
 * Storage cleanup worker.
 *
 * Runs every 30 minutes and performs four sweeps:
 *
 *  (a) Orphaned upload sessions: upload_sessions rows older than 24 h with
 *      no matching managed_videos row — delete associated upload_chunks,
 *      clean up orphaned _parts storage blobs, then delete the session row.
 *
 *  (b) Orphaned upload chunks: upload_chunks rows for sessions that are
 *      completed/cancelled (inline assembly cleanup is non-fatal and can be
 *      skipped by a crash) or whose parent session no longer exists.
 *      Runs with a 2-hour grace period so it never races an in-progress
 *      assembly.
 *
 *  (c) Corrupt-upload blobs: managed_videos rows with transcodingStatus = 'failed'
 *      AND transcodingErrorCode IN ('CORRUPT_SOURCE', 'SOURCE_MISSING',
 *      'ASSEMBLY_FAILED') AND the quarantine was created more than
 *      CORRUPT_UPLOAD_RETENTION_DAYS days ago — delete storage object,
 *      set objectPath = null.
 *
 *  (d) Stuck transcoding: managed_videos rows with transcodingStatus = 'queued'
 *      and updatedAt older than 2 h with no active transcoding job (status
 *      'queued' or 'processing' in transcoding_jobs) — auto-requeued via
 *      enqueueTranscode() so the dispatcher picks them up on restart; or reset
 *      to 'failed' with STUCK_TRANSCODE if objectPath is missing (can't retry).
 *
 * All sweeps are non-fatal: errors are logged and the worker continues.
 * Emits ops-alerts only when anomalies are found.
 */
import { sql, and, eq, lt, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { storage } from "../../infrastructure/storage.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { enqueueTranscode } from "../transcoder/transcoder.queue.js";

const CORRUPT_UPLOAD_RETENTION_DAYS = Number(
  process.env["CORRUPT_UPLOAD_RETENTION_DAYS"] ?? "7",
);
const ORPHAN_SESSION_AGE_H = 24;
const STUCK_TRANSCODE_AGE_H = 2;
/** Grace period before sweeping chunks for completed/cancelled sessions.
 *  Must be long enough that in-flight assembly never races this sweep. */
const ORPHAN_CHUNK_GRACE_H = 2;
const SWEEP_INTERVAL_MS = 30 * 60_000;

let _sweepTimer: NodeJS.Timeout | null = null;
let _stopped = false;

const v = schema.videosTable;

interface SweepStats {
  orphanedSessionsRemoved: number;
  orphanedChunksRemoved: number;
  corruptBlobsDeleted: number;
  stuckTranscodeReset: number;
  errors: number;
}

async function sweepOrphanedSessions(stats: SweepStats): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - ORPHAN_SESSION_AGE_H * 60 * 60_000);
    const rows = await db.execute<{
      session_id: string;
      object_key: string | null;
      upload_id: string | null;
    }>(sql`
      SELECT s.session_id, s.object_key, s.upload_id
      FROM upload_sessions s
      WHERE s.created_at < ${cutoff.toISOString()}
        AND s.status NOT IN ('completed', 'cancelled')
        AND NOT EXISTS (
          SELECT 1 FROM managed_videos v WHERE v.id = s.completed_video_id
        )
        -- CRITICAL SAFETY NET: When the completedVideoId update fails non-fatally
        -- (e.g. transient DB blip after the video INSERT succeeds), the session
        -- has completed_video_id = NULL even though a managed_videos row exists
        -- pointing to this exact object_key via object_path. Without this guard
        -- the session would be treated as orphaned and its blob deleted, leaving
        -- the video row permanently broken. This cross-check ensures we never
        -- sweep a session whose storage key is still referenced by any video row.
        AND (
          s.object_key IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM managed_videos v2 WHERE v2.object_path = s.object_key
          )
        )
      LIMIT 50
    `);

    for (const row of rows.rows) {
      if (_stopped) break;
      try {
        // 1. Delete associated chunk rows first (lightweight ETag records).
        await db.execute(sql`
          DELETE FROM upload_chunks WHERE session_id = ${row.session_id}
        `).catch((err: unknown) =>
          logger.warn(
            { err, sessionId: row.session_id },
            "[cleanup-worker] chunk cleanup failed for orphaned session (non-fatal)",
          ),
        );

        // 2. Delete staging parts for this upload (PostgreSQL storage — no MinIO
        //    multipart to abort, but staging rows in storage_upload_parts should
        //    be cleaned up so they do not waste BYTEA storage).
        if (row.upload_id) {
          await db.execute(sql`
            DELETE FROM storage_upload_parts WHERE upload_id = ${row.upload_id}
          `).catch((err: unknown) =>
            logger.warn(
              { err, sessionId: row.session_id, uploadId: row.upload_id },
              "[cleanup-worker] staging-parts cleanup failed for orphaned session (non-fatal)",
            ),
          );
        }

        // 3. Delete the assembled destination blob — but only after a belt-and-
        //    suspenders DB check confirms no video row references this key.
        //    The SQL WHERE above prevents most races, but this guard is defence-
        //    in-depth for any edge case where a video was inserted between the
        //    SELECT and this point (very unlikely, but catastrophic if it occurs).
        if (row.object_key) {
          const videoRef = await db.execute<{ id: string }>(sql`
            SELECT id FROM managed_videos WHERE object_path = ${row.object_key} LIMIT 1
          `).catch(() => null);
          const referencedId = (videoRef?.rows as Array<{ id: string }> | undefined)?.[0]?.id;
          if (referencedId) {
            logger.warn(
              {
                sessionId: row.session_id,
                objectKey: row.object_key,
                videoId: referencedId,
              },
              "[cleanup-worker] SAFETY: skipping blob deletion — object_key is still " +
              "referenced by a managed_videos row (completedVideoId update was non-fatal); " +
              "marking session cancelled instead of deleting its blob",
            );
            await db.execute(sql`
              UPDATE upload_sessions
              SET status = 'cancelled',
                  completed_video_id = ${referencedId},
                  updated_at = NOW()
              WHERE session_id = ${row.session_id}
            `).catch(() => {});
            continue;
          }

          const s = storage();
          if (s.enabled) {
            await s.deleteObject(row.object_key).catch(() => {});
          }
        }

        // 4. Finally remove the session row itself.
        await db.execute(sql`
          DELETE FROM upload_sessions WHERE session_id = ${row.session_id}
        `);
        stats.orphanedSessionsRemoved++;
        logger.info(
          { sessionId: row.session_id, objectKey: row.object_key, uploadId: row.upload_id },
          "[cleanup-worker] deleted orphaned upload session (chunks + parts cleaned up)",
        );
      } catch (err) {
        stats.errors++;
        logger.warn({ err, sessionId: row.session_id }, "[cleanup-worker] failed to delete orphaned session");
      }
    }
  } catch (err) {
    stats.errors++;
    logger.warn({ err }, "[cleanup-worker] orphaned-session sweep failed");
  }
}

/**
 * Belt-and-suspenders sweep for leftover upload_chunks rows.
 *
 * Two scenarios require this beyond the inline cleanup inside finalize:
 *
 *  1. The process crashed between assembly-commit and the non-fatal
 *     db.delete(chunks) call — the session shows 'completed' but chunks remain.
 *  2. The session row was deleted (externally, or by sweepOrphanedSessions on a
 *     previous cycle that pre-dated this fix) but its chunk rows were not,
 *     leaving truly orphaned BYTEA data with no parent.
 *
 * A 2-hour grace period ensures we never race an in-progress assembly.
 */
async function sweepOrphanedChunks(stats: SweepStats): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - ORPHAN_CHUNK_GRACE_H * 60 * 60_000);

    // Scenario 1 — completed/cancelled sessions with leftover chunks.
    const completedResult = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM upload_chunks uc
        USING upload_sessions us
        WHERE uc.session_id = us.session_id
          AND us.status IN ('completed', 'cancelled')
          AND us.updated_at < ${cutoff.toISOString()}
        RETURNING uc.id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `).catch((err: unknown) => {
      logger.warn({ err }, "[cleanup-worker] completed-session chunk sweep query failed (non-fatal)");
      return null;
    });

    const completedCount = Number(
      (completedResult?.rows as Array<{ count: string }> | undefined)?.[0]?.count ?? 0,
    );
    if (completedCount > 0) {
      logger.info(
        { count: completedCount },
        "[cleanup-worker] swept leftover chunks for completed/cancelled sessions",
      );
      stats.orphanedChunksRemoved += completedCount;
    }

    // Scenario 2 — truly orphaned chunks with no parent session at all.
    const orphanResult = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM upload_chunks uc
        WHERE uc.received_at < ${cutoff.toISOString()}
          AND NOT EXISTS (
            SELECT 1 FROM upload_sessions us WHERE us.session_id = uc.session_id
          )
        RETURNING uc.id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `).catch((err: unknown) => {
      logger.warn({ err }, "[cleanup-worker] orphan-chunk sweep query failed (non-fatal)");
      return null;
    });

    const orphanCount = Number(
      (orphanResult?.rows as Array<{ count: string }> | undefined)?.[0]?.count ?? 0,
    );
    if (orphanCount > 0) {
      logger.info(
        { count: orphanCount },
        "[cleanup-worker] swept truly orphaned chunks (no parent session exists)",
      );
      stats.orphanedChunksRemoved += orphanCount;
    }
  } catch (err) {
    stats.errors++;
    logger.warn({ err }, "[cleanup-worker] orphaned-chunks sweep failed");
  }
}

async function sweepCorruptBlobs(stats: SweepStats): Promise<void> {
  try {
    const retentionMs = CORRUPT_UPLOAD_RETENTION_DAYS * 24 * 60 * 60_000;
    const cutoff = new Date(Date.now() - retentionMs);

    const rows = await db.execute<{
      id: string;
      object_path: string | null;
      title: string;
      transcoding_error_code: string | null;
    }>(sql`
      SELECT mv.id, mv.object_path, mv.title, mv.transcoding_error_code
      FROM managed_videos mv
      INNER JOIN media_audit_log mal ON mal.video_id = mv.id
      WHERE mv.transcoding_status = 'failed'
        AND mv.transcoding_error_code IN ('CORRUPT_SOURCE', 'SOURCE_MISSING', 'STORAGE_LOST')
        AND mv.object_path IS NOT NULL
        AND mal.action = 'QUARANTINE'
        AND mal.created_at < ${cutoff.toISOString()}
      LIMIT 20
    `);

    for (const row of rows.rows) {
      if (_stopped) break;
      try {
        const s = storage();
        if (s.enabled && row.object_path) {
          await s.deleteObject(row.object_path).catch(() => {});
        }
        await db
          .update(v)
          .set({ objectPath: null })
          .where(eq(v.id, row.id));
        stats.corruptBlobsDeleted++;
        logger.info(
          { videoId: row.id, objectPath: row.object_path, errorCode: row.transcoding_error_code },
          "[cleanup-worker] pruned expired corrupt-upload blob",
        );
      } catch (err) {
        stats.errors++;
        logger.warn({ err, videoId: row.id }, "[cleanup-worker] failed to prune corrupt blob");
      }
    }

    if (stats.corruptBlobsDeleted > 0) {
      adminEventBus.push("videos-library-updated", {
        reason: "cleanup-worker-corrupt-blobs-pruned",
        count: stats.corruptBlobsDeleted,
      });
    }
  } catch (err) {
    stats.errors++;
    logger.warn({ err }, "[cleanup-worker] corrupt-blob sweep failed");
  }
}

async function sweepStuckTranscodes(stats: SweepStats): Promise<void> {
  try {
    // Use updatedAt (not importedAt) as the cutoff so old videos that are
    // legitimately re-queued today are not immediately flagged. updatedAt is
    // bumped automatically by the $onUpdate hook on every row write, including
    // every transcodingStatus change.
    const cutoff = new Date(Date.now() - STUCK_TRANSCODE_AGE_H * 60 * 60_000);

    // Only include videos with no active transcoding job (queued or processing).
    // The doc comment always promised this check but the original code omitted it,
    // causing videos being actively processed to be wrongly reset.
    const rows = await db
      .select({ id: v.id, title: v.title, objectPath: v.objectPath })
      .from(v)
      .where(
        and(
          eq(v.transcodingStatus, "queued"),
          lt(v.updatedAt, cutoff),
          sql`NOT EXISTS (
            SELECT 1 FROM transcoding_jobs j
            WHERE j.video_id = ${v.id}
            AND j.status IN ('queued', 'processing')
          )`,
        ),
      )
      .limit(20);

    if (rows.length === 0) return;

    // Split into re-queuable (have a source blob) vs truly unrecoverable.
    const requeue = rows.filter((r) => r.objectPath != null);
    const noSource = rows.filter((r) => r.objectPath == null);

    // Re-enqueue videos that have a source blob so the dispatcher picks them
    // up automatically on its next poll — no manual operator action needed.
    const requeuedIds: string[] = [];
    for (const row of requeue) {
      try {
        await enqueueTranscode({ videoId: row.id, objectKey: row.objectPath! });
        requeuedIds.push(row.id);
      } catch (enqErr) {
        logger.warn(
          { err: enqErr, videoId: row.id },
          "[cleanup-worker] stuck-transcode: failed to re-enqueue video",
        );
        // Fall through — will be caught by the noSource path on next sweep
      }
    }

    // Videos with no objectPath cannot be re-transcoded: mark failed so the
    // operator knows to re-upload.
    const noSourceIds = noSource.map((r) => r.id);
    if (noSourceIds.length > 0) {
      await db
        .update(v)
        .set({
          transcodingStatus: "failed",
          transcodingErrorCode: "STUCK_TRANSCODE",
          transcodingErrorMessage:
            "Transcoding job was queued more than 2 hours ago but never started, " +
            "and no source blob is on file to retry from. " +
            "Re-upload the video to retry.",
        })
        .where(inArray(v.id, noSourceIds));
    }

    const totalAffected = requeuedIds.length + noSourceIds.length;
    stats.stuckTranscodeReset += totalAffected;

    if (requeuedIds.length > 0) {
      logger.warn(
        { count: requeuedIds.length, videoIds: requeuedIds },
        "[cleanup-worker] stuck-transcode: auto-requeued videos stuck in 'queued' >2 h",
      );
    }
    if (noSourceIds.length > 0) {
      logger.warn(
        { count: noSourceIds.length, videoIds: noSourceIds },
        "[cleanup-worker] stuck-transcode: marked videos failed (no source blob, cannot retry)",
      );
    }

    adminEventBus.push("videos-library-updated", {
      reason: "cleanup-worker-stuck-transcode-reset",
      count: totalAffected,
    });

    try {
      adminEventBus.push("ops-alert", {
        level: "warn",
        title: "Stuck transcoding jobs requeued",
        message:
          `${requeuedIds.length} video(s) were stuck in 'queued' state for >2 hours with no active job ` +
          `and have been automatically requeued. ` +
          (noSourceIds.length > 0
            ? `${noSourceIds.length} additional video(s) had no source blob and were marked failed. `
            : "") +
          `Check the transcoder worker if jobs remain stuck after the next poll.`,
        timestamp: new Date().toISOString(),
        source: "cleanup-worker",
      });
    } catch {
      // non-fatal
    }
  } catch (err) {
    stats.errors++;
    logger.warn({ err }, "[cleanup-worker] stuck-transcode sweep failed");
  }
}

async function runSweep(): Promise<void> {
  if (_stopped) return;
  const start = Date.now();
  const stats: SweepStats = {
    orphanedSessionsRemoved: 0,
    orphanedChunksRemoved: 0,
    corruptBlobsDeleted: 0,
    stuckTranscodeReset: 0,
    errors: 0,
  };

  logger.debug("[cleanup-worker] sweep started");

  await sweepOrphanedSessions(stats);
  if (!_stopped) await sweepOrphanedChunks(stats);
  if (!_stopped) await sweepCorruptBlobs(stats);
  if (!_stopped) await sweepStuckTranscodes(stats);

  const durationMs = Date.now() - start;
  logger.info(
    { ...stats, durationMs },
    "[cleanup-worker] sweep complete",
  );
}

export const cleanupWorker = {
  start(): void {
    if (_sweepTimer) return;
    _stopped = false;

    const scheduleNext = (): void => {
      _sweepTimer = setTimeout(() => {
        _sweepTimer = null;
        void runSweep().catch((err) =>
          logger.warn({ err }, "[cleanup-worker] sweep error"),
        ).finally(() => {
          if (!_stopped) scheduleNext();
        });
      }, SWEEP_INTERVAL_MS);
      _sweepTimer.unref?.();
    };

    scheduleNext();
    logger.info(
      { intervalMs: SWEEP_INTERVAL_MS, retentionDays: CORRUPT_UPLOAD_RETENTION_DAYS },
      "[cleanup-worker] started",
    );
  },

  stop(): void {
    _stopped = true;
    if (_sweepTimer) {
      clearTimeout(_sweepTimer);
      _sweepTimer = null;
    }
  },

  /** Run a sweep immediately (for testing / admin "run now" trigger). */
  async sweep(): Promise<SweepStats> {
    const stats: SweepStats = {
      orphanedSessionsRemoved: 0,
      orphanedChunksRemoved: 0,
      corruptBlobsDeleted: 0,
      stuckTranscodeReset: 0,
      errors: 0,
    };
    await sweepOrphanedSessions(stats);
    await sweepOrphanedChunks(stats);
    await sweepCorruptBlobs(stats);
    await sweepStuckTranscodes(stats);
    return stats;
  },
};
