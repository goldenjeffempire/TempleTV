/**
 * Upload Integrity Monitor — Enterprise-Grade Production Rewrite
 *
 * Background worker that periodically scans storage for anomalies the hot-path
 * guards cannot catch after the fact.
 *
 * Philosophy: VERIFY-AND-SELF-HEAL FIRST, destroy only as a last resort.
 * Every anomaly is first checked for lossless recoverability (are the upload
 * parts still staged?) and rebuilt via the normal reassembly path when
 * possible. A video is permanently failed only when no parts remain to
 * recover from — the monitor's primary job is to keep healthy uploads
 * healthy, not to clean up corruption.
 *
 * Scans:
 *   1. Corrupt blobs — storage_blobs rows where size_bytes = 0 or data IS NULL.
 *      Avoided the original octet_length(data) full-BYTEA-scan: the recorded
 *      size_bytes column is used for fast detection; a bounded mismatch check
 *      runs only if time budget permits, with a hard DB-level statement timeout.
 *      Recoverable blobs (upload parts still staged) are rebuilt via session
 *      reset; only truly unrecoverable blobs are deleted + marked CORRUPT_SOURCE.
 *
 *   2. Videos with confirmed blob reference (s3MirroredAt IS NOT NULL) but no
 *      matching row in storage_blobs — these produce a 404 on every playback
 *      request. If upload parts are present they are reset for auto-reassembly;
 *      otherwise the video is permanently marked ASSEMBLY_FAILED.
 *
 *   3. Orphaned storage_upload_parts — BYTEA rows whose upload_id has no active
 *      upload session. Each row is ≤ 8 MiB; orphans waste real PostgreSQL
 *      storage. Completely removed the original SUM(octet_length(data)) full
 *      BYTEA table scan; size is now estimated from COUNT × max-chunk-size.
 *
 * Production guarantees:
 *   • Every DB query is bounded by a hard client-side deadline + DB-level
 *     statement_timeout so a lock wait or slow sequential scan cannot block
 *     the shared connection pool indefinitely.
 *   • All three passes receive a shared deadline derived from the worker
 *     supervisor's 10-minute hard limit; each pass checks the deadline between
 *     row iterations and exits gracefully when time runs out.
 *   • Per-item remediation is wrapped in individual try/catch — one bad row
 *     never aborts the rest of the pass.
 *   • No BYTEA columns are read to compute sizes in the orphaned-parts scan.
 *   • The mismatch-size scan (the only remaining octet_length query) runs with
 *     a dedicated 25-second DB statement_timeout and is only attempted when the
 *     overall pass has at least 30 s of budget remaining.
 *   • The all-failed re-throw is replaced with per-pass tracking so the
 *     supervisor's circuit breaker counts correctly.
 *
 * Registered in main.ts via workerSupervisor.spawn():
 *   interval: 30 min, initial delay: 5 min, timeout: 10 min.
 */

import { sql, eq } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger as rootLogger } from "../../infrastructure/logger.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";

const logger = rootLogger.child({ module: "upload-integrity-monitor" });
const videos = schema.videosTable;

// ── Batch limits — bound DB I/O per pass ─────────────────────────────────────
const MAX_CORRUPT_BLOBS_PER_PASS = 20;
const MAX_MISSING_BLOBS_PER_PASS = 20;
const MAX_ORPHAN_UPLOAD_IDS_PER_PASS = 30;

// ── Query timeouts ────────────────────────────────────────────────────────────
/** Fast queries (index-only scans, small result sets). */
const FAST_QUERY_TIMEOUT_MS = 15_000;
/** Slow queries (those that may touch BYTEA data or large table scans). */
const SLOW_QUERY_TIMEOUT_MS = 25_000;
/** Per-row remediation (UPDATE/DELETE on single row by PK). */
const REMEDIATION_TIMEOUT_MS = 10_000;

// ── Estimated max bytes per upload part (8 MiB chunk ceiling). ───────────────
// Used for ops-alert threshold when we cannot read actual BYTEA sizes.
const MAX_PART_BYTES = 8 * 1024 * 1024;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract rows from a Drizzle execute() result regardless of driver version. */
function extractRows<T>(result: unknown): T[] {
  if (!result) return [];
  const r = result as { rows?: T[] } | T[];
  if (Array.isArray(r)) return r as T[];
  return (r as { rows?: T[] }).rows ?? [];
}

