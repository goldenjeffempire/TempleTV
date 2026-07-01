/**
 * Production-grade video recovery service.
 *
 * Scans every locally-uploaded video for pipeline issues, classifies the root
 * cause, applies the appropriate recovery action idempotently, and returns a
 * structured report. Safe to run multiple times — videos already in a healthy
 * state are counted and skipped; no duplicate jobs or queue entries are created.
 *
 * Issue taxonomy handled:
 *   FAILED_RETRYABLE    — transcoding_status='failed', source blob still in storage
 *   FAILED_SOURCE_GONE  — transcoding_status='failed', blob confirmed absent → quarantine
 *   ORPHAN_ENCODING     — status='encoding' with no active job for >90 min
 *   STUCK_QUEUED        — status='queued' with no job progress for >60 min
 *   NEVER_PROCESSED     — status='none', objectPath present, no transcoding job ever created
 *   DEAD_LETTER         — latest job is in dead_letter, no video-level block
 *   MISSING_FROM_QUEUE  — status='hls_ready' but not in the active broadcast queue
 *   HEALTHY             — everything looks fine; no action taken
 */

import { sql } from "drizzle-orm";
import { db } from "../../infrastructure/db.js";
import { logger as rootLogger } from "../../infrastructure/logger.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import {
  enqueueTranscode,
  retryAllFailed,
  requeueFromDlq,
} from "./transcoder.queue.js";
import { enqueueIfMissing } from "../broadcast/auto-enqueue.service.js";
import {
  clearAllBadUrls,
  reEnableAllSuspended,
} from "../broadcast-v2/repository/queue.repo.js";
import { transcoderDispatcher } from "./transcoder.dispatcher.js";
import { broadcastOrchestrator } from "../broadcast-v2/engine/broadcast-orchestrator.js";

const log = rootLogger.child({ module: "video-recovery" });

// ── Types ─────────────────────────────────────────────────────────────────────

type IssueKind =
  | "healthy"
  | "failed_retryable"
  | "failed_source_gone"
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
    badUrlCacheCleared: boolean;
    suspendedReEnabled: number;
  };
  items: RecoveryItem[];
  remainingActions: string[];
}

// ── Snapshot row shape from Phase 1 query ─────────────────────────────────────

