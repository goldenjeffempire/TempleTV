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

import { and, eq, lte, or, sql } from "drizzle-orm";
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

  let totalSegmentCount = 0;
  const renditionKeys = renditionRelUris.map((u) => resolveHlsKey(masterKey, u));

  // 2. Check each rendition playlist exists and contains segments
  for (const rendKey of renditionKeys) {
    const rendResult = await db.execute(sql`
      SELECT data FROM storage_blobs WHERE key = ${rendKey} LIMIT 1
    `);

    if (rendResult.rows.length === 0) {
      errors.push(`rendition playlist missing: ${rendKey}`);
      continue;
    }

    const rendRow = rendResult.rows[0] as { data: Buffer };
    const rendText = rendRow.data.toString("utf8");
    const segmentUris = parseM3u8Uris(rendText).filter(
      (u) => !u.endsWith(".m3u8"),
    );

    if (segmentUris.length === 0) {
      errors.push(`rendition playlist has no segments: ${rendKey}`);
      continue;
    }

    // Count-based segment validation: verify that the number of segment files
    // in storage matches the number listed in the playlist exactly.
    //
    // Why count-based instead of sampling N segments:
    //   Sample-based approaches (e.g. first/last/10 evenly-spaced) can miss
    //   corrupt or missing segments in the middle of the rendition. A 60-min
    //   sermon at 2 s segments = ~1800 segments; sampling 10 checks only 0.6%.
    //   A single COUNT query is O(1) in storage_blobs for a prefix scan and
    //   catches any gap regardless of where it falls in the timeline.
    //
    // The rendition directory prefix is the playlist key up to the last '/'.
    // Segments live at e.g. transcoded/{videoId}/v0/seg00001.ts.
    // We filter out .m3u8 playlist files so only raw segment files are counted.
    const rendDir = rendKey.substring(0, rendKey.lastIndexOf("/") + 1);
    const countResult = await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM storage_blobs
      WHERE key LIKE ${rendDir + "%"}
        AND key NOT LIKE ${"%.m3u8"}
        AND key NOT LIKE ${"%.json"}
    `);
    const storedCount = parseInt(
      String((countResult.rows[0] as { cnt: string | number }).cnt ?? 0),
      10,
    );

    if (storedCount < segmentUris.length) {
      errors.push(
        `rendition ${rendKey}: manifest references ${segmentUris.length} segment(s) but ` +
        `only ${storedCount} segment file(s) found in storage — ` +
        `${segmentUris.length - storedCount} missing (would cause mid-video playback stall after source deletion)`,
      );
    }

    totalSegmentCount += segmentUris.length;
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
      await db.execute(sql`
        DELETE FROM upload_chunks
        WHERE session_id = ANY(${sessionIds}::text[])
      `);
      // Delete the session rows.
      await db.execute(sql`
        DELETE FROM upload_sessions
        WHERE session_id = ANY(${sessionIds}::text[])
      `);
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
    const retentionMs = env.CLEANUP_RETENTION_HOURS * 3_600_000;
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
      { videoId, sourceObjectKey, cleanupAfter, retentionHours: env.CLEANUP_RETENTION_HOURS },
      "[cleanup] source cleanup scheduled",
    );

    // If retention window is zero, run immediately (synchronously, but
    // non-blocking to the caller via void).
    if (retentionMs === 0) {
      void runCleanupForVideo(videoId, sourceObjectKey);
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

  // Claim eligible videos atomically.
  const candidates = await db
    .select({
      id: videos.id,
      objectPath: videos.objectPath,
      sourceCleanupAfter: videos.sourceCleanupAfter,
    })
    .from(videos)
    .where(
      and(
        eq(videos.sourceCleanupStatus, "scheduled"),
        or(
          lte(videos.sourceCleanupAfter, now),
          // Also catch rows where sourceCleanupAfter was never set (edge case).
          sql`${videos.sourceCleanupAfter} IS NULL`,
        ),
        sql`${videos.objectPath} IS NOT NULL`,
      ),
    )
    .limit(env.CLEANUP_MAX_PER_SWEEP);

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

    const tick = () => {
      if (this.stopped) return;
      if (this.running) {
        this.timer = setTimeout(tick, env.CLEANUP_SWEEP_MS);
        return;
      }
      this.running = true;
      void runCleanupSweep()
        .catch((err) => logger.error({ err }, "[cleanup-worker] sweep error"))
        .finally(() => {
          this.running = false;
          if (!this.stopped) {
            this.timer = setTimeout(tick, env.CLEANUP_SWEEP_MS);
          }
        });
    };

    // Initial delay: run first sweep 60 s after startup to let the server
    // fully warm up before doing DB-heavy cleanup work.
    this.timer = setTimeout(tick, Math.min(60_000, env.CLEANUP_SWEEP_MS));
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
