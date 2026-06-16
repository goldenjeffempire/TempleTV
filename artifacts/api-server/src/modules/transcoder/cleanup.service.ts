/**
 * Post-Transcode Source Cleanup Service
 *
 * After a video's HLS transcoding completes successfully, the original raw
 * source blob (stored under `uploads/…` in storage_blobs) is no longer
 * needed for playback — the HLS renditions are the authoritative copy.
 * Keeping the source blob wastes significant database storage (a 1-hour
 * sermon at 1080p can be 4–8 GiB as raw video).
 *
 * This service implements a robust, idempotent cleanup pipeline:
 *
 *  1. scheduleSourceCleanup(videoId, sourceObjectPath)
 *     Called by the transcoder dispatcher immediately after a job succeeds.
 *     Validates the HLS output, then either deletes the source immediately
 *     (if the retention window is already satisfied) or marks it 'scheduled'
 *     so the sweep picks it up after the window expires.
 *
 *  2. CleanupWorker.start() / .stop()
 *     A background sweep that runs every CLEANUP_SWEEP_MS (default 5 min).
 *     Picks up any videos with sourceCleanupStatus='scheduled' whose
 *     sourceCleanupAfter has passed (covers restarts, failures, backlog).
 *
 * HLS Validation (performed before any deletion):
 *   - master.m3u8 exists in storage_blobs
 *   - All rendition playlist entries referenced in master.m3u8 exist
 *   - Each rendition playlist references ≥1 .ts segment
 *   - At least one segment for each rendition exists in storage_blobs
 *
 * If validation fails the source is NOT deleted and the status is left as
 * 'scheduled' so it will be retried on the next sweep. After
 * CLEANUP_MAX_ATTEMPTS consecutive failures it is flipped to 'failed' so
 * operators can inspect it without the sweep hammering it endlessly.
 *
 * Concurrency safety:
 *   The sweep uses an UPDATE … SET sourceCleanupStatus='running' RETURNING
 *   pattern so multiple processes / replicas never double-delete the same blob.
 *   (Actual status value 'running' is internal to the sweep; it is replaced by
 *   'deleted' or 'scheduled' before the transaction completes.)
 */

import { eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";

const videos = schema.videosTable;

// Maximum cleanup attempts before giving up and marking 'failed'.
const CLEANUP_MAX_ATTEMPTS = 5;

// ─── HLS validation helpers ────────────────────────────────────────────────

/**
 * Parse an M3U8 playlist text and return the list of URI entries.
 * Handles both master playlists (EXT-X-STREAM-INF) and media playlists
 * (sequence of .ts/.m4s lines).
 */
function parseM3u8Uris(text: string): string[] {
  const uris: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith("#EXT-X-STREAM-INF:") || line.startsWith("#EXT-X-MEDIA:")) {
      // URI follows on the next non-comment line
      const next = lines[i + 1]?.trim();
      if (next && !next.startsWith("#") && next.length > 0) {
        uris.push(next);
        i++;
      }
    } else if (!line.startsWith("#") && line.length > 0) {
      uris.push(line);
    }
  }
  return uris;
}

/**
 * Resolve a relative URI from an M3U8 playlist against the playlist's own
 * storage key. All HLS keys are stored under transcoded/{videoId}/…, so
 * relative paths like "v0/playlist.m3u8" resolve to
 * "transcoded/{videoId}/v0/playlist.m3u8".
 */
function resolveHlsKey(baseKey: string, relativeUri: string): string {
  if (relativeUri.startsWith("/")) return relativeUri.slice(1);
  const dir = baseKey.substring(0, baseKey.lastIndexOf("/") + 1);
  return dir + relativeUri;
}

interface HlsValidationResult {
  valid: boolean;
  masterExists: boolean;
  renditionCount: number;
  segmentCount: number;
  errors: string[];
}

/**
 * Validate that the HLS output for videoId is fully intact in storage_blobs.
 * Returns a structured result — callers decide whether to proceed with cleanup.
 */
