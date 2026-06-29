/**
 * Upload Integrity Monitor
 *
 * Background worker that periodically scans storage for anomalies that the
 * hot-path guards (completeMultipartUpload transaction, finalize pre-flight)
 * cannot catch after the fact:
 *
 *   1. Corrupt blobs — storage_blobs rows where size_bytes = 0 or
 *      size_bytes ≠ octet_length(data).  Can result from a crash between an
 *      UPDATE and COMMIT in a legacy assembly path, or from direct DB edits.
 *
 *   2. Videos with a confirmed blob reference (s3MirroredAt IS NOT NULL)
 *      but no matching row in storage_blobs — the blob is gone.  These
 *      videos produce a 404 on every playback request.
 *
 *   3. Orphaned storage_upload_parts — BYTEA rows whose upload_id no longer
 *      matches any active upload session (session completed, expired, or
 *      aborted without full cleanup).  Each row is up to 8 MiB; orphans
 *      waste significant PostgreSQL storage.
 *
 * All scans use tight LIMIT caps to bound PostgreSQL I/O and avoid impacting
 * production traffic.  Findings are emitted as structured log entries and
 * admin-event-bus "ops-alert" events for operator visibility.
 *
 * Registered in main.ts startWorkers() via workerSupervisor.spawn():
 *   interval: 30 min, initial delay: 5 min, timeout: 10 min.
 */

import { sql, eq } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger as rootLogger } from "../../infrastructure/logger.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";

const logger = rootLogger.child({ module: "upload-integrity-monitor" });
const videos = schema.videosTable;

// ── Limits per scan pass to bound DB I/O ─────────────────────────────────────
const MAX_CORRUPT_BLOBS_PER_PASS = 20;
const MAX_MISSING_BLOBS_PER_PASS = 20;
const MAX_ORPHAN_UPLOAD_IDS_PER_PASS = 30;

// ── Helper: extract rows from Drizzle execute() result ───────────────────────
// Drizzle wraps pg results differently depending on driver version; handle both.
function extractRows<T>(result: unknown): T[] {
  if (!result) return [];
  const r = result as { rows?: T[] } | T[];
  if (Array.isArray(r)) return r as T[];
  return (r as { rows?: T[] }).rows ?? [];
}

// ── Pass 1: Corrupt blobs ─────────────────────────────────────────────────────
// Find storage_blobs rows where size_bytes = 0 or size_bytes ≠ actual data
// length.  For each: mark the referencing video CORRUPT_SOURCE, delete the
// corrupt blob, push an ops-alert.
async function scanCorruptBlobs(): Promise<number> {
  type CorruptRow = { key: string; size_bytes: string; actual_bytes: string };
  const rows = extractRows<CorruptRow>(
    await db.execute<CorruptRow>(sql`
      SELECT
        key,
        size_bytes::text         AS size_bytes,
        octet_length(data)::text AS actual_bytes
      FROM storage_blobs
      WHERE size_bytes = 0 OR size_bytes != octet_length(data)
      LIMIT ${MAX_CORRUPT_BLOBS_PER_PASS}
    `).catch(() => null),
  );

  if (rows.length === 0) return 0;

  logger.warn(
    { count: rows.length },
    "[integrity] corrupt blobs detected — starting remediation",
  );

  let fixed = 0;
  for (const row of rows) {
    const { key, size_bytes, actual_bytes } = row;
    try {
      const [video] = await db
        .select({ id: videos.id, transcodingStatus: videos.transcodingStatus })
        .from(videos)
        .where(eq(videos.objectPath, key))
        .limit(1);

      if (video && video.transcodingStatus !== "failed") {
        await db
          .update(videos)
          .set({
            transcodingStatus: "failed",
            transcodingErrorCode: "CORRUPT_SOURCE",
            transcodingErrorMessage:
              `Storage integrity scan found a corrupt blob at key=${key}: ` +
              `recorded size_bytes=${size_bytes} but actual data is ${actual_bytes} bytes. ` +
              `Delete this video and re-upload to recover.`,
          })
          .where(eq(videos.id, video.id));

        adminEventBus.push("videos-library-updated", {
          videoId: video.id,
          reason: "integrity-scan-corrupt-blob",
        });
      }

      await db.execute(sql`DELETE FROM storage_blobs WHERE key = ${key}`);

      logger.error(
        {
          key,
          size_bytes: Number(size_bytes),
          actual_bytes: Number(actual_bytes),
          videoId: video?.id ?? null,
        },
        "[integrity] corrupt blob deleted — video marked CORRUPT_SOURCE",
      );

      adminEventBus.push("ops-alert", {
        level: "error",
        component: "upload-integrity-monitor",
        message:
          `Corrupt storage blob detected and removed: key=${key} ` +
          `(recorded ${size_bytes} bytes, actual ${actual_bytes} bytes). ` +
          (video ? `Video ${video.id} marked CORRUPT_SOURCE.` : "No referencing video found."),
      });

      fixed++;
    } catch (err) {
      logger.warn({ err, key }, "[integrity] failed to remediate corrupt blob (will retry next pass)");
    }
  }

  return fixed;
}

