/**
 * Faststart recovery worker.
 *
 * Opportunistically applies MP4 faststart (moov-atom relocation) to local
 * uploads that skipped it during the finalize chain (network blip, ffmpeg
 * crash, server restart, etc.).  Faststart is a BEST-EFFORT OPTIMIZATION
 * only — it is never a gate for broadcast admission or queue eligibility.
 *
 * Architecture:
 *   Each sweep() is non-blocking end-to-end:
 *     • DB queries carry per-call statement timeouts.
 *     • `dispatchOne()` is fire-and-forget — the ffmpeg job runs in a
 *       detached void-async block; sweep() returns immediately after
 *       dispatching all eligible candidates.
 *     • Concurrent faststart jobs are capped at MAX_CONCURRENT_FASTSTART.
 *     • A sweep-running guard prevents overlapping executions triggered by
 *       the worker supervisor and the orchestrator dead-air path.
 *     • `backfillPlaceholderDurations()` carries a per-item wall-clock
 *       timeout and skips items whose status guarantees the transcoder/
 *       faststart will update the duration itself.
 *     • A storage-probe circuit breaker prevents cascading DB saturation
 *       when storage is degraded.
 *
 * Failure handling:
 *   • Transient failures (ffmpeg error, download blip): retry up to
 *     MAX_ATTEMPTS; video airs as raw MP4 throughout.
 *   • Unrecoverable failures (CORRUPT_UPLOAD / SOURCE_MISSING): marked in
 *     DB, ops-alert fired, admin email sent; queue item STAYS ACTIVE and
 *     is auto-skipped at runtime by the orchestrator bad-URL cache.
 *   • Queue item deactivation: NEVER performed by this worker — deactivation
 *     is an operator action.  The runtime auto-skip handles all bad sources.
 */

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { storage } from "../../../infrastructure/storage.js";
import { logger as rootLogger } from "../../../infrastructure/logger.js";
import { registerNamedStore } from "../../../infrastructure/cache.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { sendAdminAlert } from "../../mail/mail.service.js";
import { runFaststart } from "../../transcoder/faststart.service.js";
import { probeUploadedDuration } from "../../transcoder/transcoder.service.js";

const v = schema.videosTable;
const q = schema.broadcastQueueTable;

const logger = rootLogger.child({ module: "faststart-recovery" });

// ── Tuning constants ──────────────────────────────────────────────────────────
const MAX_ATTEMPTS = 3;
/**
 * Maximum number of concurrent runFaststart() invocations.  Each call
 * downloads the full blob from storage, runs ffmpeg, and re-uploads —
 * a very heavy operation.  Capping at 2 prevents CPU / DB connection
 * starvation while still parallelising for the common case of a queue
 * flushed all at once after a deployment gap.
 */
const MAX_CONCURRENT_FASTSTART = 2;
/**
 * Maximum candidates fetched per sweep from the DB JOIN.  Bounds the
 * result set so a large queue never causes an unbounded result allocation
 * or holds shared row-locks across the full table.
 */
const CANDIDATE_QUERY_LIMIT = 20;
/**
 * Maximum rows updated per sweep in backfillDurationsFromVideoTable().
 * Limits the lock surface to a small batch per cycle; the next sweep
 * picks up remaining rows.
 */
const DURATION_BACKFILL_BATCH_LIMIT = 50;
/**
 * Wall-clock timeout for the candidate JOIN query.  Protects against
 * long-running sequential scans when the DB is under heavy write load.
 */
const CANDIDATE_QUERY_TIMEOUT_MS = 8_000;
/**
 * Wall-clock timeout for the fast-path duration UPDATE.
 */
const DURATION_UPDATE_TIMEOUT_MS = 8_000;
/**
 * Per-item wall-clock cap for probeUploadedDuration().
 * A large blob download + ffprobe can stall the sweep indefinitely
 * without this guard.
 */
const PROBE_ITEM_TIMEOUT_MS = 60_000;
/**
 * Wall-clock timeout for a storage headObject() used during backfill to
 * confirm whether a source blob is absent.
 */
const HEAD_OBJECT_TIMEOUT_MS = 6_000;
/** > faststart internal 15-min ffmpeg timeout — gives runFaststart() a
 *  reasonable grace period before the inFlight TTL evicts the entry. */
const INFLIGHT_TTL_MS = 30 * 60_000;
/** Max entries in `givenUpIds` before a full clear. */
const MAX_GIVEN_UP = 5_000;
/** Max entries in `probeSkipObjectPaths` before a full clear. */
const MAX_PROBE_SKIP = 5_000;

// ── Storage-probe circuit breaker ─────────────────────────────────────────────
/**
 * Opens when consecutive ffprobe-via-storage calls fail (download error,
 * storage timeout, etc.).  While open, backfillPlaceholderDurations() skips
 * all probes — preventing a degraded storage tier from saturating the DB
 * connection pool with large SUBSTRING reads on every 60-second sweep.
 *
 * Auto-closes after CIRCUIT_COOLDOWN_MS; the first successful probe resets
 * the counter entirely.
 */