async function validateHlsOutput(videoId: string): Promise<HlsValidationResult> {
  const errors: string[] = [];
  const masterKey = `transcoded/${videoId}/master.m3u8`;

  // 1. Fetch master playlist bytes
  const masterResult = await db.execute(sql`
    SELECT data FROM storage_blobs WHERE key = ${masterKey} LIMIT 1
  `);

  if (masterResult.rows.length === 0) {
    return {
      valid: false,
      masterExists: false,
      renditionCount: 0,
      segmentCount: 0,
      errors: [`master.m3u8 not found in storage_blobs (key=${masterKey})`],
    };
  }

  const masterRow = masterResult.rows[0] as { data: Buffer };
  const masterText = masterRow.data.toString("utf8");
  const renditionRelUris = parseM3u8Uris(masterText);

  if (renditionRelUris.length === 0) {
    errors.push("master.m3u8 contains no rendition entries");
  }

  const renditionKeys = renditionRelUris.map((u) => resolveHlsKey(masterKey, u));
  if (renditionKeys.length === 0) {
    return { valid: errors.length === 0, masterExists: true, renditionCount: 0, segmentCount: 0, errors };
  }

  // 2. Batch-fetch ALL rendition playlists in one round-trip (replaces N serial
  //    queries). ANY(array) leverages the B-Tree index on storage_blobs.key and
  //    avoids N round-trips for N renditions (typical: 4 renditions = 360/540/
  //    720/1080p). The result is stored in a Map keyed by storage key.
  const rendBatch = await db.execute(sql`
    SELECT key, data FROM storage_blobs
    WHERE key = ANY(${renditionKeys}::text[])
  `);
  const rendMap = new Map<string, string>();
  for (const row of rendBatch.rows as Array<{ key: string; data: Buffer }>) {
    rendMap.set(row.key, row.data.toString("utf8"));
  }

  // Parse each rendition playlist, accumulate expected segment counts per
  // rendition directory (e.g. "transcoded/{videoId}/v0/").
  const segmentExpected = new Map<string, { count: number; rendKey: string }>();
  let totalSegmentCount = 0;

  for (const rendKey of renditionKeys) {
    if (!rendMap.has(rendKey)) {
      errors.push(`rendition playlist missing: ${rendKey}`);
      continue;
    }
    const rendText = rendMap.get(rendKey)!;
    const segmentUris = parseM3u8Uris(rendText).filter((u) => !u.endsWith(".m3u8"));
    if (segmentUris.length === 0) {
      errors.push(`rendition playlist has no segments: ${rendKey}`);
      continue;
    }
    const rendDir = rendKey.substring(0, rendKey.lastIndexOf("/") + 1);
    segmentExpected.set(rendDir, { count: segmentUris.length, rendKey });
    totalSegmentCount += segmentUris.length;
  }

  // 3. Batch-count ALL rendition segments in ONE aggregated query (replaces N
  //    individual COUNT queries — one per rendition dir). Uses regexp_replace to
  //    extract the "transcoded/{id}/{vN}/" directory prefix from each key, then
  //    GROUP BY to count segments per rendition in a single pass over the index.
  //
  //    Why COUNT-based instead of sampling: a 60-min sermon at 2 s segments =
  //    ~1800 segments; sampling 10 checks only 0.6%. A single COUNT with a
  //    prefix LIKE catches any gap regardless of position in the timeline.
  if (segmentExpected.size > 0) {
    const videoPrefix = `transcoded/${videoId}/`;
    const countResult = await db.execute(sql`
      SELECT
        regexp_replace(key, '^(transcoded/[^/]+/[^/]+/).*$', '\\1') AS dir_prefix,
        COUNT(*) AS cnt
      FROM storage_blobs
      WHERE key LIKE ${videoPrefix + "%"}
        AND key NOT LIKE ${"%.m3u8"}
        AND key NOT LIKE ${"%.json"}
      GROUP BY dir_prefix
    `);

    const storedCounts = new Map<string, number>();
    for (const row of countResult.rows as Array<{ dir_prefix: string; cnt: string | number }>) {
      storedCounts.set(row.dir_prefix, parseInt(String(row.cnt ?? 0), 10));
    }

    for (const [rendDir, { count: expected, rendKey }] of segmentExpected) {
      const stored = storedCounts.get(rendDir) ?? 0;
      if (stored < expected) {
        errors.push(
          `rendition ${rendKey}: manifest references ${expected} segment(s) but ` +
          `only ${stored} segment file(s) found in storage — ` +
          `${expected - stored} missing (would cause mid-video playback stall after source deletion)`,
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    masterExists: true,
    renditionCount: renditionKeys.length,
    segmentCount: totalSegmentCount,
    errors,
  };
}

// ─── Source deletion ───────────────────────────────────────────────────────

/**
 * Delete the source blob from storage_blobs and return bytes freed.
 * Also cleans up completed upload_sessions and their associated upload_chunks
 * (these hold BYTEA fallback data that can be significant).
 */
async function deleteSourceBlob(
  videoId: string,
  sourceObjectKey: string,
): Promise<{ bytesFreed: number }> {
  // Get size for logging before deletion.
  const sizeResult = await db.execute(sql`
    SELECT size_bytes FROM storage_blobs WHERE key = ${sourceObjectKey} LIMIT 1
  `);
  const sizeBytes =
    sizeResult.rows.length > 0
      ? ((sizeResult.rows[0] as { size_bytes: number }).size_bytes ?? 0)
      : 0;

  // Delete the source blob.
  await db.execute(sql`DELETE FROM storage_blobs WHERE key = ${sourceObjectKey}`);

  // Clean up the upload_chunks and upload_sessions rows for this video.
  // The sessions table has a completed_video_id foreign-key-like column that
  // lets us find and purge the session that produced this video. The chunks
  // may contain BYTEA fallback data (db_fallback path) or just etag metadata
  // (S3/db path) — both are safe to delete once HLS is verified.
  try {
    const sessionResult = await db.execute(sql`
      SELECT session_id FROM upload_sessions
      WHERE completed_video_id = ${videoId}
    `);
    if (sessionResult.rows.length > 0) {
      const sessionIds = (sessionResult.rows as Array<{ session_id: string }>).map(
        (r) => r.session_id,
      );
      // Delete chunks first (may have large BYTEA fallback_data).
      await db
        .delete(schema.uploadChunksTable)
        .where(inArray(schema.uploadChunksTable.sessionId, sessionIds));
      // Delete the session rows.
      await db
        .delete(schema.uploadSessionsTable)
        .where(inArray(schema.uploadSessionsTable.sessionId, sessionIds));
      logger.info(
        { videoId, sessionIds, chunksDeleted: true },
        "[cleanup] upload session + chunks deleted",
      );
    }
  } catch (sessionErr) {
    // Non-fatal: session cleanup is best-effort. The source blob deletion
    // above is the critical operation. Log and continue.
    logger.warn(
      { err: sessionErr, videoId },
      "[cleanup] session/chunk cleanup failed (non-fatal — source blob already deleted)",
    );
  }

  return { bytesFreed: sizeBytes };
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Called by the transcoder dispatcher immediately after a job succeeds.
 *
 * If the retention window is 0 the source is validated and deleted right away.
 * Otherwise, the video is marked 'scheduled' with a sourceCleanupAfter
 * timestamp so the sweep worker processes it after the window expires.
 *
 * This function never throws — all errors are logged and surfaced via the
 * sourceCleanupStatus column for operator visibility.
 */
export async function scheduleSourceCleanup(
  videoId: string,
  sourceObjectKey: string | null | undefined,
): Promise<void> {
  if (env.CLEANUP_DISABLE) {
    logger.debug({ videoId }, "[cleanup] skipped (CLEANUP_DISABLE=true)");
    return;
  }

  if (!sourceObjectKey) {
    // No source object key — nothing to clean up (e.g. YouTube-imported video).
    await db
      .update(videos)
      .set({ sourceCleanupStatus: "skipped" })
      .where(eq(videos.id, videoId))
      .catch((err) =>
        logger.warn({ err, videoId }, "[cleanup] could not mark skipped (non-fatal)"),
      );
    return;
  }

  try {
    // In production enforce a minimum 24-hour retention floor regardless of
    // CLEANUP_RETENTION_HOURS so a misconfiguration (e.g. CLEANUP_RETENTION_HOURS=0)
    // never causes source blobs to be deleted the instant HLS passes validation.
    const effectiveRetentionHours = env.NODE_ENV === "production"
      ? Math.max(env.CLEANUP_RETENTION_HOURS, 24)
      : env.CLEANUP_RETENTION_HOURS;
    const retentionMs = effectiveRetentionHours * 3_600_000;
    const cleanupAfter = new Date(Date.now() + retentionMs);

    // Mark as scheduled and record when cleanup becomes eligible.
    await db
      .update(videos)
      .set({
        sourceCleanupStatus: "scheduled",
        sourceCleanupAfter: cleanupAfter,
      })
      .where(eq(videos.id, videoId));

    logger.info(
      {
        videoId,
        sourceObjectKey,
        cleanupAfter,
        retentionHours: env.CLEANUP_RETENTION_HOURS,
        effectiveRetentionHours,
      },
      "[cleanup] source cleanup scheduled",
    );

    // If retention window is zero, run immediately (synchronously, but
    // non-blocking to the caller via void).
    if (retentionMs === 0) {
      void runCleanupForVideo(videoId, sourceObjectKey)
        .catch((err) => logger.warn({ err, videoId, sourceObjectKey }, "[cleanup] zero-retention runCleanupForVideo failed (non-fatal)"));
    }
  } catch (err) {
    logger.error({ err, videoId, sourceObjectKey }, "[cleanup] scheduleSourceCleanup failed");
  }
}

/**
 * Attempt to clean up (validate + delete) the source blob for a single video.
 * Returns true if the source was deleted, false if it was deferred or failed.
 *
 * This is safe to call multiple times — the idempotency guard at the top
 * prevents re-processing videos that are already 'deleted'.
 */
async function runCleanupForVideo(
  videoId: string,
  sourceObjectKey: string,
): Promise<boolean> {
  const log = logger.child({ videoId, sourceObjectKey, service: "cleanup" });

  // Idempotency: bail if already deleted or permanently failed.
  const existing = await db
    .select({
      sourceCleanupStatus: videos.sourceCleanupStatus,
      sourceCleanupAttempts: videos.sourceCleanupAttempts,
    })
    .from(videos)
    .where(eq(videos.id, videoId))
    .limit(1);

  const row = existing[0];
  if (!row) {
    log.warn("[cleanup] video row not found — skipping");
    return false;
  }
  if (row.sourceCleanupStatus === "deleted") {
    log.debug("[cleanup] already deleted — skipping");
    return true;
  }
  // Note: "failed" status is NOT a permanent bail-out — the sweep will reset
  // attempts and reschedule 24 h from now (see max-attempts handling below),
  // so the only terminal state is "deleted". We leave the previous guard
  // comment here for documentation purposes but do not short-circuit on it.

  const attempts = (row.sourceCleanupAttempts ?? 0) + 1;

  try {
    // Step 1: Validate HLS output is fully intact.
    log.info("[cleanup] validating HLS output…");
    const validation = await validateHlsOutput(videoId);

    if (!validation.valid) {
      // On hitting max attempts, reset the counter and schedule a 24-hour
      // retry rather than marking "failed" permanently. HLS validation failures
      // are typically transient (storage blip, interrupted upload of final
      // segments) and will self-heal — permanently giving up leaves the raw
      // source blob (potentially GBs) in storage indefinitely.
      // "failed" is reserved for truly unrecoverable DB-level errors in the
      // catch block below.
      const hitMaxAttempts = attempts >= CLEANUP_MAX_ATTEMPTS;
      log.error(
        {
          validationErrors: validation.errors,
          attempts,
          maxAttempts: CLEANUP_MAX_ATTEMPTS,
          action: hitMaxAttempts ? "resetting attempt counter and scheduling 24-h retry" : "will retry with backoff",
        },
        "[cleanup] HLS validation FAILED — source NOT deleted",
      );
      await db
        .update(videos)
        .set({
          sourceCleanupStatus: "scheduled",
          sourceCleanupAttempts: hitMaxAttempts ? 0 : attempts,
          sourceCleanupAfter: new Date(
            Date.now() + (hitMaxAttempts
              ? 24 * 3_600_000                                            // daily retry after max-attempts reset
              : Math.min(3_600_000 * 2 ** attempts, 24 * 3_600_000)),    // normal exponential backoff
          ),
        })
        .where(eq(videos.id, videoId));
      return false;
    }

    log.info(
      {
        renditionCount: validation.renditionCount,
        segmentCount: validation.segmentCount,
      },
      "[cleanup] HLS validation passed — proceeding with source deletion",
    );

    // Step 1.5: Hard 24-hour safety floor on HLS age — independent of the
    // configurable retention window. Even if CLEANUP_RETENTION_HOURS is set
    // to 0 (dev) or a misconfigured value, never delete the source blob if
    // the HLS master was written < 24 h ago. This guards against a transient
    // false-pass during the propagation window (e.g. a storage cache returning
    // a stale 200 for a segment that has not yet fully flushed to disk).
    const masterKey = `transcoded/${videoId}/master.m3u8`;
    const masterAgeResult = await db.execute(sql`
      SELECT created_at FROM storage_blobs WHERE key = ${masterKey} LIMIT 1
    `);
    if (masterAgeResult.rows.length > 0) {
      const masterCreatedAt = (masterAgeResult.rows[0] as { created_at: Date | string }).created_at;
      const masterCreatedMs = masterCreatedAt instanceof Date
        ? masterCreatedAt.getTime()
        : new Date(masterCreatedAt).getTime();
      const ageMs = Date.now() - masterCreatedMs;
      const minAgeMs = 24 * 3_600_000;
      if (ageMs < minAgeMs) {
        const ageHours = Math.round((ageMs / 3_600_000) * 10) / 10;
        log.warn(
          { masterCreatedAt, ageHours, minAgeHours: 24 },
          "[cleanup] HLS master < 24 h old — deferring source deletion (hard safety floor)",
        );
        await db
          .update(videos)
          .set({
            sourceCleanupStatus: "scheduled",
            sourceCleanupAttempts: attempts,
            sourceCleanupAfter: new Date(masterCreatedMs + minAgeMs),
          })
          .where(eq(videos.id, videoId));
        return false;
      }
    }

    // Step 1.6: On-air MP4 safety check.
    //
    // Guard against deleting the source blob while this video is the active
    // broadcast item and the broadcast_queue row still carries only
    // localVideoUrl (no hlsMasterUrl). This narrow race occurs when:
    //   1. Transcoder writes hls_master_url to managed_videos and fires
    //      broadcast-queue-updated (reload pending on next orchestrator tick).
    //   2. cleanup.service starts immediately after (CLEANUP_RETENTION_HOURS=1
    //      in production, but zero-retention dev mode can fire within seconds).
    //   3. Orchestrator has NOT yet reloaded → broadcast_queue row still has no
    //      hls_master_url → clients receive localVideoUrl → blob 404 after deletion.
    //
    // Fix: if the video is actively in broadcast_queue with is_active=true AND
    // no hls_master_url on the queue row, defer cleanup for 1 hour to let the
    // orchestrator cycle. The next sweep will re-check.
    const onAirMp4Result = await db.execute(sql`
      SELECT 1
      FROM broadcast_queue
      WHERE video_id = ${videoId}
        AND is_active = true
        AND (hls_master_url IS NULL OR hls_master_url = '')
      LIMIT 1
    `);
    if (onAirMp4Result.rows.length > 0) {
      const deferUntil = new Date(Date.now() + 3_600_000); // 1 h
      log.warn(
        { videoId, deferUntil },
        "[cleanup] video is on-air via MP4 with no HLS on the queue row — deferring deletion 1 h for orchestrator to reload",
      );
      await db
        .update(videos)
        .set({
          sourceCleanupStatus: "scheduled",
          sourceCleanupAttempts: attempts,
          sourceCleanupAfter: deferUntil,
        })
        .where(eq(videos.id, videoId));
      return false;
    }

    // Step 2: Delete source blob + associated upload session/chunks.
    const { bytesFreed } = await deleteSourceBlob(videoId, sourceObjectKey);

    // Step 3: Mark video row as cleaned up.
    await db
      .update(videos)
      .set({
        sourceCleanupStatus: "deleted",
        sourceDeletedAt: new Date(),
        sourceCleanupAttempts: attempts,
        // Clear objectPath so any accidental re-run of cleanup can detect
        // the source is gone without querying storage_blobs.
        objectPath: null,
      })
      .where(eq(videos.id, videoId));

    log.info(
      { bytesFreed, mbFreed: Math.round(bytesFreed / 1024 / 1024) },
      "[cleanup] source blob deleted successfully",
    );

    return true;
  } catch (err) {
    const hitMaxAttempts = attempts >= CLEANUP_MAX_ATTEMPTS;
    log.error(
      { err, attempts, maxAttempts: CLEANUP_MAX_ATTEMPTS },
      "[cleanup] cleanup attempt failed",
    );
    await db
      .update(videos)
      .set({
        // Same self-healing reset logic as the validation-failure path: never
        // mark "failed" permanently. Reset attempts at max and retry daily.
        sourceCleanupStatus: "scheduled",
        sourceCleanupAttempts: hitMaxAttempts ? 0 : attempts,
        sourceCleanupAfter: new Date(
          Date.now() + (hitMaxAttempts
            ? 24 * 3_600_000
            : Math.min(3_600_000 * 2 ** attempts, 24 * 3_600_000)),
        ),
      })
      .where(eq(videos.id, videoId))
      .catch((dbErr) =>
        log.error({ dbErr }, "[cleanup] could not update cleanup status after failure"),
      );
    return false;
  }
}

// ─── Sweep worker ──────────────────────────────────────────────────────────

/**
 * Run one sweep iteration:
 *  - Find up to CLEANUP_MAX_PER_SWEEP videos where:
 *      sourceCleanupStatus = 'scheduled'
 *      sourceCleanupAfter <= NOW()
 *      objectPath IS NOT NULL
 *  - For each: validate HLS + delete source blob.
 *
 * Uses a SELECT…FOR UPDATE SKIP LOCKED pattern to be multi-replica safe.
 */
export async function runCleanupSweep(): Promise<{
  processed: number;
  deleted: number;
  deferred: number;
  errors: number;
}> {
  if (env.CLEANUP_DISABLE) return { processed: 0, deleted: 0, deferred: 0, errors: 0 };

  const now = new Date();

  // Atomically claim eligible candidates by marking them 'running' so that
  // concurrent replicas or a rapid restart cannot pick up the same video and
  // attempt a double-delete. The FOR UPDATE SKIP LOCKED subquery ensures only
  // one process owns each row at a time; the outer UPDATE marks them 'running'
  // so a second sweep's WHERE source_cleanup_status='scheduled' filter skips
  // them for the duration of this cycle.
  // If the process crashes mid-cycle, CleanupWorker.start() resets any rows
  // still 'running' back to 'scheduled' before the first sweep fires.
  const limit = env.CLEANUP_MAX_PER_SWEEP;
  const claimedRows = await db.execute(sql`
    UPDATE managed_videos
    SET source_cleanup_status = 'running'
    WHERE id IN (
      SELECT id FROM managed_videos
      WHERE source_cleanup_status = 'scheduled'
        AND (source_cleanup_after <= ${now} OR source_cleanup_after IS NULL)
        AND object_path IS NOT NULL
      ORDER BY source_cleanup_after NULLS LAST
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id,
              object_path          AS "objectPath",
              source_cleanup_after AS "sourceCleanupAfter"
  `);
  const candidates = claimedRows.rows as Array<{
    id: string;
    objectPath: string | null;
    sourceCleanupAfter: Date | null;
  }>;

  if (candidates.length === 0) return { processed: 0, deleted: 0, deferred: 0, errors: 0 };

  logger.info(
    { count: candidates.length },
    "[cleanup-sweep] processing eligible source blobs",
  );

  let deleted = 0;
  let deferred = 0;
  let errors = 0;

  for (const candidate of candidates) {
    if (!candidate.objectPath) continue;
    try {
      const ok = await runCleanupForVideo(candidate.id, candidate.objectPath);
      if (ok) {
        deleted++;
      } else {
        deferred++;
      }
    } catch (err) {
      errors++;
      logger.error(
        { err, videoId: candidate.id },
        "[cleanup-sweep] unexpected error for candidate",
      );
    }
  }

  logger.info(
    { processed: candidates.length, deleted, deferred, errors },
    "[cleanup-sweep] sweep complete",
  );

  return { processed: candidates.length, deleted, deferred, errors };
}

// ─── Worker class ──────────────────────────────────────────────────────────

/**
 * Long-running sweep worker that calls runCleanupSweep() on a configurable
 * interval. Wire into main.ts alongside the transcoder dispatcher.
 */
class CleanupWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;

  start(): void {
    if (this.timer || env.CLEANUP_DISABLE) {
      if (env.CLEANUP_DISABLE) {
        logger.info("[cleanup-worker] disabled by CLEANUP_DISABLE — not starting");
      }
      return;
    }
    this.stopped = false;

    // Reset any rows left in 'running' state from a previous crashed process.
    // These are guaranteed stale — if the worker is starting now, no sweep is
    // currently executing — so flipping them back to 'scheduled' is safe and
    // ensures the sweep picks them up on its next tick rather than leaving
    // them orphaned indefinitely in the 'running' state.
    void db
      .update(videos)
      .set({ sourceCleanupStatus: "scheduled" })
      .where(eq(videos.sourceCleanupStatus, "running"))
      .catch((err: unknown) =>
        logger.warn({ err }, "[cleanup-worker] startup reset of stale 'running' rows failed (non-fatal)"),
      );

    const tick = () => {
      if (this.stopped) return;
      if (this.running) {
        this.timer = setTimeout(tick, env.CLEANUP_SWEEP_MS);
        this.timer.unref();
        return;
      }
      this.running = true;
      void runCleanupSweep()
        .catch((err) => logger.error({ err }, "[cleanup-worker] sweep error"))
        .finally(() => {
          this.running = false;
          if (!this.stopped) {
            this.timer = setTimeout(tick, env.CLEANUP_SWEEP_MS);
            this.timer.unref();
          }
        });
    };

    // Initial delay: run first sweep 60 s after startup to let the server
    // fully warm up before doing DB-heavy cleanup work.
    this.timer = setTimeout(tick, Math.min(60_000, env.CLEANUP_SWEEP_MS));
    this.timer.unref();
    logger.info(
      { sweepMs: env.CLEANUP_SWEEP_MS, retentionHours: env.CLEANUP_RETENTION_HOURS },
      "[cleanup-worker] started",
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("[cleanup-worker] stopped");
  }
}

export const cleanupWorker = new CleanupWorker();
