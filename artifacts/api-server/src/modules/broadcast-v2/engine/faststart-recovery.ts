/**
 * Faststart recovery worker — background sweep to ensure every locally-uploaded
 * MP4 has its moov atom relocated to the front before it enters the broadcast.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The upload finalize path runs faststart inline (within its background task)
 * and gates the broadcast queue on `faststartApplied = true`.  But two failure
 * modes can leave videos stuck without faststart:
 *
 *   1. Server crash / SIGTERM mid-finalize: the process was killed while
 *      faststart was running.  `transcodingStatus` is left at 'processing'.
 *
 *   2. Old uploads: videos uploaded before this feature was enabled have
 *      `faststartApplied = false` and `transcodingStatus = 'ready'` — they
 *      aired as raw MP4 but now need upgrading to guarantee browser/TV/mobile
 *      instant-start behaviour.
 *
 * The recovery worker finds both categories and re-runs faststart on each one,
 * backoff-limited to MAX_ATTEMPTS per video.  After MAX_ATTEMPTS the video is
 * left at `transcodingStatus = 'failed'` with `errorCode = FASTSTART_FAILED`
 * and an alert is logged so an operator can investigate.
 *
 * RETRY CADENCE
 * ─────────────
 * Per-video attempts are persisted in `managed_videos.faststart_attempts` so
 * the backoff survives process restarts.  The sweep runs every SWEEP_INTERVAL_MS
 * and processes up to BATCH_SIZE videos per sweep.
 */

