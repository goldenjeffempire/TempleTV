/**
 * Storage cleanup worker.
 *
 * Runs every 30 minutes and performs three sweeps:
 *
 *  (a) Orphaned upload sessions: upload_sessions rows older than 24 h with
 *      no matching managed_videos row — delete storage object, delete session.
 *
 *  (b) Corrupt-upload blobs: managed_videos rows with transcodingStatus = 'failed'
 *      AND transcodingErrorCode IN ('CORRUPT_SOURCE', 'SOURCE_MISSING',
 *      'ASSEMBLY_FAILED') AND the quarantine was created more than
 *      CORRUPT_UPLOAD_RETENTION_DAYS days ago — delete storage object,
 *      set objectPath = null.
 *
 *  (c) Stuck transcoding: managed_videos rows with transcodingStatus = 'queued'
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
const SWEEP_INTERVAL_MS = 30 * 60_000;

let _sweepTimer: NodeJS.Timeout | null = null;
let _stopped = false;

const v = schema.videosTable;

interface SweepStats {
  orphanedSessionsRemoved: number;
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
        if (row.object_key) {
          const s = storage();
          if (s.enabled) {
            await s.deleteObject(row.object_key).catch(() => {});
          }
        }
        await db.execute(sql`
          DELETE FROM upload_sessions WHERE session_id = ${row.session_id}
        `);
        stats.orphanedSessionsRemoved++;
        logger.info(
          { sessionId: row.session_id, objectKey: row.object_key },
          "[cleanup-worker] deleted orphaned upload session",
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
    corruptBlobsDeleted: 0,
    stuckTranscodeReset: 0,
    errors: 0,
  };

  logger.debug("[cleanup-worker] sweep started");

  await sweepOrphanedSessions(stats);
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
      corruptBlobsDeleted: 0,
      stuckTranscodeReset: 0,
      errors: 0,
    };
    await sweepOrphanedSessions(stats);
    await sweepCorruptBlobs(stats);
    await sweepStuckTranscodes(stats);
    return stats;
  },
};
