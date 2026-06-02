import { and, eq, inArray, lt, lte, ne, or, sql, isNull, count } from "drizzle-orm";
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

  /**
   * FFmpeg circuit breaker.
   *
   * When ffmpeg is unavailable `ffmpegAvailable` is set to false and all job
   * dispatch is paused — preventing every queued video from exhausting its
   * retry budget against a missing binary and being permanently failed.
   *
   * A background re-check fires every FFMPEG_RECHECK_MS until ffmpeg is
   * confirmed reachable, then the circuit closes automatically.
   */
  private ffmpegAvailable = true;
  private ffmpegRecheckTimer: NodeJS.Timeout | null = null;
  private static readonly FFMPEG_RECHECK_MS = 30_000;

  /**
   * Storage circuit breaker.
   *
   * When consecutive storage/DB writes fail (e.g. Postgres connection lost,
   * object-store unreachable), job dispatch is temporarily paused so healthy
   * queued jobs don't burn through their retry budgets against a transient
   * infrastructure outage. The circuit re-closes after STORAGE_REOPEN_DELAY_MS.
   *
   * Tracking: `storageErrorStreak` counts consecutive jobs that fail with a
   * storage-flavoured error. Once it hits STORAGE_ERROR_THRESHOLD the circuit
   * opens. Any successful job resets the streak to 0.
   */
  private storageErrorStreak = 0;
  private storageCircuitOpenUntil = 0;
  private static readonly STORAGE_ERROR_THRESHOLD = 3;
  private static readonly STORAGE_REOPEN_DELAY_MS = 60_000; // 1 min cool-down

  /**
   * Open the ffmpeg circuit breaker. Logs a CRITICAL warning and schedules
   * periodic re-checks so the dispatcher self-heals when ffmpeg is installed.
   */
  private openFfmpegCircuit(): void {
    if (!this.ffmpegAvailable) return; // already open
    this.ffmpegAvailable = false;
    logger.error(
      "transcoder: CRITICAL — ffmpeg binary not found or not executable. " +
      "Job dispatch is PAUSED to prevent burning through retry budgets on every job. " +
      "Fix: install ffmpeg (e.g. apt-get install ffmpeg). " +
      "The dispatcher will recover automatically once ffmpeg is available.",
    );
    const scheduleRecheck = (): void => {
      if (this.stopped) return;
      this.ffmpegRecheckTimer = setTimeout(() => {
        void checkFfmpegAvailable().then((available) => {
          if (available) {
            this.ffmpegAvailable = true;
            this.ffmpegRecheckTimer = null;
            logger.info(
              "transcoder: ffmpeg binary restored — circuit CLOSED, job dispatch resumed ✓",
            );
          } else {
            scheduleRecheck();
          }
        }).catch(() => scheduleRecheck());
      }, TranscoderDispatcher.FFMPEG_RECHECK_MS);
      this.ffmpegRecheckTimer?.unref?.();
    };
    scheduleRecheck();
  }

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
    // If unavailable, the circuit breaker opens and job dispatch pauses
    // until ffmpeg becomes reachable (checked every FFMPEG_RECHECK_MS).
    void checkFfmpegAvailable().then((available) => {
      if (!available) {
        this.openFfmpegCircuit();
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
        logger.info({ removed, scratchRoot }, "transcoder: purged orphaned scratch directories");
      }
    } catch (err) {
      logger.warn({ err }, "transcoder: scratch dir GC failed (non-fatal)");
    }
  }

  // Scratch dir GC sweep counter — runs every SCRATCH_GC_TICKS ticks
  // (roughly every 30 minutes at the default 10-second poll cadence).
  private scratchGcCounter = 0;
  private static readonly SCRATCH_GC_TICKS = 180; // ~30 min at 10 s/tick

  // ── In-process heartbeat ────────────────────────────────────────────────────
  // Written on every dispatch tick so the diagnostics panel can surface
  // real-time transcoder state without a DB round-trip.
  private lastHeartbeatAt: number | null = null;
  private currentJobId: string | null = null;
  private currentJobVideoId: string | null = null;
  private lastCompletedAt: number | null = null;
  private lastCompletedJobId: string | null = null;
  private lastCompletedStatus: "done" | "failed" | null = null;

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

      // Reset videos stuck in "processing" with no backing transcoding_job.
      // These were orphaned by faststart (which sets transcodingStatus="processing"
      // directly, without a transcoding_job row) when the server was killed mid-run.
      // After the transcoding_jobs reset above, any video still at "processing"
      // has no active job — safe to reset to "queued" (source blob is intact).
      const faststartOrphans = await db
        .select({ id: videos.id })
        .from(videos)
        .where(eq(videos.transcodingStatus, "processing"))
        .limit(100);
      if (faststartOrphans.length > 0) {
        const orphanIds = faststartOrphans.map((r) => r.id);
        await db.update(videos)
          .set({ transcodingStatus: "queued" })
          .where(inArray(videos.id, orphanIds));
        logger.warn(
          { count: faststartOrphans.length },
          "transcoder: reset faststart-orphaned videos stuck in 'processing' on startup",
        );
      }

      // ── Partial-success recovery ──────────────────────────────────────────
      // Covers the crash window between the two writes in runOnce():
      //   1. UPDATE transcoding_jobs SET status='done'   ← succeeded
      //   2. UPDATE managed_videos SET transcodingStatus='hls_ready' ← lost
      //
      // After a restart, the video is stuck at "encoding" forever (it never
      // re-enters the dispatch loop because the job is "done"). Recover by
      // verifying that master.m3u8 actually landed in storage and then
      // completing the video-row update that was lost.
      const encodingVideoIds = await db
        .select({ id: videos.id })
        .from(videos)
        .where(eq(videos.transcodingStatus, "encoding"))
        .then((rows) => rows.map((r) => r.id));

      if (encodingVideoIds.length > 0) {
        const doneJobs = await db
          .select({ videoId: jobs.videoId, id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.status, "done"), inArray(jobs.videoId, encodingVideoIds)));

        for (const job of doneJobs) {
          try {
            const masterKey = `transcoded/${job.videoId}/master.m3u8`;
            const masterExists = await db
              .execute(sql`SELECT 1 FROM storage_blobs WHERE key = ${masterKey} LIMIT 1`)
              .then((r) => (r.rows as unknown[]).length > 0)
              .catch(() => false);

            if (masterExists) {
              const masterUrl = `/api/hls/${job.videoId}/master.m3u8`;
              await db.update(videos)
                .set({ transcodingStatus: "hls_ready", hlsMasterUrl: masterUrl })
                .where(eq(videos.id, job.videoId));
              logger.warn(
                { videoId: job.videoId, jobId: job.id, masterUrl },
                "transcoder: recovered partial-success video — job was 'done' but video was stuck at 'encoding'. " +
                "Applied missing hls_ready update.",
              );
              adminEventBus.push("transcoding-update", {
                videoId: job.videoId,
                jobId: job.id,
                status: "hls_ready",
                progress: 100,
                hlsMasterUrl: masterUrl,
              });
            }
          } catch (recErr) {
            logger.warn(
              { err: recErr, videoId: job.videoId, jobId: job.id },
              "transcoder: partial-success recovery check failed (non-fatal)",
            );
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "transcoder: failed to reset orphaned jobs on startup (non-fatal)");
    }
  }

  getHeartbeat(): {
    lastHeartbeatAt: number | null;
    currentJobId: string | null;
    currentJobVideoId: string | null;
    lastCompletedAt: number | null;
    lastCompletedJobId: string | null;
    lastCompletedStatus: "done" | "failed" | null;
    isRunning: boolean;
    ffmpegAvailable: boolean;
    stopped: boolean;
    storageCircuitOpenUntil: number;
    storageErrorStreak: number;
    circuitOpen: boolean;
    circuitOpenRemainingMs: number | null;
  } {
    const now = Date.now();
    const circuitOpen = this.storageCircuitOpenUntil > now;
    return {
      lastHeartbeatAt: this.lastHeartbeatAt,
      currentJobId: this.currentJobId,
      currentJobVideoId: this.currentJobVideoId,
      lastCompletedAt: this.lastCompletedAt,
      lastCompletedJobId: this.lastCompletedJobId,
      lastCompletedStatus: this.lastCompletedStatus,
      isRunning: this.running,
      ffmpegAvailable: this.ffmpegAvailable,
      stopped: this.stopped,
      storageCircuitOpenUntil: this.storageCircuitOpenUntil,
      storageErrorStreak: this.storageErrorStreak,
      circuitOpen,
      circuitOpenRemainingMs: circuitOpen ? this.storageCircuitOpenUntil - now : null,
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ffmpegRecheckTimer) {
      clearTimeout(this.ffmpegRecheckTimer);
      this.ffmpegRecheckTimer = null;
    }
    logger.info("transcoder dispatcher stopped");
  }

  /**
   * Shared tick used by start() and nudge(). Runs one dispatch cycle then
   * re-arms the timer at the normal TRANSCODER_POLL_MS cadence.
   */
  private tick(): void {
    if (this.stopped) return;
    // Stamp liveness on every scheduler cycle — including idle ticks where no
    // job is claimed — so getHeartbeat() accurately reflects that the dispatcher
    // is alive even when the queue is empty.
    this.lastHeartbeatAt = Date.now();
    void this.runOnce().catch((err) => {
      logger.warn({ err }, "transcoder: unhandled runOnce error — will retry on next tick");
    }).finally(() => {
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
   * Unlike resetOrphanedJobs (startup-only reset), this watchdog INCREMENTS
   * the attempts counter on each reset. Jobs that exceed maxAttempts via
   * repeated timeouts are permanently failed rather than looping forever.
   * The 5-minute grace period beyond TRANSCODER_JOB_TIMEOUT_MS prevents
   * false resets when the job is legitimately finishing its final upload.
   */
  private async resetStuckJobs(): Promise<void> {
    try {
      const stuckCutoff = new Date(
        Date.now() - (env.TRANSCODER_JOB_TIMEOUT_MS + 5 * 60_000),
      );

      // Find stuck jobs first (read-only).
      const stuckJobs = await db
        .select({
          id: jobs.id,
          videoId: jobs.videoId,
          attempts: jobs.attempts,
          maxAttempts: jobs.maxAttempts,
        })
        .from(jobs)
        .where(
          and(
            eq(jobs.status, "processing"),
            lt(jobs.startedAt, stuckCutoff),
          ),
        );

      if (stuckJobs.length === 0) return;

      const resetResults: Array<{ id: string; videoId: string; failed: boolean }> = [];

      for (const stuck of stuckJobs) {
        const newAttempts = stuck.attempts + 1;
        const exceeded = newAttempts >= stuck.maxAttempts;
        const timeoutMinutes = Math.round(env.TRANSCODER_JOB_TIMEOUT_MS / 60_000);

        // Atomic claim: only update if still "processing" (multi-replica safe).
        const claimed = await db
          .update(jobs)
          .set({
            status: exceeded ? "failed" : "queued",
            progress: 0,
            attempts: newAttempts,
            startedAt: null,
            completedAt: exceeded ? new Date() : null,
            errorMessage: exceeded
              ? `Job permanently failed after ${newAttempts} timeout(s). ` +
                `Exceeded ${timeoutMinutes}-minute processing limit on every attempt — operator review required.`
              : `Watchdog reset (attempt ${newAttempts}/${stuck.maxAttempts}): ` +
                `job exceeded ${timeoutMinutes}-minute processing limit — re-queuing for retry.`,
          })
          .where(and(eq(jobs.id, stuck.id), eq(jobs.status, "processing")))
          .returning({ id: jobs.id });

        if (claimed.length > 0) {
          resetResults.push({ id: stuck.id, videoId: stuck.videoId, failed: exceeded });
        }
      }

      if (resetResults.length === 0) return;

      const failedVideoIds = resetResults.filter((r) => r.failed).map((r) => r.videoId);
      const requeuedVideoIds = resetResults.filter((r) => !r.failed).map((r) => r.videoId);

      if (failedVideoIds.length > 0) {
        await db.update(videos).set({ transcodingStatus: "failed" }).where(inArray(videos.id, failedVideoIds));
      }
      if (requeuedVideoIds.length > 0) {
        // Guard: never revert a video that has already reached hls_ready
        // (e.g. completed by a concurrent replica between the stuck-job scan
        // and this update). Without the guard a stuck-job watchdog cycle could
        // downgrade a finished video back to "queued" and re-transcode it.
        await db.update(videos)
          .set({ transcodingStatus: "queued" })
          .where(and(inArray(videos.id, requeuedVideoIds), ne(videos.transcodingStatus, "hls_ready")));
      }

      logger.warn(
        {
          total: resetResults.length,
          failed: failedVideoIds.length,
          requeued: requeuedVideoIds.length,
          jobIds: resetResults.map((r) => r.id),
        },
        "transcoder: periodic watchdog reset stuck processing jobs",
      );

      for (const r of resetResults) {
        adminEventBus.push("transcoding-update", {
          videoId: r.videoId,
          jobId: r.id,
          status: r.failed ? "failed" : "queued",
          progress: 0,
        });
      }
    } catch (err) {
      logger.warn({ err }, "transcoder: stuck-job watchdog error (non-fatal)");
    }
  }

  async runOnce(): Promise<{ ran: boolean }> {
    if (this.running) return { ran: false };
    // Circuit open — ffmpeg unavailable. Pause dispatch to preserve every
    // job's retry budget. The openFfmpegCircuit() re-check loop closes the
    // circuit automatically when ffmpeg becomes reachable again.
    if (!this.ffmpegAvailable) return { ran: false };
    // Storage circuit open — pause dispatch during transient Postgres/storage
    // outages so healthy jobs don't burn retries against an infrastructure
    // failure that will resolve on its own within the cool-down window.
    if (this.storageCircuitOpenUntil > Date.now()) return { ran: false };
    this.running = true;
    try {
      // Run the stuck-job watchdog on every tick to recover jobs that somehow
      // outlived their timeout in a long-running production process.
      await this.resetStuckJobs();

      // Periodic scratch directory GC (~every 30 min at 10 s/tick) so stale
      // dirs from SIGKILL-orphaned processes don't accumulate between restarts
      // in long-running production deployments.
      this.scratchGcCounter++;
      if (this.scratchGcCounter >= TranscoderDispatcher.SCRATCH_GC_TICKS) {
        this.scratchGcCounter = 0;
        void this.purgeOrphanedScratchDirs();
      }

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

      this.lastHeartbeatAt = Date.now();
      this.currentJobId = job.id;
      this.currentJobVideoId = job.videoId;

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

        // ── Storage circuit breaker: reset streak on success ───────────────
        this.storageErrorStreak = 0;
        this.lastCompletedAt = Date.now();
        this.lastCompletedJobId = job.id;
        this.lastCompletedStatus = "done";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errCode = (err as NodeJS.ErrnoException).code;

        // ENOSPC / EDQUOT: disk-full errors are non-retryable — no amount of
        // waiting will free disk space. Immediately mark the job "failed" without
        // burning any retry slots, and emit a high-severity log so operators
        // know they need to free storage before re-queuing.
        const isDiskFull = errCode === "ENOSPC" || errCode === "EDQUOT";

        // CORRUPT_SOURCE: the source video file is structurally unrecoverable.
        // Retrying the same corrupt blob will produce the same failure every time —
        // the operator must re-upload from the original source. Like ENOSPC, we
        // immediately mark the job failed without burning any retry slots.
        //
        // Detection layers (in order of reliability):
        //   1. error.code === "CORRUPT_SOURCE" — set by runTranscode when
        //      detectMdatWithoutMoov() returns true or all remux strategies fail.
        //   2. Message pattern match — catch corruption errors that propagate
        //      without a typed code (e.g. from FFmpeg stderr via the remux path,
        //      or from the early-gate probe running inside the transcoder).
        const corruptSourcePattern =
          /moov atom not found|NO moov atom|unrecoverable|unrepairable|structurally corrupt|corrupt.*re-upload|re-upload.*corrupt|invalid data found when processing|output file is empty.*encoded|no streams were found/i;
        const isCorruptSource =
          errCode === "CORRUPT_SOURCE" || corruptSourcePattern.test(message);

        // ── Storage circuit breaker: detect Postgres/storage outage ────────
        // Infrastructure errors (connection refused, broken pipe, DB pool timeout)
        // are transient and will resolve without operator action. Count consecutive
        // such failures; once the threshold is hit, pause dispatch for
        // STORAGE_REOPEN_DELAY_MS so the outage can recover before more jobs burn
        // their retry budgets. Any successful job resets the streak.
        const isStorageError = !isDiskFull && (
          errCode === "ECONNREFUSED" ||
          errCode === "ECONNRESET" ||
          errCode === "ETIMEDOUT" ||
          errCode === "EPIPE" ||
          (message.includes("Connection terminated") ||
           message.includes("pool") ||
           message.includes("ECONNREFUSED") ||
           message.includes("connection refused"))
        );
        if (isStorageError) {
          this.storageErrorStreak++;
          if (this.storageErrorStreak >= TranscoderDispatcher.STORAGE_ERROR_THRESHOLD) {
            this.storageCircuitOpenUntil = Date.now() + TranscoderDispatcher.STORAGE_REOPEN_DELAY_MS;
            this.storageErrorStreak = 0;
            logger.error(
              { errCode, message, cooldownMs: TranscoderDispatcher.STORAGE_REOPEN_DELAY_MS },
              "transcoder: storage outage detected — dispatch PAUSED for 60 s to protect job retry budgets",
            );
          }
        } else {
          this.storageErrorStreak = 0; // non-storage error → reset streak
        }

        // Neither disk-full nor corrupt-source should burn through retry slots —
        // waiting and retrying the same broken input is pointless.
        const isImmediateFail = isDiskFull || isCorruptSource;
        const attempts = job.attempts + (isImmediateFail ? 0 : 1);
        const exceeded = isImmediateFail || attempts >= job.maxAttempts;
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

        // Truncate error message to 2000 chars to avoid DB bloat from FFmpeg
        // stderr dumps. The full error is always in application logs.
        const truncatedMessage = message.slice(0, 2000);
        await db.update(videos)
          .set({
            transcodingStatus: exceeded ? "failed" : "queued",
            // Write failure reason and machine-readable code to managed_videos so:
            //   (a) admin UI can show WHY a video failed without joining transcoding_jobs.
            //   (b) auto-enqueue can exclude CORRUPT_SOURCE videos without regex-matching.
            //   (c) retryAllFailed() can skip permanently-unrecoverable jobs.
            // Only set on terminal failure — cleared on re-queue via enqueueTranscode.
            ...(exceeded ? {
              transcodingErrorMessage: truncatedMessage,
              transcodingErrorCode: isCorruptSource ? "CORRUPT_SOURCE" : isDiskFull ? "DISK_FULL" : null,
            } : {}),
          })
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

        // When a job permanently fails, push broadcast-queue-updated so the
        // orchestrator immediately reloads (250 ms debounce) and the queue
        // integrity validator runs (3 s debounce).  Without this, a corrupt or
        // max-attempts-exhausted item stays in the active broadcast rotation for
        // up to 10 minutes — the validator's scheduled interval — burning skip
        // budget on every orchestrator tick and causing unnecessary dead-air.
        // The validator's UNPLAYABLE_CORRUPT_UPLOAD auto-fix deactivates the
        // row within seconds of this push, closing the gap.
        if (exceeded) {
          adminEventBus.push("broadcast-queue-updated", {
            reason: isCorruptSource
              ? "transcoding-corrupt-source"
              : isDiskFull
                ? "transcoding-disk-full"
                : "transcoding-max-attempts",
            videoId: job.videoId,
          });
        }

        if (isCorruptSource) {
          logger.error(
            { err, jobId: job.id, videoId: job.videoId, errCode },
            "transcoder: job permanently failed — source file is corrupt/unrecoverable; " +
              "operator must re-upload from original source",
          );
        } else if (isDiskFull) {
          logger.error({
            err,
            jobId: job.id,
            videoId: job.videoId,
            errCode,
          }, "transcoder: job aborted — disk full (ENOSPC/EDQUOT); free storage and re-queue the video");
        } else {
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
        // Only record a terminal status. A non-exceeded failure re-queues for
        // retry — the job is not done yet, so we leave lastCompletedStatus as
        // whatever the previous terminal value was (or null on first failure).
        if (exceeded) {
          this.lastCompletedAt = Date.now();
          this.lastCompletedJobId = job.id;
          this.lastCompletedStatus = "failed";
        }
      }

      return { ran: true };
    } catch (err) {
      // Reaches here only for pre-claim failures: the candidates SELECT,
      // the atomic UPDATE claim, or the initial video-status write.
      // Job-execution errors are caught by the inner try/catch above.
      // Log and absorb so the tick() caller never sees an unhandled rejection.
      const message = err instanceof Error ? err.message : String(err);
      const errCode = (err as NodeJS.ErrnoException).code;
      const isStorageError =
        errCode === "ECONNREFUSED" ||
        errCode === "ECONNRESET" ||
        errCode === "ETIMEDOUT" ||
        errCode === "EPIPE" ||
        message.includes("Connection terminated") ||
        message.includes("pool") ||
        message.includes("ECONNREFUSED") ||
        message.includes("connection refused") ||
        message.includes("Failed query");
      if (isStorageError) {
        this.storageErrorStreak++;
        if (this.storageErrorStreak >= TranscoderDispatcher.STORAGE_ERROR_THRESHOLD) {
          this.storageCircuitOpenUntil = Date.now() + TranscoderDispatcher.STORAGE_REOPEN_DELAY_MS;
          this.storageErrorStreak = 0;
          logger.error(
            { errCode, message, cooldownMs: TranscoderDispatcher.STORAGE_REOPEN_DELAY_MS },
            "transcoder: storage outage detected (pre-claim) — dispatch PAUSED for 60 s",
          );
        } else {
          logger.warn({ err, errCode }, "transcoder: transient DB error in dispatch pre-claim — will retry");
        }
      } else {
        logger.error({ err }, "transcoder: unexpected pre-claim error — will retry on next tick");
      }
      return { ran: false };
    } finally {
      this.running = false;
      this.currentJobId = null;
      this.currentJobVideoId = null;
    }
  }
}

export const transcoderDispatcher = new TranscoderDispatcher();
