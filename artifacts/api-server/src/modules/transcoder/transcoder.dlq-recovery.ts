/**
 * Autonomous DLQ Recovery Worker
 *
 * Automatically requeues dead-lettered transcoding jobs on a 3-tier
 * exponential cooldown schedule, eliminating the need for manual operator
 * intervention on transient failures.
 *
 * Recovery tiers (measured from deadLetteredAt):
 *   Tier 1 (requeueCount = 0): requeue after 4 h
 *   Tier 2 (requeueCount = 1): requeue after 12 h
 *   Tier 3 (requeueCount = 2): requeue after 24 h
 *   Tier 4+ (requeueCount ≥ 3): mark permanentFailure=true, emit ops-alert
 *
 * Terminal error codes (CORRUPT_SOURCE, SOURCE_MISSING) are never
 * auto-requeued — they require a new source upload.
 *
 * When a requeued job fails again and returns to dead_letter status the
 * same DLQ entry is reused (the dispatcher's onConflictDoUpdate refreshes
 * the failure fields and clears requeuedAt) and the recovery worker picks
 * it up on the next sweep with an incremented requeueCount.
 */

import { sql } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger as rootLogger } from "../../infrastructure/logger.js";
import { adminEventBus } from "../admin-ops/admin-event-bus.js";
import { requeueFromDlq } from "./transcoder.queue.js";
import { env } from "../../config/env.js";

const logger = rootLogger.child({ module: "dlq-recovery" });

type DlqRow = {
  id: string;
  jobId: string;
  videoId: string | null;
  videoTitle: string | null;
  attempts: number;
  lastError: string | null;
  errorCode: string | null;
  deadLetteredAt: Date;
  requeuedAt: Date | null;
  requeueCount: number;
  nextDlqRetryAt: Date | null;
  permanentFailure: boolean;
  jobStatus: string | null;
};

const TERMINAL_ERROR_CODES = new Set([
  "CORRUPT_SOURCE",
  "SOURCE_MISSING",
]);