// ── Pass 2: Videos with missing blobs ────────────────────────────────────────
// Videos where s3MirroredAt IS NOT NULL (blob was confirmed written) but no
// matching row exists in storage_blobs.  These play as 404.
async function scanMissingBlobs(): Promise<number> {
  type MissingRow = { id: string; object_path: string };
  const rows = extractRows<MissingRow>(
    await db.execute<MissingRow>(sql`
      SELECT v.id, v.object_path
      FROM managed_videos v
      LEFT JOIN storage_blobs b ON b.key = v.object_path
      WHERE v.s3_mirrored_at IS NOT NULL
        AND v.object_path IS NOT NULL
        AND b.key IS NULL
        AND v.transcoding_status != 'failed'
      LIMIT ${MAX_MISSING_BLOBS_PER_PASS}
    `).catch(() => null),
  );

  if (rows.length === 0) return 0;

  logger.warn(
    { count: rows.length },
    "[integrity] videos with s3MirroredAt but missing blob detected",
  );

  let handled = 0;
  for (const row of rows) {
    const { id, object_path } = row;
    try {
      type SessionRow = { session_id: string; total_chunks: number; upload_id: string | null };
      const [session] = extractRows<SessionRow>(
        await db.execute<SessionRow>(sql`
          SELECT session_id, total_chunks, upload_id
          FROM upload_sessions
          WHERE completed_video_id = ${id}
          LIMIT 1
        `).catch(() => null),
      );

      let hasPartsForReassembly = false;
      if (session?.upload_id) {
        type CntRow = { cnt: string };
        const [cntRow] = extractRows<CntRow>(
          await db.execute<CntRow>(sql`
            SELECT COUNT(*)::text AS cnt
            FROM storage_upload_parts
            WHERE upload_id = ${session.upload_id}
          `).catch(() => null),
        );
        const partsPresent = parseInt(cntRow?.cnt ?? "0", 10);
        hasPartsForReassembly = partsPresent >= (session.total_chunks ?? 1);
      }

      if (hasPartsForReassembly && session) {
        // Parts still available — reset to trigger auto-reconciliation.
        await db.execute(sql`
          UPDATE upload_sessions
          SET status = 'assembling', updated_at = NOW()
          WHERE session_id = ${session.session_id}
            AND status = 'completed'
        `);
        await db
          .update(videos)
          .set({
            s3MirroredAt: null,
            transcodingStatus: "none",
            transcodingErrorCode: null,
            transcodingErrorMessage: null,
          })
          .where(eq(videos.id, id));

        adminEventBus.push("videos-library-updated", {
          videoId: id,
          reason: "integrity-scan-missing-blob-recovery",
        });

        logger.warn(
          { videoId: id, objectPath: object_path, sessionId: session.session_id },
          "[integrity] missing blob — upload parts present, session reset for auto-reassembly",
        );
      } else {
        // No parts remain — mark permanently failed.
        await db
          .update(videos)
          .set({
            transcodingStatus: "failed",
            transcodingErrorCode: "ASSEMBLY_FAILED",
            transcodingErrorMessage:
              `Storage integrity scan: blob at key=${object_path} is missing ` +
              `and no upload parts remain to reassemble it. ` +
              `Delete this video and re-upload to recover.`,
          })
          .where(eq(videos.id, id));

        adminEventBus.push("videos-library-updated", {
          videoId: id,
          reason: "integrity-scan-missing-blob-no-parts",
        });

        logger.error(
          { videoId: id, objectPath: object_path },
          "[integrity] missing blob — no upload parts remain, video marked ASSEMBLY_FAILED",
        );

        adminEventBus.push("ops-alert", {
          level: "error",
          component: "upload-integrity-monitor",
          message:
            `Video ${id} has s3MirroredAt set but no blob at key=${object_path} ` +
            `and no upload parts remain. Marked ASSEMBLY_FAILED — re-upload required.`,
        });
      }

      handled++;
    } catch (err) {
      logger.warn({ err, videoId: id }, "[integrity] failed to remediate missing blob (will retry next pass)");
    }
  }

  return handled;
}

