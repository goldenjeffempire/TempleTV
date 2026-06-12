/**
 * Faststart recovery worker.
 *
 * Closes the v1/v2 admission gap that produces "Off Air" even though the
 * v1 `/broadcast/guide` reports a currently-playing local MP4.
 *
 * Root cause:
 *   `queueRepo.loadActive()` (broadcast-v2/repository/queue.repo.ts) enforces
 *   STRICT BROADCAST POLICY — for managed_videos rows where
 *   `transcoding_status ∈ (none, queued, encoding)` it admits the row ONLY
 *   when `faststart_applied = true`. Un-faststarted MP4s have the moov atom
 *   at EOF and trigger SKIP_PENDING dead-air loops on every player surface
 *   that binds them.
 *
 *   When faststart did not run during the upload-finalize chain (network
 *   blip, ffmpeg crash, restart between finalize and the void runFaststart
 *   call, etc.) the row sits in the broadcast_queue forever, invisible to
 *   v2, and the channel reports Off Air despite a perfectly good source
 *   blob in object storage.
 *
 * This worker:
 *   1. Periodically scans for active queue items whose joined managed_videos
 *      row is local-source, has an objectPath, has faststart_applied=false,
 *      and is in a status that requires faststart for admission.
 *   2. Fires `runFaststart()` for each candidate (fire-and-forget — the
 *      function already handles status restore on failure).
 *   3. Enforces an in-memory attempt cap (3) and in-flight set so we never
 *      stampede ffmpeg or loop on a permanently corrupt source.
 *
 * Safety:
 *   - Attempt counters reset on process restart by design — operators can
 *     re-trigger by redeploying, and ffmpeg cost is bounded by FASTSTART
 *     timeout (15 min) anyway. Persisting counters would require a schema
 *     migration that the column-resilience hot path in queue.repo.ts proves
 *     is risky during incremental deploys.
 *   - Never throws into the supervisor — every error is logged and swallowed
 *     so a single corrupt file does not stop recovery for the rest.
 *   - Uses the same runFaststart entry point that admin "Re-apply faststart"
 *     uses, so any future hardening to that function applies here too.
 */

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { storage } from "../../../infrastructure/storage.js";
import { logger as rootLogger } from "../../../infrastructure/logger.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { runFaststart } from "../../transcoder/faststart.service.js";
import { probeUploadedDuration } from "../../transcoder/transcoder.service.js";

const v = schema.videosTable;
const q = schema.broadcastQueueTable;

const logger = rootLogger.child({ service: "faststart-recovery" });

const MAX_ATTEMPTS = 3;
const attemptCounts = new Map<string, number>();
/**
 * Permanently given-up video IDs for this process lifetime.
 * Using a separate Set (instead of keeping MAX_ATTEMPTS+1 in attemptCounts)
 * allows the attemptCounts Map to be fully cleared for given-up entries,
 * preventing unbounded Map growth when many corrupt-upload videos accumulate
 * over a long-running deployment.
 */
const givenUpIds = new Set<string>();
const inFlight = new Set<string>();
// Tracks when each videoId was added to inFlight so stale entries (hung ffmpeg
// jobs that never resolve) can be evicted.  Without this TTL, a zombie ffmpeg
// process that never exits would block all future recovery attempts for that
// video until the process is restarted.
const inFlightSince = new Map<string, number>();
const INFLIGHT_TTL_MS = 30 * 60_000; // 30 minutes — > faststart internal timeout

/**
 * objectPaths that have been confirmed absent from storage (SOURCE_MISSING) in a
 * prior sweep.  Skipping them prevents re-downloading a large missing blob on
 * every 60-second cycle.  Cleared on process restart so a re-uploaded source is
 * retried automatically on the next deploy.
 */
const probeSkipObjectPaths = new Set<string>();

/**
 * Set to true by stop() when shutdown begins.  Checked at every DB-call
 * boundary inside sweep() so in-flight operations bail out before the
 * connection pool is closed.
 */
let _faststartRecoveryStopped = false;

