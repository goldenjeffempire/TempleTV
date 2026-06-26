/**
 * Transcoding Auto-Retry Worker
 *
 * Periodically scans managed_videos for permanently-failed transcoding jobs
 * that are recoverable (source blob exists, error is not terminal) and
 * re-enqueues them automatically after a 24-hour cooldown.
 *
 * Criteria for auto-retry eligibility:
 *   - transcodingStatus = 'failed'
 *   - objectPath IS NOT NULL (source blob exists in storage)
 *   - transcodingErrorCode NOT IN ('CORRUPT_SOURCE','SOURCE_MISSING','ASSEMBLY_FAILED')
 *     — these indicate a bad source file; retrying is pointless.
 *   - autoRetryCount < MAX_AUTO_RETRIES (default 3)
 *   - Last transcoding attempt was > AUTO_RETRY_COOLDOWN_MS ago
 *     (falls back to updated_at / imported_at when no separate retry timestamp)
 *
 * On retry:
 *   - Calls enqueueTranscode() which atomically resets the job and sets
 *     transcodingStatus = 'queued'.
 *   - Increments auto_retry_count on managed_videos.
 *   - Emits broadcast-queue-updated so the orchestrator reloads.
 *
 * The worker is registered with the WorkerSupervisor so it has:
 *   - Circuit-breaker protection (opens after 5 consecutive failures)
 *   - Structured error logging
 *   - Automatic retry with exponential back-off
 *
 * Disabled via TRANSCODING_AUTO_RETRY_DISABLE=1.
 */
import { db, schema } from "../../../infrastructure/db.js";
import { sql } from "drizzle-orm";
import { logger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { enqueueTranscode } from "../../transcoder/transcoder.queue.js";

const MAX_AUTO_RETRIES = Number(process.env["TRANSCODING_AUTO_RETRY_MAX"] ?? 3);
const COOLDOWN_MS = Number(process.env["TRANSCODING_AUTO_RETRY_COOLDOWN_MS"] ?? 24 * 60 * 60 * 1000);
const BATCH = Math.max(1, Math.min(20, Number(process.env["TRANSCODING_AUTO_RETRY_BATCH"] ?? 5)));

/** Terminal error codes — retrying these wastes CPU and is always a no-op. */
const TERMINAL_ERROR_CODES = ["CORRUPT_SOURCE", "SOURCE_MISSING", "ASSEMBLY_FAILED", "CORRUPT_UPLOAD"];

export interface TranscodingAutoRetryStatus {
  enabled: boolean;
  lastRunAtMs: number | null;
  lastRetryCount: number;
  totalRetried: number;
  lastError: string | null;
}

const _status: TranscodingAutoRetryStatus = {
  enabled: !process.env["TRANSCODING_AUTO_RETRY_DISABLE"],
  lastRunAtMs: null,
  lastRetryCount: 0,
  totalRetried: 0,
  lastError: null,
};

export function getTranscodingAutoRetryStatus(): TranscodingAutoRetryStatus {
  return { ..._status };
}

export async function transcodingAutoRetryScan(): Promise<void> {
  if (process.env["TRANSCODING_AUTO_RETRY_DISABLE"]) return;

  _status.lastRunAtMs = Date.now();

  // Build terminal-code exclusion list for SQL
  const terminalList = TERMINAL_ERROR_CODES.map((c) => `'${c}'`).join(", ");
  const cooldownSecs = Math.floor(COOLDOWN_MS / 1000);

  const rows = await db.execute<{
    id: string;
    title: string;
    object_path: string;
    auto_retry_count: string | null;
    transcoding_error_code: string | null;
  }>(sql`
    SELECT
      id,
      title,
      object_path,
      auto_retry_count,
      transcoding_error_code
    FROM managed_videos
    WHERE
      transcoding_status = 'failed'
      AND object_path IS NOT NULL
      AND (transcoding_error_code IS NULL OR transcoding_error_code NOT IN (${sql.raw(terminalList)}))
      AND COALESCE(auto_retry_count, 0) < ${MAX_AUTO_RETRIES}
      AND GREATEST(updated_at, imported_at) < NOW() - INTERVAL '${sql.raw(String(cooldownSecs))} seconds'
    ORDER BY COALESCE(auto_retry_count, 0) ASC, imported_at DESC
    LIMIT ${BATCH}
  `);

  const candidates: { id: string; title: string; object_path: string; auto_retry_count: string | null; transcoding_error_code: string | null }[] =
    Array.isArray(rows.rows) ? rows.rows : (rows as unknown as typeof rows.rows);

  if (!candidates.length) {
    _status.lastRetryCount = 0;
    return;
  }

  logger.info(
    { count: candidates.length, maxRetries: MAX_AUTO_RETRIES },
    "[transcoding-auto-retry] found eligible failed jobs — re-enqueuing",
  );

  let retried = 0;
  for (const row of candidates) {
    try {
      await enqueueTranscode({ videoId: row.id, videoPath: row.object_path });

      // Increment auto_retry_count on the video row
      await db.execute(sql`
        UPDATE managed_videos
        SET auto_retry_count = COALESCE(auto_retry_count, 0) + 1, updated_at = NOW()
        WHERE id = ${row.id}
      `);

      logger.info(
        {
          videoId: row.id,
          title: row.title,
          retryCount: (parseInt(row.auto_retry_count ?? "0", 10) + 1),
          prevErrorCode: row.transcoding_error_code ?? null,
        },
        "[transcoding-auto-retry] re-enqueued failed transcoding job",
      );
      retried++;
    } catch (err) {
      logger.warn(
        { err, videoId: row.id, title: row.title },
        "[transcoding-auto-retry] failed to re-enqueue job (non-fatal)",
      );
    }
  }

  if (retried > 0) {
    _status.lastRetryCount = retried;
    _status.totalRetried += retried;
    _status.lastError = null;
    adminEventBus.push("broadcast-queue-updated");
    adminEventBus.push("ops-alert", {
      level: "info",
      code: "transcoding-auto-retry",
      message: `Auto-retry re-enqueued ${retried} failed transcoding job(s) for another attempt.`,
      context: { retried, maxRetries: MAX_AUTO_RETRIES, cooldownHours: Math.round(COOLDOWN_MS / 3_600_000) },
    });
  } else {
    _status.lastRetryCount = 0;
  }
}
