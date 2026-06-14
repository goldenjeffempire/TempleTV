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
import { and, count, eq, gt, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { env } from "../../../config/env.js";
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
        UPDATE ${q}
        SET ${q.durationSecs} = GREATEST(60, ROUND(${v.duration}::numeric))
        FROM ${v}
        WHERE ${q.videoId} = ${v.id}
          AND ${q.isActive} = true
          AND ${q.durationSecs} = 0
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
 * Re-admit eligible videos that have ONLY inactive queue rows by creating
 * fresh active rows for them.  scanLibraryAndEnqueue already handles the
 * NOT EXISTS (active row) case, but this pass also covers the edge case
 * where the only row was system-deactivated (validatorDeactivatedReason IS NOT NULL)
 * and scanLibraryAndEnqueue's NOT EXISTS already filters to is_active=true.
 *
 * In practice this is redundant with scanLibraryAndEnqueue's logic, but it
 * serves as a belt-and-suspenders guard against orphaned inactive-only rows.
 */
async function reactivateSystemDeactivated(): Promise<number> {
  try {
    // Re-enable system-deactivated items (is_active=false, validatorDeactivatedReason IS NOT NULL).
    // Operator-deactivated items (validatorDeactivatedReason IS NULL) are intentionally left alone.
    const result = await db
      .update(q)
      .set({ isActive: true, validatorDeactivatedReason: null })
      .where(
        and(
          eq(q.isActive, false),
          isNotNull(q.validatorDeactivatedReason),
        ),
      )
      .returning({ id: q.id });
    const count = result.length;
    if (count > 0) {
      logger.info(
        { count },
        "[queue-reconcile] re-enabled system-deactivated queue items",
      );
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

class QueueHealthGuardImpl {
  private lastCheckAtMs: number | null = null;
  private lastActiveCount: number | null = null;
  private lastRebuildAtMs: number | null = null;
  private totalRebuilds = 0;
  private lastRebuildAdded = 0;
  private belowThreshold = false;
  private lastOpsAlertAtMs = 0;

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
    //   - Has localVideoUrl OR hlsMasterUrl
    //   - Not CORRUPT_SOURCE / SOURCE_MISSING / ASSEMBLY_FAILED
    //   - Not (transcodingStatus=failed AND faststartApplied=false AND no HLS)
    //   - Local videos: s3_mirrored_at IS NOT NULL (blob committed to storage)
    //   - Not YouTube (library-only)
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

    // ── Phase 4: Threshold alerting ────────────────────────────────────────
    const activeCount = await getActiveItemCount();
    this.lastActiveCount = activeCount;
    this.belowThreshold = activeCount < threshold;

    if (!this.belowThreshold) {
      // Queue is healthy — reset the ops-alert cooldown so the next below-
      // threshold event fires immediately rather than being suppressed.
      this.lastOpsAlertAtMs = 0;
      logger.debug(
        { activeCount, threshold },
        "[queue-reconcile] queue size OK",
      );
      return;
    }

    logger.warn(
      { activeCount, threshold, added },
      "[queue-reconcile] queue still below threshold after reconciliation — library may have too few eligible videos",
    );

    const nowMs = Date.now();
    const msSinceLastAlert = nowMs - this.lastOpsAlertAtMs;
    if (msSinceLastAlert >= OPS_ALERT_COOLDOWN_MS) {
      this.lastOpsAlertAtMs = nowMs;
      try {
        const { adminEventBus } = await import("../../admin-ops/admin-event-bus.js");
        adminEventBus.push("ops-alert", {
          level: "warn",
          title: "Broadcast queue below minimum size",
          message: `Active queue has ${activeCount} item(s) — below the minimum of ${threshold}. The video library may have too few eligible videos for broadcast.`,
          detail: `Active items: ${activeCount} / threshold: ${threshold}. Added in reconciliation: ${added}.`,
          timestamp: new Date().toISOString(),
          source: "queue-health-guard",
        });
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
