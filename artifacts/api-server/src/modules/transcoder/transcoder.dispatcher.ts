import { and, eq, inArray, lt, lte, or, sql, isNull, count } from "drizzle-orm";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";
import { transcodingQueueDepth, SERVICE_LABELS } from "../../infrastructure/metrics.js";
import { runTranscode, checkFfmpegAvailable } from "./transcoder.service.js";
import { scheduleSourceCleanup } from "./cleanup.service.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { enqueueIfMissing } from "../broadcast/auto-enqueue.service.js";
import { broadcastSignal } from "../network/signal-bus.js";
import { invalidateVideosCatalogCache } from "../videos/videos.routes.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";

const jobs = schema.transcodingJobsTable;
const videos = schema.videosTable;

/**
 * In-process FFmpeg transcoder dispatcher.
 *
 * Polls `transcoding_jobs` for the highest-priority queued (or due-for-
 * retry) row, claims it atomically with UPDATE...RETURNING, runs the
 * ffmpeg pipeline (see ./transcoder.service.ts), and updates the job
 * + the corresponding `managed_videos` row with the resulting HLS
 * master playlist URL.
 *
 * Concurrency model: one job at a time per replica. The atomic claim
 * (UPDATE WHERE id=<picked> AND status='queued' RETURNING *) makes
 * this safe across replicas — a second worker that races us will see
 * zero rows returned and try again on the next tick.
 *
 * Failure handling:
 *   - On error, increment `attempts`. If attempts < maxAttempts the
 *     row goes back to 'queued' with an exponential `next_retry_at`.
 *   - When attempts >= maxAttempts the row is flipped to 'failed' and
 *     the matching managed_videos row is marked transcoding_status='failed'.
 */
class TranscoderDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  start(): void {
    if (this.timer) return;
    this.stopped = false;

    // Any job left in 'processing' was orphaned when the previous server
    // process died (its FFmpeg child was killed with it). Reset them back
    // to 'queued' immediately so they retry on the next poll tick.
    // Fire-and-forget is safe: first tick is delayed by TRANSCODER_POLL_MS
    // (10 s) so the reset always completes before a new job is claimed.
    void this.resetOrphanedJobs();

    // Purge any leftover scratch directories from a previous process that
    // was SIGKILL-ed (the finally block in runTranscode never ran). Each
    // job gets its own subdirectory under scratchRoot named by jobId so
    // we can safely remove all subdirectories older than 1 hour without
    // touching anything belonging to a job in-flight in another replica.
    void this.purgeOrphanedScratchDirs();

    this.timer = setTimeout(() => this.tick(), env.TRANSCODER_POLL_MS);
    logger.info({ pollMs: env.TRANSCODER_POLL_MS }, "transcoder dispatcher started");

