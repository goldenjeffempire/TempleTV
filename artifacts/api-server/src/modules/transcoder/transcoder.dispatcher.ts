import { and, eq, inArray, lt, ne, or, sql, isNull, count } from "drizzle-orm";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";
import {
  transcodingQueueDepth,
  transcoderActiveJobCount,
  transcoderConcurrentJobs,
  transcoderStageDurationMs,
  transcoderDlqDepth,
  transcoderStageTransitionTotal,
  transcoderJobDurationSeconds,
  SERVICE_LABELS,
} from "../../infrastructure/metrics.js";
import { runTranscode, checkFfmpegAvailable } from "./transcoder.service.js";
import { enqueueTranscode } from "./transcoder.queue.js";
import { scheduleSourceCleanup } from "./cleanup.service.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { enqueueIfMissing } from "../broadcast/auto-enqueue.service.js";
import { broadcastSignal } from "../network/signal-bus.js";
import { invalidateVideosCatalogCache } from "../videos/videos.routes.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { workerRegistry } from "./transcoder.worker-registry.js";
import { jobLeaseManager } from "./transcoder.lease.js";
import { emitJobEvent, purgeOldEvents } from "./transcoder.job-events.js";
import { dlqRecoveryWorker } from "./transcoder.dlq-recovery.js";

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
  private leaseReclaimTimer: NodeJS.Timeout | null = null;
  private eventLogPurgeTimer: NodeJS.Timeout | null = null;
  /**
   * Active job IDs currently being processed in concurrent slots.
   * Replaces the old single `running: boolean` flag.
   * Size is bounded by TRANSCODER_MAX_CONCURRENT_JOBS (default 2).
   */
  private activeJobs: Set<string> = new Set();
  private stopped = false;
  /**
   * Set to true only by start(). Guards nudge() so that an explicit
   * TRANSCODER_DISABLE=1 configuration — which skips start() entirely —
   * cannot be bypassed by callers invoking nudge() after a new job is
   * enqueued. Without this flag, stopped=false (the default) would allow
   * nudge() to call tick() and re-arm the poll timer even when the
   * dispatcher was intentionally never started.
   */
  private started = false;
  /** Max concurrent jobs = TRANSCODER_MAX_CONCURRENT_JOBS (validated 1–4). */
  private get maxConcurrent(): number { return env.TRANSCODER_MAX_CONCURRENT_JOBS; }

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
    this.started = true;
    this.stopped = false;

    // Register this worker process in the worker registry so the admin UI
    // can display active workers and the lease reclaimer can identify dead ones.
    void workerRegistry.register();

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

    // Scan /proc for ffmpeg processes left over from a previous server run
    // (SIGKILL bypasses the finally block in runTranscode, leaving orphaned
    // ffmpeg children alive). Only kills processes whose cmdline references
    // our own scratch directory — zero risk of touching unrelated ffmpeg
    // processes that may be running in the same container.
    void this.scanAndKillOrphanedFfmpegProcesses();

    // Lease reclaim timer: periodically reset expired leases from dead workers
    // so their jobs re-enter the queue and are picked up by healthy workers.
    this.leaseReclaimTimer = setInterval(() => {
      void jobLeaseManager.reclaimExpiredLeases(workerRegistry.id).catch((err) => {
        logger.warn({ err }, "transcoder: lease reclaim error (non-fatal)");
      });
      void workerRegistry.pruneStale().catch(() => { /* non-fatal */ });
    }, env.TRANSCODER_LEASE_RECLAIM_INTERVAL_MS);
    this.leaseReclaimTimer.unref();

    // Event log purge: remove events older than 30 days once every 24 h.
    this.eventLogPurgeTimer = setInterval(() => {
      void purgeOldEvents(30).then((n) => {
        if (n > 0) logger.info({ purged: n }, "transcoder: purged old job events");
      }).catch(() => { /* non-fatal */ });
    }, 24 * 3_600_000);
    this.eventLogPurgeTimer.unref();

    this.timer = setTimeout(() => this.tick(), env.TRANSCODER_POLL_MS);
    this.timer.unref();

    // Start the autonomous DLQ recovery worker. It sweeps dead-lettered jobs
    // every DLQ_RECOVERY_INTERVAL_MS (default 30 min) and requeues them on a
    // 3-tier cooldown schedule (4 h → 12 h → 24 h). Terminal error codes
    // (CORRUPT_SOURCE, SOURCE_MISSING) are never auto-requeued.
    dlqRecoveryWorker.start();

    logger.info(
      { pollMs: env.TRANSCODER_POLL_MS, maxConcurrent: this.maxConcurrent, workerId: workerRegistry.id },
      "transcoder dispatcher started",
    );

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
      const results = await Promise.allSettled(
        entries.map(async (entry) => {
          const full = path.join(scratchRoot, entry);
          const s = await stat(full);
          if (s.isDirectory() && s.mtimeMs < cutoffMs) {
            await rm(full, { recursive: true, force: true });
            return 1;
          }
          return 0;
        }),
      );
      const removed = results.reduce(
        (sum, r) => sum + (r.status === "fulfilled" ? r.value : 0),
        0,
      );
      if (removed > 0) {
        logger.info({ removed, scratchRoot }, "transcoder: purged orphaned scratch directories");
      }
    } catch (err) {
      logger.warn({ err }, "transcoder: scratch dir GC failed (non-fatal)");
    }
  }

  /**
   * Scan /proc for ffmpeg child processes left behind by a SIGKILL-ed server.
   *
   * When the server is killed (OOM, deploy SIGKILL, container eviction) the
   * normally-reliable finally block in runTranscode() never runs, leaving
   * orphaned ffmpeg processes alive. They consume CPU and memory while
   * their jobs have already been reset to 'queued' by resetOrphanedJobs().
   *
   * Safety: ONLY kills ffmpeg processes whose cmdline references our own
   * TRANSCODER_SCRATCH_DIR. This makes it safe even if other services in the
   * same container run ffmpeg for unrelated purposes.
   *
   * Linux-only: skips silently on macOS / Windows where /proc is absent.
   */
  private async scanAndKillOrphanedFfmpegProcesses(): Promise<void> {
    if (process.platform !== "linux") return;
    const scratchRoot = env.TRANSCODER_SCRATCH_DIR ?? path.join(os.tmpdir(), "transcoder");
    try {
      let entries: string[];
      try {
        entries = await readdir("/proc");
      } catch {
        return; // /proc not mounted or unreadable — skip silently
      }
      let killed = 0;
      for (const pidStr of entries) {
        // /proc entries are PIDs (all-digit strings) or named files.
        if (!/^\d+$/.test(pidStr)) continue;
        try {
          // cmdline contains NUL-separated args: exe\0arg1\0arg2\0...
          const cmdlineRaw = await readFile(`/proc/${pidStr}/cmdline`, "utf8");
          const args = cmdlineRaw.split("\0");
          const exe = args[0] ?? "";
          // Only target ffmpeg processes.
          if (!exe.endsWith("ffmpeg") && exe !== "ffmpeg") continue;
          // Only kill processes working on OUR scratch directory — ignore
          // any unrelated ffmpeg instances running in the same container.
          if (!cmdlineRaw.includes(scratchRoot)) continue;
          const pid = parseInt(pidStr, 10);
          process.kill(pid, "SIGTERM");
          killed++;
        } catch {
          // /proc entry vanished between readdir and readFile — normal race,
          // not an error. ESRCH on process.kill means the process already died.
        }
      }
      if (killed > 0) {
        logger.warn(
          { killed, scratchRoot },
          "transcoder: killed orphaned ffmpeg processes from previous server run",
        );
      } else {
        logger.debug(
          { scratchRoot },
          "transcoder: no orphaned ffmpeg processes found at startup",
        );
      }
    } catch (err) {
      logger.warn({ err }, "transcoder: orphaned ffmpeg scan failed (non-fatal)");
    }
  }

  // Partial-success drift recovery counter — runs every PARTIAL_RECOVERY_TICKS
  // ticks so a video stuck at "encoding" (job is "done" but the hls_ready write
  // was lost to a crash) is healed within minutes in a long-running 24/7 process
  // instead of only on the next restart.
  private partialRecoveryCounter = 0;
  // Target cadence: ~3 min. Computed from the actual poll interval so this
  // fires on schedule regardless of whether TRANSCODER_POLL_MS was tuned.
  private get partialRecoveryTicks(): number {
    return Math.max(1, Math.round(3 * 60_000 / env.TRANSCODER_POLL_MS));
  }

  // Auto-retry recoverable failed jobs counter.  Runs every AUTO_RETRY_TICKS
  // ticks (default ~30 min). Re-queues status='failed' jobs where the error
  // code is NOT terminal (CORRUPT_SOURCE / SOURCE_MISSING) and attempts <
  // maxAttempts. DISK_FULL and transient FFmpeg exits recover automatically
  // without operator action. Controlled by TRANSCODER_AUTO_RETRY_FAILED env var.
  private autoRetryCounter = 0;

  // Stuck-job watchdog counter — runs every stuckJobsTicks ticks (~2 min).
  // With the early-stuck (30 min no-progress) and stale-progress (15 min stall)
  // detectors active, a 2-minute poll cadence keeps the detection window tight
  // while still batching dozens of ticks into a single DB query.
  private stuckJobsCounter = 0;
  // Target cadence: ~2 min. Computed from the actual poll interval so the
  // watchdog fires on schedule regardless of TRANSCODER_POLL_MS tuning.
  private get stuckJobsTicks(): number {
    return Math.max(1, Math.round(2 * 60_000 / env.TRANSCODER_POLL_MS));
  }

  private dlqCheckCounter = 0;

  // Faststart-orphan watchdog: sweeps managed_videos for rows stuck in
  // transcodingStatus='processing'/'queued' with no backing transcoding_jobs
  // row and updated_at older than faststartOrphanTicks × poll interval
  // (~45 min). This catches faststart crashes that leave the video status
  // permanently stuck while the job row was already cleaned up.
  private faststartOrphanCounter = 0;
  // Target cadence: ~45 min. Computed from poll interval.
  private get faststartOrphanTicks(): number {
    return Math.max(1, Math.round(45 * 60_000 / env.TRANSCODER_POLL_MS));
  }

  // Early-stuck detector thresholds (not configurable via env — hardcoded for
  // simplicity; operators who need different values can fork the dispatcher).
  // - EARLY_STUCK_MS: if a job starts but never reports any progress within
  //   this window, assume it crashed silently and reset it.
  // - PROGRESS_STALE_MS: if a running job's lastProgressAt falls this far
  //   behind wall-clock, it has stopped making progress (FFmpeg hung, disk
  //   stall, OOM kill without SIGTERM).  Reset and requeue.
  // - JOB_START_GRACE_MS: brand-new jobs are exempt from the stale-progress
  //   check for this window so a legitimately slow first rendition pass isn't
  //   misclassified as stalled.
  private static readonly EARLY_STUCK_MS = 30 * 60_000;   // 30 min
  private static readonly PROGRESS_STALE_MS = 15 * 60_000; // 15 min
  private static readonly JOB_START_GRACE_MS = 5 * 60_000; // 5 min

  // Scratch dir GC sweep counter — runs every scratchGcTicks ticks
  // (target: ~30 min). Computed from poll interval.
  private scratchGcCounter = 0;
  private get scratchGcTicks(): number {
    return Math.max(1, Math.round(30 * 60_000 / env.TRANSCODER_POLL_MS));
  }

  // Periodic FFmpeg zombie scan — re-runs every zombieScanTicks ticks after startup.
  // Startup always fires once unconditionally in start().
  // The startup scan covers orphans from the previous process; this covers any
  // orphans created by an OOM-kill or SIGKILL during the current process lifetime.
  private zombieScanCounter = 0;
  private get zombieScanTicks(): number {
    return Math.max(1, Math.round(5 * 60_000 / env.TRANSCODER_POLL_MS));
  }

  // Stale-queued watchdog — fires every staleQueuedTicks ticks (~15 min).
  // Emits an ops-alert when jobs have sat in 'queued' status for longer than
  // TRANSCODER_QUEUE_STALE_ALERT_MS without a worker picking them up.
  // Symptoms: circuit breaker permanently open (ffmpeg missing), all workers
  // dead without leaving a 'processing' row, or TRANSCODER_DISABLE=1 accidentally set.
  private staleQueuedCounter = 0;
  private get staleQueuedTicks(): number {
    return Math.max(1, Math.round(15 * 60_000 / env.TRANSCODER_POLL_MS));
  }

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
      // Wrap both writes in a transaction so a mid-restart crash can't leave
      // transcoding_jobs in "queued" while managed_videos is still in
      // "processing". Either both updates commit or both are rolled back —
      // the same startup recovery runs again on the next boot.
      const reset = await db.transaction(async (tx) => {
        const updated = await tx
          .update(jobs)
          .set({
            status: "queued",
            // Reset stage to "pending" so the UI shows a clean restart state
            // rather than a stale "processing"/"finalizing" badge on a queued job.
            stage: "pending",
            progress: 0,
            startedAt: null,
            errorMessage: "Reset: server restarted while job was in-progress (FFmpeg process orphaned).",
          })
          .where(eq(jobs.status, "processing"))
          .returning({ id: jobs.id, videoId: jobs.videoId });

        if (updated.length > 0) {
          const videoIds = updated.map((r) => r.videoId).filter((id): id is string => id !== null);
          if (videoIds.length > 0) {
            await tx
              .update(videos)
              .set({ transcodingStatus: "queued" })
              .where(inArray(videos.id, videoIds));
          }
        }
        return updated;
      });

      if (reset.length > 0) {

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
      // Heal videos stuck at "encoding" because the hls_ready write was lost to
      // a crash (see recoverPartialSuccessVideos for the full rationale). Runs
      // at boot here, and periodically via the watchdog so the drift is fixed
      // within minutes in a long-running 24/7 process — not only on restart.
      await this.recoverPartialSuccessVideos();
    } catch (err) {
      logger.error({ err }, "transcoder: failed to reset orphaned jobs on startup (non-fatal)");
    }
  }

  /**
   * Heals "partial-success" drift: a video stuck at "encoding" whose job is
   * already "done". Covers the crash window between the two writes in runOnce():
   *   1. UPDATE transcoding_jobs SET status='done'        ← succeeded
   *   2. UPDATE managed_videos SET transcodingStatus='hls_ready' ← lost
   *
   * Without recovery the video never re-enters the dispatch loop (its job is
   * "done") and serves the raw MP4 fallback forever. Recovery is idempotent and
   * safe to run repeatedly: it only flips a video to hls_ready after verifying
   * that master.m3u8 actually landed in object storage, and the early return on
   * an empty "encoding" set keeps the steady-state cost to a single cheap SELECT.
   */
  private async recoverPartialSuccessVideos(): Promise<void> {
    const encodingVideoIds = await db
      .select({ id: videos.id })
      .from(videos)
      .where(eq(videos.transcodingStatus, "encoding"))
      .then((rows) => rows.map((r) => r.id));

    if (encodingVideoIds.length === 0) return;

    // Exclude any video that currently has an active (queued/processing) job:
    // a manual re-transcode legitimately puts a previously-finished video back
    // into "encoding" while an older "done" job (and its old master.m3u8) still
    // exists. Healing on the stale "done" job would flip it to hls_ready
    // mid-encode. Only genuine drift (a "done" job with NO active job) qualifies.
    const activeVideoIds = new Set(
      (
        await db
          .select({ videoId: jobs.videoId })
          .from(jobs)
          .where(
            and(
              inArray(jobs.status, ["queued", "processing"]),
              inArray(jobs.videoId, encodingVideoIds),
            ),
          )
      ).map((r) => r.videoId).filter((id): id is string => id !== null),
    );

    const recoverableVideoIds = encodingVideoIds.filter((id) => !activeVideoIds.has(id));
    if (recoverableVideoIds.length === 0) return;

    const doneJobs = await db
      .select({ videoId: jobs.videoId, id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.status, "done"), inArray(jobs.videoId, recoverableVideoIds)));

    // Batch-check ALL master HLS keys in a single round-trip instead of one
    // SELECT per job (N+1 → 1). For N done-but-stuck jobs this eliminates
    // N−1 sequential DB round-trips on every recoverPartialSuccessVideos() call.
    // Falls back to an empty Set on error so no jobs are healed in that cycle —
    // safer than crashing and skipping recovery entirely.
    const jobEntries = doneJobs.map((job) => ({
      job,
      masterKey: `transcoded/${job.videoId}/master.m3u8`,
    }));
    const masterKeysToProbe = jobEntries.map((e) => e.masterKey);
    // sql.param() passes the array as a single $N binding; the pg driver
    // serialises string[] to {v1,v2,...}. The bare ${array}::text[] pattern
    // causes Drizzle to emit tuple notation ($1,$2)::text[] → ERROR 42846.
    const existingMasterKeys: Set<string> = masterKeysToProbe.length > 0
      ? await db
          .execute(sql`
            SELECT key FROM storage_blobs
            WHERE key = ANY(${sql.param(masterKeysToProbe)}::text[])
          `)
          .then((r) => new Set((r.rows as Array<{ key: string }>).map((row) => row.key)))
          .catch((err) => {
            logger.warn({ err }, "transcoder: batch master-key probe failed — skipping recovery this cycle");
            return new Set<string>();
          })
      : new Set<string>();

    // Collect video IDs that are successfully healed so we can batch-sync
    // broadcast_queue.duration_secs in a single UPDATE after the loop instead
    // of one SELECT + UPDATE per video (N+1 → 1 batch query).
    const healedVideoIds: string[] = [];

    for (const { job, masterKey } of jobEntries) {
      try {
        const masterExists = existingMasterKeys.has(masterKey);

        if (masterExists) {
          const masterUrl = `/api/hls/${job.videoId}/master.m3u8`;
          // Atomic heal — all guards live in one statement so there is no
          // TOCTOU window between the active-job pre-filter above and this write:
          //   • transcoding_status='encoding' → multi-replica idempotency (only
          //     one replica heals; the normal completion path may also win).
          //   • NOT EXISTS active job → never flip a video that a freshly-queued
          //     re-transcode just put back into "encoding" (its old "done" job
          //     and stale master.m3u8 would otherwise trigger a mid-encode heal).
          const healedRows = await db.execute(sql`
            UPDATE managed_videos
            SET transcoding_status = 'hls_ready', hls_master_url = ${masterUrl}
            WHERE id = ${job.videoId}
              AND transcoding_status = 'encoding'
              AND NOT EXISTS (
                SELECT 1 FROM transcoding_jobs j
                WHERE j.video_id = managed_videos.id
                  AND j.status IN ('queued', 'processing')
              )
            RETURNING id
          `);
          const healed = healedRows.rows as Array<{ id: string }>;

          if (healed.length > 0) {
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

            // Mark for batch duration sync (done below, after the loop).
            if (job.videoId) healedVideoIds.push(job.videoId);

            // Bust the public video catalogue cache so TV/mobile clients
            // immediately reflect the healed hls_ready status instead of
            // serving the stale 'encoding' state until the TTL expires.
            void invalidateVideosCatalogCache();
            // Notify the admin library and connected clients that this
            // video's status changed — essential for the admin panel to
            // update the transcoding badge without a manual refresh.
            adminEventBus.push("videos-library-updated", { videoId: job.videoId, reason: "partial-success-recovery" });

            // The video just became airable HLS — notify the broadcast
            // orchestrator so it can pick up the upgraded source promptly
            // instead of continuing on the raw MP4 fallback until its next scan.
            adminEventBus.push("broadcast-queue-updated", {
              reason: "partial-success-recovery",
              videoId: job.videoId,
            });
          }
        }
      } catch (recErr) {
        logger.warn(
          { err: recErr, videoId: job.videoId, jobId: job.id },
          "transcoder: partial-success recovery check failed (non-fatal)",
        );
      }
    }

    // Batch-sync broadcast_queue.duration_secs for all healed videos in one
    // UPDATE FROM SELECT instead of N individual SELECT+UPDATE pairs. Corrects
    // the 1800-second upload-time placeholder so the orchestrator uses accurate
    // cycle timing — preventing dead-air gaps when videos end before the
    // placeholder expires. The NOT EXISTS guard on active jobs above ensures
    // this only runs for genuinely healed (not mid-encode) videos.
    if (healedVideoIds.length > 0) {
      await db.execute(sql`
        UPDATE broadcast_queue bq
        SET    duration_secs = ROUND(mv.duration::numeric)
        FROM   managed_videos mv
        WHERE  bq.video_id = mv.id
          AND  bq.video_id = ANY(${sql.param(healedVideoIds)}::text[])
          AND  mv.duration IS NOT NULL
          AND  mv.duration ~ '^[0-9]+(\\.[0-9]+)?$'
          AND  mv.duration::numeric > 10
          AND  ROUND(mv.duration::numeric) != 1800
      `).catch((err: unknown) => {
        logger.warn(
          { err, count: healedVideoIds.length, videoIds: healedVideoIds },
          "transcoder: partial-success recovery batch duration sync failed (non-fatal)",
        );
      });
    }
  }

  /**
   * Auto-retry recoverable failed transcoding jobs.
   *
   * Scans for transcoding_jobs with status='failed' where:
   *   • attempts < maxAttempts (retry budget not exhausted)
   *   • The managed_videos error code is NOT terminal:
   *       – CORRUPT_SOURCE: moov atom absent — re-upload required
   *       – SOURCE_MISSING: source blob deleted — re-upload required
   *     DISK_FULL and transient FFmpeg exits are retryable once disk is freed.
   *   • completedAt is older than TRANSCODER_AUTO_RETRY_INTERVAL_MS so we
   *     don't immediately re-attempt a job that just failed.
   *
   * Re-queued jobs reset nextRetryAt to now() so the dispatcher picks them
   * up on the next tick. At most 20 jobs per sweep to bound DB work.
   * Controlled by TRANSCODER_AUTO_RETRY_FAILED env var (default: true).
   */
  private async sweepRecoverableFailed(): Promise<void> {
    if (!env.TRANSCODER_AUTO_RETRY_FAILED) return;
    type CandidateRow = { id: string; videoId: string; attempts: number };
    const candidates = await db.execute<CandidateRow>(sql`
      SELECT tj.id, tj.video_id AS "videoId", tj.attempts
      FROM transcoding_jobs tj
      LEFT JOIN managed_videos mv ON mv.id = tj.video_id
      WHERE tj.status = 'failed'
        AND tj.attempts < tj.max_attempts
        AND (tj.completed_at IS NULL OR tj.completed_at < now() - (${env.TRANSCODER_AUTO_RETRY_INTERVAL_MS} || ' milliseconds')::interval)
        AND (
          mv.transcoding_error_code IS NULL
          OR mv.transcoding_error_code NOT IN ('CORRUPT_SOURCE', 'SOURCE_MISSING')
        )
      ORDER BY tj.created_at ASC
      LIMIT 20
    `);
    const rows = (candidates.rows as CandidateRow[]) ?? [];
    if (rows.length === 0) return;

    const ids = rows.map((r) => r.id);
    await db
      .update(jobs)
      .set({
        status: "queued",
        // Reset stage so re-queued jobs start from "pending" rather than
        // showing a stale "processing"/"finalizing" stage in the admin UI.
        stage: "pending",
        nextRetryAt: new Date(),
        errorMessage: sql`CONCAT(COALESCE(error_message, ''), ' [auto-retried by dispatcher]')`,
      })
      .where(inArray(jobs.id, ids));

    // Reset the managed_videos status back to 'queued' so the UI shows
    // the video as pending rather than permanently failed.
    const videoIds = [...new Set(rows.map((r) => r.videoId))];
    await db
      .update(videos)
      .set({ transcodingStatus: "queued", transcodingErrorCode: null, transcodingErrorMessage: null })
      .where(and(inArray(videos.id, videoIds), eq(videos.transcodingStatus, "failed")));

    logger.warn(
      { count: rows.length, jobIds: ids, videoIds },
      "transcoder: auto-retry sweep re-queued recoverable failed jobs",
    );

    for (const r of rows) {
      adminEventBus.push("transcoding-update", {
        videoId: r.videoId,
        jobId: r.id,
        status: "queued",
        progress: 0,
      });
    }

    // Wake the dispatcher immediately so re-queued jobs start within
    // milliseconds rather than waiting up to TRANSCODER_POLL_MS.
    this.nudge();
  }

  /**
   * Stale-queued watchdog.
   *
   * Emits an ops-alert SSE event when any transcoding_jobs row has been
   * sitting in status='queued' for longer than TRANSCODER_QUEUE_STALE_ALERT_MS
   * without a worker picking it up.  This is a signal that something systemic
   * is broken, not that a single job is slow — healthy queues drain within
   * seconds (one dispatch tick).
   *
   * Causes of stale-queued jobs:
   *   • TRANSCODER_DISABLE=1 accidentally set (workers never poll)
   *   • FFmpeg circuit breaker permanently open (ffmpeg binary not installed)
   *   • All workers crashed without leaving a 'processing' row
   *   • DB connectivity lost after the job was enqueued
   *   • nextRetryAt set far in the future by exponential back-off (expected)
   *
   * Only jobs whose nextRetryAt IS NULL or is in the past are considered —
   * jobs waiting for an exponential back-off window are intentionally deferred
   * and do NOT trigger the alert.
   */
  private async sweepStaleQueuedJobs(): Promise<void> {
    const staleMs = env.TRANSCODER_QUEUE_STALE_ALERT_MS;
    const staleCutoff = new Date(Date.now() - staleMs);
    type StaleRow = { id: string; videoId: string | null; createdAt: Date; attempts: number };
    let stale: StaleRow[];
    try {
      const result = await db.execute<StaleRow>(sql`
        SELECT id, video_id AS "videoId", created_at AS "createdAt", attempts
        FROM transcoding_jobs
        WHERE status = 'queued'
          AND created_at < ${staleCutoff}
          AND (next_retry_at IS NULL OR next_retry_at < now())
        ORDER BY created_at ASC
        LIMIT 50
      `);
      stale = (result.rows as StaleRow[]) ?? [];
    } catch (err) {
      logger.warn({ err }, "transcoder: stale-queued check DB error (non-fatal)");
      return;
    }
    if (stale.length === 0) return;

    const staleMinutes = Math.round(staleMs / 60_000);
    logger.warn(
      {
        count: stale.length,
        oldestJobId: stale[0]?.id,
        oldestCreatedAt: stale[0]?.createdAt,
        staleThresholdMs: staleMs,
        ffmpegAvailable: this.ffmpegAvailable,
        activeJobCount: this.activeJobs.size,
      },
      `transcoder: ${stale.length} job(s) have been in 'queued' for >${staleMinutes} min without a worker pick-up`,
    );

    const reasons: string[] = [];
    if (!this.ffmpegAvailable) reasons.push("ffmpeg binary not found (circuit breaker open)");
    if (env.TRANSCODER_DISABLE) reasons.push("TRANSCODER_DISABLE is set");
    if (this.stopped) reasons.push("dispatcher is stopped");
    const hint = reasons.length > 0 ? ` — likely cause: ${reasons.join("; ")}` : "";

    adminEventBus.push("ops-alert", {
      level: "warn",
      component: "transcoder",
      message:
        `${stale.length} transcoding job(s) stuck in queue for >${staleMinutes} min with no worker activity${hint}. ` +
        `Oldest job: ${stale[0]?.id ?? "unknown"} (created ${stale[0]?.createdAt?.toISOString() ?? "unknown"}). ` +
        `Check TRANSCODER_DISABLE, ffmpeg availability, and dispatcher health.`,
      count: stale.length,
      staleThresholdMinutes: staleMinutes,
      ffmpegAvailable: this.ffmpegAvailable,
      dispatcherStopped: this.stopped,
      possibleCauses: reasons,
    });

    // Self-healing nudge: attempt to pick up stale jobs immediately.
    // If the circuit breaker is open but ffmpeg has become available
    // since it was tripped, this gives the dispatcher a chance to
    // recover without waiting for the next scheduled ffmpeg re-check.
    if (!this.ffmpegAvailable) {
      void checkFfmpegAvailable().then((available) => {
        if (available) {
          this.ffmpegAvailable = true;
          this.ffmpegRecheckTimer = null;
          logger.info(
            "transcoder: stale-queued watchdog detected ffmpeg restored — circuit CLOSED, nudging dispatcher",
          );
          this.nudge();
        }
      }).catch(() => { /* non-fatal — will retry on next recheck */ });
    } else if (!this.stopped) {
      // Circuit is closed but jobs are stale — nudge immediately to try
      // picking them up (handles edge cases like a brief DB hiccup that
      // prevented the previous tick from claiming any jobs).
      logger.info(
        { count: stale.length },
        "transcoder: stale-queued watchdog nudging dispatcher for self-healing",
      );
      this.nudge();
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
    activeJobCount: number;
    maxConcurrent: number;
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
      isRunning: this.activeJobs.size > 0,
      activeJobCount: this.activeJobs.size,
      maxConcurrent: this.maxConcurrent,
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
    if (this.leaseReclaimTimer) {
      clearInterval(this.leaseReclaimTimer);
      this.leaseReclaimTimer = null;
    }
    if (this.eventLogPurgeTimer) {
      clearInterval(this.eventLogPurgeTimer);
      this.eventLogPurgeTimer = null;
    }
    // Stop the autonomous DLQ recovery worker.
    dlqRecoveryWorker.stop();
    // Deregister from worker registry (best-effort — non-blocking).
    void workerRegistry.deregister().catch(() => { /* non-fatal */ });
    logger.info("transcoder dispatcher stopped");
  }

  /**
   * Shared tick used by start() and nudge(). Runs periodic maintenance
   * tasks and launches up to maxConcurrent job slots concurrently, then
   * re-arms the timer at the normal TRANSCODER_POLL_MS cadence.
   *
   * The timer is re-armed immediately (not in .finally) so concurrent jobs
   * don't block future ticks — we want the poll loop to keep running even
   * while multiple jobs are executing in parallel.
   */
  private tick(): void {
    if (this.stopped) return;
    // Stamp liveness on every scheduler cycle so getHeartbeat() accurately
    // reflects that the dispatcher is alive even when the queue is empty.
    this.lastHeartbeatAt = Date.now();

    // Run periodic maintenance tasks (independent of job execution).
    void this.runPeriodicTasks().catch((err) => {
      logger.warn({ err }, "transcoder: periodic tasks error (non-fatal)");
    });

    // Launch up to maxConcurrent job slots concurrently.
    const slotsAvailable = this.maxConcurrent - this.activeJobs.size;
    for (let i = 0; i < slotsAvailable; i++) {
      void this.runOnce().catch((err) => {
        logger.warn({ err }, "transcoder: unhandled runOnce error — will retry on next tick");
      });
    }

    // Re-arm timer immediately so future ticks don't wait for active jobs.
    if (!this.stopped) {
      this.timer = setTimeout(() => this.tick(), env.TRANSCODER_POLL_MS);
      this.timer.unref();
    }
  }

  /**
   * Periodic maintenance tasks, called once per tick regardless of active
   * job count. Moved out of runOnce() so they run even when all slots are
   * occupied by concurrent jobs.
   */
  private async runPeriodicTasks(): Promise<void> {
    // Run the stuck-job watchdog periodically.
    this.stuckJobsCounter++;
    if (this.stuckJobsCounter >= this.stuckJobsTicks) {
      this.stuckJobsCounter = 0;
      await this.resetStuckJobs();
    }

    // Periodic scratch directory GC (~every 30 min).
    this.scratchGcCounter++;
    if (this.scratchGcCounter >= this.scratchGcTicks) {
      this.scratchGcCounter = 0;
      void this.purgeOrphanedScratchDirs();
    }

    // Periodic partial-success recovery.
    this.partialRecoveryCounter++;
    if (this.partialRecoveryCounter >= this.partialRecoveryTicks) {
      this.partialRecoveryCounter = 0;
      await this.recoverPartialSuccessVideos().catch((err) => {
        logger.warn({ err }, "transcoder: periodic partial-success recovery error (non-fatal)");
      });
    }

    // Auto-retry recoverable failed jobs.
    if (env.TRANSCODER_AUTO_RETRY_FAILED) {
      this.autoRetryCounter++;
      const retryTicks = Math.max(1, Math.round(env.TRANSCODER_AUTO_RETRY_INTERVAL_MS / env.TRANSCODER_POLL_MS));
      if (this.autoRetryCounter >= retryTicks) {
        this.autoRetryCounter = 0;
        await this.sweepRecoverableFailed().catch((err) => {
          logger.warn({ err }, "transcoder: auto-retry sweep error (non-fatal)");
        });
      }
    }

    // Periodic faststart-orphan watchdog (~every 45 min).
    this.faststartOrphanCounter++;
    if (this.faststartOrphanCounter >= this.faststartOrphanTicks) {
      this.faststartOrphanCounter = 0;
      await this.resetFaststartOrphans().catch((err) => {
        logger.warn({ err }, "[transcoder] faststart-orphan watchdog error (non-fatal)");
      });
    }

    // Periodic FFmpeg zombie scan (~every 5 min).
    // The startup scan covers orphans from the PREVIOUS process; this covers
    // orphans created by OOM-kills or SIGKILL during the CURRENT process's
    // lifetime (e.g. a job killed mid-encode well after the startup scan ran).
    this.zombieScanCounter++;
    if (this.zombieScanCounter >= this.zombieScanTicks) {
      this.zombieScanCounter = 0;
      void this.scanAndKillOrphanedFfmpegProcesses().catch((err) => {
        logger.warn({ err }, "transcoder: periodic zombie scan error (non-fatal)");
      });
    }

    // Stale-queued watchdog (~every 15 min).
    this.staleQueuedCounter++;
    if (this.staleQueuedCounter >= this.staleQueuedTicks) {
      this.staleQueuedCounter = 0;
      await this.sweepStaleQueuedJobs().catch((err) => {
        logger.warn({ err }, "transcoder: stale-queued watchdog error (non-fatal)");
      });
    }

    // Sample queue depth metric.
    db.select({ total: count() })
      .from(jobs)
      .where(eq(jobs.status, "queued"))
      .then(([row]) => {
        transcodingQueueDepth.set(SERVICE_LABELS, row?.total ?? 0);
      })
      .catch(() => { /* non-fatal metric skip */ });

    // Update active job count metric.
    transcoderActiveJobCount.set(SERVICE_LABELS, this.activeJobs.size);

    // Sample DLQ depth metric periodically.
    this.dlqCheckCounter = (this.dlqCheckCounter ?? 0) + 1;
    if (this.dlqCheckCounter >= 30) {
      this.dlqCheckCounter = 0;
      void this.updateDlqMetric();
    }
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
    // Guard: only run if the dispatcher was explicitly started.
    // When TRANSCODER_DISABLE=1 is set, start() is never called so
    // this.started stays false. Without this check, stopped=false (the
    // initial default) would let nudge() bypass the disable flag and
    // silently start the full polling loop whenever a job is enqueued.
    if (!this.started || this.stopped) return;
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
      // Early-stuck: job started N minutes ago but never reported any progress.
      // Catches silent FFmpeg crashes that don't kill the Node process.
      const earlyStuckCutoff = new Date(
        Date.now() - TranscoderDispatcher.EARLY_STUCK_MS,
      );
      // Stale-progress: job reported progress at some point but has not updated
      // lastProgressAt in N minutes.  Catches FFmpeg hung mid-encode (disk stall,
      // OOM kill via SIGKILL before SIGTERM reached the process, etc.).
      const progressStaleCutoff = new Date(
        Date.now() - TranscoderDispatcher.PROGRESS_STALE_MS,
      );
      // Grace period: skip the stale-progress check for jobs that just started.
      const graceCutoff = new Date(
        Date.now() - TranscoderDispatcher.JOB_START_GRACE_MS,
      );

      // Find stuck jobs first (read-only).
      const stuckJobs = await db
        .select({
          id: jobs.id,
          videoId: jobs.videoId,
          attempts: jobs.attempts,
          maxAttempts: jobs.maxAttempts,
          startedAt: jobs.startedAt,
          lastProgressAt: jobs.lastProgressAt,
        })
        .from(jobs)
        .where(
          and(
            eq(jobs.status, "processing"),
            or(
              // Primary: exceeded full job timeout (unchanged).
              lt(jobs.startedAt, stuckCutoff),
              // Early-stuck: started 30+ min ago and never reported progress.
              and(
                lt(jobs.startedAt, earlyStuckCutoff),
                isNull(jobs.lastProgressAt),
              ),
              // Stale-progress: progress was last updated 15+ min ago while job
              // is past the initial grace window (i.e. it was making progress
              // but has now stopped responding).
              and(
                lt(jobs.startedAt, graceCutoff),
                lt(jobs.lastProgressAt, progressStaleCutoff),
              ),
            ),
          ),
        );

      if (stuckJobs.length === 0) return;

      const resetResults: Array<{ id: string; videoId: string | null; failed: boolean }> = [];

      for (const stuck of stuckJobs) {
        const newAttempts = stuck.attempts + 1;
        const exceeded = newAttempts >= stuck.maxAttempts;
        const timeoutMinutes = Math.round(env.TRANSCODER_JOB_TIMEOUT_MS / 60_000);
        const earlyStuckMinutes = Math.round(TranscoderDispatcher.EARLY_STUCK_MS / 60_000);
        const progressStaleMinutes = Math.round(TranscoderDispatcher.PROGRESS_STALE_MS / 60_000);

        // Determine which watchdog condition triggered so the reset message is
        // as specific as possible (helps operators diagnose the root cause).
        const isFullTimeout = stuck.startedAt !== null && stuck.startedAt < stuckCutoff;
        const isNoProgress = !isFullTimeout && stuck.lastProgressAt === null;
        // isProgressStale: had progress before, but none recently.

        const watchdogReason = isFullTimeout
          ? `job exceeded ${timeoutMinutes}-minute processing limit`
          : isNoProgress
          ? `job reported no progress after ${earlyStuckMinutes} minutes (silent crash or FFmpeg spawn failure)`
          : `job has not updated progress in ${progressStaleMinutes} minutes (FFmpeg hung mid-encode)`;

        // Atomic claim: only update if still "processing" (multi-replica safe).
        const claimed = await db
          .update(jobs)
          .set({
            status: exceeded ? "failed" : "queued",
            // Reset stage to "pending" in all cases:
            //   - Re-queued: "pending" is the correct start-of-pipeline state.
            //   - Permanently failed: "pending" signals "start from scratch if
            //     an operator retries" — avoids misleading "processing" badge
            //     on a job that will never make further progress in its current form.
            stage: "pending",
            progress: 0,
            attempts: newAttempts,
            startedAt: null,
            lastProgressAt: null,
            completedAt: exceeded ? new Date() : null,
            errorMessage: exceeded
              ? `Job permanently failed after ${newAttempts} attempt(s): ${watchdogReason}. Operator review required.`
              : `Watchdog reset (attempt ${newAttempts}/${stuck.maxAttempts}): ${watchdogReason} — re-queuing for retry.`,
          })
          .where(and(eq(jobs.id, stuck.id), eq(jobs.status, "processing")))
          .returning({ id: jobs.id });

        if (claimed.length > 0) {
          resetResults.push({ id: stuck.id, videoId: stuck.videoId, failed: exceeded });
        }
      }

      if (resetResults.length === 0) return;

      const failedVideoIds = resetResults.filter((r) => r.failed).map((r) => r.videoId).filter((id): id is string => id !== null);
      const requeuedVideoIds = resetResults.filter((r) => !r.failed).map((r) => r.videoId).filter((id): id is string => id !== null);

      if (failedVideoIds.length > 0) {
        const timeoutMinutes = Math.round(env.TRANSCODER_JOB_TIMEOUT_MS / 60_000);
        // Guard: never downgrade a video that has already reached hls_ready (same
        // guard as the re-queue path above). A narrow race exists where HLS
        // completes and writes hls_ready to managed_videos just before this update
        // runs — without the guard the watchdog would overwrite it with "failed".
        await db.update(videos)
          .set({
            transcodingStatus: "failed",
            // Surface the timeout reason in managed_videos so the admin panel
            // shows an actionable error message (not just a bare "failed" badge).
            // The normal dispatcher failure path writes this field; the watchdog
            // previously left it null, making timed-out failures invisible in the UI.
            transcodingErrorMessage:
              `Job permanently timed out after ${timeoutMinutes} min on every attempt. ` +
              `Retry the job once disk space / memory conditions have been confirmed — ` +
              `the source file is still available for re-transcoding.`,
            // Machine-readable error code so the queue integrity validator can
            // classify and auto-fix broadcast_queue rows whose backing video is stuck
            // at "failed" with no recoverable path. Without a code, the validator's
            // UNPLAYABLE_CORRUPT_UPLOAD check is the only guard, and it only fires
            // for CORRUPT_SOURCE/SOURCE_MISSING. STUCK_JOB is a separate signal that
            // the operator needs to investigate (OOM, disk stall, FFmpeg hang) rather
            // than that the source file itself is bad.
            transcodingErrorCode: "STUCK_JOB",
          })
          .where(and(
            inArray(videos.id, failedVideoIds),
            ne(videos.transcodingStatus, "hls_ready"),
          ));
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

  /**
   * Faststart-orphan recovery watchdog.
   *
   * Finds `managed_videos` rows stuck in transcodingStatus = 'processing' or
   * 'queued' with no corresponding `transcoding_jobs` row in an active state
   * AND whose updated_at is older than 45 minutes. This indicates the
   * process that was running faststart/transcoding died (SIGKILL, OOM, crash)
   * without cleaning up the video status, leaving it permanently stuck.
   *
   * Fix: reset transcodingStatus → 'queued' so the dispatcher re-picks the
   * video on the next tick. Does NOT increment the attempts counter (unlike
   * resetStuckJobs) because the cause is infrastructure failure, not a bad job.
   */
  private async resetFaststartOrphans(): Promise<void> {
    const ORPHAN_AGE_MS = 45 * 60_000;
    const cutoff = new Date(Date.now() - ORPHAN_AGE_MS);
    try {
      // Select object_path and hls_master_url alongside id so we can create
      // missing transcoding_jobs rows after the status reset (see below).
      const result = await db.execute<{
        id: string;
        object_path: string | null;
        hls_master_url: string | null;
      }>(sql`
        SELECT v.id, v.object_path, v.hls_master_url
        FROM managed_videos v
        WHERE v.transcoding_status IN ('processing', 'queued')
          AND v.updated_at < ${cutoff}
          AND NOT EXISTS (
            SELECT 1 FROM transcoding_jobs j
            WHERE j.video_id = v.id
              AND j.status IN ('queued', 'processing')
          )
        LIMIT 20
      `);

      type OrphanRow = { id: string; object_path: string | null; hls_master_url: string | null };
      const stuckRows = result.rows as OrphanRow[];
      if (stuckRows.length === 0) return;

      const stuckIds = stuckRows.map((r) => r.id);

      logger.warn(
        { count: stuckIds.length, videoIds: stuckIds },
        "[transcoder] faststart-orphan watchdog: videos stuck in processing/queued >45 min " +
        "with no active transcoding_jobs row — resetting to queued for re-dispatch",
      );

      await db.execute(sql`
        UPDATE managed_videos
        SET transcoding_status = 'queued',
            transcoding_error_message = NULL,
            updated_at = NOW()
        WHERE id = ANY(${sql.param(stuckIds)}::text[])
      `);

      adminEventBus.push("videos-library-updated", {
        reason: "faststart-orphan-watchdog-reset",
        count: stuckIds.length,
      });
      adminEventBus.push("broadcast-queue-updated", {
        reason: "faststart-orphan-watchdog-reset",
        count: stuckIds.length,
      });

      // For each recovered video that still needs HLS (no hls_master_url) and
      // has a source blob (object_path set), create the missing transcoding_jobs
      // row. Without this step the dispatcher never picks the video up — it
      // only polls transcoding_jobs, not managed_videos directly. A server
      // crash between faststart starting (transcodingStatus='processing') and
      // enqueueTranscode being called leaves the video in limbo: the status
      // reset above puts it back to 'queued', but no job exists to process it.
      const needsTranscode = stuckRows.filter(
        (r) => r.object_path && !r.hls_master_url,
      );
      if (needsTranscode.length > 0) {
        let jobsCreated = 0;
        for (const row of needsTranscode) {
          try {
            await enqueueTranscode({ videoId: row.id, videoPath: row.object_path! });
            jobsCreated++;
          } catch (enqErr) {
            logger.warn(
              { err: enqErr, videoId: row.id },
              "[transcoder] faststart-orphan watchdog: failed to enqueue HLS for recovered video (non-fatal)",
            );
          }
        }
        if (jobsCreated > 0) {
          logger.info(
            { jobsCreated, videoIds: needsTranscode.map((r) => r.id) },
            "[transcoder] faststart-orphan watchdog: created missing transcoding_jobs rows for recovered videos",
          );
          // Wake the dispatcher immediately so encoding starts on the next
          // tick rather than waiting for the next poll interval.
          this.nudge();
        }
      }
    } catch (err) {
      logger.warn({ err }, "[transcoder] faststart-orphan watchdog sweep failed (non-fatal)");
    }
  }

  async runOnce(): Promise<{ ran: boolean }> {
    // Semaphore: reject if all concurrent slots are occupied.
    if (this.activeJobs.size >= this.maxConcurrent) return { ran: false };
    // Circuit open — ffmpeg unavailable. Pause dispatch to preserve every
    // job's retry budget. The openFfmpegCircuit() re-check loop closes the
    // circuit automatically when ffmpeg becomes reachable again.
    if (!this.ffmpegAvailable) return { ran: false };
    // Storage circuit open — pause dispatch during transient Postgres/storage
    // outages so healthy jobs don't burn retries against an infrastructure
    // failure that will resolve on its own within the cool-down window.
    if (this.storageCircuitOpenUntil > Date.now()) return { ran: false };

    // Claim a job via the lease manager — atomically stamps lease_expires_at
    // and leased_by so dead workers can be detected and their jobs reclaimed.
    const job = await jobLeaseManager.claimJob(workerRegistry.id);
    if (!job) return { ran: false };

    // Slot acquired — track in activeJobs so the semaphore and metrics are accurate.
    this.activeJobs.add(job.id);
    transcoderActiveJobCount.set(SERVICE_LABELS, this.activeJobs.size);
    transcoderConcurrentJobs.set(SERVICE_LABELS, this.activeJobs.size);
    const jobStartMs = Date.now();
    let stageStartMs = jobStartMs;

    try {
      // Guard: videoId is null when the parent managed_videos row was deleted
      // after the job was queued (FK ON DELETE SET NULL). Abandon the job
      // rather than failing with a cryptic error.
      if (!job.videoId) {
        logger.warn({ jobId: job.id }, "transcoder: abandoning orphaned job — parent video was deleted");
        await db.update(jobs)
          .set({ status: "failed", errorMessage: "Parent video was deleted; job abandoned.", leaseExpiresAt: null, leasedBy: null })
          .where(eq(jobs.id, job.id))
          .catch(() => { /* non-fatal */ });
        return { ran: false };
      }

      // ── Stage: pending → validating ──────────────────────────────────────
      await this.transitionStage(job.id, "validating", workerRegistry.id);
      transcoderStageDurationMs.observe({ stage: "pending", status: "ok", ...SERVICE_LABELS }, Date.now() - stageStartMs);
      stageStartMs = Date.now();

      // Look up the video title for SSE event payloads. Non-critical: null on failure.
      const videoTitle = await db
        .select({ title: videos.title })
        .from(videos)
        .where(eq(videos.id, job.videoId))
        .limit(1)
        .then((r) => r[0]?.title ?? null)
        .catch(() => null);

      // ── Stage: validating → processing ───────────────────────────────────
      await this.transitionStage(job.id, "processing", workerRegistry.id);
      transcoderStageDurationMs.observe({ stage: "validating", status: "ok", ...SERVICE_LABELS }, Date.now() - stageStartMs);
      stageStartMs = Date.now();

      await db.update(videos)
        .set({ transcodingStatus: "encoding" })
        .where(eq(videos.id, job.videoId));

      adminEventBus.push("transcoding-update", {
        videoId: job.videoId,
        jobId: job.id,
        status: "encoding",
        progress: 0,
        stage: "processing",
        videoTitle,
      });

      logger.info(
        { jobId: job.id, videoId: job.videoId, attempt: job.attempts + 1, workerId: workerRegistry.id },
        "transcoder: starting job",
      );

      this.lastHeartbeatAt = Date.now();
      this.currentJobId = job.id;
      this.currentJobVideoId = job.videoId;

      // Update worker registry with current job state.
      void workerRegistry.setJobState(job.id, "processing");

      // Lease renewal timer — renews the lease every LEASE_RENEW_MS while the
      // job is in progress so the lease never expires on a healthy worker.
      let leaseStillHeld = true;
      const leaseRenewer = setInterval(() => {
        if (!leaseStillHeld) return;
        void jobLeaseManager.renewLease(job.id, workerRegistry.id).then((ok) => {
          if (!ok) {
            leaseStillHeld = false;
            logger.warn({ jobId: job.id }, "transcoder: lease renewal failed — job may have been reclaimed by another worker");
          }
        }).catch(() => { /* non-fatal — will be detected on next renewal */ });
      }, env.TRANSCODER_LEASE_RENEW_MS);
      leaseRenewer.unref();

      let lastProgressUpdate = Date.now();

      try {
        // Read checkpoint to support rendition-level resume.
        const checkpoint = (job.checkpoint as { completedRenditions?: string[]; encodeDone?: boolean } | null) ?? null;
        const skipRenditions: string[] = checkpoint?.completedRenditions ?? [];

        const result = await runTranscode({
          jobId: job.id,
          videoId: job.videoId,
          sourceObjectKey: job.videoPath,
          skipRenditions,
          onProgress: async (pct) => {
            const now = Date.now();
            if (now - lastProgressUpdate < 5000 && pct < 100) return;
            lastProgressUpdate = now;
            const progressTs = new Date();
            await db.update(jobs).set({ progress: pct, lastProgressAt: progressTs }).where(eq(jobs.id, job.id)).catch((err) => {
              logger.warn({ err, jobId: job.id, pct }, "transcoder: progress update failed (non-fatal)");
            });
            // Emit SSE progress event so the admin broadcast panel updates the
            // per-item progress bar in real time rather than waiting for the next
            // 60-second poll. Throttle matches the DB-write throttle above (5 s).
            adminEventBus.push("transcoding-progress", {
              videoId: job.videoId,
              jobId: job.id,
              progress: pct,
              videoTitle,
            });
          },
          onFfmpegComplete: async () => {
            // Persist "encode done" checkpoint so a retry after an upload-phase
            // interruption knows the ffmpeg step already succeeded.
            await db.update(jobs)
              .set({ checkpoint: { ...(checkpoint ?? {}), encodeDone: true } as object })
              .where(eq(jobs.id, job.id))
              .catch((err) => { logger.warn({ err, jobId: job.id }, "transcoder: onFfmpegComplete checkpoint save failed (non-fatal)"); });
          },
          onRenditionUploaded: async (renditionName) => {
            // Atomically append this rendition to checkpoint.completedRenditions
            // so a retry resumes from where it left off without re-uploading.
            const current = await db
              .select({ checkpoint: jobs.checkpoint })
              .from(jobs)
              .where(eq(jobs.id, job.id))
              .limit(1)
              .then((r) => r[0]?.checkpoint as { completedRenditions?: string[]; encodeDone?: boolean } | null)
              .catch(() => null);
            const completed = [...new Set([...(current?.completedRenditions ?? []), renditionName])];
            await db.update(jobs)
              .set({ checkpoint: { ...(current ?? {}), completedRenditions: completed } as object })
              .where(eq(jobs.id, job.id))
              .catch((err) => { logger.warn({ err, jobId: job.id, renditionName }, "transcoder: onRenditionUploaded checkpoint save failed (non-fatal)"); });
          },
        });

        // ── Stage: processing → finalizing ───────────────────────────────────
        await this.transitionStage(job.id, "finalizing", workerRegistry.id);
        transcoderStageDurationMs.observe({ stage: "processing", status: "ok", ...SERVICE_LABELS }, Date.now() - stageStartMs);
        stageStartMs = Date.now();

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

        // ── HLS segment count integrity gate ────────────────────────────────
        // After confirming master.m3u8 is present, verify that all variant
        // playlists and their .ts segments are also stored. A partial-success
        // crash during uploadDirRecursive can write the master but leave
        // variant playlists or segments missing — players stall without the
        // server ever seeing a visible error. Throwing here triggers a normal
        // retry that regenerates HLS from scratch.
        //
        // Implementation: read master.m3u8 content, parse variant URIs,
        // for each variant read its playlist and count #EXTINF lines,
        // then count matching .ts blobs in storage. Reject if blob count
        // is < expected - 1 (one-segment tolerance for the tail-segment
        // write race). Capped at 6 variants to keep total DB round-trips low.
        //
        // All errors from this block are surfaced as UPLOAD_INCOMPLETE so
        // the outer catch routes them to a retry (not a terminal failure).
        try {
          const masterContentRow = await db
            .execute<{ content: string }>(sql`
              SELECT convert_from(data, 'UTF8') AS content
              FROM storage_blobs
              WHERE key = ${masterKey}
              LIMIT 1
            `)
            .then((r) => (r.rows as Array<{ content: string }>)[0] ?? null)
            .catch(() => null);

          if (masterContentRow) {
            const masterLines = masterContentRow.content.split("\n");
            const variantKeys: string[] = [];
            const masterDir = masterKey.replace(/\/[^/]+$/, "/");
            for (let mi = 0; mi < masterLines.length - 1; mi++) {
              const mline = masterLines[mi]?.trim() ?? "";
              if (!mline.startsWith("#EXT-X-STREAM-INF")) continue;
              const uri = masterLines[mi + 1]?.trim() ?? "";
              if (!uri || uri.startsWith("#")) continue;
              if (uri.startsWith("http://") || uri.startsWith("https://")) {
                variantKeys.push(uri);
              } else {
                variantKeys.push(`${masterDir}${uri}`);
              }
            }

            for (const variantKey of variantKeys.slice(0, 6)) {
              const variantRow = await db
                .execute<{ content: string }>(sql`
                  SELECT convert_from(data, 'UTF8') AS content
                  FROM storage_blobs
                  WHERE key = ${variantKey}
                  LIMIT 1
                `)
                .then((r) => (r.rows as Array<{ content: string }>)[0] ?? null)
                .catch(() => null);

              if (!variantRow) {
                const missingErr = new Error(
                  `transcoder: HLS segment count gate — variant playlist missing from storage ` +
                  `(key='${variantKey}'). FFmpeg exited 0 but upload was incomplete. ` +
                  `Retrying will regenerate HLS from scratch.`,
                );
                (missingErr as NodeJS.ErrnoException).code = "UPLOAD_INCOMPLETE";
                throw missingErr;
              }

              const extinfCount = (variantRow.content.match(/#EXTINF/g) ?? []).length;
              if (extinfCount === 0) {
                const emptyErr = new Error(
                  `transcoder: HLS segment count gate — variant playlist contains no #EXTINF ` +
                  `segments (key='${variantKey}'). Playlist is malformed. ` +
                  `Retrying will regenerate HLS from scratch.`,
                );
                (emptyErr as NodeJS.ErrnoException).code = "UPLOAD_INCOMPLETE";
                throw emptyErr;
              }

              // Count the .ts segment blobs for this variant's directory prefix.
              const variantDir = variantKey.replace(/\/[^/]+$/, "/");
              const segBlobCount = await db
                .execute<{ cnt: string }>(sql`
                  SELECT COUNT(*) AS cnt
                  FROM storage_blobs
                  WHERE key LIKE ${variantDir + "%"}
                    AND key LIKE '%.ts'
                `)
                .then((r) => parseInt((r.rows as Array<{ cnt: string }>)[0]?.cnt ?? "0", 10))
                .catch(() => -1);

              // Allow 1-segment tolerance: the final segment may not yet be
              // visible in a strongly-consistent read if storage lagged slightly
              // behind the manifest write. Reject anything more than 1 missing.
              if (segBlobCount >= 0 && segBlobCount < extinfCount - 1) {
                const segErr = new Error(
                  `transcoder: HLS segment count gate — variant '${variantKey}' lists ` +
                  `${extinfCount} segments but only ${segBlobCount} .ts blobs found in storage ` +
                  `(missing ${extinfCount - segBlobCount}). ` +
                  `Retrying will regenerate HLS from scratch.`,
                );
                (segErr as NodeJS.ErrnoException).code = "UPLOAD_INCOMPLETE";
                throw segErr;
              }
            }

            logger.debug(
              { videoId: job.videoId, variantsChecked: variantKeys.length },
              "transcoder: HLS segment count gate passed ✓",
            );
          }
        } catch (segGateErr) {
          if ((segGateErr as NodeJS.ErrnoException).code === "UPLOAD_INCOMPLETE") {
            throw segGateErr; // surface as a retriable error
          }
          // Unexpected errors (encoding issues, DB transient) — log and continue
          // rather than blocking the entire finalization step.
          logger.warn(
            { err: segGateErr, videoId: job.videoId },
            "transcoder: HLS segment count gate error (non-fatal — treating as passed)",
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

        // Sync the real duration and the HLS master URL to any broadcast_queue
        // rows that reference this video.
        //
        // duration_secs: written at upload-finalize time as a 1800 s placeholder
        // (before ffprobe runs); correcting it ensures the orchestrator's cycle
        // timing matches the actual video length.
        //
        // hls_master_url: the queue row is inserted at upload-finalize time with
        // only localVideoUrl set (MP4-first immediate enrollment). Once HLS
        // transcoding completes, we stamp hls_master_url on the existing queue
        // row so the orchestrator's source resolver immediately prefers HLS over
        // the raw MP4 on the next reload — no re-enqueue needed.
        await db
          .update(schema.broadcastQueueTable)
          .set({
            hlsMasterUrl: result.masterPlaylistUrl,
            ...(result.durationSecs && result.durationSecs > 10
              ? { durationSecs: Math.round(result.durationSecs) }
              : {}),
          })
          .where(eq(schema.broadcastQueueTable.videoId, job.videoId))
          .catch((err: unknown) => {
            logger.warn(
              { err, videoId: job.videoId },
              "transcoder: broadcast_queue hls_master_url + duration sync failed (non-fatal)",
            );
          });

        adminEventBus.push("transcoding-update", {
          videoId: job.videoId,
          jobId: job.id,
          status: "hls_ready",
          progress: 100,
          hlsMasterUrl: result.masterPlaylistUrl,
          videoTitle,
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
        // Targeted source-upgrade event: lets the orchestrator update only
        // this item's source URL in-place (MP4 → HLS) without a full reload.
        adminEventBus.push("broadcast-source-upgraded", {
          videoId: job.videoId,
          quality: "hls",
          hlsMasterUrl: result.masterPlaylistUrl,
        });

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
        scheduleSourceCleanup(job.videoId, job.videoPath ?? null).catch((err) => {
          logger.warn({ err, videoId: job.videoId }, "transcoder: post-transcode source cleanup scheduling failed (non-fatal)");
        });

        // ── Stage: finalizing → completed ────────────────────────────────────
        await this.transitionStage(job.id, "completed", workerRegistry.id);
        transcoderStageDurationMs.observe({ stage: "finalizing", status: "ok", ...SERVICE_LABELS }, Date.now() - stageStartMs);

        // ── Storage circuit breaker: reset streak on success ───────────────
        this.storageErrorStreak = 0;
        this.lastCompletedAt = Date.now();
        this.lastCompletedJobId = job.id;
        this.lastCompletedStatus = "done";

        // ── Duration metric ─────────────────────────────────────────────────
        transcoderJobDurationSeconds.observe({ status: "done", ...SERVICE_LABELS }, (Date.now() - jobStartMs) / 1000);
        clearInterval(leaseRenewer);
        void jobLeaseManager.releaseLease(job.id, workerRegistry.id).catch(() => { /* non-fatal */ });
        workerRegistry.recordJobCompleted();

        void emitJobEvent({
          jobId: job.id,
          workerId: workerRegistry.id,
          eventType: "completed",
          stage: "completed",
          payload: { elapsedMs: result.elapsedMs, masterUrl: result.masterPlaylistUrl },
        }).catch(() => { /* non-fatal */ });
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

        // SOURCE_MISSING: the source blob no longer exists in storage (deleted,
        // orphaned, or GC'd). storage().getObject() throws "Object not found in
        // storage: <key>" tagged with code "SOURCE_MISSING". Re-running the
        // transcode fails identically every time — there is nothing to download.
        // Like CORRUPT_SOURCE, mark the job failed immediately without burning
        // retry slots and record a terminal code so retry / auto-enqueue /
        // validator all treat it as unrecoverable (operator must re-upload).
        // Only LOCAL storage misses are terminal: remote prod-sync downloads
        // fail with "remote source download failed — <status>" (a different
        // message) and stay retryable, since upstream may be briefly down.
        const isSourceMissing =
          errCode === "SOURCE_MISSING" || /object not found in storage/i.test(message);

        // ── Storage circuit breaker: detect Postgres/storage outage ────────
        // Infrastructure errors (connection refused, broken pipe, DB pool timeout)
        // are transient and will resolve without operator action. Count consecutive
        // such failures; once the threshold is hit, pause dispatch for
        // STORAGE_REOPEN_DELAY_MS so the outage can recover before more jobs burn
        // their retry budgets. Any successful job resets the streak.
        const isStorageError = !isDiskFull && !isSourceMissing && (
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

        // DISK_FULL (ENOSPC/EDQUOT): treat as a temporary infrastructure failure,
        // not a permanent job failure. The disk may be freed (old scratch files GC'd,
        // operator action) and the job should retry automatically once space is
        // available. Open the dispatch circuit for 10 min so the queue doesn't
        // hammer the disk while it's full, and schedule a retry with a long backoff.
        // (Reduced from 30 min to limit upload-pipeline dead time on a 24/7 platform.)
        if (isDiskFull) {
          this.storageCircuitOpenUntil = Date.now() + 10 * 60_000; // 10-min cool-down
          this.storageErrorStreak = 0;
          logger.error(
            { errCode, jobId: job.id, videoId: job.videoId, cooldownMs: 10 * 60_000 },
            "transcoder: DISK_FULL (ENOSPC/EDQUOT) — dispatch PAUSED 10 min; " +
            "job will be retried automatically once space is freed",
          );
        }

        // Corrupt-source and source-missing are unrecoverable: no amount of retrying
        // will fix a structurally corrupt file or a deleted source blob. Fail immediately
        // without burning any retry slots so the operator knows the root cause.
        // DISK_FULL is retryable (disk may be freed), so it uses the normal retry path.
        const isImmediateFail = isCorruptSource || isSourceMissing;
        const attempts = job.attempts + (isImmediateFail ? 0 : 1);
        const exceeded = isImmediateFail || attempts >= job.maxAttempts;
        // DISK_FULL gets a 10-min backoff on top of the circuit breaker to spread
        // retries after disk is freed; other errors use exponential backoff capped at
        // 5 min (down from 30 min) to keep uploads moving on a 24/7 platform.
        const backoffMs = isDiskFull
          ? 10 * 60_000
          : Math.min(60_000 * 2 ** attempts, 5 * 60_000);
        const nextRetry = new Date(Date.now() + backoffMs);

        // Truncate error message to 2000 chars to avoid DB bloat from FFmpeg
        // stderr dumps. The full error is always in application logs.
        const truncatedMessage = message.slice(0, 2000);

        // Determine terminal job status:
        //   "failed"      — permanent, unrecoverable errors (CORRUPT_SOURCE / SOURCE_MISSING)
        //                   OR non-exceeded failures that will be re-queued automatically
        //   "dead_letter" — retry budget exhausted for *transient* errors (disk full,
        //                   timeout, storage outage). A DLQ row is inserted atomically
        //                   in the same transaction so DLQ presence is always in lockstep
        //                   with job status — no partial-state from fire-and-forget.
        const terminalStatus: "failed" | "dead_letter" | "queued" = exceeded
          ? (isCorruptSource || isSourceMissing ? "failed" : "dead_letter")
          : "queued";

        await db.transaction(async (tx) => {
          await tx.update(jobs)
            .set({
              status: terminalStatus,
              // Reset stage to "pending" so:
              //   - Re-queued jobs (terminalStatus="queued") start cleanly from
              //     the beginning on the next pick-up — no stale "processing" badge.
              //   - Permanently failed/dead_letter jobs show "pending" rather than
              //     a misleading last-active stage, signalling "start from scratch
              //     if an operator retries this job".
              stage: "pending",
              attempts,
              progress: 0,
              errorMessage: message,
              nextRetryAt: exceeded ? null : nextRetry,
              completedAt: exceeded ? new Date() : null,
              startedAt: null,
            })
            .where(eq(jobs.id, job.id));

          await tx.update(videos)
            .set({
              transcodingStatus: exceeded ? "failed" : "queued",
              // Write failure reason and machine-readable code to managed_videos so:
              //   (a) admin UI can show WHY a video failed without joining transcoding_jobs.
              //   (b) auto-enqueue can exclude CORRUPT_SOURCE videos without regex-matching.
              //   (c) retryAllFailed() can skip permanently-unrecoverable jobs.
              // Only set on terminal failure — cleared on re-queue via enqueueTranscode.
              ...(exceeded ? {
                transcodingErrorMessage: truncatedMessage,
                transcodingErrorCode: isCorruptSource ? "CORRUPT_SOURCE" : isSourceMissing ? "SOURCE_MISSING" : isDiskFull ? "DISK_FULL" : null,
              } : {}),
            })
            .where(eq(videos.id, job.videoId!));

          // Atomically insert the DLQ row when routing to dead_letter.
          // Doing this inside the transaction guarantees the DLQ entry is
          // always created and the job status is always "dead_letter" in
          // lockstep — a crash between separate writes would cause phantom
          // "failed" jobs with no DLQ entry (invisible to operators) or
          // DLQ entries pointing at jobs that were never marked dead_letter.
          if (terminalStatus === "dead_letter") {
            const dlqTable = schema.transcodingDeadLetterTable;
            // Use onConflictDoUpdate so that when a previously-requeued job
            // (either manually or by the DLQ recovery worker) exhausts its
            // retry budget again, the existing DLQ entry is refreshed with
            // the new failure info rather than silently discarded. The update:
            //   - Refreshes attempts, lastError, errorCode, deadLetteredAt
            //   - Clears requeuedAt to null so the entry reappears in the
            //     default DLQ view and the recovery worker picks it up again
            //   - Preserves requeueCount / nextDlqRetryAt (recovery metadata)
            //   - Preserves permanentFailure (once marked, stays marked)
            await tx.insert(dlqTable).values({
              id: randomUUID(),
              jobId: job.id,
              videoId: job.videoId ?? undefined,
              videoPath: job.videoPath ?? undefined,
              attempts,
              lastError: truncatedMessage,
              errorCode: isDiskFull ? "DISK_FULL" : "MAX_ATTEMPTS_EXCEEDED",
            }).onConflictDoUpdate({
              target: dlqTable.jobId,
              set: {
                attempts: sql`EXCLUDED.attempts`,
                lastError: sql`EXCLUDED.last_error`,
                errorCode: sql`EXCLUDED.error_code`,
                deadLetteredAt: sql`NOW()`,
                requeuedAt: null,
              },
            });
          }
        });

        adminEventBus.push("transcoding-update", {
          videoId: job.videoId,
          jobId: job.id,
          status: exceeded ? "failed" : "queued",
          progress: 0,
          errorMessage: message,
          willRetry: !exceeded,
          nextRetryAt: exceeded ? null : nextRetry.toISOString(),
          videoTitle,
        });

        // Emit an immediate ops-alert when a job is routed to the dead-letter
        // queue so operators learn about it via the admin dashboard without
        // waiting for the periodic DLQ metric sweep (every ~150 s).
        if (terminalStatus === "dead_letter") {
          adminEventBus.push("ops-alert", {
            level: "warn",
            title: "Transcoding Job Dead-Lettered",
            message: `Video "${videoTitle ?? job.videoId}" exhausted its retry budget after ${attempts} attempt(s) and was moved to the dead-letter queue. Error: ${truncatedMessage.slice(0, 200)}`,
            metric: "transcoder_dlq_depth",
            jobId: job.id,
            videoId: job.videoId,
          });
        }

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

        // When a job terminally fails due to SOURCE_MISSING, trigger the storage
        // blob recovery waterfall non-blockingly.  The waterfall verifies storage
        // state and either re-enqueues transcoding if a blob was re-uploaded since
        // the job was claimed, or quarantines the video if truly gone.
        // This closes the gap where a SOURCE_MISSING failure is recorded but no
        // autonomous recovery attempt is made without the 10-min reconciliation pass.
        if (isSourceMissing && exceeded && job.videoId) {
          void (async () => {
            try {
              const { storageBlobRecoveryService } = await import("../broadcast-v2/engine/storage-blob-recovery.service.js");
              // Fetch objectPath from managed_videos for the waterfall.
              const vidRow = await db
                .select({ objectPath: videos.objectPath, hlsMasterUrl: videos.hlsMasterUrl, title: videos.title })
                .from(videos)
                .where(eq(videos.id, job.videoId!))
                .then((r) => r[0] ?? null);
              if (vidRow) {
                await storageBlobRecoveryService.runWaterfall({
                  videoId: job.videoId!,
                  queueId: "",
                  title: vidRow.title ?? job.videoId ?? "(unknown)",
                  objectPath: vidRow.objectPath,
                  hlsUrl: vidRow.hlsMasterUrl,
                  triggeredBy: "transcoder-dispatcher",
                });
              }
            } catch (recErr) {
              logger.warn({ err: recErr, videoId: job.videoId }, "transcoder: post-SOURCE_MISSING recovery trigger failed (non-fatal)");
            }
          })();
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
          transcoderJobDurationSeconds.observe({ status: "failed", ...SERVICE_LABELS }, (Date.now() - jobStartMs) / 1000);
          workerRegistry.recordJobFailed();

          void emitJobEvent({
            jobId: job.id,
            workerId: workerRegistry.id,
            eventType: "dead_lettered",
            stage: "failed",
            payload: { attempts, errorCode: isDiskFull ? "DISK_FULL" : "MAX_ATTEMPTS_EXCEEDED", message: truncatedMessage },
          }).catch(() => { /* non-fatal */ });
        }

        clearInterval(leaseRenewer);
        void jobLeaseManager.releaseLease(job.id, workerRegistry.id).catch(() => { /* non-fatal */ });

        void emitJobEvent({
          jobId: job.id,
          workerId: workerRegistry.id,
          eventType: "error",
          stage: "failed",
          payload: { message: truncatedMessage, errCode, attempts, maxAttempts: job.maxAttempts, willRetry: !exceeded },
        }).catch(() => { /* non-fatal */ });
      }

      return { ran: true };
    } catch (err) {
      // Reaches here only for pre-claim failures or unhandled errors not caught
      // by the inner try/catch above.  Log and absorb so tick() never sees an
      // unhandled rejection.
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
      // Release semaphore slot regardless of outcome.
      this.activeJobs.delete(job.id);
      transcoderActiveJobCount.set(SERVICE_LABELS, this.activeJobs.size);
      transcoderConcurrentJobs.set(SERVICE_LABELS, this.activeJobs.size);
      // Release DB lease so another worker can pick up if this slot errored unexpectedly.
      void jobLeaseManager.releaseLease(job.id, workerRegistry.id).catch(() => { /* non-fatal */ });
      // Clear current-job tracking if this was the only active slot.
      if (this.activeJobs.size === 0) {
        this.currentJobId = null;
        this.currentJobVideoId = null;
      }
      // Update worker registry state.
      void workerRegistry.setJobState(
        this.activeJobs.size > 0 ? [...this.activeJobs][0] ?? null : null,
        this.activeJobs.size > 0 ? "processing" : null,
      ).catch(() => { /* non-fatal */ });
    }
  }

  /** Transition a job to a new stage, recording the event and updating the metric. */
  private async transitionStage(jobId: string, stage: string, workerId: string): Promise<void> {
    try {
      await db.update(jobs)
        .set({ stage, stageProgress: 0 })
        .where(eq(jobs.id, jobId));
      transcoderStageTransitionTotal.inc({ stage, ...SERVICE_LABELS });
      void emitJobEvent({ jobId, workerId, eventType: "stage_enter", stage });
    } catch (err) {
      logger.debug({ err, jobId, stage }, "transcoder: transitionStage failed (non-fatal)");
    }
  }

  /** Update the DLQ depth Prometheus metric. */
  private async updateDlqMetric(): Promise<void> {
    try {
      const [row] = await db
        .select({ cnt: count() })
        .from(schema.transcodingDeadLetterTable)
        .where(isNull(schema.transcodingDeadLetterTable.requeuedAt));
      transcoderDlqDepth.set(SERVICE_LABELS, row?.cnt ?? 0);
      const dlqDepth = row?.cnt ?? 0;
      if (dlqDepth >= env.TRANSCODER_DLQ_ALERT_THRESHOLD) {
        adminEventBus.push("ops-alert", {
          level: "warn",
          title: "Transcoder Dead-Letter Queue Alert",
          message: `${dlqDepth} transcoding job(s) are in the dead-letter queue awaiting operator review.`,
          metric: "transcoder_dlq_depth",
          value: dlqDepth,
        });
      }
    } catch {
      /* non-fatal */
    }
  }
}

export const transcoderDispatcher = new TranscoderDispatcher();
