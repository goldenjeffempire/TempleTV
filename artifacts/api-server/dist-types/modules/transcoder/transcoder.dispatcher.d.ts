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
declare class TranscoderDispatcher {
    private timer;
    private running;
    private stopped;
    /**
     * Set to true only by start(). Guards nudge() so that an explicit
     * TRANSCODER_DISABLE=1 configuration — which skips start() entirely —
     * cannot be bypassed by callers invoking nudge() after a new job is
     * enqueued. Without this flag, stopped=false (the default) would allow
     * nudge() to call tick() and re-arm the poll timer even when the
     * dispatcher was intentionally never started.
     */
    private started;
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
    private ffmpegAvailable;
    private ffmpegRecheckTimer;
    private static readonly FFMPEG_RECHECK_MS;
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
    private storageErrorStreak;
    private storageCircuitOpenUntil;
    private static readonly STORAGE_ERROR_THRESHOLD;
    private static readonly STORAGE_REOPEN_DELAY_MS;
    /**
     * Open the ffmpeg circuit breaker. Logs a CRITICAL warning and schedules
     * periodic re-checks so the dispatcher self-heals when ffmpeg is installed.
     */
    private openFfmpegCircuit;
    start(): void;
    private purgeOrphanedScratchDirs;
    private partialRecoveryCounter;
    private static readonly PARTIAL_RECOVERY_TICKS;
    private autoRetryCounter;
    private stuckJobsCounter;
    private static readonly STUCK_JOBS_TICKS;
    private static readonly EARLY_STUCK_MS;
    private static readonly PROGRESS_STALE_MS;
    private static readonly JOB_START_GRACE_MS;
    private scratchGcCounter;
    private static readonly SCRATCH_GC_TICKS;
    private lastHeartbeatAt;
    private currentJobId;
    private currentJobVideoId;
    private lastCompletedAt;
    private lastCompletedJobId;
    private lastCompletedStatus;
    private resetOrphanedJobs;
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
    private recoverPartialSuccessVideos;
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
    private sweepRecoverableFailed;
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
    };
    stop(): void;
    /**
     * Shared tick used by start() and nudge(). Runs one dispatch cycle then
     * re-arms the timer at the normal TRANSCODER_POLL_MS cadence.
     */
    private tick;
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
    nudge(): void;
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
    private resetStuckJobs;
    runOnce(): Promise<{
        ran: boolean;
    }>;
}
export declare const transcoderDispatcher: TranscoderDispatcher;
export {};
