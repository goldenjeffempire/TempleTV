/**
 * Queue health guard worker.
 *
 * Proactively monitors the active broadcast queue item count and auto-rebuilds
 * from the video library when it drops below the configured minimum threshold.
 *
 * This is MORE proactive than the orchestrator's empty-queue self-heal, which
 * only triggers when the queue is completely empty for 60 s. The guard fires
 * while content is still playing (N items remain) so there is always a buffer
 * of items before dead air occurs — particularly important for fast-cycling
 * queues or queues with many failed/suspended items.
 *
 * Threshold: QUEUE_MIN_ITEMS env var (default 5). When active items < threshold,
 * scanLibraryAndEnqueue is called to pull in eligible library videos. An ops-alert
 * is emitted if the queue remains below threshold after rebuilding (i.e. the
 * library itself is too small or all items are ineligible).
 */
import { count, eq } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { env } from "../../../config/env.js";
import { scanLibraryAndEnqueue } from "../../broadcast/auto-enqueue.service.js";

const q = schema.broadcastQueueTable;

async function getActiveItemCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(q).where(eq(q.isActive, true));
  return Number(row?.n ?? 0);
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
 * below threshold after a rebuild.  Prevents flooding the admin console SSE
 * channel (and any connected notification handlers) every 5 minutes when the
 * library is genuinely small (e.g. dev environment with no local videos, or
 * a content pause window in production).  After the initial alert, subsequent
 * below-threshold alerts are suppressed until the cooldown expires.
 */
const OPS_ALERT_COOLDOWN_MS = 30 * 60_000; // 30 minutes

class QueueHealthGuardImpl {
  private lastCheckAtMs: number | null = null;
  private lastActiveCount: number | null = null;
  private lastRebuildAtMs: number | null = null;
  private totalRebuilds = 0;
  private lastRebuildAdded = 0;
  private belowThreshold = false;
  /** Wall-clock ms of the last ops-alert emission. Zero = never. */
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
    const activeCount = await getActiveItemCount();
    this.lastCheckAtMs = Date.now();
    this.lastActiveCount = activeCount;

    if (activeCount >= threshold) {
      this.belowThreshold = false;
      logger.debug(
        { activeCount, threshold },
        "[queue-health-guard] queue size OK",
      );
      return;
    }

    // Below threshold — attempt library rebuild.
    this.belowThreshold = true;
    const deficit = threshold - activeCount;
    logger.warn(
      { activeCount, threshold, deficit },
      "[queue-health-guard] active queue below threshold — rebuilding from library",
    );

    let added = 0;
    try {
      const result = await scanLibraryAndEnqueue({
        reason: "queue-health-guard",
        maxToAdd: Math.max(50, deficit * 3), // Pull in headroom beyond the deficit
      });
      added = result?.enqueued ?? 0;
      this.lastRebuildAtMs = Date.now();
      this.totalRebuilds++;
      this.lastRebuildAdded = added;

      logger.info(
        { activeCount, threshold, deficit, added },
        "[queue-health-guard] library rebuild complete",
      );
    } catch (err) {
      logger.warn({ err }, "[queue-health-guard] library rebuild failed (non-fatal)");
    }

    // If we still can't fill the queue, emit an ops-alert so operators know.
    // The alert is throttled to OPS_ALERT_COOLDOWN_MS (30 min) to prevent
    // flooding the admin console SSE channel every 5 minutes when the library
    // is genuinely small (dev with no local videos, or a scheduled content gap).
    const newCount = activeCount + added;
    if (newCount < threshold) {
      logger.warn(
        { newCount, threshold, added },
        "[queue-health-guard] queue still below threshold after rebuild — library may be empty or all items ineligible",
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
            message: `Active queue has ${newCount} item(s) — below the minimum of ${threshold}. The video library may be too small or all videos are ineligible for broadcast.`,
            detail: `Active items: ${newCount} / threshold: ${threshold}. Added in rebuild: ${added}.`,
            timestamp: new Date().toISOString(),
            source: "queue-health-guard",
          });
        } catch {
          // non-fatal
        }
      } else {
        logger.debug(
          { newCount, threshold, cooldownRemainingMs: OPS_ALERT_COOLDOWN_MS - msSinceLastAlert },
          "[queue-health-guard] ops-alert suppressed (within cooldown window)",
        );
      }
    } else {
      // Queue recovered above threshold — reset the alert cooldown so the next
      // below-threshold event is reported immediately (not silently suppressed).
      this.lastOpsAlertAtMs = 0;
    }
  }
}

export const queueHealthGuard = new QueueHealthGuardImpl();
export function getQueueHealthGuardStatus(): QueueHealthGuardStatus {
  return queueHealthGuard.getStatus();
}