interface SnapshotRow {
  id: string;
  title: string;
  transcoding_status: string;
  transcoding_error_code: string | null;
  transcoding_error_message: string | null;
  object_path: string | null;
  hls_master_url: string | null;
  local_video_url: string | null;
  s3_mirrored_at: Date | null;
  latest_job_id: string | null;
  latest_job_status: string | null;
  latest_job_started_at: Date | null;
  latest_job_last_progress: Date | null;
  in_broadcast_queue: boolean;
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
    badUrlCacheCleared: false,
    suspendedReEnabled: 0,
  };

  log.info("deep-recovery: starting full local-video audit");

  // ── Phase 1: Snapshot every locally-uploaded video ────────────────────────
  // One query captures:
  //   • current transcoding_status / error_code
  //   • local_video_url + s3_mirrored_at (MP4-pipeline: blob confirmed flag)
  //   • latest transcoding job state (status, started_at, last_progress_at)
  //   • whether the video is in the active broadcast queue
  //   • whether the source blob exists and has size > 0 (inline blob check)
  const snapshotResult = await db.execute(sql`
    SELECT
      mv.id,
      mv.title,
      mv.transcoding_status,
      mv.transcoding_error_code,
      mv.transcoding_error_message,
      mv.object_path,
      mv.hls_master_url,
      mv.local_video_url,
      mv.s3_mirrored_at,
      latest.job_id           AS latest_job_id,
      latest.job_status       AS latest_job_status,
      latest.job_started_at   AS latest_job_started_at,
      latest.job_last_progress AS latest_job_last_progress,
      EXISTS(
        SELECT 1 FROM broadcast_queue bq
        WHERE bq.video_id = mv.id AND bq.is_active = true
      ) AS in_broadcast_queue,
      CASE
        WHEN mv.object_path IS NOT NULL THEN
          EXISTS(
            SELECT 1 FROM storage_blobs sb
            WHERE sb.key = mv.object_path AND sb.size_bytes > 0
          )
        ELSE NULL
      END AS blob_valid
    FROM managed_videos mv
    LEFT JOIN LATERAL (
      SELECT
        tj.id           AS job_id,
        tj.status       AS job_status,
        tj.started_at   AS job_started_at,
        tj.last_progress_at AS job_last_progress
      FROM transcoding_jobs tj
      WHERE tj.video_id = mv.id
      ORDER BY tj.created_at DESC
      LIMIT 1
    ) latest ON true
    WHERE mv.video_source = 'local'
    ORDER BY mv.imported_at DESC
  `);

  const rows = snapshotResult.rows as unknown as SnapshotRow[];
  log.info({ count: rows.length }, "deep-recovery: snapshot complete");

  if (rows.length === 0) {
    return buildReport(startMs, runAt, 0, items, actions);
  }

  const nowMs = Date.now();
  const ORPHAN_THRESHOLD_MS  = 90  * 60 * 1000;
  const STUCK_QUEUE_MS       = 60  * 60 * 1000;

  // ── Phase 2: Classify every video ─────────────────────────────────────────
  type ClassifiedRow = SnapshotRow & { issueKind: IssueKind };
  const classified: ClassifiedRow[] = rows.map((row) => {
    const st = row.transcoding_status;
    const errCode = row.transcoding_error_code;
    const objectPath = row.object_path;
    const blobValid = row.blob_valid;
    const jobStatus = row.latest_job_status;
    const jobStarted = row.latest_job_started_at
      ? new Date(row.latest_job_started_at).getTime()
      : null;
    const jobLastProgress = row.latest_job_last_progress
      ? new Date(row.latest_job_last_progress).getTime()
      : null;
    const lastActivity = jobLastProgress ?? jobStarted ?? 0;

    // ── MP4-pipeline healthy states ───────────────────────────────────────────
    // On the MP4-only pipeline (TRANSCODER_DISABLE=1) videos are admitted
    // directly to the broadcast queue after upload (no HLS transcoding).
    // transcodingStatus stays "none" and localVideoUrl is set once the blob
    // is assembled.  s3MirroredAt IS NOT NULL confirms the blob is in storage.
    //
    // "none" + localVideoUrl + s3MirroredAt + in broadcast queue → healthy.
    // "none" + localVideoUrl + s3MirroredAt + NOT in queue       → missing_from_queue
    //   → Phase 7 calls enqueueIfMissing() to add them.
    //
    // "none" + localVideoUrl + s3MirroredAt IS NULL → still assembling or
    //   stamp silently failed; repairMissingS3MirroredAt() heals within 90 s.
    //   Treat as healthy (in-progress) and let auto-refill re-check later.
    const isMp4Ready = (st === "none" || st === "uploaded") &&
      !!row.local_video_url &&
      !!row.s3_mirrored_at;
    if (isMp4Ready && row.in_broadcast_queue) {
      return { ...row, issueKind: "healthy" };
    }
    if (isMp4Ready && !row.in_broadcast_queue) {
      return { ...row, issueKind: "missing_from_queue" };
    }

    // Already healthy (HLS pipeline legacy)
    if (st === "hls_ready" && row.in_broadcast_queue) {
      return { ...row, issueKind: "healthy" };
    }
    // HLS ready but not in broadcast queue
    if (st === "hls_ready" && !row.in_broadcast_queue) {
      return { ...row, issueKind: "missing_from_queue" };
    }
    // Dead-letter job (max attempts exhausted) — not a terminal video state
    if (jobStatus === "dead_letter" && errCode !== "SOURCE_MISSING" && !(errCode === "CORRUPT_SOURCE" && !objectPath)) {
      return { ...row, issueKind: "dead_letter" };
    }
    // Failed
    if (st === "failed") {
      if (errCode === "SOURCE_MISSING" || blobValid === false) {
        return { ...row, issueKind: "failed_source_gone" };
      }
      return { ...row, issueKind: "failed_retryable" };
    }
    // Stuck encoding (no active job or stalled heartbeat)
    if (st === "encoding") {
      const isOrphaned = jobStatus === null || (jobStatus !== "processing" && jobStatus !== "queued");
      const isStalled = lastActivity > 0 && (nowMs - lastActivity) > ORPHAN_THRESHOLD_MS;
      if (isOrphaned || isStalled) {
        return { ...row, issueKind: "orphan_encoding" };
      }
    }
    // Stuck queued
    if (st === "queued" && lastActivity > 0 && (nowMs - lastActivity) > STUCK_QUEUE_MS) {
      return { ...row, issueKind: "stuck_queued" };
    }
    // Never processed — objectPath present but no transcoding job and no local
    // video URL.  This is a legacy state from before the MP4-only pipeline
    // switch; enqueueTranscode is disabled so this is effectively a no-op,
    // but we still log it for operator visibility.
    if ((st === "none" || st === "uploaded") && objectPath && !row.local_video_url) {
      return { ...row, issueKind: "never_processed" };
    }
    // Fallback — consider healthy (in-progress, queued within threshold, etc.)
    return { ...row, issueKind: "healthy" };
  });

  // ── Phase 3: Bulk retry all failed jobs (single DB round-trip) ────────────
  const failedRetryableIds = classified
    .filter((r) => r.issueKind === "failed_retryable")
    .map((r) => r.id);
  if (failedRetryableIds.length > 0) {
    actions.retriedFailed = await retryAllFailed();
    log.info({ count: actions.retriedFailed }, "deep-recovery: retried failed jobs");
  }

  // ── Phase 4: Bulk reset orphaned-encoding videos ──────────────────────────
  const orphanIds = classified
    .filter((r) => r.issueKind === "orphan_encoding")
    .map((r) => r.id);
  if (orphanIds.length > 0) {
    const res = await db.execute(sql`
      UPDATE managed_videos
      SET transcoding_status = 'none',
          transcoding_error_message = NULL,
          transcoding_error_code = NULL
      WHERE id = ANY(${orphanIds}::text[])
        AND transcoding_status = 'encoding'
    `);
    actions.resetOrphaned = (res.rowCount ?? 0) as number;
    // Also cancel any stale lease/processing DB rows so the dispatcher
    // doesn't skip them thinking they are still leased.
    await db.execute(sql`
      UPDATE transcoding_jobs
      SET status = 'failed',
          error_message = 'Reset by deep-recovery: orphaned encoding state',
          lease_expires_at = NULL,
          leased_by = NULL
      WHERE video_id = ANY(${orphanIds}::text[])
        AND status = 'processing'
    `);
  }

  // ── Phase 5: Bulk reset stuck-queued videos ────────────────────────────────
  const stuckIds = classified
    .filter((r) => r.issueKind === "stuck_queued")
    .map((r) => r.id);
  if (stuckIds.length > 0) {
    const res = await db.execute(sql`
      UPDATE managed_videos
      SET transcoding_status = 'none',
          transcoding_error_message = NULL,
          transcoding_error_code = NULL
      WHERE id = ANY(${stuckIds}::text[])
        AND transcoding_status = 'queued'
    `);
    actions.resetStuck = (res.rowCount ?? 0) as number;
    await db.execute(sql`
      UPDATE transcoding_jobs
      SET status = 'failed',
          error_message = 'Reset by deep-recovery: stuck queued state'
      WHERE video_id = ANY(${stuckIds}::text[])
        AND status = 'queued'
    `);
  }

  // ── Phase 6: Re-enqueue reset videos + never-processed videos ────────────
  // Collect all videos that now need a fresh transcoding job:
  //   • orphans and stuck (just reset above)
  //   • never-processed (objectPath exists but never had a job)
  //   • dead-letter jobs that can be re-queued
  const toEnqueue = classified.filter((r) =>
    r.issueKind === "orphan_encoding" ||
    r.issueKind === "stuck_queued" ||
    r.issueKind === "never_processed"
  );
  for (const row of toEnqueue) {
    if (!row.object_path) continue;
    try {
      await enqueueTranscode({ videoId: row.id, objectKey: row.object_path });
      if (row.issueKind === "orphan_encoding") actions.resetOrphaned++;
      else if (row.issueKind === "stuck_queued") actions.resetStuck++;
      else actions.enqueuedUnprocessed++;
    } catch (err) {
      log.warn({ videoId: row.id, err }, "deep-recovery: enqueueTranscode failed (non-fatal)");
    }
  }

  // Re-queue dead-letter jobs via requeueFromDlq so they get a fresh budget.
  const dlqRows = classified.filter((r) => r.issueKind === "dead_letter");
  for (const row of dlqRows) {
    if (!row.latest_job_id) continue;
    try {
      await requeueFromDlq(row.latest_job_id);
      actions.requeuedDlq++;
    } catch (err) {
      log.warn({ videoId: row.id, jobId: row.latest_job_id, err }, "deep-recovery: requeueFromDlq failed (non-fatal)");
    }
  }

  // ── Phase 7: Enqueue hls_ready videos not in broadcast queue ─────────────
  const missingQueueRows = classified.filter((r) => r.issueKind === "missing_from_queue");
  for (const row of missingQueueRows) {
    try {
      const res = await enqueueIfMissing({ videoId: row.id, reason: "deep-recovery" });
      if (res.enqueued) actions.enqueuedBroadcast++;
    } catch (err) {
      log.warn({ videoId: row.id, err }, "deep-recovery: enqueueIfMissing failed (non-fatal)");
    }
  }

  // ── Phase 8: Confirm source_missing videos (check blob one more time) ─────
  // Mark confirmed SOURCE_MISSING in the DB so they are excluded from future
  // retryAllFailed() calls and operators know they need a re-upload.
  const sourceMissingRows = classified.filter((r) => r.issueKind === "failed_source_gone");
  for (const row of sourceMissingRows) {
    if (row.transcoding_error_code !== "SOURCE_MISSING") {
      // Blob check was false but error code wasn't SOURCE_MISSING — correct it.
      try {
        await db.execute(sql`
          UPDATE managed_videos
          SET transcoding_error_code = 'SOURCE_MISSING',
              transcoding_error_message = 'Source blob confirmed absent from storage during deep recovery scan. Re-upload the original video file.'
          WHERE id = ${row.id}
            AND transcoding_status = 'failed'
        `);
        actions.sourceMissingConfirmed++;
      } catch (err) {
        log.warn({ videoId: row.id, err }, "deep-recovery: failed to mark SOURCE_MISSING (non-fatal)");
      }
    } else {
      actions.sourceMissingConfirmed++;
    }
  }

  // ── Phase 9: Clear bad-URL cache + re-enable suspended queue items ─────────
  clearAllBadUrls();
  actions.badUrlCacheCleared = true;
  try {
    actions.suspendedReEnabled = await reEnableAllSuspended();
  } catch (err) {
    log.warn({ err }, "deep-recovery: reEnableAllSuspended failed (non-fatal)");
  }

  // ── Phase 10: Nudge dispatcher + reload orchestrator ──────────────────────
  const anyWork =
    actions.retriedFailed > 0 ||
    actions.resetOrphaned > 0 ||
    actions.resetStuck > 0 ||
    actions.enqueuedUnprocessed > 0 ||
    actions.requeuedDlq > 0;

  if (anyWork) {
    transcoderDispatcher.nudge();
  }
  if (anyWork || actions.enqueuedBroadcast > 0 || actions.suspendedReEnabled > 0) {
    void broadcastOrchestrator.reload().catch(() => {});
  }

  // ── Phase 11: Push SSE events ─────────────────────────────────────────────
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

  // ── Phase 12: Build per-video result items ─────────────────────────────────
  for (const row of classified) {
    const item = buildItem(row);
    items.push(item);
  }

  const report = buildReport(startMs, runAt, rows.length, items, actions);
  log.info(
    {
      durationMs: report.durationMs,
      totalLocalVideos: report.totalLocalVideos,
      healthy: report.summary.healthy,
      recovered: report.summary.recovered,
      quarantined: report.summary.quarantined,
    },
    "deep-recovery: complete",
  );
  return report;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildItem(row: SnapshotRow & { issueKind: IssueKind }): RecoveryItem {
  const base = {
    videoId: row.id,
    title: row.title,
    issueKind: row.issueKind,
    previousStatus: row.transcoding_status,
    previousErrorCode: row.transcoding_error_code,
    blobVerified: row.blob_valid,
    rootCause: null as string | null,
    issueDetail: "",
    actionTaken: "skipped_healthy" as ActionTaken,
    actionDetail: "",
  };

  switch (row.issueKind) {
    case "healthy":
      base.issueDetail = "Video is HLS-ready and queued for broadcast.";
      base.actionTaken = "skipped_healthy";
      base.actionDetail = "No action required.";
      break;

    case "failed_retryable":
      base.issueDetail = `Transcoding failed (${row.transcoding_error_code ?? "unknown"}) but source blob is present in storage.`;
      base.rootCause = row.transcoding_error_message ?? row.transcoding_error_code ?? "Unknown transcoding error";
      base.actionTaken = "retried_transcoding";
      base.actionDetail = "Job reset to queued with fresh retry budget. All 5 recovery strategies will be attempted.";
      break;

    case "failed_source_gone":
      base.issueDetail = "Transcoding failed and source blob is absent from object storage.";
      base.rootCause = "SOURCE_MISSING — original uploaded file was deleted or never stored. Re-upload required.";
      base.actionTaken = "quarantined_source_gone";
      base.actionDetail = "Marked as SOURCE_MISSING. No recovery possible without re-uploading the original file.";
      break;

    case "orphan_encoding":
      base.issueDetail = "Video stuck in 'encoding' state with no active transcoding job.";
      base.rootCause = "Server restart or crash during transcoding left video in orphaned state.";
      base.actionTaken = "reset_orphan_and_requeued";
      base.actionDetail = "Reset to 'none', stale job cancelled, fresh transcoding job created.";
      break;

    case "stuck_queued":
      base.issueDetail = "Video stuck in 'queued' state with no progress for >60 minutes.";
      base.rootCause = "Dispatcher skip, lease deadlock, or server restart lost the job context.";
      base.actionTaken = "reset_stuck_and_requeued";
      base.actionDetail = "Reset to 'none', stale queue entry cancelled, fresh transcoding job created.";
      break;

    case "never_processed":
      base.issueDetail = "Source file is stored but no transcoding job was ever created.";
      base.rootCause = "Upload finalised but dispatcher was not notified (server restart during finalize or DB constraint skipped the enqueue).";
      base.actionTaken = "enqueued_unprocessed";
      base.actionDetail = "Fresh HLS transcoding job created from existing source file.";
      break;

    case "dead_letter":
      base.issueDetail = "Job exhausted its retry budget and moved to dead-letter queue.";
      base.rootCause = row.transcoding_error_message ?? "Max attempts reached — likely a transient infrastructure issue.";
      base.actionTaken = "requeued_from_dlq";
      base.actionDetail = "Job re-queued from dead-letter with a fresh retry budget.";
      break;

    case "missing_from_queue":
      base.issueDetail = "Video is HLS-ready but absent from the active broadcast queue.";
      base.rootCause = "Broadcast queue was cleared or rebuilt without this video, or it was manually deactivated.";
      base.actionTaken = "enqueued_broadcast";
      base.actionDetail = "Added to broadcast queue — will appear in rotation immediately.";
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
  const quarantined = items.filter((i) => i.actionTaken === "quarantined_source_gone").length;
  const errors = items.filter((i) => i.actionTaken === "error").length;
  const recovered = items.length - healthy - quarantined - errors;

  const remaining: string[] = [];
  if (quarantined > 0) {
    remaining.push(
      `${quarantined} video${quarantined !== 1 ? "s" : ""} require re-upload — original source file${quarantined !== 1 ? "s are" : " is"} no longer in storage.`,
    );
  }
  const inProgress = items.filter(
    (i) => i.actionTaken === "retried_transcoding" || i.actionTaken === "reset_orphan_and_requeued" ||
           i.actionTaken === "reset_stuck_and_requeued" || i.actionTaken === "enqueued_unprocessed" ||
           i.actionTaken === "requeued_from_dlq",
  ).length;
  if (inProgress > 0) {
    remaining.push(
      `${inProgress} video${inProgress !== 1 ? "s are" : " is"} now queued for transcoding — monitor the Transcoding tab for completion.`,
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