const CIRCUIT_CONSECUTIVE_FAIL_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 5 * 60_000;
const probeCircuit = {
  failures: 0,
  openUntilMs: 0,
  isOpen(): boolean {
    return Date.now() < this.openUntilMs;
  },
  recordSuccess(): void {
    this.failures = 0;
    this.openUntilMs = 0;
  },
  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= CIRCUIT_CONSECUTIVE_FAIL_THRESHOLD) {
      this.openUntilMs = Date.now() + CIRCUIT_COOLDOWN_MS;
      logger.warn(
        { consecutiveFailures: this.failures, cooldownMs: CIRCUIT_COOLDOWN_MS },
        "faststart-recovery: storage probe circuit opened — skipping blob probes until cooldown expires",
      );
    }
  },
};

// ── In-process state ──────────────────────────────────────────────────────────
const attemptCounts = new Map<string, number>();
const givenUpIds = new Set<string>();
const inFlight = new Set<string>();
const inFlightSince = new Map<string, number>();
const probeSkipObjectPaths = new Set<string>();

// ── Diagnostics registration ──────────────────────────────────────────────────
registerNamedStore("faststart-recovery-given-up",   () => givenUpIds.size);
registerNamedStore("faststart-recovery-in-flight",  () => inFlight.size);
registerNamedStore("faststart-recovery-probe-skip", () => probeSkipObjectPaths.size);

/**
 * Set to true by stop() during graceful shutdown.  Checked at every
 * DB-call boundary inside sweep() so in-flight operations bail out
 * before the connection pool closes.
 */
let _faststartRecoveryStopped = false;

/**
 * Prevents overlapping sweep executions.  The worker supervisor fires on
 * a 60-second interval, but the broadcast orchestrator's dead-air path
 * also calls sweep() directly.  Without this guard both invocations run
 * in parallel and compete for the same inFlight slots, the same DB rows,
 * and the same ffmpeg CPU budget.
 */
let _sweepRunning = false;