import { and, eq, gt, isNotNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { runFaststart } from "../../transcoder/faststart.service.js";
import { enqueueIfMissing } from "../../broadcast/auto-enqueue.service.js";
import { scheduleVideoValidation } from "../../transcoder/video-validation.service.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { invalidateVideosCatalogCache } from "../../videos/videos.routes.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** How long to wait between recovery sweeps. */
const SWEEP_INTERVAL_MS = 5 * 60_000; // 5 min

/** Max videos processed per sweep cycle to bound CPU/memory usage. */
const BATCH_SIZE = 20;

/** Max faststart attempts before permanently marking a video as failed. */
const MAX_ATTEMPTS = 3;

/**
 * A video stuck in 'processing' for longer than this is considered stale
 * (the process that started it died) and is eligible for recovery.
 */
const PROCESSING_STALE_AFTER_MS = 15 * 60_000; // 15 min

// ── Per-video attempt state ───────────────────────────────────────────────
//
// In addition to the persisted `faststart_attempts` column, we keep an
// in-process cooldown map so rapid retries from multiple sweep cycles don't
// pile up on the same video.

const inProcessCooldown = new Map<string, number>(); // videoId → next eligible retry ms
const IN_PROCESS_COOLDOWN_MS = 2 * 60_000; // 2 min between in-process retries

// ── State ─────────────────────────────────────────────────────────────────

let sweepTimer: NodeJS.Timeout | null = null;
let sweeping = false;

const videos = schema.videosTable;

// ── Recovery sweep ────────────────────────────────────────────────────────

/**
 * Find all videos that need faststart and process them in batches.
 *
 * Three categories:
 *   A. `transcodingStatus = 'processing'` for > PROCESSING_STALE_AFTER_MS
 *      (crash recovery — these were mid-faststart when the process died).
 *   B. `transcodingStatus = 'ready'` AND `faststartApplied = false` AND
 *      `localVideoUrl IS NOT NULL` (old uploads or those that somehow bypassed
 *      the upload-finalize faststart gate).
 *   C. `transcodingStatus = 'none'` AND `faststartApplied = false` AND
 *      `localVideoUrl IS NOT NULL` (finalized uploads where the inline
 *      faststart trigger was never reached — e.g. server restart during
 *      the background assembly task, or pre-feature uploads with a local URL
 *      but no status progression).
 *
 * All categories must have `faststart_attempts < MAX_ATTEMPTS`.
 */
async function doSweep(): Promise<void> {
  if (sweeping) {
    logger.debug("[faststart-recovery] sweep already in progress — skipping");
    return;
  }
  sweeping = true;
  const t0 = Date.now();

  try {
    const staleThreshold = new Date(Date.now() - PROCESSING_STALE_AFTER_MS);

    const candidates = await db
      .select({
        id: videos.id,
        localVideoUrl: videos.localVideoUrl,
        transcodingStatus: videos.transcodingStatus,
        faststartApplied: videos.faststartApplied,
        faststartAttempts: videos.faststartAttempts,
        title: videos.title,
      })
      .from(videos)
      .where(
        and(
          ne(videos.videoSource, "youtube"),
          isNotNull(videos.localVideoUrl),
          eq(videos.faststartApplied, false),
          lte(videos.faststartAttempts, MAX_ATTEMPTS - 1),
          or(
            // Category A: stale 'processing' jobs (crash recovery)
            and(
              eq(videos.transcodingStatus, "processing"),
              lt(videos.updatedAt, staleThreshold),
            ),
            // Category B: 'ready' but not faststart'd (legacy or bypass)
            eq(videos.transcodingStatus, "ready"),
            // Category C: 'none' status with a local URL — finalize completed
            // but the inline faststart trigger was never reached (server crash
            // during background assembly or pre-feature upload).
            eq(videos.transcodingStatus, "none"),
          ),
        ),
      )
      .orderBy(sql`${videos.faststartAttempts} ASC, ${videos.updatedAt} ASC`)
      .limit(BATCH_SIZE);

    if (candidates.length === 0) {
      logger.debug("[faststart-recovery] sweep complete — no candidates");
      return;
    }

    logger.info(
      { count: candidates.length },
      "[faststart-recovery] sweep found candidates — processing",
    );

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of candidates) {
      // In-process cooldown: don't retry the same video more than once per 2 min
      // within a single process lifetime (prevents rapid loop on transient failures).
      const cooldownExpiry = inProcessCooldown.get(row.id) ?? 0;
      if (Date.now() < cooldownExpiry) {
        skipped++;
        continue;
      }
      inProcessCooldown.set(row.id, Date.now() + IN_PROCESS_COOLDOWN_MS);

      // Derive the storage key from the localVideoUrl
      const rawUrl = row.localVideoUrl ?? "";
      const objectKey = rawUrl.startsWith("/")
        ? rawUrl.replace(/^\/(?:api\/(?:v\d+\/)?)?/, "")
        : rawUrl;

      if (!objectKey) {
        logger.warn({ videoId: row.id }, "[faststart-recovery] could not derive objectKey — skipping");
        skipped++;
        continue;
      }

      logger.info(
        {
          videoId: row.id,
          title: row.title,
          transcodingStatus: row.transcodingStatus,
          faststartAttempts: row.faststartAttempts,
          objectKey,
        },
        "[faststart-recovery] running faststart on candidate",
      );

      const result = await runFaststart(row.id, objectKey, { skipStatusUpdate: false });

      if (result.ok) {
        succeeded++;
        logger.info(
          {
            videoId: row.id,
            finalStatus: result.finalStatus,
            durationMs: result.durationMs,
            remuxed: result.remuxed,
          },
          "[faststart-recovery] faststart succeeded — enrolling in broadcast queue",
        );

        // Enroll in broadcast queue now that faststartApplied=true.
        try {
          const enqRes = await enqueueIfMissing({
            videoId: row.id,
            reason: "faststart-recovery-complete",
          });
          if (enqRes.enqueued) {
            logger.info(
              { videoId: row.id, queueItemId: enqRes.queueItemId },
              "[faststart-recovery] video enrolled in broadcast queue",
            );
          }
        } catch (enqErr) {
          logger.warn(
            { err: enqErr, videoId: row.id },
            "[faststart-recovery] enqueueIfMissing failed (non-fatal — queue self-heal will retry)",
          );
        }

        // Notify connected admin tabs and refresh the public catalog cache so
        // TV/mobile clients see the updated transcodingStatus=ready immediately
        // (not after the 30-min catalog TTL).  broadcast-source-upgraded clears
        // the "Applying faststart…" spinner in the admin videos page in real-time.
        void invalidateVideosCatalogCache();
        adminEventBus.push("videos-library-updated", { videoId: row.id, reason: "faststart-recovery-complete" });
        adminEventBus.push("broadcast-source-upgraded", { videoId: row.id, quality: "mp4_faststart" });

        // Schedule comprehensive playback validation now that faststart is confirmed.
        // Fire-and-forget: sets validationStatus='pending' immediately, runs all
        // 9 checks asynchronously without blocking the recovery sweep.
        scheduleVideoValidation(row.id, objectKey, {
          faststartApplied: true,
        });
      } else {
        failed++;
        logger.warn(
          {
            videoId: row.id,
            rootCause: result.rootCause,
            durationMs: result.durationMs,
            actions: result.actions,
          },
          "[faststart-recovery] faststart failed on candidate",
        );

        // If this video has hit MAX_ATTEMPTS, log an alert for operator action.
        const [updated] = await db
          .select({ faststartAttempts: videos.faststartAttempts })
          .from(videos)
          .where(eq(videos.id, row.id))
          .limit(1);
        if ((updated?.faststartAttempts ?? 0) >= MAX_ATTEMPTS) {
          logger.error(
            {
              videoId: row.id,
              title: row.title,
              faststartAttempts: updated?.faststartAttempts,
              rootCause: result.rootCause,
            },
            "[faststart-recovery] VIDEO PERMANENTLY FAILED after max attempts — operator action required",
          );
          // Update error code so admin UI shows FASTSTART_FAILED prominently.
          await db
            .update(videos)
            .set({
              transcodingStatus: "failed",
              transcodingErrorCode: "FASTSTART_FAILED",
              transcodingErrorMessage: `Faststart failed after ${MAX_ATTEMPTS} attempts: ${result.rootCause ?? "unknown error"}`,
            })
            .where(eq(videos.id, row.id))
            .catch((err: unknown) =>
              logger.warn({ err, videoId: row.id }, "[faststart-recovery] failed to persist FASTSTART_FAILED status"),
            );
        }
      }
    }

    logger.info(
      { candidates: candidates.length, succeeded, failed, skipped, sweepMs: Date.now() - t0 },
      "[faststart-recovery] sweep complete",
    );
  } catch (err) {
    logger.warn({ err }, "[faststart-recovery] sweep threw unexpectedly (non-fatal)");
  } finally {
    sweeping = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export const faststartRecoveryWorker = {
  /**
   * Run a single sweep pass immediately (asynchronous — does not block the
   * caller).  Used by the /reload route to ensure in-flight or stale-processing
   * videos are re-examined before the orchestrator reloads the queue.
   */
  async sweep(): Promise<void> {
    await doSweep();
  },

  /**
   * Alias for sweep() kept for call-site compatibility with the /reload route.
   */
  async runSweep(): Promise<void> {
    await doSweep();
  },

  /**
   * Reset the in-process attempt cooldown for a specific video (or all videos
   * when called without arguments), allowing the next sweep to retry immediately.
   * Called by the /reload route after an operator triggers a manual retry.
   */
  resetAttempts(videoId?: string): void {
    if (videoId) {
      inProcessCooldown.delete(videoId);
    } else {
      inProcessCooldown.clear();
    }
  },

  /**
   * Clear the "given up" state for a specific video so it becomes eligible for
   * recovery again.  Used by the admin retry-faststart endpoint.
   */
  clearGivenUp(videoId?: string): void {
    if (videoId) {
      inProcessCooldown.delete(videoId);
    } else {
      inProcessCooldown.clear();
    }
  },

  /**
   * Start the background sweep interval.  Safe to call multiple times — the
   * second call is a no-op if the interval is already running.
   */
  start(intervalMs = SWEEP_INTERVAL_MS): void {
    if (sweepTimer) return;
    // Delay the first sweep by 1 min so it doesn't race with the orchestrator's
    // startup/hydration work but still picks up newly uploaded videos quickly.
    const INITIAL_DELAY_MS = 1 * 60_000;
    sweepTimer = setTimeout(() => {
      void doSweep().catch((err) =>
        logger.warn({ err }, "[faststart-recovery] initial sweep error"),
      );
      sweepTimer = setInterval(() => {
        void doSweep().catch((err) =>
          logger.warn({ err }, "[faststart-recovery] scheduled sweep error"),
        );
      }, intervalMs);
      (sweepTimer as NodeJS.Timeout).unref?.();
    }, INITIAL_DELAY_MS);
    sweepTimer.unref?.();
    logger.info({ intervalMs, initialDelayMs: INITIAL_DELAY_MS }, "[faststart-recovery] worker started");
  },

  /** Stop the background sweep interval. */
  stop(): void {
    if (sweepTimer) {
      clearTimeout(sweepTimer);
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  },
};