interface RecoveryStats {
  enabled: boolean;
  installedAt: number | null;
  lastSweepAt: number | null;
  lastSweepCandidates: number;
  lastSweepDispatched: number;
  totalSweeps: number;
  totalDispatched: number;
  totalSucceeded: number;
  totalFailed: number;
  totalGivenUp: number;
  lastError: string | null;
  lastErrorAt: number | null;
}

const stats: RecoveryStats = {
  enabled: false,
  installedAt: null,
  lastSweepAt: null,
  lastSweepCandidates: 0,
  lastSweepDispatched: 0,
  totalSweeps: 0,
  totalDispatched: 0,
  totalSucceeded: 0,
  totalFailed: 0,
  totalGivenUp: 0,
  lastError: null,
  lastErrorAt: null,
};

interface Candidate {
  videoId: string;
  objectPath: string;
  title: string;
}

async function findCandidatesOnce(
  faststartExpr: ReturnType<typeof sql>,
): Promise<Candidate[]> {
  // Active queue items joined to local-source videos that v2.loadActive()
  // would reject for missing faststart. Mirrors the WHERE-clause logic in
  // queue.repo.ts:loadActive — including the HLS escape hatches (a row
  // with hlsMasterUrl on either the queue row OR the joined video row is
  // already admitted by loadActive regardless of faststart, so we MUST
  // exclude it here or we will trigger needless ffmpeg work). Keep both
  // in sync if the admission policy changes.
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
        inArray(v.transcodingStatus, ["none", "queued", "encoding"]),
        // Exclude rows already admitted by loadActive() via the HLS
        // escape hatches — both the joined video's hlsMasterUrl and the
        // queue-row-level hlsMasterUrl (operator-set / live-ingest).
        isNull(v.hlsMasterUrl),
        isNull(q.hlsMasterUrl),
      ),
    );
  // de-dupe by videoId and apply the faststartApplied filter in JS so the
  // schema-guard fallback (literal `false` expression) behaves identically
  // to the live column path.
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

async function findCandidates(): Promise<Candidate[]> {
  // Schema-resilience: mirror queue.repo.ts:loadActive's pattern of
  // catching SQLSTATE 42703 on managed_videos.faststart_applied so a
  // partially-migrated DB doesn't break recovery. Without this guard the
  // worker would log a query failure every 60 s on pre-migration DBs.
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
}

async function dispatchOne(c: Candidate): Promise<boolean> {
  // Evict stale inFlight entries before the membership check — a zombie ffmpeg
  // that never exits (or an unhandled rejection that skipped the finally block)
  // would otherwise block this video indefinitely until process restart.
  const now = Date.now();
  for (const [id, addedAt] of inFlightSince) {
    if (now - addedAt > INFLIGHT_TTL_MS) {
      inFlight.delete(id);
      inFlightSince.delete(id);
      logger.warn(
        { videoId: id },
        "faststart-recovery: evicted stale inFlight entry (> 30 min) — likely hung ffmpeg job; allowing retry",
      );
    }
  }

  if (inFlight.has(c.videoId)) return false;
  // Check the permanently-given-up set first.  Entries here had their
  // attemptCounts entry deleted to keep the Map bounded; re-checking
  // `attemptCounts.get` would return 0 and incorrectly allow a retry.
  if (givenUpIds.has(c.videoId)) return false;
  const prev = attemptCounts.get(c.videoId) ?? 0;
  if (prev >= MAX_ATTEMPTS) {
    // Move from the attempt-counter Map to the dedicated given-up Set.
    // Deleting from attemptCounts keeps that Map bounded: entries are
    // only present for videos actively being retried (0–MAX_ATTEMPTS-1),
    // never for the potentially large population of permanently-failed ones.
    stats.totalGivenUp += 1;
    attemptCounts.delete(c.videoId);
    givenUpIds.add(c.videoId);
    logger.error(
      { videoId: c.videoId, title: c.title, attempts: prev },
      "faststart-recovery: max attempts reached — giving up until process restart; video excluded from broadcast",
    );
    void import("../../../infrastructure/sentry.js").then(({ captureEvent }) =>
      captureEvent(
        `Faststart recovery gave up on "${c.title ?? c.videoId}" after ${prev} attempts — video excluded from broadcast until process restart`,
        "error",
        { videoId: c.videoId, title: c.title, attempts: prev, maxAttempts: MAX_ATTEMPTS },
      ),
    ).catch(() => {});
    return false;
  }
  inFlight.add(c.videoId);
  inFlightSince.set(c.videoId, Date.now());
  attemptCounts.set(c.videoId, prev + 1);
  stats.totalDispatched += 1;
  logger.info(
    { videoId: c.videoId, title: c.title, attempt: prev + 1 },
    "faststart-recovery: dispatching runFaststart for stuck queue item",
  );

  try {
    // skipStatusUpdate=false so the row transitions through
    // processing → ready and re-enters the v2 admission window.
    // runFaststart fires broadcast-queue-updated on success which
    // triggers orchestrator.reload() via the bus bridge.
    await runFaststart(c.videoId, c.objectPath, { skipStatusUpdate: false });
    stats.totalSucceeded += 1;
    attemptCounts.delete(c.videoId);
    logger.info(
      { videoId: c.videoId, title: c.title },
      "faststart-recovery: runFaststart succeeded — row will be admitted on next reload",
    );
  } catch (err) {
    stats.totalFailed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    stats.lastError = msg;
    stats.lastErrorAt = Date.now();
    logger.warn(
      { err, videoId: c.videoId, title: c.title, attempt: prev + 1 },
      "faststart-recovery: runFaststart failed (will retry up to MAX_ATTEMPTS)",
    );
  } finally {
    inFlight.delete(c.videoId);
    inFlightSince.delete(c.videoId);
  }
  return true;
}

