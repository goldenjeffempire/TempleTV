/**
 * Queue reconciliation + health guard worker.
 *
 * Runs on a fixed interval and does three things:
 *
 *  1. Full library reconciliation — scans the ENTIRE managed_videos library
 *     and enqueues every eligible video that is not already in the active
 *     broadcast queue.  This guarantees that any uploaded, validated, active
 *     video enters rotation automatically regardless of HLS / transcoding /
 *     FastStart status, with no operator action required.
 *
 *  2. Duration repair — fixes broadcast_queue rows where durationSecs=0 by
 *     reading the current value from managed_videos.duration.  Zero-duration
 *     items receive a 60 s floor in the orchestrator, but this repair promotes
 *     them to their real duration so the cycle schedule stays accurate.
 *
 *  3. Inactive-item re-admission — creates fresh active queue rows for
 *     eligible videos whose only existing queue rows are inactive (previously
 *     deactivated by the validator, auto-suspension, or legacy logic), so they
 *     re-enter broadcast rotation without operator intervention.
 *
 * The ops-alert fires only when the active item count remains below
 * QUEUE_MIN_ITEMS after reconciliation — indicating the library genuinely
 * has fewer eligible videos than the minimum threshold.
 */
import { and, count, eq, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { env } from "../../../config/env.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { scanLibraryAndEnqueue } from "../../broadcast/auto-enqueue.service.js";

const q = schema.broadcastQueueTable;
const v = schema.videosTable;

async function getActiveItemCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(q).where(eq(q.isActive, true));
  return Number(row?.n ?? 0);
}

/**
 * Fix broadcast_queue rows whose durationSecs=0 by pulling the current
 * duration value from the joined managed_videos row.  Uses ROUND() to
 * match the integer-seconds storage format.
 * Returns the number of rows repaired.
 */
async function repairZeroDurations(): Promise<number> {
  try {
    const result = await db.execute(
      sql`
        UPDATE broadcast_queue
        SET duration_secs = GREATEST(60, ROUND(${v.duration}::numeric))
        FROM ${v}
        WHERE broadcast_queue.video_id = ${v.id}
          AND broadcast_queue.is_active = true
          AND broadcast_queue.duration_secs = 0
          AND ${v.duration} IS NOT NULL
          AND ${v.duration} != '0'
          AND ${v.duration}::numeric > 0
      `,
    );
    const repaired = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    if (repaired > 0) {
      logger.info(
        { repaired },
        "[queue-reconcile] repaired zero-duration queue items — orchestrator will pick up new durations on next reload",
      );
    }
    return repaired;
  } catch (err) {
    logger.warn({ err }, "[queue-reconcile] repairZeroDurations failed (non-fatal)");
    return 0;
  }
}

/**
 * Re-admit system-deactivated queue items that are now admissible under
 * the current broadcast-eligibility policy.
 *
 * Uses a JOIN to managed_videos so we only re-enable items that:
 *   • have at least one playable URL (on the queue row OR the video row)
 *   • have a confirmed blob (s3_mirrored_at IS NOT NULL) — raw MP4 is
 *     broadcast-eligible immediately once the blob is committed; faststart
 *     status is NOT an admission gate in the MP4-only pipeline.
 *   • are NOT CORRUPT_SOURCE / SOURCE_MISSING / ASSEMBLY_FAILED
 *     (those are the only codes that warrant DB-level deactivation; they
 *     are re-deactivated by the validator on the next cycle and re-enabling
 *     them here would just create a pointless oscillation).
 *
 * Operator-deactivated items (validatorDeactivatedReason IS NULL) are
 * intentionally left alone — this function only touches rows that the
 * validator or a prior automated process disabled.
 *
 * This function is exported so the sync-library endpoint can run an
 * immediate re-activation pass without waiting for the 10-minute
 * workerSupervisor interval.
 */
export async function reactivateSystemDeactivated(): Promise<number> {
  try {
    const result = await db.execute<{ id: string }>(sql`
      UPDATE broadcast_queue bq
      SET
        is_active                    = true,
        validator_deactivated_reason = NULL
      FROM managed_videos mv
      WHERE bq.is_active = false
        AND bq.validator_deactivated_reason IS NOT NULL
        AND bq.video_id = mv.id
        AND mv.video_source != 'youtube'
        AND (
          bq.local_video_url IS NOT NULL
          OR mv.local_video_url IS NOT NULL
        )
        AND mv.s3_mirrored_at IS NOT NULL
        AND (
          mv.transcoding_error_code IS NULL
          OR mv.transcoding_error_code NOT IN ('CORRUPT_SOURCE', 'SOURCE_MISSING', 'ASSEMBLY_FAILED')
        )
      RETURNING bq.id
    `);
    const count = (result.rows as unknown[]).length;
    if (count > 0) {
      logger.info(
        { count },
        "[queue-reconcile] re-enabled system-deactivated queue items that are now admissible",
      );
      // Notify the orchestrator immediately so re-activated items enter the
      // broadcast cycle on the next tick rather than waiting up to 30 s for
      // the self-heal stale timer or the next 10-minute health guard scan.
      adminEventBus.push("broadcast-queue-updated", {
        reason: "reactivated-system-deactivated",
        count,
      });
    }
    return count;
  } catch (err) {
    logger.warn({ err }, "[queue-reconcile] reactivateSystemDeactivated failed (non-fatal)");
    return 0;
  }
}