// ── Per-stage timing interface ────────────────────────────────────────────────
interface StageTimings {
  fastDurationBackfillMs: number | null;
  probeDurationBackfillMs: number | null;
  candidateQueryMs: number | null;
  dispatchMs: number | null;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
interface RecoveryStats {
  enabled: boolean;
  installedAt: number | null;
  lastSweepAt: number | null;
  lastSweepCandidates: number;
  lastSweepDispatched: number;
  lastSweepSkippedConcurrencyCap: number;
  lastSweepStageMs: StageTimings;
  totalSweeps: number;
  totalDispatched: number;
  totalSucceeded: number;
  totalFailed: number;
  totalGivenUp: number;
  inFlightCount: number;
  probeCircuitOpenUntilMs: number;
  lastError: string | null;
  lastErrorAt: number | null;
}

const stats: RecoveryStats = {
  enabled: false,
  installedAt: null,
  lastSweepAt: null,
  lastSweepCandidates: 0,
  lastSweepDispatched: 0,
  lastSweepSkippedConcurrencyCap: 0,
  lastSweepStageMs: {
    fastDurationBackfillMs: null,
    probeDurationBackfillMs: null,
    candidateQueryMs: null,
    dispatchMs: null,
  },
  totalSweeps: 0,
  totalDispatched: 0,
  totalSucceeded: 0,
  totalFailed: 0,
  totalGivenUp: 0,
  inFlightCount: 0,
  probeCircuitOpenUntilMs: 0,
  lastError: null,
  lastErrorAt: null,
};

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Races a promise against a wall-clock timeout.  Rejects with a labelled
 * Error if the timeout fires first.  The timer is always cleared on
 * resolution to prevent timer leaks.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[timeout] ${label} exceeded ${ms} ms`)),
      ms,
    );
    // unref() so a long-sleeping timeout never keeps the process alive.
    if (timer.unref) timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── Candidate query ───────────────────────────────────────────────────────────

interface Candidate {
  videoId: string;
  objectPath: string;
  title: string;
}

function isUndefinedColumnError(err: unknown, columnName: string): boolean {
  let cursor: unknown = err;
  for (let i = 0; i < 5 && cursor; i++) {
    const e = cursor as { code?: string; message?: string; cause?: unknown };
    if (e.code === "42703") return true;
    if (
      e.message &&
      e.message.includes(`"${columnName}"`) &&
      e.message.toLowerCase().includes("does not exist")
    ) {
      return true;
    }
    cursor = e.cause;
  }
  return false;
}

async function findCandidatesOnce(
  faststartExpr: ReturnType<typeof sql>,
): Promise<Candidate[]> {
  // Active queue items joined to local-source videos that may benefit from
  // faststart moov-atom relocation.  Results are capped at CANDIDATE_QUERY_LIMIT
  // per sweep to prevent an unbounded result set on large queues; remaining
  // items are picked up by the next 60-second sweep cycle.
  //
  // HLS escape hatch: rows with hlsMasterUrl on either the queue row or
  // joined video row are already streaming via HLS; faststart is irrelevant.
  const rows = await db
    .select({
      videoId: v.id,
      objectPath: v.objectPath,
      title: v.title,
      faststartApplied: faststartExpr as ReturnType<typeof sql<boolean>>,
    })
    .from(q)
    .innerJoin(v, eq(q.videoId, v.id))
    .where(
      and(
        eq(q.isActive, true),
        eq(v.videoSource, "local"),
        isNotNull(v.objectPath),
        inArray(v.transcodingStatus, ["none", "queued", "encoding", "failed"]),
        isNull(v.hlsMasterUrl),
        isNull(q.hlsMasterUrl),
      ),
    )
    .limit(CANDIDATE_QUERY_LIMIT);

  const byId = new Map<string, Candidate>();
  for (const r of rows) {
    if (!r.objectPath) continue;
    if (r.faststartApplied === true) continue;
    byId.set(r.videoId, {
      videoId: r.videoId,
      objectPath: r.objectPath,
      title: r.title,
    });
  }
  return Array.from(byId.values());
}

async function findCandidates(): Promise<Candidate[]> {
  const run = async () => {
    try {
      return await findCandidatesOnce(
        sql<boolean>`COALESCE(${v.faststartApplied}, false)`,
      );
    } catch (err) {
      if (!isUndefinedColumnError(err, "faststart_applied")) throw err;
      logger.warn(
        "faststart-recovery: managed_videos.faststart_applied column not found " +
          "— retrying with fallback expression (run `pnpm --filter @workspace/db run push` to fix permanently)",
      );
      return await findCandidatesOnce(sql<boolean>`false`);
    }
  };
  return withTimeout(run(), CANDIDATE_QUERY_TIMEOUT_MS, "findCandidates");
}

// ── Dispatch (fire-and-forget) ────────────────────────────────────────────────

/**
 * Evict inFlight entries whose ffmpeg job appears to have hung (no
 * completion callback in INFLIGHT_TTL_MS).  Called at the start of
 * every dispatchOne() so stale entries are cleaned up lazily.
 */
function evictStaleInflight(): void {
  const now = Date.now();
  for (const [id, addedAt] of inFlightSince) {
    if (now - addedAt > INFLIGHT_TTL_MS) {
      inFlight.delete(id);
      inFlightSince.delete(id);
      logger.warn(
        { videoId: id, staleSecs: Math.round((now - addedAt) / 1000) },
        "faststart-recovery: evicted stale inFlight entry — likely hung ffmpeg; allowing retry",
      );
    }
  }
}

/**
 * Attempt to dispatch a faststart job for one candidate.
 *
 * Returns "dispatched" if a new fire-and-forget job was started,
 * "skipped_inflight" if already running, "skipped_giveup" if permanently
 * failed, "skipped_cap" if the concurrency cap is reached, or "skipped_stop"
 * if shutdown is in progress.
 *
 * IMPORTANT: the actual runFaststart() call runs in a detached void-async
 * block.  This function returns immediately without waiting for ffmpeg to
 * complete, ensuring sweep() is non-blocking regardless of file size or
 * transcoding duration.
 */
function dispatchOne(
  c: Candidate,
): "dispatched" | "skipped_inflight" | "skipped_giveup" | "skipped_cap" | "skipped_stop" {
  if (_faststartRecoveryStopped) return "skipped_stop";

  evictStaleInflight();

  if (inFlight.has(c.videoId)) return "skipped_inflight";
  if (givenUpIds.has(c.videoId)) return "skipped_giveup";

  const prev = attemptCounts.get(c.videoId) ?? 0;
  if (prev >= MAX_ATTEMPTS) {
    stats.totalGivenUp += 1;
    attemptCounts.delete(c.videoId);
    if (givenUpIds.size >= MAX_GIVEN_UP) {
      logger.warn(
        { cap: MAX_GIVEN_UP },
        "faststart-recovery: givenUpIds cap reached — clearing set; candidates re-evaluated",
      );
      givenUpIds.clear();
    }
    givenUpIds.add(c.videoId);
    logger.error(
      { videoId: c.videoId, title: c.title, attempts: prev },
      "faststart-recovery: max attempts reached — giving up until process restart",
    );
    void import("../../../infrastructure/sentry.js")
      .then(({ captureEvent }) =>
        captureEvent(
          `Faststart recovery gave up on "${c.title ?? c.videoId}" after ${prev} attempts`,
          "error",
          { videoId: c.videoId, title: c.title, attempts: prev, maxAttempts: MAX_ATTEMPTS },
        ),
      )
      .catch(() => {});
    return "skipped_giveup";
  }

  // Enforce the concurrency cap AFTER the give-up check so permanently-failed
  // items don't consume a slot and block healthy candidates.
  if (inFlight.size >= MAX_CONCURRENT_FASTSTART) return "skipped_cap";

  inFlight.add(c.videoId);
  inFlightSince.set(c.videoId, Date.now());
  attemptCounts.set(c.videoId, prev + 1);
  stats.totalDispatched += 1;
  stats.inFlightCount = inFlight.size;

  logger.info(
    { videoId: c.videoId, title: c.title, attempt: prev + 1, inFlightTotal: inFlight.size },
    "faststart-recovery: dispatching runFaststart (fire-and-forget)",
  );

  // ── Fire-and-forget ────────────────────────────────────────────────────────
  // The sweep() caller returns immediately.  runFaststart() owns its own
  // internal 15-min ffmpeg timeout; the INFLIGHT_TTL_MS guard in
  // evictStaleInflight() acts as a belt-and-suspenders eviction for truly
  // hung jobs that never call their finally block.
  void (async () => {
    const jobStart = Date.now();
    try {
      await runFaststart(c.videoId, c.objectPath, { skipStatusUpdate: false });
      stats.totalSucceeded += 1;
      attemptCounts.delete(c.videoId);
      logger.info(
        {
          videoId: c.videoId,
          title: c.title,
          elapsedMs: Date.now() - jobStart,
        },
        "faststart-recovery: runFaststart succeeded — row will be admitted on next reload",
      );
    } catch (err) {
      stats.totalFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.lastError = msg;
      stats.lastErrorAt = Date.now();

      // ── Permanent-failure fast-path ──────────────────────────────────────
      // CORRUPT_UPLOAD (moov_absent, structure_invalid, etc.) and
      // SOURCE_MISSING are unrecoverable — no amount of retrying will fix a
      // file with no moov atom or a blob that no longer exists in storage.
      // Skip all remaining attempts immediately, mark the video record so
      // the operator sees a clear error, and add to givenUpIds so this video
      // never enters the candidate set again.
      const errCode = (err as { code?: string } | null)?.code;
      const errKind = (err as { kind?: string } | null)?.kind ?? null;
      const isUnrecoverable = errCode === "CORRUPT_UPLOAD" || errCode === "SOURCE_MISSING";

      if (isUnrecoverable) {
        givenUpIds.add(c.videoId);
        attemptCounts.delete(c.videoId);
        stats.totalGivenUp += 1;
        logger.error(
          { err, videoId: c.videoId, title: c.title, errCode, errKind, attempt: prev + 1, elapsedMs: Date.now() - jobStart },
          "faststart-recovery: unrecoverable container error — marking CORRUPT_SOURCE and skipping all future attempts",
        );

        // ── 1. Persist permanent failure to DB ─────────────────────────────
        // Include transcodingErrorKind so the retry-repair endpoint can
        // correctly reject moov_absent items (re-running faststart on a file
        // with no moov will always fail — re-upload is the only fix), and so
        // the admin panel shows the specific diagnostic rather than a generic
        // "CORRUPT_SOURCE" badge with no actionable detail.
        void db
          .update(v)
          .set({
            transcodingStatus: "failed",
            transcodingErrorCode: "CORRUPT_SOURCE",
            transcodingErrorKind: errKind,
            transcodingErrorMessage: msg.slice(0, 2048),
          })
          .where(eq(v.id, c.videoId))
          .catch((dbErr: unknown) =>
            logger.warn(
              { err: dbErr, videoId: c.videoId },
              "faststart-recovery: failed to write CORRUPT_SOURCE to DB (non-fatal)",
            ),
          );

        // ── 2. Broadcast queue item STAYS ACTIVE ───────────────────────────
        // Per the no-blocking-gates architecture the queue item is NOT
        // deactivated here.  The orchestrator's bad-URL cache and runtime
        // auto-skip advance past unresolvable sources cleanly — deactivation
        // is an operator action, not a worker action.  This preserves the
        // 24/7 broadcast SLA: other items in the queue continue to air while
        // the operator decides whether to re-upload this file.
        logger.warn(
          { videoId: c.videoId, errCode, errKind, attempt: prev + 1 },
          "faststart-recovery: unrecoverable container — queue item remains active; " +
          "orchestrator will auto-skip this source at runtime; re-upload to fully restore",
        );

        // ── 3. SSE ops-alert — surfaces a dashboard banner immediately ──────
        const alertTitle =
          errKind === "moov_absent"
            ? "Video unplayable — re-upload required"
            : "Video container corrupt — re-upload required";
        const alertMessage =
          errKind === "moov_absent"
            ? `"${c.title ?? c.videoId}" has media data but no moov atom. The recording was interrupted before it could finish writing. The file cannot be decoded by any player. The broadcast queue item remains active and will be auto-skipped at runtime — re-upload the original source file to fully restore it.`
            : `"${c.title ?? c.videoId}" has a permanently corrupt container — all five remux recovery strategies were exhausted. The broadcast queue item remains active and will be auto-skipped at runtime — re-upload the original source file.`;
        adminEventBus.push("ops-alert", {
          code: "FASTSTART_UNRECOVERABLE",
          severity: "error",
          title: alertTitle,
          message: alertMessage,
          videoId: c.videoId,
        });

        // ── 4. Admin email — out-of-band alert for operators not on dashboard ─
        void sendAdminAlert({
          severity: "error",
          subject: `${alertTitle}: "${c.title ?? c.videoId}"`,
          body:
            `${alertMessage}\n\n` +
            `Video ID: ${c.videoId}\n` +
            `Error code: ${errCode ?? "unknown"}${errKind ? ` (${errKind})` : ""}\n` +
            `Faststart attempts before giving up: ${prev + 1}`,
        }).catch((mailErr: unknown) =>
          logger.warn({ err: mailErr, videoId: c.videoId }, "faststart-recovery: admin alert email failed (non-fatal)"),
        );

        adminEventBus.push("videos-library-updated", {
          videoId: c.videoId,
          reason: "faststart-unrecoverable",
        });
        adminEventBus.push("broadcast-queue-updated", {
          videoId: c.videoId,
          reason: "faststart-unrecoverable",
        });
      } else {
        logger.warn(
          { err, videoId: c.videoId, title: c.title, attempt: prev + 1, elapsedMs: Date.now() - jobStart },
          "faststart-recovery: runFaststart failed (will retry up to MAX_ATTEMPTS)",
        );
      }
    } finally {
      inFlight.delete(c.videoId);
      inFlightSince.delete(c.videoId);
      stats.inFlightCount = inFlight.size;
    }
  })();

  return "dispatched";
}

// ── Fast-path duration backfill ───────────────────────────────────────────────

/**
 * Propagates real durations already stored in managed_videos directly into
 * broadcast_queue rows that still carry the 1800-s upload-time placeholder.
 *
 * No ffprobe or storage access needed — purely a DB UPDATE with a LIMIT so
 * each sweep only locks a small batch of rows.  Fires broadcast-queue-updated
 * after each batch so the orchestrator picks up the corrected slot length
 * immediately.
 *
 * Returns the number of rows corrected.
 */
async function backfillDurationsFromVideoTable(): Promise<number> {
  try {
    const result = await withTimeout(
      db.execute(sql`
        UPDATE broadcast_queue q
        SET    duration_secs = ROUND(v.duration::numeric)
        FROM   managed_videos v
        WHERE  q.video_id = v.id
          AND  q.is_active = true
          AND  q.duration_secs = 1800
          AND  v.duration IS NOT NULL
          AND  v.duration ~ '^[0-9]+(\\.[0-9]+)?$'
          AND  ROUND(v.duration::numeric) > 5
          AND  ROUND(v.duration::numeric) != 1800
          AND  q.id IN (
               SELECT q2.id FROM broadcast_queue q2
               JOIN   managed_videos v2 ON q2.video_id = v2.id
               WHERE  q2.is_active = true
                 AND  q2.duration_secs = 1800
                 AND  v2.duration IS NOT NULL
                 AND  v2.duration ~ '^[0-9]+(\\.[0-9]+)?$'
                 AND  ROUND(v2.duration::numeric) > 5
                 AND  ROUND(v2.duration::numeric) != 1800
               LIMIT  ${DURATION_BACKFILL_BATCH_LIMIT}
               )
        RETURNING q.id AS queue_item_id, q.video_id, ROUND(v.duration::numeric) AS new_dur_secs
      `),
      DURATION_UPDATE_TIMEOUT_MS,
      "backfillDurationsFromVideoTable",
    );
    const rows = result.rows as Array<{
      queue_item_id: string;
      video_id: string;
      new_dur_secs: number;
    }>;
    if (rows.length > 0) {
      logger.info(
        { count: rows.length },
        "faststart-recovery: fast-path duration backfill propagated real durations from video table → queue",
      );
      for (const row of rows) {
        adminEventBus.push("broadcast-queue-updated", {
          reason: "duration-backfill-from-video-table",
          videoId: row.video_id,
          queueItemId: row.queue_item_id,
          newDurSecs: row.new_dur_secs,
        });
      }
    }
    return rows.length;
  } catch (err) {
    logger.warn(
      { err },
      "faststart-recovery: fast-path duration backfill from video table failed (non-fatal)",
    );
    return 0;
  }
}

// ── Slow-path duration backfill (ffprobe) ─────────────────────────────────────

/**
 * Backfills broadcast_queue rows still carrying the 1800-s placeholder on
 * BOTH the queue row AND the joined managed_videos row by running ffprobe
 * on the raw blob.
 *
 * Key design decisions to avoid hangs:
 *
 *   1. Status filter: items in 'none' or 'queued' status are SKIPPED — they
 *      will have faststart or the transcoder update their duration soon.
 *      Only 'ready', 'hls_ready', and 'failed' items reach ffprobe here.
 *
 *   2. Circuit breaker: if storage calls are repeatedly failing (network
 *      degradation, PG I/O pressure), the circuit opens and all probes are
 *      skipped for CIRCUIT_COOLDOWN_MS.  This prevents a degraded storage
 *      tier from saturating the DB connection pool with SUBSTRING reads.
 *
 *   3. Per-item timeout: each probeUploadedDuration call is capped at
 *      PROBE_ITEM_TIMEOUT_MS.  A large blob download that stalls mid-stream
 *      will be abandoned rather than hanging the sweep indefinitely.
 *
 *   4. headObject-first: before downloading the full blob, a lightweight
 *      HEAD request confirms the object actually exists in storage.  This
 *      prevents a full download attempt for missing/corrupt blobs.
 *
 *   5. probeSkipObjectPaths: confirmed-absent blobs are cached for the
 *      process lifetime so they are never re-downloaded on subsequent sweeps.
 */
async function backfillPlaceholderDurations(): Promise<void> {
  // Status filter: skip items whose pipeline stage guarantees the duration
  // will be written by a more authoritative path (faststart / transcoder).
  // 'none' and 'queued' → faststart is about to run and will call ffprobe.
  // 'encoding' → HLS transcoder is running and will update duration on completion.
  // Only 'ready', 'hls_ready', and 'failed' need manual backfill here.
  const probableStatuses = ["ready", "hls_ready", "failed"] as const;

  let rows: Array<{
    queueItemId: string;
    videoId: string;
    objectPath: string | null;
    title: string;
  }>;
  try {
    rows = await withTimeout(
      db
        .select({
          queueItemId: q.id,
          videoId: v.id,
          objectPath: v.objectPath,
          title: q.title,
        })
        .from(q)
        .innerJoin(v, eq(q.videoId, v.id))
        .where(
          and(
            eq(q.isActive, true),
            eq(q.durationSecs, 1800),
            eq(v.duration, "1800"),
            isNotNull(v.objectPath),
            inArray(v.transcodingStatus, [...probableStatuses]),
          ),
        )
        .limit(10),
      CANDIDATE_QUERY_TIMEOUT_MS,
      "backfillPlaceholderDurations-query",
    );
  } catch (err) {
    logger.warn({ err }, "faststart-recovery: placeholder-duration backfill query failed");
    return;
  }

  if (rows.length === 0) return;

  // Circuit breaker — skip all probes while storage is degraded.
  if (probeCircuit.isOpen()) {
    logger.debug(
      { openUntilMs: probeCircuit.openUntilMs },
      "faststart-recovery: storage probe circuit open — skipping blob probes this sweep",
    );
    stats.probeCircuitOpenUntilMs = probeCircuit.openUntilMs;
    return;
  }

  // Deduplicate by objectPath within this sweep (handles DUPLICATE_ACTIVE_VIDEO).
  // Also filter already-confirmed-absent paths.
  const seenInThisSweep = new Set<string>();
  const filteredRows = rows.filter((row) => {
    if (!row.objectPath) return false;
    if (row.objectPath.startsWith("http://") || row.objectPath.startsWith("https://")) {
      logger.warn(
        { videoId: row.videoId, objectPath: row.objectPath },
        "faststart-recovery: skipping duration backfill for absolute-URL objectPath (data quality issue)",
      );
      return false;
    }
    if (probeSkipObjectPaths.has(row.objectPath)) return false;
    if (seenInThisSweep.has(row.objectPath)) return false;
    seenInThisSweep.add(row.objectPath);
    return true;
  });

  if (filteredRows.length === 0) return;

  logger.info(
    { totalRows: rows.length, uniqueToProbe: filteredRows.length },
    "faststart-recovery: probing duration for placeholder items",
  );

  for (const row of filteredRows) {
    if (_faststartRecoveryStopped) break;
    try {
      // ── headObject gate ──────────────────────────────────────────────────
      // Lightweight existence check before committing to a full blob download.
      // A missing or zero-size blob is added to probeSkipObjectPaths so it is
      // never re-downloaded on future sweeps.
      const s = storage();
      if (s.enabled) {
        let head: { exists?: boolean; contentLength?: number | null } | null;
        try {
          head = await withTimeout(
            s.headObject(row.objectPath!),
            HEAD_OBJECT_TIMEOUT_MS,
            `headObject(${row.objectPath})`,
          );
        } catch {
          head = null; // transient — allow the probe attempt below
        }
        if (head?.exists === false) {
          if (probeSkipObjectPaths.size >= MAX_PROBE_SKIP) {
            logger.warn({ cap: MAX_PROBE_SKIP }, "faststart-recovery: probeSkipObjectPaths cap reached — clearing");
            probeSkipObjectPaths.clear();
          }
          probeSkipObjectPaths.add(row.objectPath!);
          logger.warn(
            { videoId: row.videoId, objectPath: row.objectPath },
            "faststart-recovery: source object not found in storage — skipping in all future sweeps",
          );
          probeCircuit.recordFailure();
          continue;
        }
      }

      // ── ffprobe with per-item wall-clock timeout ──────────────────────────
      // probeUploadedDuration() downloads the entire blob to a tmp file before
      // running ffprobe.  The timeout abandons the download if it stalls so
      // the sweep is never blocked longer than PROBE_ITEM_TIMEOUT_MS per item.
      let secs: number | null;
      try {
        secs = await withTimeout(
          probeUploadedDuration(row.objectPath!),
          PROBE_ITEM_TIMEOUT_MS,
          `probeUploadedDuration(${row.videoId})`,
        );
        probeCircuit.recordSuccess();
        stats.probeCircuitOpenUntilMs = probeCircuit.openUntilMs;
      } catch (probeErr) {
        const isTimeout =
          probeErr instanceof Error && probeErr.message.startsWith("[timeout]");
        logger.warn(
          { err: probeErr, videoId: row.videoId, isTimeout },
          isTimeout
            ? "faststart-recovery: duration probe timed out — skipping item this sweep"
            : "faststart-recovery: duration probe failed — skipping item this sweep",
        );
        probeCircuit.recordFailure();
        stats.probeCircuitOpenUntilMs = probeCircuit.openUntilMs;
        continue;
      }

      if (secs == null || secs < 5) {
        // Check whether the blob is absent from storage.
        const s2 = storage();
        if (s2.enabled) {
          const head2 = await withTimeout(
            s2.headObject(row.objectPath!),
            HEAD_OBJECT_TIMEOUT_MS,
            "headObject-post-probe",
          ).catch(() => null);
          if (head2?.exists === false) {
            if (probeSkipObjectPaths.size >= MAX_PROBE_SKIP) {
              probeSkipObjectPaths.clear();
            }
            probeSkipObjectPaths.add(row.objectPath!);
            logger.warn(
              { videoId: row.videoId, objectPath: row.objectPath },
              "faststart-recovery: source object missing after probe returned null — skipping in future sweeps",
            );
            probeCircuit.recordFailure();
            stats.probeCircuitOpenUntilMs = probeCircuit.openUntilMs;
          }
        }
        continue;
      }

      const rounded = Math.round(secs);

      // Two separate updates — no transaction across network calls.
      // Each is small, fast, and non-fatal if it fails.
      await db
        .update(v)
        .set({ duration: String(rounded) })
        .where(eq(v.id, row.videoId))
        .catch((err: unknown) =>
          logger.warn({ err, videoId: row.videoId }, "faststart-recovery: managed_videos duration update failed"),
        );

      await db
        .update(q)
        .set({ durationSecs: rounded })
        .where(eq(q.id, row.queueItemId))
        .catch((err: unknown) =>
          logger.warn({ err, queueItemId: row.queueItemId }, "faststart-recovery: broadcast_queue duration update failed"),
        );

      logger.info(
        { videoId: row.videoId, queueItemId: row.queueItemId, title: row.title, secs: rounded },
        "faststart-recovery: duration backfill corrected placeholder",
      );
      adminEventBus.push("broadcast-queue-updated", {
        reason: "duration-backfill-corrected",
        videoId: row.videoId,
        queueItemId: row.queueItemId,
        newDurSecs: rounded,
      });
    } catch (err) {
      logger.warn(
        { err, videoId: row.videoId, title: row.title },
        "faststart-recovery: duration backfill item failed (non-fatal)",
      );
    }
  }
}

// ── Public worker interface ───────────────────────────────────────────────────

export const faststartRecoveryWorker = {
  /**
   * Signal sweep() to abort at the next DB-call checkpoint.  Called during
   * graceful shutdown before the connection pool closes.
   */
  stop(): void {
    _faststartRecoveryStopped = true;
  },

  /**
   * Run one recovery sweep.
   *
   * Non-blocking design:
   *   • Each DB call is wrapped in withTimeout() so the sweep never waits
   *     indefinitely on a slow query or lock.
   *   • dispatchOne() is fire-and-forget — runFaststart() runs in a detached
   *     void-async block; this method returns immediately after scheduling.
   *   • A sweep-running guard prevents overlap with the orchestrator dead-air
   *     path, which also calls sweep() directly.
   *   • Per-stage elapsed times are logged so tracing identifies exactly where
   *     time is spent (DB, storage probe, ffprobe, dispatch scheduling).
   */
  async sweep(): Promise<void> {
    if (_faststartRecoveryStopped) return;

    // ── Concurrency guard ──────────────────────────────────────────────────
    // Prevents overlapping sweeps when the supervisor fires on its 60-s
    // interval while the orchestrator dead-air path also calls sweep().
    if (_sweepRunning) {
      logger.debug("faststart-recovery: sweep already running — skipping concurrent invocation");
      return;
    }
    _sweepRunning = true;

    const sweepStart = Date.now();
    stats.totalSweeps += 1;
    stats.lastSweepAt = sweepStart;
    stats.lastSweepStageMs = {
      fastDurationBackfillMs: null,
      probeDurationBackfillMs: null,
      candidateQueryMs: null,
      dispatchMs: null,
    };

    try {
      // ── Stage 1: Fast-path duration backfill (pure DB UPDATE) ────────────
      // Propagates real durations from managed_videos → broadcast_queue.
      // No ffprobe, no storage access.  Fires immediately so the orchestrator
      // reloads with correct slot lengths before the video ends.
      const t1 = Date.now();
      await backfillDurationsFromVideoTable();
      stats.lastSweepStageMs.fastDurationBackfillMs = Date.now() - t1;

      if (_faststartRecoveryStopped) return;

      // ── Stage 2: Slow-path duration backfill (ffprobe via storage) ───────
      // Only for items where managed_videos ALSO still has the 1800-s placeholder.
      // Skips 'none'/'queued'/'encoding' — those will be updated by faststart/
      // transcoder in their own flows.  Circuit breaker prevents saturation.
      const t2 = Date.now();
      await backfillPlaceholderDurations();
      stats.lastSweepStageMs.probeDurationBackfillMs = Date.now() - t2;

      if (_faststartRecoveryStopped) return;

      // ── Stage 3: Faststart candidate query ───────────────────────────────
      const t3 = Date.now();
      let candidates: Candidate[];
      try {
        candidates = await findCandidates();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stats.lastError = msg;
        stats.lastErrorAt = Date.now();
        logger.warn({ err }, "faststart-recovery: candidate query failed");
        return;
      }
      stats.lastSweepStageMs.candidateQueryMs = Date.now() - t3;
      stats.lastSweepCandidates = candidates.length;
      stats.lastSweepDispatched = 0;
      stats.lastSweepSkippedConcurrencyCap = 0;

      if (candidates.length === 0) {
        logger.debug(
          { stageMs: stats.lastSweepStageMs, totalMs: Date.now() - sweepStart },
          "faststart-recovery: sweep complete — no candidates",
        );
        return;
      }

      // ── Stage 4: Dispatch (fire-and-forget per candidate) ────────────────
      // dispatchOne() returns immediately; the actual ffmpeg work runs in a
      // detached void-async block.  Sweep always completes in O(candidates)
      // time, not O(candidates × ffmpeg-duration).
      const t4 = Date.now();
      for (const c of candidates) {
        if (_faststartRecoveryStopped) break;
        const result = dispatchOne(c);
        if (result === "dispatched") {
          stats.lastSweepDispatched += 1;
        } else if (result === "skipped_cap") {
          stats.lastSweepSkippedConcurrencyCap += 1;
          logger.debug(
            { videoId: c.videoId, cap: MAX_CONCURRENT_FASTSTART },
            "faststart-recovery: concurrency cap reached — candidate deferred to next sweep",
          );
        }
      }
      stats.lastSweepStageMs.dispatchMs = Date.now() - t4;

      logger.info(
        {
          candidates: candidates.length,
          dispatched: stats.lastSweepDispatched,
          skippedCap: stats.lastSweepSkippedConcurrencyCap,
          inFlight: inFlight.size,
          stageMs: stats.lastSweepStageMs,
          totalMs: Date.now() - sweepStart,
        },
        "faststart-recovery: sweep complete",
      );
    } finally {
      _sweepRunning = false;
    }
  },

  markEnabled(): void {
    stats.enabled = true;
    stats.installedAt = Date.now();
  },

  getStats(): Readonly<RecoveryStats> {
    return { ...stats, inFlightCount: inFlight.size };
  },

  /** Test/admin-only: reset attempt counters so retried items get a fresh chance. */
  resetAttempts(videoId?: string): void {
    if (videoId) {
      attemptCounts.delete(videoId);
      givenUpIds.delete(videoId);
    } else {
      attemptCounts.clear();
      givenUpIds.clear();
    }
  },

  /** Diagnostic: number of permanently-given-up videos this process lifetime. */
  getGivenUpCount(): number {
    return givenUpIds.size;
  },

  /** Diagnostic: number of active in-flight faststart jobs. */
  getInFlightCount(): number {
    return inFlight.size;
  },

  /** Diagnostic: current state of the storage-probe circuit breaker. */
  getProbeCircuitState(): { isOpen: boolean; openUntilMs: number; consecutiveFailures: number } {
    return {
      isOpen: probeCircuit.isOpen(),
      openUntilMs: probeCircuit.openUntilMs,
      consecutiveFailures: probeCircuit.failures,
    };
  },
};