    // Verify the ffmpeg binary is reachable so we surface a clear error
    // immediately at startup rather than silently failing on every job.
    void checkFfmpegAvailable().then((available) => {
      if (!available) {
        logger.error(
          "transcoder: CRITICAL — ffmpeg binary not found or not executable. " +
          "Every transcoding job will fail until ffmpeg is installed. " +
          "Fix: apt-get install ffmpeg  (or set TRANSCODER_DISABLE=1 to suppress this message).",
        );
      } else {
        logger.info("transcoder: ffmpeg binary confirmed available ✓");
      }
    });
  }

  private async purgeOrphanedScratchDirs(): Promise<void> {
    try {
      const scratchRoot = env.TRANSCODER_SCRATCH_DIR ?? path.join(os.tmpdir(), "transcoder");
      let entries: string[];
      try {
        entries = await readdir(scratchRoot);
      } catch {
        return; // root doesn't exist yet — nothing to clean
      }
      const cutoffMs = Date.now() - 3_600_000; // 1 hour
      let removed = 0;
      for (const entry of entries) {
        const full = path.join(scratchRoot, entry);
        try {
          const s = await stat(full);
          if (s.isDirectory() && s.mtimeMs < cutoffMs) {
            await rm(full, { recursive: true, force: true });
            removed++;
          }
        } catch {
          // ignore — may have been cleaned by a parallel replica
        }
      }
      if (removed > 0) {
        logger.info({ removed, scratchRoot }, "transcoder: purged orphaned scratch directories on startup");
      }
    } catch (err) {
      logger.warn({ err }, "transcoder: scratch dir GC failed on startup (non-fatal)");
    }
  }

  private async resetOrphanedJobs(): Promise<void> {
    try {
      const reset = await db
        .update(jobs)
        .set({
          status: "queued",
          progress: 0,
          startedAt: null,
          errorMessage: "Reset: server restarted while job was in-progress (FFmpeg process orphaned).",
        })
        .where(eq(jobs.status, "processing"))
        .returning({ id: jobs.id, videoId: jobs.videoId });

      if (reset.length > 0) {
        const videoIds = reset.map((r) => r.videoId);
        await db.update(videos)
          .set({ transcodingStatus: "queued" })
          .where(inArray(videos.id, videoIds));

        logger.warn(
          { count: reset.length, jobIds: reset.map((r) => r.id) },
          "transcoder: reset orphaned processing jobs on startup",
        );

        for (const r of reset) {
          adminEventBus.push("transcoding-update", {
            videoId: r.videoId,
            jobId: r.id,
            status: "queued",
            progress: 0,
          });
        }
      }
    } catch (err) {
      logger.error({ err }, "transcoder: failed to reset orphaned jobs on startup (non-fatal)");
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("transcoder dispatcher stopped");
  }

  /**
   * Shared tick used by start() and nudge(). Runs one dispatch cycle then
   * re-arms the timer at the normal TRANSCODER_POLL_MS cadence.
   */
  private tick(): void {
    if (this.stopped) return;
    void this.runOnce().finally(() => {
      if (this.stopped) return;
      this.timer = setTimeout(() => this.tick(), env.TRANSCODER_POLL_MS);
    });
  }

  /**
   * Immediately trigger a dispatch cycle without waiting for the next poll
   * timer. Safe to call from any context — if a job is already running the
   * call is a no-op (runOnce() guards with `this.running`). Cancels any
   * pending timer and re-arms after the immediate run so the regular cadence
   * is preserved.
   *
   * Call this whenever a new transcoding job is enqueued so HLS encoding
   * starts within milliseconds of the job being created rather than waiting
   * up to TRANSCODER_POLL_MS (10 s) for the next scheduled tick.
   */
  nudge(): void {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.tick();
  }

  /**
   * Periodically resets jobs that are stuck in "processing" beyond the
   * configured job timeout. This is a belt-and-suspenders guard for
   * long-running production deployments — resetOrphanedJobs only fires
   * on startup, but a job can theoretically outlive its SIGKILL window
   * (e.g. SIGKILL was swallowed, or a server crash race left the DB row
   * in "processing" while this.running was never set again).
   *
   * Resets to "queued" rather than "failed" so the job retries normally.
   * The 5-minute grace period beyond TRANSCODER_JOB_TIMEOUT_MS prevents
   * false resets when the job is legitimately finishing its final upload.
   */
  private async resetStuckJobs(): Promise<void> {
    try {
      const stuckCutoff = new Date(
        Date.now() - (env.TRANSCODER_JOB_TIMEOUT_MS + 5 * 60_000),
      );
      const reset = await db
        .update(jobs)
        .set({
          status: "queued",
          progress: 0,
          startedAt: null,
          errorMessage: "Reset: job exceeded processing timeout — periodic stuck-job watchdog.",
        })
        .where(
          and(
            eq(jobs.status, "processing"),
            lt(jobs.startedAt, stuckCutoff),
          ),
        )
        .returning({ id: jobs.id, videoId: jobs.videoId });

      if (reset.length > 0) {
        const videoIds = reset.map((r) => r.videoId);
        await db
          .update(videos)
          .set({ transcodingStatus: "queued" })
          .where(inArray(videos.id, videoIds));

        logger.warn(
          { count: reset.length, jobIds: reset.map((r) => r.id) },
          "transcoder: periodic watchdog reset stuck processing jobs",
        );
        for (const r of reset) {
          adminEventBus.push("transcoding-update", {
            videoId: r.videoId,
            jobId: r.id,
            status: "queued",
            progress: 0,
          });
        }
      }
    } catch (err) {
      logger.warn({ err }, "transcoder: stuck-job watchdog error (non-fatal)");
    }
  }

  async runOnce(): Promise<{ ran: boolean }> {
    if (this.running) return { ran: false };
    this.running = true;
    try {
      // Run the stuck-job watchdog on every tick to recover jobs that somehow
      // outlived their timeout in a long-running production process.
      await this.resetStuckJobs();

      const now = new Date();

      // Sample and publish queue depth before claiming a job.
      db.select({ total: count() })
        .from(jobs)
        .where(eq(jobs.status, "queued"))
        .then(([row]) => {
          transcodingQueueDepth.set(SERVICE_LABELS, row?.total ?? 0);
        })
        .catch(() => { /* non-fatal metric skip */ });

      const candidates = await db
        .select()
        .from(jobs)
        .where(and(
          eq(jobs.status, "queued"),
          or(isNull(jobs.nextRetryAt), lte(jobs.nextRetryAt, now)),
        ))
        .orderBy(sql`${jobs.priority} desc`, sql`${jobs.createdAt} asc`)
        .limit(1);

      const candidate = candidates[0];
      if (!candidate) return { ran: false };

      // Atomic claim — race-safe across replicas.
      const claimed = await db
        .update(jobs)
        .set({ status: "processing", startedAt: now, progress: 0, errorMessage: null })
        .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "queued")))
        .returning();

      const job = claimed[0];
      if (!job) return { ran: false };

      await db.update(videos)
        .set({ transcodingStatus: "encoding" })
        .where(eq(videos.id, job.videoId));

      adminEventBus.push("transcoding-update", {
        videoId: job.videoId,
        jobId: job.id,
        status: "encoding",
        progress: 0,
      });

      logger.info({ jobId: job.id, videoId: job.videoId, attempt: job.attempts + 1 }, "transcoder: starting job");

      let lastProgressUpdate = Date.now();

      try {
        const result = await runTranscode({
          jobId: job.id,
          videoId: job.videoId,
          sourceObjectKey: job.videoPath,
          onProgress: async (pct) => {
            const now = Date.now();
            if (now - lastProgressUpdate < 5000 && pct < 100) return;
            lastProgressUpdate = now;
            await db.update(jobs).set({ progress: pct }).where(eq(jobs.id, job.id)).catch((err) => {
              logger.warn({ err, jobId: job.id, pct }, "transcoder: progress update failed (non-fatal)");
            });
          },
        });

        // ── HLS output integrity check ────────────────────────────────────────
        // Verify the master playlist actually landed in storage before committing
        // hls_ready. A partial DB write failure in uploadDirRecursive would leave
        // the job showing "done" but the master.m3u8 missing — every player would
        // 404. Throwing here causes a normal retry which regenerates HLS from scratch.
        const masterKey = `transcoded/${job.videoId}/master.m3u8`;
        const masterExists = await db
          .execute(sql`SELECT 1 FROM storage_blobs WHERE key = ${masterKey} LIMIT 1`)
          .then((r) => (r.rows as unknown[]).length > 0)
          .catch(() => false);
        if (!masterExists) {
          throw new Error(
            `transcoder: HLS integrity check failed — master.m3u8 not found in storage ` +
            `(key=${masterKey}). FFmpeg exited 0 but the manifest was not stored. ` +
            `Retrying will regenerate HLS output.`,
          );
        }

        await db.update(jobs)
          .set({
            status: "done",
            progress: 100,
            completedAt: new Date(),
            errorMessage: null,
          })
          .where(eq(jobs.id, job.id));

        const durationSecsStr = result.durationSecs ? String(Math.round(result.durationSecs)) : undefined;
        await db.update(videos)
          .set({
            transcodingStatus: "hls_ready",
            hlsMasterUrl: result.masterPlaylistUrl,
            ...(durationSecsStr ? { duration: durationSecsStr } : {}),
            // Only update thumbnailUrl when the transcoder produced one — avoids
            // wiping any thumbnail that was set by a previous import/manual edit.
            ...(result.thumbnailUrl ? { thumbnailUrl: result.thumbnailUrl } : {}),
          })
          .where(eq(videos.id, job.videoId));

        // Sync the real duration to any broadcast_queue rows that reference
        // this video. The queue row is written at upload-finalize time with
        // a 1800-second placeholder (before ffprobe runs); this corrects it
        // so the orchestrator's cycle timing matches the actual video length.
        if (result.durationSecs && result.durationSecs > 10) {
          const roundedDuration = Math.round(result.durationSecs);
          await db
            .update(schema.broadcastQueueTable)
            .set({ durationSecs: roundedDuration })
            .where(eq(schema.broadcastQueueTable.videoId, job.videoId))
            .catch((err) => {
              logger.warn(
                { err, videoId: job.videoId, durationSecs: roundedDuration },
                "transcoder: broadcast_queue duration sync failed (non-fatal)",
              );
            });
        }

        adminEventBus.push("transcoding-update", {
          videoId: job.videoId,
          jobId: job.id,
          status: "hls_ready",
          progress: 100,
          hlsMasterUrl: result.masterPlaylistUrl,
        });

        // Notify all connected clients that the video library has been updated
        // now that HLS is ready. TV/web pick this up via the SSE sidecar
        // (videos-library-updated event); mobile picks it up via the WS
        // library-updated frame — closing the EventSource gap on React Native.
        adminEventBus.push("videos-library-updated", { videoId: job.videoId, reason: "hls-ready" });

        // Notify the v2 broadcast orchestrator to switch from the raw MP4 fallback
        // to the newly-available HLS stream. loadActive() already admits items in
        // 'queued' and 'encoding' states so they broadcast from localVideoUrl
        // during the transcoding window. This push triggers an orchestrator reload
        // so it immediately picks up hlsMasterUrl and serves adaptive HLS to every
        // connected client without waiting for a manual queue mutation.
        adminEventBus.push("broadcast-queue-updated", { reason: "hls-ready", videoId: job.videoId });

        // Safety-net enqueue: if this video somehow never made it into the
        // broadcast queue (e.g. faststart was skipped, the server restarted
        // during the upload pipeline, or the video was imported without going
        // through the normal upload flow), add it now. HLS is confirmed ready
        // so isPlayableForBroadcast() will pass and enqueueIfMissing inserts
        // the row immediately. Idempotent — no-ops if already queued.
        void enqueueIfMissing({ videoId: job.videoId, reason: "upload-finalize" }).then((res) => {
          if (res.enqueued) {
            logger.info(
              { videoId: job.videoId, queueItemId: res.queueItemId },
              "transcoder: safety-net auto-enqueued video after HLS completion",
            );
          }
        }).catch(() => { /* non-fatal — orchestrator self-heal covers this case */ });

        logger.info({
          jobId: job.id,
          videoId: job.videoId,
          elapsedMs: result.elapsedMs,
          totalBytes: result.totalBytes,
          renditions: result.renditions.length,
          masterUrl: result.masterPlaylistUrl,
          thumbnailUrl: result.thumbnailUrl ?? null,
        }, "transcoder: job done");

        // Bust the public video catalogue cache so the next GET /api/videos
        // reflects the updated hlsMasterUrl without waiting for the TTL.
        void invalidateVideosCatalogCache();

        // Reload the broadcast engine so it picks up the freshly-stored
        // hlsMasterUrl immediately — without this the engine's in-memory
        // snapshot keeps the old null hlsMasterUrl until the next admin
        // queue mutation, meaning every connected TV/mobile client would
        // continue receiving the raw MP4 fallback URL even though HLS is ready.
        try {
          await broadcastEngine.reload();
          broadcastSignal("PROGRAM_CHANGED", "temple-tv-live", {
            message: `HLS ready for videoId ${job.videoId}`,
            payload: { videoId: job.videoId },
          });
          logger.info({ videoId: job.videoId }, "transcoder: broadcast engine reloaded after HLS ready");
        } catch (reloadErr) {
          // Non-fatal: the engine will pick up the new URL on the next
          // scheduled reload or admin action.
          logger.warn({ reloadErr, videoId: job.videoId }, "transcoder: broadcast engine reload failed (non-fatal)");
        }

        // Schedule post-transcode source blob cleanup. Validates that HLS
        // segments are intact, then deletes the raw source blob after the
        // configurable retention window (CLEANUP_RETENTION_HOURS). This
        // frees significant DB storage (raw 1080p sermons can be 4–8 GiB).
        void scheduleSourceCleanup(job.videoId, job.videoPath ?? null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const attempts = job.attempts + 1;
        const exceeded = attempts >= job.maxAttempts;
        const backoffMs = Math.min(60_000 * 2 ** attempts, 30 * 60_000);
        const nextRetry = new Date(Date.now() + backoffMs);

        await db.update(jobs)
          .set({
            status: exceeded ? "failed" : "queued",
            attempts,
            progress: 0,
            errorMessage: message,
            nextRetryAt: exceeded ? null : nextRetry,
            completedAt: exceeded ? new Date() : null,
            startedAt: null,
          })
          .where(eq(jobs.id, job.id));

        await db.update(videos)
          .set({ transcodingStatus: exceeded ? "failed" : "queued" })
          .where(eq(videos.id, job.videoId));

        adminEventBus.push("transcoding-update", {
          videoId: job.videoId,
          jobId: job.id,
          status: exceeded ? "failed" : "queued",
          progress: 0,
          errorMessage: message,
          willRetry: !exceeded,
          nextRetryAt: exceeded ? null : nextRetry.toISOString(),
        });

        logger.error({
          err,
          jobId: job.id,
          videoId: job.videoId,
          attempts,
          maxAttempts: job.maxAttempts,
          willRetry: !exceeded,
          nextRetryAt: exceeded ? null : nextRetry.toISOString(),
        }, "transcoder: job failed");
      }

      return { ran: true };
    } finally {
      this.running = false;
    }
  }
}

export const transcoderDispatcher = new TranscoderDispatcher();