const RECOVERY_TIERS_MS: readonly number[] = [
  4  * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

export class DlqRecoveryWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private sweeping = false;

  start(): void {
    if (!env.DLQ_RECOVERY_ENABLED) {
      logger.info("DLQ auto-recovery disabled (DLQ_RECOVERY_ENABLED=false)");
      return;
    }
    logger.info(
      { intervalMs: env.DLQ_RECOVERY_INTERVAL_MS, tiers: RECOVERY_TIERS_MS },
      "DLQ auto-recovery worker started",
    );
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("DLQ auto-recovery worker stopped");
  }

  /** Force an immediate sweep (e.g. after a manual requeue / on startup). */
  nudge(): void {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.runSweepSafe();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.runSweepSafe();
    }, env.DLQ_RECOVERY_INTERVAL_MS);
    this.timer.unref();
  }

  private runSweepSafe(): void {
    if (this.stopped) return;
    void (async () => {
      try {
        await this.sweep();
      } catch (err) {
        logger.warn({ err }, "DLQ auto-recovery sweep error (non-fatal)");
      } finally {
        this.sweeping = false;
        this.scheduleNext();
      }
    })();
  }

  /**
   * Sweep the dead-letter table for entries eligible for auto-recovery.
   * Eligible = not permanently failed, not a terminal error code, and
   * either never requeued OR the requeued job has re-failed (status=dead_letter).
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;

    const dlq = schema.transcodingDeadLetterTable;
    void dlq;

    const { rows } = await db.execute<DlqRow>(sql`
      SELECT
        d.id,
        d.job_id          AS "jobId",
        d.video_id        AS "videoId",
        d.video_title     AS "videoTitle",
        d.attempts,
        d.last_error      AS "lastError",
        d.error_code      AS "errorCode",
        d.dead_lettered_at AS "deadLetteredAt",
        d.requeued_at     AS "requeuedAt",
        COALESCE(d.requeue_count, 0)      AS "requeueCount",
        d.next_dlq_retry_at               AS "nextDlqRetryAt",
        COALESCE(d.permanent_failure, false) AS "permanentFailure",
        j.status AS "jobStatus"
      FROM transcoding_dead_letter d
      LEFT JOIN transcoding_jobs j ON j.id = d.job_id
      WHERE COALESCE(d.permanent_failure, false) = false
        AND (
          d.requeued_at IS NULL
          OR j.status = 'dead_letter'
        )
      ORDER BY d.dead_lettered_at ASC
      LIMIT 50
    `);

    const entries = (rows ?? []) as DlqRow[];
    if (entries.length === 0) return;

    logger.info({ count: entries.length }, "DLQ auto-recovery: sweep found eligible entries");

    for (const entry of entries) {
      await this.processEntry(entry);
    }
  }

  private async processEntry(entry: DlqRow): Promise<void> {
    if (TERMINAL_ERROR_CODES.has(entry.errorCode ?? "")) {
      await db.execute(sql`
        UPDATE transcoding_dead_letter
        SET permanent_failure = true,
            notes = 'Terminal error code — requires new source upload, auto-recovery skipped'
        WHERE id = ${entry.id}
      `);
      logger.info(
        { dlqId: entry.id, jobId: entry.jobId, errorCode: entry.errorCode },
        "DLQ auto-recovery: skipped terminal error code (marked permanent)",
      );
      return;
    }

    const requeueCount = entry.requeueCount ?? 0;

    if (requeueCount >= RECOVERY_TIERS_MS.length) {
      await db.execute(sql`
        UPDATE transcoding_dead_letter
        SET permanent_failure = true,
            notes = 'Auto-recovery exhausted: ' || ${requeueCount} || ' automatic requeue attempts all failed. Manual re-upload required.'
        WHERE id = ${entry.id}
      `);

      const videoLabel = entry.videoTitle ?? entry.videoId ?? entry.jobId;
      adminEventBus.push("ops-alert", {
        level: "error",
        title: "Transcoding: Permanent Failure After Auto-Recovery",
        component: "dlq-recovery",
        message:
          `Video "${videoLabel}" has exhausted all ${RECOVERY_TIERS_MS.length} automatic ` +
          `recovery attempts and is now permanently failed. ` +
          `Manual re-upload or operator investigation is required. ` +
          `Last error: ${(entry.lastError ?? "unknown").slice(0, 200)}`,
        jobId: entry.jobId,
        videoId: entry.videoId,
        requeueCount,
      });

      logger.warn(
        { dlqId: entry.id, jobId: entry.jobId, videoId: entry.videoId, requeueCount },
        "DLQ auto-recovery: permanent failure — all recovery tiers exhausted",
      );
      return;
    }

    const tierMs = RECOVERY_TIERS_MS[requeueCount]!;
    const cooldownExpiry = new Date(entry.deadLetteredAt.getTime() + tierMs);
    const now = new Date();

    if (cooldownExpiry > now) {
      const existingNext = entry.nextDlqRetryAt;
      if (!existingNext || Math.abs(existingNext.getTime() - cooldownExpiry.getTime()) > 60_000) {
        await db.execute(sql`
          UPDATE transcoding_dead_letter
          SET next_dlq_retry_at = ${cooldownExpiry}
          WHERE id = ${entry.id}
        `);
      }
      return;
    }

    try {
      const { jobId } = await requeueFromDlq(entry.id);

      const nextTierMs = RECOVERY_TIERS_MS[requeueCount + 1];
      const nextRetryAt = nextTierMs != null
        ? new Date(entry.deadLetteredAt.getTime() + nextTierMs)
        : null;

      const tierLabel = `${requeueCount + 1}/${RECOVERY_TIERS_MS.length}`;
      await db.execute(sql`
        UPDATE transcoding_dead_letter
        SET requeue_count    = ${requeueCount + 1},
            next_dlq_retry_at = ${nextRetryAt},
            notes            = 'Auto-requeued (tier ' || ${tierLabel} || ')'
        WHERE id = ${entry.id}
      `);

      adminEventBus.push("transcoding-update", {
        type: "dlq-auto-requeue",
        jobId,
        dlqId: entry.id,
        tier: requeueCount + 1,
        totalTiers: RECOVERY_TIERS_MS.length,
        videoId: entry.videoId,
      });

      logger.info(
        {
          dlqId: entry.id,
          jobId,
          videoId: entry.videoId,
          tier: requeueCount + 1,
          totalTiers: RECOVERY_TIERS_MS.length,
          nextRetryAt: nextRetryAt?.toISOString() ?? "none (final tier)",
        },
        "DLQ auto-recovery: job requeued successfully",
      );
    } catch (err) {
      logger.warn(
        { err, dlqId: entry.id, jobId: entry.jobId },
        "DLQ auto-recovery: requeue failed (will retry on next sweep)",
      );
    }
  }

  getStatus(): {
    enabled: boolean;
    intervalMs: number;
    tiers: readonly number[];
    stopped: boolean;
    sweeping: boolean;
  } {
    return {
      enabled: env.DLQ_RECOVERY_ENABLED,
      intervalMs: env.DLQ_RECOVERY_INTERVAL_MS,
      tiers: RECOVERY_TIERS_MS,
      stopped: this.stopped,
      sweeping: this.sweeping,
    };
  }
}

export const dlqRecoveryWorker = new DlqRecoveryWorker();