export interface QueueHealthGuardStatus {
  lastCheckAtMs: number | null;
  lastActiveCount: number | null;
  lastRebuildAtMs: number | null;
  totalRebuilds: number;
  lastRebuildAdded: number;
  belowThreshold: boolean;
  threshold: number;
}

/**
 * Minimum gap between consecutive ops-alert emissions when the queue stays
 * below threshold after reconciliation.  Prevents alert floods in dev
 * environments with no local videos or during deliberate content pauses.
 */
const OPS_ALERT_COOLDOWN_MS = 30 * 60_000; // 30 minutes

/**
 * When the queue is below threshold after a reconciliation pass, schedule a
 * follow-up scan after this delay (in addition to the regular workerSupervisor
 * interval).  This provides faster queue recovery without over-scanning on a
 * healthy library.
 */
const ADAPTIVE_RETRY_MS = 2 * 60_000; // 2 minutes

class QueueHealthGuardImpl {
  private lastCheckAtMs: number | null = null;
  private lastActiveCount: number | null = null;
  private lastRebuildAtMs: number | null = null;
  private totalRebuilds = 0;
  private lastRebuildAdded = 0;
  private belowThreshold = false;
  private lastOpsAlertAtMs = 0;
  private adaptiveTimer: NodeJS.Timeout | null = null;

  getStatus(): QueueHealthGuardStatus {
    return {
      lastCheckAtMs: this.lastCheckAtMs,
      lastActiveCount: this.lastActiveCount,
      lastRebuildAtMs: this.lastRebuildAtMs,
      totalRebuilds: this.totalRebuilds,
      lastRebuildAdded: this.lastRebuildAdded,
      belowThreshold: this.belowThreshold,
      threshold: env.QUEUE_MIN_ITEMS,
    };
  }