/**
 * Lightweight duration backfill.
 *
 * Finds broadcast_queue items still carrying the 1800 s upload-time
 * placeholder on BOTH the queue row AND the joined managed_videos row,
 * then runs ffprobe on the video's objectPath to get the real duration.
 * Updates both rows so:
 *   - The orchestrator uses the correct slot length for timing.
 *   - The PLACEHOLDER_DURATION validator warning clears automatically.
 *
 * This handles the case where the admin upload client sends duration=1800
 * as a default and the server skipped ffprobe because `clientDuration > 0`.
 * Runs on every sweep (every 60 s) but is fast — ffprobe on a local object
 * takes < 5 s per file and exits as soon as the container header is parsed.
 * Items still in `processing` (faststart running) are skipped — runFaststart
 * calls ffprobe itself and will update the duration on completion.
 */
async function backfillPlaceholderDurations(): Promise<void> {
  let rows: Array<{ queueItemId: string; videoId: string; objectPath: string | null; title: string }>;
  try {
    rows = await db
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
          // Skip items with faststart actively running — runFaststart calls
          // ffprobe itself and will update the duration on completion.
          inArray(v.transcodingStatus, ["none", "queued", "encoding", "ready", "hls_ready", "failed"]),
        ),
      )
      .limit(10); // cap per sweep to avoid saturating ffprobe
  } catch (err) {
    logger.warn({ err }, "faststart-recovery: placeholder-duration backfill query failed");
    return;
  }

  if (rows.length === 0) return;

  // Bug A: Deduplicate by objectPath within this sweep.  A video that appears N
  // times in broadcast_queue (DUPLICATE_ACTIVE_VIDEO scenario) would otherwise
  // trigger N sequential full-file downloads of the same blob, saturating the
  // DB connection pool.  The per-sweep Set keeps each unique source probed once.
  //
  // Bug B: Also skip objectPaths already confirmed absent from storage in a prior
  // sweep (SOURCE_MISSING).  Without this, a missing 466 MB blob is re-downloaded
  // (and fails) on every 60-second cycle, generating continuous error noise and
  // burning DB connections.
  const seenInThisSweep = new Set<string>();
  const filteredRows = rows.filter((row) => {
    if (!row.objectPath) return false;
    // Skip rows whose objectPath is an absolute URL — they carry a data-quality
    // bug fixed by faststart.service.ts normalisation and the startup DB repair.
    // Probing them would fail (storage expects a bare key) and add noise; they'll
    // be repaired by the next faststart run or the startup UPDATE.
    if (row.objectPath.startsWith("http://") || row.objectPath.startsWith("https://")) {
      logger.warn(
        { videoId: row.videoId, objectPath: row.objectPath },
        "faststart-recovery: skipping duration backfill for row with absolute-URL objectPath (data quality issue — startup repair will fix)",
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
    try {
      const secs = await probeUploadedDuration(row.objectPath!);
      if (secs == null || secs < 5) {
        // Probe returned null — confirm whether the source blob is permanently
        // absent so we can stop wasting a full download attempt every sweep.
        // headObject is a lightweight metadata-only lookup (no body transfer).
        const s = storage();
        if (s.enabled) {
          const head = await s.headObject(row.objectPath!).catch(() => null);
          if (head === null) {
            probeSkipObjectPaths.add(row.objectPath!);
            logger.warn(
              { videoId: row.videoId, objectPath: row.objectPath, title: row.title },
              "faststart-recovery: source object not found in storage — skipping in all future sweeps (restart to re-enable)",
            );
          }
        }
        continue; // probe failed or suspiciously short
      }
      const rounded = Math.round(secs);
      // Update the managed_videos duration
      await db
        .update(v)
        .set({ duration: String(rounded) })
        .where(eq(v.id, row.videoId));
      // Update the broadcast_queue duration_secs
      await db
        .update(q)
        .set({ durationSecs: rounded })
        .where(eq(q.id, row.queueItemId));
      logger.info(
        { videoId: row.videoId, queueItemId: row.queueItemId, title: row.title, secs: rounded },
        "faststart-recovery: duration backfill corrected placeholder",
      );
      // Signal the orchestrator to reload so the corrected duration takes
      // effect immediately in its in-memory item schedule. Without this push
      // the orchestrator keeps using the stale 1800 s value for scheduling
      // until some other event (e.g. an unrelated queue mutation) triggers
      // a reload — which could be minutes or hours later.
      adminEventBus.push("broadcast-queue-updated", {
        reason: "duration-backfill-corrected",
        videoId: row.videoId,
        queueItemId: row.queueItemId,
        newDurSecs: rounded,
      });
    } catch (err) {
      logger.warn(
        { err, videoId: row.videoId, title: row.title },
        "faststart-recovery: duration backfill probe failed (non-fatal)",
      );
    }
  }
}

export const faststartRecoveryWorker = {
  /**
   * Signal sweep() to abort at the next DB-call checkpoint.  Called during
   * graceful shutdown before the connection pool closes so we never attempt
   * a DB query against a closed pool.  This is intentionally separate from
   * workerSupervisor.stopAll() — the supervisor only cancels the pending
   * timer; it cannot interrupt an already-executing async sweep().
   */
  stop(): void {
    _faststartRecoveryStopped = true;
  },

  async sweep(): Promise<void> {
    // Bail immediately if stop() was called (e.g. rapid restart between sweeps).
    if (_faststartRecoveryStopped) return;

    stats.totalSweeps += 1;
    stats.lastSweepAt = Date.now();

    // ── Duration backfill (lightweight, runs every sweep) ─────────────────
    // Fix items stuck at the 1800 s upload-time placeholder by running
    // ffprobe on their objectPath. No moov relocation or re-upload needed.
    await backfillPlaceholderDurations();

    // Bug C: After the (potentially long) backfill, re-check the stopped flag
    // before issuing any further DB queries.  Shutdown calls stop() while
    // backfillPlaceholderDurations() is running; without this guard,
    // findCandidates() fires after pool.end() producing
    // "Cannot use a pool after calling end on the pool".
    if (_faststartRecoveryStopped) return;

    // ── Faststart recovery (heavy, gated by MAX_ATTEMPTS) ─────────────────
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
    stats.lastSweepCandidates = candidates.length;
    stats.lastSweepDispatched = 0;
    if (candidates.length === 0) return;
    // Dispatch sequentially: ffmpeg + multipart upload is heavy and we
    // don't want N concurrent encodes saturating the CPU/network.
    for (const c of candidates) {
      const dispatched = await dispatchOne(c);
      if (dispatched) stats.lastSweepDispatched += 1;
    }
  },

  markEnabled(): void {
    stats.enabled = true;
    stats.installedAt = Date.now();
  },

  getStats(): Readonly<RecoveryStats> {
    return stats;
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
};