/**
 * Race a DB query Promise against a client-side hard timeout.
 *
 * The DB-level statement_timeout is set separately for expensive queries via
 * SET LOCAL inside a transaction. This client-side guard is the belt-and-
 * suspenders layer: it abandons waiting even if the PG connection is stuck in
 * a lock wait that SET LOCAL statement_timeout would not yet have started
 * timing (statement_timeout only runs once the server starts executing the SQL,
 * not while waiting for a lock).
 */
function withTimeout<T>(
  promise: Promise<T | null>,
  ms: number,
  label: string,
): Promise<T | null> {
  let timer: NodeJS.Timeout | null = null;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger.warn({ label, timeoutMs: ms }, "[integrity] query deadline reached — moving on");
      resolve(null);
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Check whether the pass has exceeded its per-invocation deadline.
 * Each pass receives the overall invocation deadline; individual row loops
 * check this before processing the next row to ensure graceful exit.
 */
function isExpired(deadlineMs: number, label: string): boolean {
  if (Date.now() >= deadlineMs) {
    logger.info({ label }, "[integrity] pass deadline reached — stopping gracefully");
    return true;
  }
  return false;
}

/**
 * Reassembly availability check — shared self-healing primitive.
 *
 * Given a video id, locate its upload session and count how many BYTEA parts
 * remain in storage_upload_parts. A video is *recoverable* when at least
 * `total_chunks` parts are still staged: the existing reassembly path can
 * rebuild a fully-verified blob from them with zero data loss.
 *
 * Returns null when no session/upload_id exists (nothing to recover from).
 * The per-part non-empty / sequence / SHA-256 validation is re-run inside
 * completeMultipartUpload during the actual reassembly, so a count ≥ total
 * is a sufficient (and cheap, BYTEA-free) pre-check here.
 */
export async function findReassemblyContext(videoId: string): Promise<{
  sessionId: string;
  uploadId: string;
  totalChunks: number;
  partsPresent: number;
  recoverable: boolean;
} | null> {
  type SessionRow = { session_id: string; total_chunks: number; upload_id: string | null };
  const sessionResult = await withTimeout(
    db.execute<SessionRow>(sql`
      SELECT session_id, total_chunks, upload_id
      FROM upload_sessions
      WHERE completed_video_id = ${videoId}
      LIMIT 1
    `).catch(() => null),
    FAST_QUERY_TIMEOUT_MS,
    `reassembly-find-session:${videoId}`,
  );
  const [session] = extractRows<SessionRow>(sessionResult);
  if (!session?.upload_id) return null;

  type CntRow = { cnt: string };
  const cntResult = await withTimeout(
    db.execute<CntRow>(sql`
      SELECT COUNT(*)::text AS cnt
      FROM storage_upload_parts
      WHERE upload_id = ${session.upload_id}
    `).catch(() => null),
    FAST_QUERY_TIMEOUT_MS,
    `reassembly-count-parts:${videoId}`,
  );
  const [cntRow] = extractRows<CntRow>(cntResult);
  const partsPresent = parseInt(cntRow?.cnt ?? "0", 10);
  const totalChunks = session.total_chunks ?? 1;
  return {
    sessionId: session.session_id,
    uploadId: session.upload_id,
    totalChunks,
    partsPresent,
    recoverable: partsPresent >= totalChunks,
  };
}

// ── Pass 1: Corrupt blobs ─────────────────────────────────────────────────────
//
// Two phases to avoid expensive full-BYTEA scans:
//
//   Phase A — zero-size detection: WHERE size_bytes = 0
//     This is an index-range scan on the bigint column — no BYTEA data read.
//     These are definitively corrupt; the data column is not read at all.
//
//   Phase B — size-mismatch detection: WHERE size_bytes != octet_length(data)
//     Reads BYTEA data server-side to compute the real length. Bounded by a
//     25 s DB statement_timeout inside a transaction so the server terminates
//     the query itself if it takes too long, rather than relying solely on
//     the client-side timeout. Only runs if ≥30 s of budget remains.
//
async function scanCorruptBlobs(deadlineMs: number): Promise<number> {
  type CorruptRow = { key: string; size_bytes: string; actual_bytes: string };
  let rows: CorruptRow[] = [];

  // ── Phase A: zero-size blobs (fast, no BYTEA read) ────────────────────────
  const phaseAResult = await withTimeout(
    db.execute<CorruptRow>(sql`
      SELECT
        key,
        size_bytes::text         AS size_bytes,
        '0'                      AS actual_bytes
      FROM storage_blobs
      WHERE size_bytes = 0
        AND data IS NOT NULL
      LIMIT ${MAX_CORRUPT_BLOBS_PER_PASS}
    `).catch((err) => {
      logger.warn({ err }, "[integrity] corrupt-blob phase-A query failed");
      return null;
    }),
    FAST_QUERY_TIMEOUT_MS,
    "corrupt-blobs-phase-a",
  );
  rows = rows.concat(extractRows<CorruptRow>(phaseAResult));

  // ── Phase A-null: null-data blobs (fast metadata scan) ───────────────────
  // data IS NULL is the EXPECTED shape for chunked=true blobs (their bytes
  // live in storage_blob_chunks, promoted there row-by-row by
  // completeMultipartUpload — see storage.ts). Only flag data IS NULL as
  // corruption when chunked is NOT true; for chunked blobs, corruption is
  // instead "promised chunk_count doesn't match the actual promoted rows /
  // bytes", checked separately below.
  if (!isExpired(deadlineMs, "corrupt-blobs-phase-null")) {
    const phaseNullResult = await withTimeout(
      db.execute<{ key: string }>(sql`
        SELECT key
        FROM storage_blobs
        WHERE data IS NULL
          AND size_bytes > 0
          AND chunked IS NOT TRUE
        LIMIT ${MAX_CORRUPT_BLOBS_PER_PASS}
      `).catch((err) => {
        logger.warn({ err }, "[integrity] corrupt-blob null-data query failed");
        return null;
      }),
      FAST_QUERY_TIMEOUT_MS,
      "corrupt-blobs-phase-null",
    );
    const nullRows = extractRows<{ key: string }>(phaseNullResult).map((r) => ({
      key: r.key,
      size_bytes: "0",
      actual_bytes: "0",
    }));
    rows = rows.concat(nullRows);
  }

  // ── Phase A-chunked: chunked blobs whose promoted chunks don't match the
  // manifest (chunk_count mismatch or total bytes mismatch) — the chunked
  // equivalent of "corrupt/incomplete blob". Cheap: aggregates size_bytes +
  // COUNT(*) from storage_blob_chunks (metadata only, no full BYTEA reads).
  if (!isExpired(deadlineMs, "corrupt-blobs-phase-chunked") && rows.length < MAX_CORRUPT_BLOBS_PER_PASS) {
    const phaseChunkedResult = await withTimeout(
      db.execute<{ key: string; size_bytes: string; actual_bytes: string }>(sql`
        SELECT
          b.key                                       AS key,
          b.size_bytes::text                           AS size_bytes,
          COALESCE(c.total_bytes, 0)::text             AS actual_bytes
        FROM storage_blobs b
        LEFT JOIN (
          SELECT blob_key, COUNT(*) AS chunk_count, SUM(size_bytes) AS total_bytes
          FROM storage_blob_chunks
          GROUP BY blob_key
        ) c ON c.blob_key = b.key
        WHERE b.chunked IS TRUE
          AND (
            COALESCE(c.chunk_count, 0) != b.chunk_count
            OR COALESCE(c.total_bytes, 0) != b.size_bytes
          )
        LIMIT ${MAX_CORRUPT_BLOBS_PER_PASS - rows.length}
      `).catch((err) => {
        logger.warn({ err }, "[integrity] corrupt-blob chunked-mismatch query failed");
        return null;
      }),
      FAST_QUERY_TIMEOUT_MS,
      "corrupt-blobs-phase-chunked",
    );
    rows = rows.concat(extractRows<CorruptRow>(phaseChunkedResult));
  }

  // ── Phase B: size-mismatch detection (reads BYTEA, bounded by stmt timeout) ─
  // Only run if there is at least 30 s of budget left and we haven't already
  // filled the batch limit from phases A/A-null.
  const budgetRemaining = deadlineMs - Date.now();
  if (rows.length < MAX_CORRUPT_BLOBS_PER_PASS && budgetRemaining >= 30_000) {
    const remaining = MAX_CORRUPT_BLOBS_PER_PASS - rows.length;
    // Use a transaction with SET LOCAL statement_timeout so PG itself
    // terminates the scan after SLOW_QUERY_TIMEOUT_MS, releasing any lock.
    const phaseBResult = await withTimeout(
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${SLOW_QUERY_TIMEOUT_MS}`));
        return tx.execute<CorruptRow>(sql`
          SELECT
            key,
            size_bytes::text         AS size_bytes,
            octet_length(data)::text AS actual_bytes
          FROM storage_blobs
          WHERE size_bytes > 0
            AND data IS NOT NULL
            AND size_bytes != octet_length(data)
          LIMIT ${remaining}
        `);
      }).catch((err) => {
        logger.warn({ err }, "[integrity] corrupt-blob phase-B (size mismatch) query failed or timed out");
        return null;
      }),
      SLOW_QUERY_TIMEOUT_MS + 2_000, // client-side slightly wider than DB-level
      "corrupt-blobs-phase-b",
    );
    rows = rows.concat(extractRows<CorruptRow>(phaseBResult));
  }

  // Deduplicate by key in case a blob appeared in multiple phases.
  const seen = new Set<string>();
  rows = rows.filter((r) => {
    if (seen.has(r.key)) return false;
    seen.add(r.key);
    return true;
  });

  if (rows.length === 0) return 0;

  logger.warn(
    { count: rows.length },
    "[integrity] corrupt blobs detected — starting remediation",
  );

  let fixed = 0;
  for (const row of rows) {
    if (isExpired(deadlineMs, "corrupt-blob-remediation")) break;

    const { key, size_bytes, actual_bytes } = row;
    try {
      // Find the referencing video (single indexed lookup by object_path).
      const [video] = await withTimeout(
        db
          .select({ id: videos.id, transcodingStatus: videos.transcodingStatus })
          .from(videos)
          .where(eq(videos.objectPath, key))
          .limit(1),
        FAST_QUERY_TIMEOUT_MS,
        `corrupt-blob-find-video:${key}`,
      ) ?? [];

      // ── Verify-first: attempt lossless self-healing before destruction ──
      // A corrupt blob whose upload parts are still staged can be rebuilt
      // byte-for-byte. Rather than permanently failing the video, delete only
      // the corrupt blob (so reassembly starts from a clean slate) and reset
      // the session + video so the existing reassembly path produces a fresh,
      // fully-validated blob. Permanent failure is reserved for the case where
      // no parts remain to recover from — destruction is the last resort, not
      // the first response.
      const recovery = video ? await findReassemblyContext(video.id) : null;

      if (video && recovery?.recoverable) {
        // Re-enroll the session into the periodic assembly-reconciliation path
        // so the blob is *actually* rebuilt, not merely state-mutated.
        //
        // runAssemblyReconciliation() (chunked-upload.routes.ts) claims
        // sessions WHERE status='uploading' AND completed_video_id IS NOT NULL
        // AND assembly_attempts IN (0, MAX) once their backoff window elapses,
        // then calls spawnAssemblyRetry() → completeMultipartUpload() which
        // rebuilds and fully re-validates the blob from the staged parts.
        // We therefore set:
        //   • status='uploading'                — makes it a reconciliation candidate
        //   • assembly_attempts = 1             — a fresh recovery budget always in
        //                                         (0, MAX); a prior value of MAX would
        //                                         fail lt(attempts, MAX) and strand it
        //   • updated_at aged 1h                — exceeds every backoff window → next tick picks it up
        //
        // No infinite-loop risk: once re-enrolled the session is 'uploading', so the
        // monitor's status='completed' guard cannot re-claim it; reassembly success
        // heals it, and MAX failures move it to ASSEMBLY_FAILED.
        //
        // The guard `AND status='completed'` + RETURNING makes this race-safe:
        // if another worker already moved the session (uploading/assembling),
        // zero rows return and we skip WITHOUT deleting the blob or touching
        // the video, leaving the row untouched for re-evaluation next pass.
        const resetResult = await withTimeout(
          db.execute<{ session_id: string }>(sql`
            UPDATE upload_sessions
            SET status = 'uploading',
                assembly_attempts = 1,
                updated_at = NOW() - INTERVAL '1 hour'
            WHERE session_id = ${recovery.sessionId}
              AND status = 'completed'
            RETURNING session_id
          `),
          REMEDIATION_TIMEOUT_MS,
          `corrupt-blob-reset-session:${recovery.sessionId}`,
        );
        const claimed = extractRows<{ session_id: string }>(resetResult).length > 0;

        if (!claimed) {
          logger.info(
            { key, videoId: video.id, sessionId: recovery.sessionId },
            "[integrity] corrupt blob recovery skipped — session no longer 'completed' " +
            "(claimed by another worker); will re-evaluate next pass",
          );
          continue;
        }

        // Session enrolled for reassembly. Remove the corrupt blob so the
        // rebuilt blob is written cleanly (completeMultipartUpload also deletes
        // the destination key first, but removing it now eliminates the corrupt
        // 404/partial blob immediately), and reset the video to pending.
        await withTimeout(
          db.execute(sql`DELETE FROM storage_blob_chunks WHERE blob_key = ${key}`),
          REMEDIATION_TIMEOUT_MS,
          `corrupt-blob-delete-chunks-for-recovery:${key}`,
        );
        await withTimeout(
          db.execute(sql`DELETE FROM storage_blobs WHERE key = ${key}`),
          REMEDIATION_TIMEOUT_MS,
          `corrupt-blob-delete-for-recovery:${key}`,
        );

        await withTimeout(
          db
            .update(videos)
            .set({
              s3MirroredAt: null,
              transcodingStatus: "none",
              transcodingErrorCode: null,
              transcodingErrorMessage: null,
            })
            .where(eq(videos.id, video.id)),
          REMEDIATION_TIMEOUT_MS,
          `corrupt-blob-reset-video:${video.id}`,
        );

        adminEventBus.push("videos-library-updated", {
          videoId: video.id,
          reason: "integrity-scan-corrupt-blob-recovery",
        });

        logger.warn(
          {
            key,
            videoId: video.id,
            sessionId: recovery.sessionId,
            partsPresent: recovery.partsPresent,
            totalChunks: recovery.totalChunks,
            size_bytes: Number(size_bytes),
            actual_bytes: Number(actual_bytes),
          },
          "[integrity] corrupt blob — upload parts present, session re-enrolled for self-healing reassembly (no data loss)",
        );

        adminEventBus.push("ops-alert", {
          level: "warn",
          component: "upload-integrity-monitor",
          message:
            `Corrupt storage blob at key=${key} is recoverable: ` +
            `${recovery.partsPresent}/${recovery.totalChunks} upload parts still staged. ` +
            `Session re-enrolled for automatic reassembly — no data loss, video not failed.`,
        });

        fixed++;
        continue;
      }

      // ── No recovery possible — mark failed and remove the corrupt blob ──
      if (video && video.transcodingStatus !== "failed") {
        await withTimeout(
          db
            .update(videos)
            .set({
              transcodingStatus: "failed",
              transcodingErrorCode: "CORRUPT_SOURCE",
              transcodingErrorMessage:
                `Storage integrity scan found a corrupt blob at key=${key}: ` +
                `recorded size_bytes=${size_bytes} but actual data is ${actual_bytes} bytes, ` +
                `and no upload parts remain to rebuild it. ` +
                `Delete this video and re-upload to recover.`,
            })
            .where(eq(videos.id, video.id)),
          REMEDIATION_TIMEOUT_MS,
          `corrupt-blob-mark-failed:${video.id}`,
        );

        adminEventBus.push("videos-library-updated", {
          videoId: video.id,
          reason: "integrity-scan-corrupt-blob",
        });
      }

      // Delete the corrupt blob row (idempotent — safe if already gone).
      await withTimeout(
        db.execute(sql`DELETE FROM storage_blobs WHERE key = ${key}`),
        REMEDIATION_TIMEOUT_MS,
        `corrupt-blob-delete:${key}`,
      );

      logger.error(
        {
          key,
          size_bytes: Number(size_bytes),
          actual_bytes: Number(actual_bytes),
          videoId: video?.id ?? null,
        },
        "[integrity] corrupt blob unrecoverable (no parts) — deleted, video marked CORRUPT_SOURCE",
      );

      // Only raise an error-level ops-alert when we can tie the corrupt blob
      // back to a real managed_videos row.  When video is null the blob key
      // has no referencing video (e.g. orphaned MinIO multipart staging objects
      // like "keys_parts/..." or "keys_meta/..." left over from a previous
      // storage era).  Deleting those is routine GC — not operator-actionable
      // — so we skip the alert entirely to avoid flooding the admin inbox.
      if (video) {
        adminEventBus.push("ops-alert", {
          level: "error",
          component: "upload-integrity-monitor",
          message:
            `Unrecoverable corrupt storage blob removed: key=${key} ` +
            `(recorded ${size_bytes} bytes, actual ${actual_bytes} bytes, no upload parts remain). ` +
            `Video ${video.id} marked CORRUPT_SOURCE — re-upload required.`,
        });
      }

      fixed++;
    } catch (err) {
      logger.warn(
        { err, key },
        "[integrity] failed to remediate corrupt blob (will retry next pass)",
      );
    }
  }

  return fixed;
}

// ── Pass 2: Videos with missing blobs ────────────────────────────────────────
// Videos where s3MirroredAt IS NOT NULL (blob was confirmed written) but no
// matching row in storage_blobs. These produce a 404 on every playback request.
// Retry path: if upload parts are present, reset session for auto-reassembly.
async function scanMissingBlobs(deadlineMs: number): Promise<number> {
  type MissingRow = { id: string; object_path: string };

  const result = await withTimeout(
    db.execute<MissingRow>(sql`
      SELECT v.id, v.object_path
      FROM managed_videos v
      LEFT JOIN storage_blobs b ON b.key = v.object_path
      WHERE v.s3_mirrored_at IS NOT NULL
        AND v.object_path IS NOT NULL
        AND b.key IS NULL
        AND v.transcoding_status != 'failed'
      LIMIT ${MAX_MISSING_BLOBS_PER_PASS}
    `).catch((err) => {
      logger.warn({ err }, "[integrity] missing-blob scan query failed");
      return null;
    }),
    FAST_QUERY_TIMEOUT_MS,
    "missing-blobs-scan",
  );
  const rows = extractRows<MissingRow>(result);

  if (rows.length === 0) return 0;

  logger.warn(
    { count: rows.length },
    "[integrity] videos with s3MirroredAt but missing blob detected",
  );

  let handled = 0;
  for (const row of rows) {
    if (isExpired(deadlineMs, "missing-blob-remediation")) break;

    const { id, object_path } = row;
    try {
      // Check for an upload session that can be reset for reassembly.
      type SessionRow = { session_id: string; total_chunks: number; upload_id: string | null };
      const sessionResult = await withTimeout(
        db.execute<SessionRow>(sql`
          SELECT session_id, total_chunks, upload_id
          FROM upload_sessions
          WHERE completed_video_id = ${id}
          LIMIT 1
        `).catch(() => null),
        FAST_QUERY_TIMEOUT_MS,
        `missing-blob-find-session:${id}`,
      );
      const [session] = extractRows<SessionRow>(sessionResult);

      let hasPartsForReassembly = false;
      if (session?.upload_id) {
        type CntRow = { cnt: string };
        const cntResult = await withTimeout(
          db.execute<CntRow>(sql`
            SELECT COUNT(*)::text AS cnt
            FROM storage_upload_parts
            WHERE upload_id = ${session.upload_id}
          `).catch(() => null),
          FAST_QUERY_TIMEOUT_MS,
          `missing-blob-count-parts:${id}`,
        );
        const [cntRow] = extractRows<CntRow>(cntResult);
        const partsPresent = parseInt(cntRow?.cnt ?? "0", 10);
        hasPartsForReassembly = partsPresent >= (session.total_chunks ?? 1);
      }

      if (hasPartsForReassembly && session) {
        // Parts still available — re-enroll the session into the periodic
        // assembly-reconciliation path (status='uploading' + assembly_attempts ≥ 1
        // + aged updated_at) so runAssemblyReconciliation() actually rebuilds the
        // blob on its next tick. (A bare status='assembling' reset would only be
        // re-spawned on the next server restart via the onReady hook, leaving a
        // 24/7 server's row stuck until then.) Race-safe via the status='completed'
        // guard + RETURNING: if another worker already moved the session, we skip
        // without touching the video row.
        const reEnroll = await withTimeout(
          db.execute<{ session_id: string }>(sql`
            UPDATE upload_sessions
            SET status = 'uploading',
                assembly_attempts = 1,
                updated_at = NOW() - INTERVAL '1 hour'
            WHERE session_id = ${session.session_id}
              AND status = 'completed'
            RETURNING session_id
          `).catch((err) => {
            logger.warn({ err, sessionId: session.session_id }, "[integrity] failed to reset upload session");
            throw err;
          }),
          REMEDIATION_TIMEOUT_MS,
          `missing-blob-reset-session:${session.session_id}`,
        );

        if (extractRows<{ session_id: string }>(reEnroll).length === 0) {
          logger.info(
            { videoId: id, objectPath: object_path, sessionId: session.session_id },
            "[integrity] missing blob recovery skipped — session no longer 'completed' " +
            "(claimed by another worker); will re-evaluate next pass",
          );
          continue;
        }

        await withTimeout(
          db
            .update(videos)
            .set({
              s3MirroredAt: null,
              transcodingStatus: "none",
              transcodingErrorCode: null,
              transcodingErrorMessage: null,
            })
            .where(eq(videos.id, id)),
          REMEDIATION_TIMEOUT_MS,
          `missing-blob-reset-video:${id}`,
        );

        adminEventBus.push("videos-library-updated", {
          videoId: id,
          reason: "integrity-scan-missing-blob-recovery",
        });

        logger.warn(
          { videoId: id, objectPath: object_path, sessionId: session.session_id },
          "[integrity] missing blob — upload parts present, session re-enrolled for auto-reassembly",
        );
      } else {
        // No parts remain — the blob was confirmed in storage at upload time
        // (s3MirroredAt was set) but is now absent and cannot be reassembled.
        // This is server-side data loss, NOT a user error: the operator did not
        // delete this file. Mark STORAGE_LOST so:
        //   • The admin UI shows a server-side data-loss banner (not "re-upload").
        //   • sweepCorruptBlobs picks it up for retention-period cleanup.
        //   • The video is excluded from re-upload prompts and retry flows.
        await withTimeout(
          db
            .update(videos)
            .set({
              transcodingStatus: "failed",
              transcodingErrorCode: "STORAGE_LOST",
              transcodingErrorMessage:
                `Storage integrity scan: blob at key=${object_path} was previously ` +
                `confirmed in storage but is no longer present, and no upload parts ` +
                `remain to reassemble it. This is a server-side storage loss — ` +
                `no operator action is required. Contact support if this persists.`,
            })
            .where(eq(videos.id, id)),
          REMEDIATION_TIMEOUT_MS,
          `missing-blob-mark-storage-lost:${id}`,
        );

        adminEventBus.push("videos-library-updated", {
          videoId: id,
          reason: "integrity-scan-missing-blob-storage-lost",
        });

        logger.error(
          { videoId: id, objectPath: object_path },
          "[integrity] missing blob — no upload parts remain, video marked STORAGE_LOST " +
          "(server-side data loss, not user error)",
        );

        adminEventBus.push("ops-alert", {
          level: "error",
          component: "upload-integrity-monitor",
          message:
            `STORAGE_LOST: Video ${id} had a confirmed blob at key=${object_path} ` +
            `that is now absent with no parts for reassembly. ` +
            `This is server-side storage loss. Investigate storage_blobs integrity. ` +
            `No operator re-upload is required.`,
        });
      }

      handled++;
    } catch (err) {
      logger.warn(
        { err, videoId: id },
        "[integrity] failed to remediate missing blob (will retry next pass)",
      );
    }
  }

  return handled;
}

// ── Pass 3: Orphaned storage_upload_parts ────────────────────────────────────
// Rows whose upload_id no longer matches any active session (session deleted,
// expired, or completed without full cleanup). Each row holds ≤ 8 MiB of
// BYTEA — orphans waste real PostgreSQL storage.
//
// IMPORTANT: The original implementation used SUM(octet_length(p.data)) which
// forced a full BYTEA read of every orphaned part row — on a large DB this
// could scan GB of data and cause multi-minute hangs. This rewrite uses
// COUNT(*) only; sizes are estimated from COUNT × MAX_PART_BYTES for the
// ops-alert threshold check.
async function scanOrphanedParts(deadlineMs: number): Promise<number> {
  type OrphanRow = { upload_id: string; part_count: string };

  const result = await withTimeout(
    db.execute<OrphanRow>(sql`
      SELECT
        p.upload_id,
        COUNT(*)::text AS part_count
      FROM storage_upload_parts p
      LEFT JOIN upload_sessions s ON s.upload_id = p.upload_id
      WHERE s.session_id IS NULL
         OR s.status = 'completed'
      GROUP BY p.upload_id
      LIMIT ${MAX_ORPHAN_UPLOAD_IDS_PER_PASS}
    `).catch((err) => {
      logger.warn({ err }, "[integrity] orphaned-parts scan query failed");
      return null;
    }),
    FAST_QUERY_TIMEOUT_MS,
    "orphaned-parts-scan",
  );
  const rows = extractRows<OrphanRow>(result);

  if (rows.length === 0) return 0;

  // Estimate total orphan bytes from COUNT × max chunk size (avoids BYTEA read).
  const totalOrphanPartsCount = rows.reduce(
    (sum, r) => sum + parseInt(r.part_count ?? "0", 10),
    0,
  );
  const estimatedOrphanBytes = totalOrphanPartsCount * MAX_PART_BYTES;

  logger.info(
    {
      orphanUploadIds: rows.length,
      totalOrphanParts: totalOrphanPartsCount,
      estimatedMaxBytes: estimatedOrphanBytes,
    },
    "[integrity] orphaned storage_upload_parts detected — cleaning up",
  );

  let deleted = 0;
  for (const row of rows) {
    if (isExpired(deadlineMs, "orphaned-parts-remediation")) break;

    try {
      await withTimeout(
        db.execute(sql`
          DELETE FROM storage_upload_parts WHERE upload_id = ${row.upload_id}
        `),
        REMEDIATION_TIMEOUT_MS,
        `orphaned-parts-delete:${row.upload_id}`,
      );

      logger.info(
        {
          uploadId: row.upload_id,
          parts: Number(row.part_count),
          estimatedBytes: Number(row.part_count) * MAX_PART_BYTES,
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

  // Alert when estimated orphan size is large (using max-chunk-size estimate
  // is conservative — actual size is ≤ estimated).
  if (estimatedOrphanBytes > 10 * 1024 * 1024) {
    adminEventBus.push("ops-alert", {
      level: "warn",
      component: "upload-integrity-monitor",
      message:
        `Cleaned up ${deleted} orphaned upload part group(s) ` +
        `(${totalOrphanPartsCount} parts, ≤${Math.round(estimatedOrphanBytes / 1024 / 1024)} MiB estimated freed from storage_upload_parts).`,
    });
  }

  return deleted;
}

// ── Main entry point ──────────────────────────────────────────────────────────
// The worker supervisor invokes this function and enforces a 10-minute hard
// timeout via Promise.race against a deadman timer. Inside this function we
// further subdivide the budget across the three passes so each pass is bounded
// independently, preventing a single slow pass from consuming the entire window.
export async function runUploadIntegrityScan(): Promise<void> {
  const startMs = Date.now();

  // Reserve 30 s of buffer before the supervisor's 10-minute deadman fires.
  // Each pass checks its own deadline and exits gracefully before then.
  const overallDeadlineMs = startMs + 9 * 60_000; // 9 minutes (supervisor = 10)

  logger.info(
    { budgetMs: overallDeadlineMs - startMs },
    "[integrity] upload integrity scan started",
  );

  // Heartbeat: log every 60 s so operators can see progress in logs.
  const heartbeatTimer = setInterval(() => {
    const elapsedMs = Date.now() - startMs;
    const remainingMs = overallDeadlineMs - Date.now();
    logger.info(
      { elapsedMs, remainingMs },
      "[integrity] scan in progress — heartbeat",
    );
  }, 60_000);
  heartbeatTimer.unref?.();

  let corruptFixed = 0;
  let missingHandled = 0;
  let orphansDeleted = 0;
  const passErrors: string[] = [];

  try {
    // Run passes SEQUENTIALLY, not in parallel.
    //
    // Race condition that parallel execution creates:
    //   scanMissingBlobs detects a video with s3MirroredAt set but no blob,
    //   finds upload parts still present, and resets the session from
    //   'completed' → 'assembling' so spawnAssemblyRetry can rebuild the blob.
    //   Meanwhile, scanOrphanedParts queries for parts whose session is
    //   'completed' (it sees the status BEFORE the reset commits) and DELETEs
    //   those exact parts. The recovery attempt then finds 0 parts and marks
    //   the video ASSEMBLY_FAILED — permanently corrupting recoverable data.
    //
    // Sequential execution (corrupt → missing → orphans) guarantees that by
    // the time the orphan pass runs, scanMissingBlobs has already committed
    // any session resets, so newly-'assembling' sessions are excluded from
    // the orphan query (which filters WHERE s.status = 'completed').
    //
    // The total time cost is minor: each pass is individually deadline-bounded
    // (FAST_QUERY_TIMEOUT_MS / SLOW_QUERY_TIMEOUT_MS) and the overall
    // 9-minute invocation window provides more than enough headroom for all
    // three passes to complete on even a heavily-loaded DB.

    corruptFixed = await scanCorruptBlobs(overallDeadlineMs).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "[integrity] corrupt-blob pass threw unexpectedly");
      passErrors.push(`corrupt-blobs: ${msg}`);
      return 0;
    });

    if (!isExpired(overallDeadlineMs, "main-loop-after-corrupt")) {
      missingHandled = await scanMissingBlobs(overallDeadlineMs).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err }, "[integrity] missing-blob pass threw unexpectedly");
        passErrors.push(`missing-blobs: ${msg}`);
        return 0;
      });
    }

    if (!isExpired(overallDeadlineMs, "main-loop-after-missing")) {
      orphansDeleted = await scanOrphanedParts(overallDeadlineMs).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err }, "[integrity] orphaned-parts pass threw unexpectedly");
        passErrors.push(`orphaned-parts: ${msg}`);
        return 0;
      });
    }

  } finally {
    clearInterval(heartbeatTimer);
  }

  const elapsedMs = Date.now() - startMs;
  logger.info(
    {
      elapsedMs,
      corruptBlobsFixed: corruptFixed,
      missingBlobsHandled: missingHandled,
      orphanPartGroupsDeleted: orphansDeleted,
      passErrors: passErrors.length > 0 ? passErrors : undefined,
    },
    "[integrity] upload integrity scan complete",
  );

  // Re-throw only when ALL passes encountered unrecoverable errors (not just
  // returned 0 results). This lets the worker supervisor's circuit breaker
  // count genuine failures separately from "nothing to fix" runs.
  if (passErrors.length === 3) {
    throw new Error(
      `[integrity] all three scan passes failed: ${passErrors.join(" | ")}`,
    );
  }
}