  async scan(): Promise<void> {
    const threshold = env.QUEUE_MIN_ITEMS;
    this.lastCheckAtMs = Date.now();

    // ── Phase 1: Re-enable system-deactivated queue items ──────────────────
    // Catches items that were auto-suspended or validator-deactivated in a
    // prior server session.  In-memory suspensions (current session) are
    // handled by the bad-URL cache expiry — no DB write needed for those.
    await reactivateSystemDeactivated();

    // ── Phase 2: Full library reconciliation ───────────────────────────────
    // Scans the ENTIRE managed_videos library (up to 2000 rows per run) and
    // enqueues every eligible video that has no active broadcast_queue row.
    // Using a high limit ensures large libraries are fully covered within a
    // few reconciliation cycles (worker runs every 10 min).
    //
    // "Eligible" is defined by isPlayableForBroadcast() in auto-enqueue:
    //   - Has localVideoUrl OR hlsMasterUrl (source availability is the only gate)
    //   - Not CORRUPT_SOURCE / SOURCE_MISSING / ASSEMBLY_FAILED (source truly absent)
    //   - Local videos: s3_mirrored_at IS NOT NULL (blob committed to storage)
    //   - Not YouTube (library-only)
    //
    // NOTE: faststart status, transcoding status, and moov position are NOT
    // eligibility criteria. Videos with faststartApplied=false or transcodingStatus
    // ='failed' are admitted immediately; the faststart-recovery worker retries
    // moov relocation in the background and the player watchdog handles failures.
    //
    // This is intentionally unconditional — we always reconcile, not just
    // when below threshold, so every eligible video enters rotation automatically
    // regardless of the current queue size.
    let added = 0;
    try {
      const result = await scanLibraryAndEnqueue({
        reason: "queue-health-guard",
        maxToAdd: 2000,
      });
      added = result?.enqueued ?? 0;
      this.lastRebuildAtMs = Date.now();
      this.totalRebuilds++;
      this.lastRebuildAdded = added;

      if (added > 0) {
        logger.info(
          { scanned: result.scanned, enqueued: added, skipped: result.skipped },
          "[queue-reconcile] library reconciliation: queued missing eligible videos",
        );
      } else {
        logger.debug(
          { scanned: result.scanned },
          "[queue-reconcile] library reconciliation: all eligible videos already in active queue",
        );
      }
    } catch (err) {
      logger.warn({ err }, "[queue-reconcile] library reconciliation failed (non-fatal)");
    }

    // ── Phase 3: Duration repair ───────────────────────────────────────────
    // Fix zero-duration queue items so the cycle schedule is accurate.
    await repairZeroDurations();

    // ── Phase 5: Threshold alerting ────────────────────────────────────────
    const activeCount = await getActiveItemCount();
    this.lastActiveCount = activeCount;
    this.belowThreshold = activeCount < threshold;

    if (!this.belowThreshold) {
      // Queue is healthy — reset the ops-alert cooldown so the next below-
      // threshold event fires immediately rather than being suppressed.
      this.lastOpsAlertAtMs = 0;
      // Cancel any pending adaptive follow-up — the queue is healthy.
      if (this.adaptiveTimer) {
        clearTimeout(this.adaptiveTimer);
        this.adaptiveTimer = null;
      }
      logger.debug(
        { activeCount, threshold },
        "[queue-reconcile] queue size OK",
      );
      return;
    }

    // Check whether ytShuffleFallback is active — if the library is YouTube-only
    // the queue will always be empty locally (0 HLS videos), which is the expected
    // operational state. Downgrade the log to INFO to reduce noise in that case.
    let ytShuffleActive = false;
    try {
      const { ytShuffleFallback } = await import("./youtube-shuffle-fallback.js");
      ytShuffleActive = ytShuffleFallback.isActive;
    } catch { /* non-fatal — shuffle module may not be initialised yet */ }

    if (ytShuffleActive) {
      logger.info(
        { activeCount, threshold, added },
        "[queue-reconcile] local queue below threshold — ytShuffleFallback is active (YouTube-only library); no action needed",
      );
    } else {
      logger.warn(
        { activeCount, threshold, added },
        "[queue-reconcile] queue still below threshold after reconciliation — library may have too few eligible videos",
      );
    }

    // ── Adaptive follow-up scan ─────────────────────────────────────────────
    // Schedule a faster follow-up scan when the queue is below threshold so
    // any newly-uploaded or re-activated videos are admitted within 2 minutes
    // rather than waiting the full workerSupervisor interval.
    // The timer is not re-armed if one is already pending (dedup guard).
    // Suppress on YouTube-only deployments where ytShuffleFallback is the
    // permanent broadcast driver — the local queue is always 0 by design and
    // rapid re-scans just add unnecessary DB load without changing anything.
    if (!this.adaptiveTimer && !ytShuffleActive) {
      this.adaptiveTimer = setTimeout(() => {
        this.adaptiveTimer = null;
        void this.scan().catch((err) =>
          logger.warn({ err }, "[queue-reconcile] adaptive follow-up scan error (non-fatal)"),
        );
      }, ADAPTIVE_RETRY_MS);
      this.adaptiveTimer.unref?.();
      logger.info(
        { retryMs: ADAPTIVE_RETRY_MS, activeCount, threshold },
        "[queue-reconcile] queue below threshold — scheduled adaptive follow-up scan",
      );
    }

    const nowMs = Date.now();
    const msSinceLastAlert = nowMs - this.lastOpsAlertAtMs;
    if (msSinceLastAlert >= OPS_ALERT_COOLDOWN_MS) {
      this.lastOpsAlertAtMs = nowMs;
      try {
        const { adminEventBus } = await import("../../admin-ops/admin-event-bus.js");

        // Suppress the ops-alert when an override is active — the channel is ON AIR
        // via a manual or shuffle override even though the local queue is below the
        // minimum threshold.  Log at INFO instead to preserve visibility without
        // flooding the ops inbox with false-positive below-threshold alerts.
        let overrideState: { kind: string; title: string; isYtShuffle: boolean } | null = null;
        try {
          const { broadcastOrchestrator } = await import("../index.js");
          overrideState = broadcastOrchestrator.getOverrideState();
        } catch { /* non-fatal — orchestrator may not be initialised yet */ }

        if (overrideState) {
          logger.info(
            {
              activeCount,
              threshold,
              overrideKind: overrideState.kind,
              overrideTitle: overrideState.title,
              isYtShuffle: overrideState.isYtShuffle,
            },
            "[queue-reconcile] queue below threshold but broadcast is ON AIR via override — ops-alert suppressed",
          );
        } else {
          adminEventBus.push("ops-alert", {
            level: "warn",
            code: "queue-health-below-threshold",
            title: "Broadcast queue below minimum size",
            message: `Active queue has ${activeCount} item(s) — below the minimum of ${threshold}. The video library may have too few eligible videos for broadcast.`,
            detail: `Active items: ${activeCount} / threshold: ${threshold}. Added in reconciliation: ${added}.`,
            timestamp: new Date().toISOString(),
            source: "queue-health-guard",
          });
        }
      } catch {
        // non-fatal
      }
    } else {
      logger.debug(
        { activeCount, threshold, cooldownRemainingMs: OPS_ALERT_COOLDOWN_MS - msSinceLastAlert },
        "[queue-reconcile] ops-alert suppressed (within cooldown window)",
      );
    }
  }
}

export const queueHealthGuard = new QueueHealthGuardImpl();
export function getQueueHealthGuardStatus(): QueueHealthGuardStatus {
  return queueHealthGuard.getStatus();
}
