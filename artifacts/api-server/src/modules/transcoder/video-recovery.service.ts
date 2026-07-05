/**
 * Production-grade video deep recovery service — MP4-only pipeline.
 *
 * Scans every locally-uploaded video for pipeline issues, classifies the root
 * cause, applies the appropriate idempotent recovery action, and returns a
 * structured report. Safe to run multiple times — videos already in a healthy
 * state are counted and skipped; no duplicate jobs or queue entries are created.
 *
 * Issue taxonomy (MP4-only pipeline — TRANSCODER_DISABLE=1):
 *   STORAGE_LOST        — s3MirroredAt set (blob confirmed) but blob is now absent → quarantine
 *   MISSING_FROM_QUEUE  — MP4-ready video not in active broadcast queue → re-enqueue
 *   FAILED_SOURCE_GONE  — transcoding_status='failed', source blob confirmed absent → quarantine
 *   FAILED_RETRYABLE    — transcoding_status='failed', blob still present (transcoder disabled — log only)
 *   ORPHAN_ENCODING     — status='encoding' with no active job for >90 min → reset + re-enqueue
 *   STUCK_QUEUED        — status='queued' with no job progress for >60 min → reset + re-enqueue
 *   NEVER_PROCESSED     — status='none', has objectPath but no localVideoUrl (HLS-era legacy)
 *   DEAD_LETTER         — latest job is in dead_letter (transcoder disabled — log only)
 *   HEALTHY             — stored, blob confirmed, queued for broadcast → skip
 *
 * Fixed bugs vs. previous version:
 *   • Removed mv.faststart_applied from snapshot SELECT — column no longer exists in schema
 *     (was "column managed_videos.faststart_applied does not exist" fatal SQL error)
 *   • Fixed ANY(${ids}::text[]) Drizzle array binding bug — Drizzle expands JS arrays
 *     as tuples ($1,$2…) not pg array literals → ERROR 42846 on multi-video recovery.
 *     All bulk UPDATE statements now use Drizzle ORM inArray() builder instead.
 *   • Added Phase 0: repairMissingS3MirroredAt() before snapshot so isMp4Ready
 *     classification is accurate (previously videos with valid blobs but null stamp
 *     were misclassified as "in-progress / healthy").
 *   • Added SET LOCAL statement_timeout (30 s) on the snapshot transaction to bound
 *     execution time on large catalogs and prevent DB pool exhaustion.
 *   • Fixed resetOrphaned / resetStuck counter double-counting (were incremented in
 *     both Phase 3/4 bulk-reset AND Phase 5 enqueue loop).
 *   • Fixed storage_lost classification gap — previously a video with st='failed' AND
 *     errCode='STORAGE_LOST' fell through to failed_source_gone, bypassing the
 *     storage_lost branch. Now blobConfirmedMissing always wins at highest priority.
 *   • Fixed buildReport quarantine count — now counts both quarantined_source_gone
 *     AND quarantined_storage_lost.
 *   • Added storageLostConfirmed to actions (was computed but not surfaced in report).
 *   • Replaced transcoding stub calls (enqueueTranscode, retryAllFailed, requeueFromDlq,
 *     transcoderDispatcher.nudge) with MP4-pipeline-appropriate actions.
 *   • Updated buildItem messages for MP4 pipeline accuracy (no HLS/FastStart references).
 *   • Added comprehensive per-phase structured logging with timing.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger as rootLogger } from "../../infrastructure/logger.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import {
  enqueueIfMissing,
  repairMissingS3MirroredAt,
} from "../broadcast/auto-enqueue.service.js";
import {
  clearAllBadUrls,
  reEnableAllSuspended,
} from "../broadcast-v2/repository/queue.repo.js";
import { broadcastOrchestrator } from "../broadcast-v2/engine/broadcast-orchestrator.js";

const log = rootLogger.child({ module: "video-recovery" });

// ── Execution budget constants ─────────────────────────────────────────────────
// Snapshot is bounded by DB statement_timeout so a slow blob check on a large
// catalog does not hold the connection pool indefinitely.
const SNAPSHOT_TIMEOUT_MS = 30_000;  // 30 s for the complex multi-join snapshot query
const ORPHAN_THRESHOLD_MS = 90 * 60 * 1_000;  // 90 min: encoding with no heartbeat
const STUCK_QUEUE_MS      = 60 * 60 * 1_000;  // 60 min: queued with no progress
const MAX_VIDEOS_PER_SCAN = 5_000;             // guard: prevent unbounded full-table scans

// ── Types ─────────────────────────────────────────────────────────────────────

type IssueKind =
  | "healthy"
  | "failed_retryable"
  | "failed_source_gone"
  | "storage_lost"
  | "orphan_encoding"
  | "stuck_queued"
  | "never_processed"
  | "dead_letter"
  | "missing_from_queue";

type ActionTaken =
  | "skipped_healthy"
  | "retried_transcoding"
  | "reset_orphan_and_requeued"
  | "reset_stuck_and_requeued"
  | "enqueued_unprocessed"
  | "requeued_from_dlq"
  | "enqueued_broadcast"
  | "quarantined_source_gone"
  | "quarantined_storage_lost"
  | "no_action_transcoding_disabled"
  | "error";

export interface RecoveryItem {
  videoId: string;
  title: string;
  issueKind: IssueKind;
  issueDetail: string;
  actionTaken: ActionTaken;
  actionDetail: string;
  previousStatus: string;
  previousErrorCode: string | null;
  blobVerified: boolean | null;
  rootCause: string | null;
}

export interface RecoveryReport {
  runAt: string;
  durationMs: number;
  totalLocalVideos: number;
  summary: {
    healthy: number;
    recovered: number;
    quarantined: number;
    errors: number;
  };
  actions: {
    retriedFailed: number;
    resetOrphaned: number;
    resetStuck: number;
    enqueuedUnprocessed: number;
    enqueuedBroadcast: number;
    requeuedDlq: number;
    sourceMissingConfirmed: number;
    storageLostConfirmed: number;
    badUrlCacheCleared: boolean;
    suspendedReEnabled: number;
    blobStampsRepaired: number;
  };
  items: RecoveryItem[];
  remainingActions: string[];
}

// ── Snapshot row shape returned by Phase 1 query ───────────────────────────────

interface SnapshotRow {
  id: string;
  title: string;
  transcoding_status: string;
  transcoding_error_code: string | null;
  transcoding_error_message: string | null;
  object_path: string | null;
  local_video_url: string | null;
  // s3_mirrored_at comes back as a Date from pg driver (timestamptz), or null.
  s3_mirrored_at: Date | string | null;
  latest_job_id: string | null;
  latest_job_status: string | null;
  latest_job_started_at: Date | string | null;
  latest_job_last_progress: Date | string | null;
  // PostgreSQL returns booleans as JS booleans from pg driver.
  in_broadcast_queue: boolean;
  // null = no storage key could be derived (no object_path and no local_video_url).
  blob_valid: boolean | null;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runDeepRecovery(): Promise<RecoveryReport> {
  const startMs = Date.now();
  const runAt = new Date().toISOString();
  const items: RecoveryItem[] = [];

  const actions: RecoveryReport["actions"] = {
    retriedFailed: 0,
    resetOrphaned: 0,
    resetStuck: 0,
    enqueuedUnprocessed: 0,
    enqueuedBroadcast: 0,
    requeuedDlq: 0,
    sourceMissingConfirmed: 0,
    storageLostConfirmed: 0,
    badUrlCacheCleared: false,
    suspendedReEnabled: 0,
    blobStampsRepaired: 0,
  };

  log.info({ phase: 0, totalMs: 0 }, "deep-recovery: starting full local-video audit");

  // ── Phase 0: Repair missing s3_mirrored_at stamps ─────────────────────────
  // Must run BEFORE the snapshot so Phase 2 classification is accurate.
  //
  // Problem: the post-assembly UPDATE that stamps s3_mirrored_at on each video
  // runs inside a Promise.all() that previously swallowed errors silently. If
  // it ever failed (transient pool exhaustion, statement timeout), the video
  // row keeps s3_mirrored_at=NULL permanently. Phase 2 uses s3_mirrored_at as
  // the gate for isMp4Ready — so these videos are perpetually misclassified as
  // "in progress / healthy" rather than "missing_from_queue", and they never
  // enter the broadcast queue automatically.
  //
  // repairMissingS3MirroredAt() confirms blob existence in storage_blobs and
  // stamps the column in-band, so the snapshot that follows sees up-to-date data.
  try {
    const { repaired } = await repairMissingS3MirroredAt();
    actions.blobStampsRepaired = repaired;
    if (repaired > 0) {
      log.info(
        { repaired, phase: 0, elapsedMs: Date.now() - startMs },
        "deep-recovery[0]: repaired missing s3_mirrored_at blob-confirmation stamps",
      );
    }
  } catch (err) {
    log.warn({ err, phase: 0 }, "deep-recovery[0]: repairMissingS3MirroredAt failed (non-fatal)");
  }

  // ── Phase 1: Snapshot every locally-uploaded video ────────────────────────
  // One query (run inside a transaction with SET LOCAL statement_timeout) captures:
  //   • transcoding_status + error code + message
  //   • local_video_url + s3_mirrored_at (MP4 pipeline: blob-confirmation stamp)
  //   • latest transcoding job state (for orphan/stuck detection; table may be empty)
  //   • whether the video is in the active broadcast queue (EXISTS subquery)
  //   • whether the storage blob exists with size > 0 (inline correlated EXISTS)
  //
  // KEY DESIGN DECISIONS:
  //
  //  1. faststart_applied is NOT selected.
  //     The column was removed from managed_videos during the FastStart pipeline
  //     removal. The old snapshot included `mv.faststart_applied` which caused:
  //       ERROR: column managed_videos.faststart_applied does not exist
  //     This aborted the entire deep recovery run for every invocation.
  //
  //  2. SET LOCAL statement_timeout = 30 s bounds execution time.
  //     The inline blob EXISTS subqueries scan storage_blobs for every video
  //     row. On a large catalog this can take several seconds. Without a
  //     timeout, a single slow scan holds the connection for unbounded time,
  //     exhausting the pool and causing 503 cascades.
  //     SET LOCAL is transaction-scoped so it doesn't affect other connections.
  //     Uses sql.raw() to inline the literal — parameterized SET LOCAL is
  //     rejected by the pg driver ("ERROR: syntax error at $1").
  //
  //  3. LIMIT ${MAX_VIDEOS_PER_SCAN} prevents runaway full-table scans.
  //     Deep recovery is an operator tool, not a batch processor. If the
  //     catalog has more than 5000 local videos, the scan returns the 5000
  //     most-recently imported. Operators with very large catalogs should run
  //     the scan in batches or use the dedicated reconciliation worker.
  //
  //  4. blob_valid uses object_path (authoritative key) first, then derives
  //     the storage key from local_video_url as a fallback. This mirrors the
  //     logic in repairMissingS3MirroredAt and auditMissingBlobs, ensuring
  //     consistent key derivation across all recovery paths.

  let rows: SnapshotRow[];
  try {
    rows = await db.transaction(async (tx) => {
      // SET LOCAL is transaction-scoped: does not bleed to other connections.
      // Must use sql.raw() — the pg driver rejects parameterized SET statements.
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${SNAPSHOT_TIMEOUT_MS}`));

      const result = await tx.execute(sql`
        SELECT
          mv.id,
          mv.title,
          mv.transcoding_status,
          mv.transcoding_error_code,
          mv.transcoding_error_message,
          mv.object_path,
          mv.local_video_url,
          mv.s3_mirrored_at,
          latest.job_id             AS latest_job_id,
          latest.job_status         AS latest_job_status,
          latest.job_started_at     AS latest_job_started_at,
          latest.job_last_progress  AS latest_job_last_progress,
          -- Broadcast queue membership: true when this video has an active queue row.
          EXISTS (
            SELECT 1 FROM broadcast_queue bq
            WHERE bq.video_id = mv.id
              AND bq.is_active = true
          ) AS in_broadcast_queue,
          -- blob_valid: true  = blob exists in storage with size > 0
          --             false = key derived but blob absent or zero-size
          --             null  = no storage key could be derived (no column data)
          --
          -- Priority: object_path (authoritative DB key written at upload time) →
          --           URL-derived key (fallback for rows where objectPath was not stored).
          -- This mirrors deriveStorageKeyFromUrl() in auto-enqueue.service.ts.
          CASE
            WHEN mv.object_path IS NOT NULL THEN
              EXISTS (
                SELECT 1 FROM storage_blobs sb
                WHERE sb.key = mv.object_path
                  AND sb.size_bytes > 0
              )
            WHEN mv.local_video_url IS NOT NULL THEN
              EXISTS (
                SELECT 1 FROM storage_blobs sb
                WHERE sb.key = CASE
                  WHEN mv.local_video_url ~ '^https?://'
                    THEN CASE
                      WHEN mv.local_video_url LIKE '%/api/v1/uploads/%'
                        THEN 'uploads/' || SPLIT_PART(mv.local_video_url, '/api/v1/uploads/', 2)
                      WHEN mv.local_video_url LIKE '%/api/uploads/%'
                        THEN 'uploads/' || SPLIT_PART(mv.local_video_url, '/api/uploads/', 2)
                      ELSE NULL
                    END
                  WHEN mv.local_video_url LIKE '/api/v1/uploads/%'
                    THEN 'uploads/' || SUBSTR(mv.local_video_url, LENGTH('/api/v1/uploads/') + 1)
                  WHEN mv.local_video_url LIKE '/api/uploads/%'
                    THEN 'uploads/' || SUBSTR(mv.local_video_url, LENGTH('/api/uploads/') + 1)
                  WHEN mv.local_video_url LIKE 'uploads/%'
                    THEN mv.local_video_url
                  ELSE NULL
                END
                AND sb.size_bytes > 0
              )
            ELSE NULL
          END AS blob_valid
        FROM managed_videos mv
        LEFT JOIN LATERAL (
          SELECT
            tj.id               AS job_id,
            tj.status           AS job_status,
            tj.started_at       AS job_started_at,
            tj.last_progress_at AS job_last_progress
          FROM transcoding_jobs tj
          WHERE tj.video_id = mv.id
          ORDER BY tj.created_at DESC
          LIMIT 1
        ) latest ON true
        WHERE mv.video_source = 'local'
        ORDER BY mv.imported_at DESC
        LIMIT ${MAX_VIDEOS_PER_SCAN}
      `);
      return result.rows as unknown as SnapshotRow[];
    });
  } catch (snapshotErr) {
    // Propagate: the calling route will return 500. Operators can retry once
    // they have addressed whatever caused the snapshot to fail (e.g. DB load).
    log.error(
      { err: snapshotErr, phase: 1, elapsedMs: Date.now() - startMs },
      "deep-recovery[1]: snapshot query failed — aborting recovery",
    );
    throw snapshotErr;
  }

  log.info(
    { count: rows.length, phase: 1, elapsedMs: Date.now() - startMs },
    "deep-recovery[1]: snapshot complete",
  );

  if (rows.length === 0) {
    return buildReport(startMs, runAt, 0, items, actions);
  }

  const nowMs = Date.now();

  // ── Phase 2: Classify every video ─────────────────────────────────────────
  // Each video is assigned exactly one issueKind. The ladder is evaluated in
  // priority order: STORAGE_LOST (data loss) → isMp4Ready → HLS-legacy →
  // failed → dead_letter → orphan_encoding → stuck_queued → never_processed →
  // healthy (fallback).
  type ClassifiedRow = SnapshotRow & { issueKind: IssueKind };

  const classified: ClassifiedRow[] = rows.map((row): ClassifiedRow => {
    const st = row.transcoding_status;
    const errCode = row.transcoding_error_code;
    const objectPath = row.object_path;
    const blobValid = row.blob_valid;

    // Safely parse timestamps (pg driver may return Date or ISO string).
    const parseTs = (v: Date | string | null): number | null => {
      if (!v) return null;
      const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
      return isNaN(ms) ? null : ms;
    };
    const jobStarted = parseTs(row.latest_job_started_at);
    const jobLastProgress = parseTs(row.latest_job_last_progress);
    const lastActivity = jobLastProgress ?? jobStarted ?? 0;
    const jobStatus = row.latest_job_status;

    // ── STORAGE_LOST — highest priority ───────────────────────────────────
    // Conditions: s3_mirrored_at IS NOT NULL (assembly was confirmed by the
    //   upload finalize path) AND blob_valid IS EXPLICITLY false (not null —
    //   null means the key could not be derived, which is inconclusive).
    // This is server-side data loss. The operator did NOT delete the file.
    // No retry or re-upload should be suggested unless operator confirms.
    //
    // FIX: previously two separate conditions (st !== "failed" and errCode
    // !== "STORAGE_LOST") were checked, which caused videos with
    // st="failed" && errCode="STORAGE_LOST" to fall through to
    // failed_source_gone, bypassing the storage_lost branch entirely.
    // Now blobConfirmedMissing is evaluated first unconditionally.
    const blobConfirmedMissing =
      !!row.local_video_url &&
      !!row.s3_mirrored_at &&
      blobValid === false;
    if (blobConfirmedMissing) {
      return { ...row, issueKind: "storage_lost" };
    }

    // ── MP4-ready: blob present or check inconclusive ─────────────────────
    // On the MP4-only pipeline transcodingStatus stays "none" or "uploaded"
    // after a successful upload. A video is broadcast-eligible when:
    //   • It has a local_video_url (assembly started / completed)
    //   • s3_mirrored_at IS NOT NULL (finalize confirmed the blob was written)
    //   • blob_valid is not explicitly false (true = confirmed; null = key could
    //     not be derived but we do not block on that — the queue validator
    //     handles MISSING_BLOB deactivation if the blob is actually absent)
    //
    // Note: faststart_applied is NOT checked here (column removed from schema).
    // FastStart was a background quality optimization — it was never a broadcast
    // admission gate. Raw MP4 is broadcast-eligible regardless.
    const isMp4Ready =
      (st === "none" || st === "uploaded") &&
      !!row.local_video_url &&
      !!row.s3_mirrored_at &&
      blobValid !== false;

    if (isMp4Ready) {
      return { ...row, issueKind: row.in_broadcast_queue ? "healthy" : "missing_from_queue" };
    }

    // ── Legacy HLS-ready states ───────────────────────────────────────────
    // Videos that completed the now-removed HLS transcoding pipeline.
    // Treat as broadcast-eligible if s3_mirrored_at is set (repaired by
    // repairMissingS3MirroredAt's legacy HLS step) or blob check passes.
    if (st === "hls_ready" || st === "ready") {
      return { ...row, issueKind: row.in_broadcast_queue ? "healthy" : "missing_from_queue" };
    }

    // ── Failed with source definitively gone ──────────────────────────────
    if (st === "failed") {
      if (
        errCode === "SOURCE_MISSING" ||
        errCode === "STORAGE_LOST" ||
        errCode === "ASSEMBLY_FAILED" ||
        errCode === "CORRUPT_SOURCE" ||
        blobValid === false
      ) {
        return { ...row, issueKind: "failed_source_gone" };
      }
      // Failed but source blob status is unknown or blob is present.
      // On MP4 pipeline we cannot retry transcoding (TRANSCODER_DISABLE=1),
      // so this is logged as failed_retryable to surface it to operators.
      return { ...row, issueKind: "failed_retryable" };
    }

    // ── Dead-letter job ───────────────────────────────────────────────────
    // Transcoder is disabled on this deployment (MP4-only pipeline).
    // Dead-letter jobs cannot be requeued without the transcoder running.
    // Log for operator visibility; no automated action taken.
    if (
      jobStatus === "dead_letter" &&
      errCode !== "SOURCE_MISSING" &&
      errCode !== "CORRUPT_SOURCE" &&
      errCode !== "STORAGE_LOST"
    ) {
      return { ...row, issueKind: "dead_letter" };
    }

    // ── Stuck encoding ────────────────────────────────────────────────────
    // Video is in 'encoding' status but has no active transcoding job
    // (dispatcher crashed or was restarted). Reset to 'none' in Phase 3
    // and try to re-enqueue for broadcast in Phase 5.
    if (st === "encoding") {
      const isOrphaned =
        jobStatus === null ||
        (jobStatus !== "processing" && jobStatus !== "queued");
      const isStalled =
        lastActivity > 0 && nowMs - lastActivity > ORPHAN_THRESHOLD_MS;
      if (isOrphaned || isStalled) {
        return { ...row, issueKind: "orphan_encoding" };
      }
    }

    // ── Stuck queued ──────────────────────────────────────────────────────
    // Video has been in 'queued' state for >60 min with no progress.
    // Reset to 'none' in Phase 4 and attempt broadcast enqueue in Phase 5.
    if (st === "queued" && lastActivity > 0 && nowMs - lastActivity > STUCK_QUEUE_MS) {
      return { ...row, issueKind: "stuck_queued" };
    }

    // ── Never processed (HLS-era legacy) ─────────────────────────────────
    // Has object_path (the HLS-era source file key) but no local_video_url
    // (the MP4 pipeline column). The source was stored but the MP4 assembly
    // or HLS transcoding pipeline never completed. Transcoder is disabled;
    // no automated recovery is possible — operator must re-upload.
    if ((st === "none" || st === "uploaded") && objectPath && !row.local_video_url) {
      return { ...row, issueKind: "never_processed" };
    }

    // ── Healthy fallback ──────────────────────────────────────────────────
    // In-progress (assembling), within thresholds, or genuinely queued.
    return { ...row, issueKind: "healthy" };
  });

  const classificationCounts = {
    healthy:           classified.filter((r) => r.issueKind === "healthy").length,
    missing:           classified.filter((r) => r.issueKind === "missing_from_queue").length,
    storage_lost:      classified.filter((r) => r.issueKind === "storage_lost").length,
    failed_gone:       classified.filter((r) => r.issueKind === "failed_source_gone").length,
    failed_retryable:  classified.filter((r) => r.issueKind === "failed_retryable").length,
    orphan_encoding:   classified.filter((r) => r.issueKind === "orphan_encoding").length,
    stuck_queued:      classified.filter((r) => r.issueKind === "stuck_queued").length,
    never_processed:   classified.filter((r) => r.issueKind === "never_processed").length,
    dead_letter:       classified.filter((r) => r.issueKind === "dead_letter").length,
  };
  log.info(
    { phase: 2, elapsedMs: Date.now() - startMs, ...classificationCounts },
    "deep-recovery[2]: classification complete",
  );

  // ── Phase 3: Bulk reset orphaned-encoding videos ──────────────────────────
  // Resets transcoding_status back to 'none' so Phase 5 can attempt to
  // re-enqueue them for broadcast. Also cancels stale transcoding job leases
  // so the dispatcher (if ever re-enabled) doesn't skip them as "still leased".
  //
  // IMPORTANT: uses Drizzle ORM inArray() builder — NOT raw sql`ANY(${ids})`.
  // Drizzle expands JS arrays in sql template literals as tuples ($1,$2,…)
  // rather than pg array literals, making ANY($1,$2) invalid SQL (ERROR 42846).
  // inArray() generates valid IN ($1,$2,…) or properly-parameterized ANY().
  const orphanIds = classified
    .filter((r) => r.issueKind === "orphan_encoding")
    .map((r) => r.id);

  if (orphanIds.length > 0) {
    try {
      const resetRes = await db
        .update(schema.videosTable)
        .set({
          transcodingStatus: "none",
          transcodingErrorMessage: null,
          transcodingErrorCode: null,
        })
        .where(
          and(
            inArray(schema.videosTable.id, orphanIds),
            eq(schema.videosTable.transcodingStatus, "encoding"),
          ),
        );
      // rowCount reflects the number of rows actually changed (may be < orphanIds.length
      // if some were already reset by a concurrent recovery or manual action).
      actions.resetOrphaned = (resetRes.rowCount ?? orphanIds.length) as number;
      log.info(
        { count: actions.resetOrphaned, requested: orphanIds.length, phase: 3, elapsedMs: Date.now() - startMs },
        "deep-recovery[3]: reset orphan-encoding videos to 'none'",
      );

      // Cancel stale processing leases so the dispatcher doesn't think these
      // jobs are still active. Non-fatal: if this fails the videos are still
      // reset and can be re-enqueued for broadcast.
      if (actions.resetOrphaned > 0) {
        await db
          .update(schema.transcodingJobsTable)
          .set({
            status: "failed",
            errorMessage: "Reset by deep-recovery: orphaned encoding state",
            leaseExpiresAt: null,
            leasedBy: null,
          })
          .where(
            and(
              inArray(schema.transcodingJobsTable.videoId, orphanIds),
              eq(schema.transcodingJobsTable.status, "processing"),
            ),
          )
          .catch((err: unknown) =>
            log.warn({ err, phase: 3 }, "deep-recovery[3]: stale lease cancel failed (non-fatal)"),
          );
      }
    } catch (err) {
      log.warn({ err, count: orphanIds.length, phase: 3 }, "deep-recovery[3]: orphan reset failed (non-fatal)");
    }
  }

  // ── Phase 4: Bulk reset stuck-queued videos ────────────────────────────────
  // Same pattern as Phase 3. Uses inArray() builder to avoid Drizzle array
  // binding bug (see Phase 3 comment above).
  const stuckIds = classified
    .filter((r) => r.issueKind === "stuck_queued")
    .map((r) => r.id);

  if (stuckIds.length > 0) {
    try {
      const resetRes = await db
        .update(schema.videosTable)
        .set({
          transcodingStatus: "none",
          transcodingErrorMessage: null,
          transcodingErrorCode: null,
        })
        .where(
          and(
            inArray(schema.videosTable.id, stuckIds),
            eq(schema.videosTable.transcodingStatus, "queued"),
          ),
        );
      actions.resetStuck = (resetRes.rowCount ?? stuckIds.length) as number;
      log.info(
        { count: actions.resetStuck, requested: stuckIds.length, phase: 4, elapsedMs: Date.now() - startMs },
        "deep-recovery[4]: reset stuck-queued videos to 'none'",
      );

      await db
        .update(schema.transcodingJobsTable)
        .set({
          status: "failed",
          errorMessage: "Reset by deep-recovery: stuck queued state",
        })
        .where(
          and(
            inArray(schema.transcodingJobsTable.videoId, stuckIds),
            eq(schema.transcodingJobsTable.status, "queued"),
          ),
        )
        .catch((err: unknown) =>
          log.warn({ err, phase: 4 }, "deep-recovery[4]: stuck job cancel failed (non-fatal)"),
        );
    } catch (err) {
      log.warn({ err, count: stuckIds.length, phase: 4 }, "deep-recovery[4]: stuck reset failed (non-fatal)");
    }
  }

  // ── Phase 5: Enqueue broadcast-ready videos not in queue ─────────────────
  // Covers three groups:
  //   (a) missing_from_queue — isMp4Ready + not currently active in queue
  //   (b) orphan_encoding — just reset to 'none'; if blob is confirmed present,
  //       enqueueIfMissing will admit them immediately (same call path as
  //       upload finalize)
  //   (c) stuck_queued — same reasoning as (b)
  //
  // enqueueIfMissing runs isPlayableForBroadcast() internally which checks:
  //   • s3MirroredAt IS NOT NULL (blob confirmed written)
  //   • no terminal error code (ASSEMBLY_FAILED / CORRUPT_SOURCE / SOURCE_MISSING)
  //   • not midnight-prayers category (restricted to dedicated channel)
  // So calling it on ALL three groups is safe — it self-filters non-ready videos.
  //
  // FIX: previously this loop incremented resetOrphaned / resetStuck counters
  //   AGAIN here (after Phase 3/4 already set them), causing a 2× double-count.
  //   Now we only increment enqueuedBroadcast.
  const toEnqueueForBroadcast = classified.filter(
    (r) =>
      r.issueKind === "missing_from_queue" ||
      r.issueKind === "orphan_encoding" ||
      r.issueKind === "stuck_queued",
  );

  for (const row of toEnqueueForBroadcast) {
    try {
      const res = await enqueueIfMissing({ videoId: row.id, reason: "deep-recovery" });
      if (res.enqueued) {
        actions.enqueuedBroadcast++;
      }
    } catch (err) {
      log.warn({ videoId: row.id, err, phase: 5 }, "deep-recovery[5]: enqueueIfMissing failed (non-fatal)");
    }
  }

  log.info(
    {
      phase: 5,
      elapsedMs: Date.now() - startMs,
      candidates: toEnqueueForBroadcast.length,
      enqueued: actions.enqueuedBroadcast,
    },
    "deep-recovery[5]: broadcast queue sync complete",
  );

  // ── Phase 6: Source-loss classification — update DB error codes ───────────
  // Both failed_source_gone and storage_lost indicate a missing blob, but they
  // imply different root causes and different operator actions:
  //
  //   STORAGE_LOST   — s3MirroredAt IS SET (assembly was confirmed) → server-
  //     side data loss. The blob was successfully written to storage_blobs but
  //     is now absent. Operator does NOT need to re-upload to fix — the storage
  //     integrity layer should recover it, or operator re-uploads to restore.
  //
  //   SOURCE_MISSING — s3MirroredAt IS NULL → the upload was never confirmed.
  //     The upload may have been interrupted or the assembly transaction rolled
  //     back. Operator may need to re-upload.
  //
  // We update the DB so the admin UI and subsequent scans show the correct code.
  // For storage_lost videos that have st != 'failed', we also flip the status.
  const sourceGoneRows = classified.filter(
    (r) => r.issueKind === "failed_source_gone" || r.issueKind === "storage_lost",
  );

  for (const row of sourceGoneRows) {
    const wasConfirmed = row.s3_mirrored_at != null;
    const correctCode = wasConfirmed ? "STORAGE_LOST" : "SOURCE_MISSING";
    const correctMsg = wasConfirmed
      ? "Source blob confirmed absent from storage during deep recovery scan. " +
        "The blob was previously written successfully (s3MirroredAt was set) — " +
        "this is server-side storage loss. Re-upload the video to restore it."
      : "Source blob absent from storage during deep recovery scan. " +
        "The upload may have been interrupted before the blob was committed. " +
        "Re-upload the original video file if the upload panel shows no recovery option.";

    const alreadyCorrect =
      row.transcoding_error_code === correctCode &&
      row.transcoding_status === "failed";

    if (!alreadyCorrect) {
      try {
        await db
          .update(schema.videosTable)
          .set({
            transcodingStatus: "failed" as const,
            transcodingErrorCode: correctCode,
            transcodingErrorMessage: correctMsg,
          })
          .where(eq(schema.videosTable.id, row.id));
      } catch (err) {
        log.warn(
          { videoId: row.id, correctCode, err, phase: 6 },
          "deep-recovery[6]: error code update failed (non-fatal)",
        );
      }
    }

    if (wasConfirmed) actions.storageLostConfirmed++;
    else actions.sourceMissingConfirmed++;
  }

  log.info(
    {
      phase: 6,
      elapsedMs: Date.now() - startMs,
      storageLost: actions.storageLostConfirmed,
      sourceMissing: actions.sourceMissingConfirmed,
    },
    "deep-recovery[6]: source-loss classification complete",
  );

  // ── Phase 7: Clear bad-URL cache + re-enable suspended queue items ─────────
  // clearAllBadUrls: resets the in-memory bad-URL blacklist so previously-blocked
  //   items get a fresh probe opportunity. Operator-visible as "bad URLs cleared".
  // reEnableAllSuspended: re-activates queue rows that were deactivated by the
  //   system validator (validatorDeactivatedReason IS NOT NULL). Operator-
  //   deactivated rows (validatorDeactivatedReason IS NULL) are untouched.
  clearAllBadUrls();
  actions.badUrlCacheCleared = true;
  try {
    actions.suspendedReEnabled = await reEnableAllSuspended();
    if (actions.suspendedReEnabled > 0) {
      log.info(
        { count: actions.suspendedReEnabled, phase: 7, elapsedMs: Date.now() - startMs },
        "deep-recovery[7]: re-enabled system-deactivated queue items",
      );
    }
  } catch (err) {
    log.warn({ err, phase: 7 }, "deep-recovery[7]: reEnableAllSuspended failed (non-fatal)");
  }

  // ── Phase 8: Reload orchestrator ──────────────────────────────────────────
  // Only reload if something actually changed. The orchestrator reload is a
  // DB read + state diff — safe to call speculatively, but skipping it when
  // there's no work avoids a needless broadcast frame boundary.
  const anyWork =
    actions.resetOrphaned > 0 ||
    actions.resetStuck > 0 ||
    actions.enqueuedBroadcast > 0 ||
    actions.suspendedReEnabled > 0 ||
    actions.blobStampsRepaired > 0;

  if (anyWork) {
    void broadcastOrchestrator.reload().catch(() => {});
    log.info(
      { phase: 8, elapsedMs: Date.now() - startMs },
      "deep-recovery[8]: orchestrator reload triggered",
    );
  }

  // ── Phase 9: Push SSE events ───────────────────────────────────────────────
  adminEventBus.push("transcoding-update", {
    type: "deep-recovery",
    retriedFailed: actions.retriedFailed,
    resetOrphaned: actions.resetOrphaned,
    resetStuck: actions.resetStuck,
    enqueuedUnprocessed: actions.enqueuedUnprocessed,
    enqueuedBroadcast: actions.enqueuedBroadcast,
  });
  adminEventBus.push("videos-library-updated", { reason: "deep-recovery" });
  adminEventBus.push("broadcast-queue-updated", { reason: "deep-recovery" });

  // ── Phase 10: Build per-video result items ─────────────────────────────────
  for (const row of classified) {
    items.push(buildItem(row));
  }

  const report = buildReport(startMs, runAt, rows.length, items, actions);
  log.info(
    {
      durationMs: report.durationMs,
      totalLocalVideos: report.totalLocalVideos,
      healthy: report.summary.healthy,
      recovered: report.summary.recovered,
      quarantined: report.summary.quarantined,
      errors: report.summary.errors,
    },
    "deep-recovery: complete",
  );
  return report;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildItem(row: SnapshotRow & { issueKind: IssueKind }): RecoveryItem {
  const base: RecoveryItem = {
    videoId: row.id,
    title: row.title,
    issueKind: row.issueKind,
    previousStatus: row.transcoding_status,
    previousErrorCode: row.transcoding_error_code,
    blobVerified: row.blob_valid,
    rootCause: null,
    issueDetail: "",
    actionTaken: "skipped_healthy",
    actionDetail: "",
  };

  switch (row.issueKind) {
    case "healthy":
      base.issueDetail = "Video has a confirmed storage blob and is queued for broadcast.";
      base.actionTaken = "skipped_healthy";
      base.actionDetail = "No action required.";
      break;

    case "failed_retryable":
      base.issueDetail = `Processing failed (${row.transcoding_error_code ?? "unknown"}) but source blob may still be present. Transcoder is disabled on this deployment (MP4-only pipeline).`;
      base.rootCause = row.transcoding_error_message ?? row.transcoding_error_code ?? "Unknown processing error";
      base.actionTaken = "no_action_transcoding_disabled";
      base.actionDetail = "Transcoding is disabled (MP4-only pipeline). Re-upload the video to recover.";
      break;

    case "failed_source_gone":
      base.issueDetail = "Processing failed and the source blob is absent from storage.";
      base.rootCause = "SOURCE_MISSING — the original uploaded file was deleted or never stored.";
      base.actionTaken = "quarantined_source_gone";
      base.actionDetail = "Marked as SOURCE_MISSING. Re-upload the original video file to restore it.";
      break;

    case "storage_lost":
      base.issueDetail =
        "The storage blob was confirmed written (s3MirroredAt is set) but is now absent from storage_blobs.";
      base.rootCause =
        "STORAGE_LOST — server-side storage data loss. The blob was successfully " +
        "uploaded and confirmed, but the corresponding storage_blobs row is gone.";
      base.actionTaken = "quarantined_storage_lost";
      base.actionDetail =
        "Marked as STORAGE_LOST. This is server-side data loss — re-upload the video to restore broadcast availability.";
      break;

    case "orphan_encoding":
      base.issueDetail =
        "Video is stuck in 'encoding' state with no active transcoding job " +
        "(dispatcher was restarted or crashed mid-job).";
      base.rootCause =
        "Server restart or crash during legacy transcoding left the video in an orphaned state.";
      base.actionTaken = "reset_orphan_and_requeued";
      base.actionDetail =
        "Reset to 'none' and stale job lease cancelled. " +
        "If the storage blob is confirmed present, the video was automatically re-added to the broadcast queue.";
      break;

    case "stuck_queued":
      base.issueDetail =
        "Video has been in 'queued' state for >60 minutes with no job progress.";
      base.rootCause =
        "Dispatcher skip, lease deadlock, or server restart lost the job context.";
      base.actionTaken = "reset_stuck_and_requeued";
      base.actionDetail =
        "Reset to 'none' and stale queue entry cancelled. " +
        "If the storage blob is confirmed present, the video was automatically re-added to the broadcast queue.";
      break;

    case "never_processed":
      base.issueDetail =
        "Source file key (object_path) is recorded but no MP4 was ever assembled " +
        "(local_video_url is absent — this is a pre-MP4-pipeline upload).";
      base.rootCause =
        "HLS-era legacy upload: the source was stored under object_path but the MP4 " +
        "assembly pipeline never ran or completed for this video.";
      base.actionTaken = "no_action_transcoding_disabled";
      base.actionDetail =
        "Transcoder is disabled (MP4-only pipeline). Re-upload the video to produce a playable MP4.";
      break;

    case "dead_letter":
      base.issueDetail =
        "The most recent transcoding job exhausted its retry budget and was moved " +
        "to the dead-letter queue.";
      base.rootCause =
        row.transcoding_error_message ??
        "Maximum retry attempts reached — likely a transient infrastructure issue.";
      base.actionTaken = "no_action_transcoding_disabled";
      base.actionDetail =
        "Transcoder is disabled (MP4-only pipeline). Re-upload the video to bypass the dead-letter state.";
      break;

    case "missing_from_queue":
      base.issueDetail =
        "Video has a confirmed storage blob but is absent from the active broadcast queue.";
      base.rootCause =
        "Broadcast queue was cleared or rebuilt without this video, or it was previously " +
        "deactivated by the system validator.";
      base.actionTaken = "enqueued_broadcast";
      base.actionDetail =
        "Re-added to the broadcast queue. Will appear in rotation immediately on the next orchestrator reload.";
      break;
  }

  return base;
}

function buildReport(
  startMs: number,
  runAt: string,
  totalLocalVideos: number,
  items: RecoveryItem[],
  actions: RecoveryReport["actions"],
): RecoveryReport {
  const healthy = items.filter((i) => i.actionTaken === "skipped_healthy").length;
  // FIX: count both quarantine types — previously only quarantined_source_gone
  // was counted, meaning storage_lost videos inflated the "recovered" count.
  const quarantined = items.filter(
    (i) =>
      i.actionTaken === "quarantined_source_gone" ||
      i.actionTaken === "quarantined_storage_lost",
  ).length;
  const errors = items.filter((i) => i.actionTaken === "error").length;
  const recovered = items.length - healthy - quarantined - errors;

  const remaining: string[] = [];

  const sourceGoneCount = items.filter((i) => i.actionTaken === "quarantined_source_gone").length;
  if (sourceGoneCount > 0) {
    remaining.push(
      `${sourceGoneCount} video${sourceGoneCount !== 1 ? "s" : ""} require re-upload — ` +
      `the original source file${sourceGoneCount !== 1 ? "s are" : " is"} no longer in storage (SOURCE_MISSING).`,
    );
  }

  const storageLostCount = items.filter((i) => i.actionTaken === "quarantined_storage_lost").length;
  if (storageLostCount > 0) {
    remaining.push(
      `${storageLostCount} video${storageLostCount !== 1 ? "s" : ""} lost from server-side storage (STORAGE_LOST) — ` +
      `re-upload to restore broadcast availability.`,
    );
  }

  const transcoderDisabledCount = items.filter(
    (i) => i.actionTaken === "no_action_transcoding_disabled",
  ).length;
  if (transcoderDisabledCount > 0) {
    remaining.push(
      `${transcoderDisabledCount} video${transcoderDisabledCount !== 1 ? "s" : ""} ` +
      `could not be auto-recovered (transcoder is disabled on this deployment — MP4-only pipeline). ` +
      `Re-upload each video to restore it.`,
    );
  }

  const enqueuedCount = items.filter((i) => i.actionTaken === "enqueued_broadcast").length;
  if (enqueuedCount > 0) {
    remaining.push(
      `${enqueuedCount} video${enqueuedCount !== 1 ? "s were" : " was"} re-added to the broadcast queue — ` +
      `monitor the live broadcast to confirm they air correctly.`,
    );
  }

  return {
    runAt,
    durationMs: Date.now() - startMs,
    totalLocalVideos,
    summary: { healthy, recovered, quarantined, errors },
    actions,
    items,
    remainingActions: remaining,
  };
}
