/**
 * Storage cleanup worker.
 *
 * Runs every 30 minutes and performs four sweeps:
 *
 *  (a) Orphaned upload sessions: upload_sessions rows older than 24 h with
 *      no matching managed_videos row — delete associated upload_chunks
 *      (including db_fallback BYTEA data), clean up orphaned _parts storage
 *      blobs, then delete the session row.
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
 *      and importedAt older than 2 h with no active transcoding job — reset to
 *      'failed' with STUCK_TRANSCODE error code.
 *
 * All sweeps are non-fatal: errors are logged and the worker continues.
 * Emits ops-alerts only when anomalies are found.
 */
import { sql, and, eq, lt, inArray } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { storage } from "../../infrastructure/storage.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";

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
      LIMIT 50
    `);

    for (const row of rows.rows) {
      if (_stopped) break;
      try {
        // 1. Delete associated chunk rows first. For db_fallback sessions these
        //    hold the raw BYTEA video data — skipping this causes an unbounded
        //    storage_blobs / upload_chunks growth. For db-mode sessions the rows
        //    are lightweight (etags only) but cleaning them keeps the table tidy.
        await db.execute(sql`
          DELETE FROM upload_chunks WHERE session_id = ${row.session_id}
        `).catch((err: unknown) =>
          logger.warn(
            { err, sessionId: row.session_id },
            "[cleanup-worker] chunk cleanup failed for orphaned session (non-fatal)",
          ),
        );

        // 2. Clean up orphaned _parts/{uploadId}/… rows in storage_blobs.
        //    These are created during the db-mode multipart upload path and
        //    should be removed by completeMultipartUpload on success, but
        //    abandoned sessions leave them behind indefinitely.
        if (row.upload_id) {
          const partPrefix = `_parts/${row.upload_id}/`;
          await db.execute(sql`
            DELETE FROM storage_blobs WHERE starts_with(key, ${partPrefix})
          `).catch((err: unknown) =>
            logger.warn(
              { err, sessionId: row.session_id, uploadId: row.upload_id },
              "[cleanup-worker] _parts cleanup failed for orphaned session (non-fatal)",
            ),
          );
        }

        // 3. Delete the assembled destination blob if one exists.
        if (row.object_key) {
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
        AND mv.transcoding_error_code IN ('CORRUPT_SOURCE', 'SOURCE_MISSING', 'ASSEMBLY_FAILED')
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
    const cutoff = new Date(Date.now() - STUCK_TRANSCODE_AGE_H * 60 * 60_000);
    const rows = await db
      .select({ id: v.id, title: v.title })
      .from(v)
      .where(
        and(
          eq(v.transcodingStatus, "queued"),
          lt(v.importedAt, cutoff),
        ),
      )
      .limit(20);

    if (rows.length === 0) return;

    const ids = rows.map((r) => r.id);
    await db
      .update(v)
      .set({
        transcodingStatus: "failed",
        transcodingErrorCode: "STUCK_TRANSCODE",
        transcodingErrorMessage:
          "Transcoding job was queued more than 2 hours ago but never started. " +
          "This may indicate a transcoder crash or missing worker process. " +
          "Re-enqueue from the admin panel to retry.",
      })
      .where(inArray(v.id, ids));

    stats.stuckTranscodeReset += ids.length;
    logger.warn(
      { count: ids.length, videoIds: ids },
      "[cleanup-worker] reset stuck transcoding jobs (queued > 2 h with no progress)",
    );

    adminEventBus.push("videos-library-updated", {
      reason: "cleanup-worker-stuck-transcode-reset",
      count: ids.length,
    });

    if (ids.length > 0) {
      try {
        adminEventBus.push("ops-alert", {
          level: "warn",
          title: "Stuck transcoding jobs detected",
          message: `${ids.length} video(s) were stuck in 'queued' state for >2 hours and have been reset to 'failed'. Check the transcoder worker.`,
          timestamp: new Date().toISOString(),
          source: "cleanup-worker",
        });
      } catch {
        // non-fatal
      }
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