// ── Pass 3: Orphaned storage_upload_parts ────────────────────────────────────
// Rows whose upload_id has no matching active session (session deleted, expired,
// or completed without the parts cleanup transaction running fully).  Each row
// holds up to 8 MiB of BYTEA — orphans waste real PostgreSQL storage.
async function scanOrphanedParts(): Promise<number> {
  type OrphanRow = { upload_id: string; part_count: string; total_bytes: string };
  const rows = extractRows<OrphanRow>(
    await db.execute<OrphanRow>(sql`
      SELECT
        p.upload_id,
        COUNT(*)::text                  AS part_count,
        SUM(octet_length(p.data))::text AS total_bytes
      FROM storage_upload_parts p
      LEFT JOIN upload_sessions s ON s.upload_id = p.upload_id
      WHERE s.session_id IS NULL
         OR s.status = 'completed'
      GROUP BY p.upload_id
      LIMIT ${MAX_ORPHAN_UPLOAD_IDS_PER_PASS}
    `).catch(() => null),
  );

  if (rows.length === 0) return 0;

  const totalOrphanBytes = rows.reduce(
    (sum, r) => sum + parseInt(r.total_bytes ?? "0", 10),
    0,
  );

  logger.info(
    { orphanUploadIds: rows.length, totalOrphanBytes },
    "[integrity] orphaned storage_upload_parts detected — cleaning up",
  );

  let deleted = 0;
  for (const row of rows) {
    try {
      await db.execute(sql`
        DELETE FROM storage_upload_parts WHERE upload_id = ${row.upload_id}
      `);
      logger.info(
        {
          uploadId: row.upload_id,
          parts: Number(row.part_count),
          bytes: Number(row.total_bytes),
        },
        "[integrity] orphaned upload parts deleted",
      );
      deleted++;
    } catch (err) {
      logger.warn(
        { err, uploadId: row.upload_id },
        "[integrity] failed to delete orphaned parts (will retry next pass)",
      );
    }
  }

  if (totalOrphanBytes > 10 * 1024 * 1024) {
    adminEventBus.push("ops-alert", {
      level: "warn",
      component: "upload-integrity-monitor",
      message:
        `Cleaned up ${rows.length} orphaned upload part group(s) ` +
        `(${Math.round(totalOrphanBytes / 1024 / 1024)} MiB freed from storage_upload_parts).`,
    });
  }

  return deleted;
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function runUploadIntegrityScan(): Promise<void> {
  const startMs = Date.now();
  logger.info("[integrity] upload integrity scan started");

  const results = await Promise.allSettled([
    scanCorruptBlobs(),
    scanMissingBlobs(),
    scanOrphanedParts(),
  ]);

  const [corruptFixed, missingHandled, orphansDeleted] = results.map((r) =>
    r.status === "fulfilled" ? r.value : 0,
  );

  const elapsedMs = Date.now() - startMs;
  logger.info(
    {
      elapsedMs,
      corruptBlobsFixed: corruptFixed,
      missingBlobsHandled: missingHandled,
      orphanPartGroupsDeleted: orphansDeleted,
    },
    "[integrity] upload integrity scan complete",
  );

  // Re-throw if ALL three passes failed so the worker supervisor can
  // count it as a consecutive failure and open the circuit breaker.
  const allFailed = results.every((r) => r.status === "rejected");
  if (allFailed) {
    throw (results[0] as PromiseRejectedResult).reason;
  }
}
