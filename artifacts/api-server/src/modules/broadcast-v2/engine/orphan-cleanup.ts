/**
 * Background orphan-state cleanup worker.
 *
 * Periodically sweeps the database for stale/orphaned state that accumulates
 * over time and is safe to clean automatically:
 *
 *   1. broadcast_event_log rows beyond MAX_RETENTION_PER_CHANNEL (1 000) —
 *      already handled by eventLogRepo.trim() every 60 s in the orchestrator,
 *      but we run an additional deep-trim on each sweep.
 *
 *   2. broadcast_queue rows where the referenced video was hard-deleted —
 *      auto-deactivated (is_active → false) so the orchestrator never tries
 *      to play a video that no longer exists.
 *
 *   3. viewer_sessions rows where ended_at IS NULL but last_heartbeat_at is
 *      older than STALE_SESSION_THRESHOLD_MINS — these are abandoned sessions
 *      from viewers who closed the app/tab without sending a completed or
 *      abandoned event. We close them by setting ended_at = last_heartbeat_at
 *      so the analytics queries stop counting them as "active" and the table
 *      does not grow without bound on a 24/7 broadcast platform.
 *
 * Runs every 4 hours with a 10-minute boot delay to avoid competing with
 * startup DB work. Results exposed via /diagnostics.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { eventLogRepo } from "../repository/event-log.repo.js";

/** Sessions whose last heartbeat is older than this are considered abandoned. */
const STALE_SESSION_THRESHOLD_MINS = 10;

export interface CleanupStats {
  lastRunAtMs: number | null;
  lastRunDurationMs: number | null;
  totalRuns: number;
  lastOrphanedRefCount: number;
  lastOrphanedRefsDeactivated: number;
  orphanedRefCandidates: Array<{ id: string; title: string; videoId: string }>;
  lastStaleSessiosClosed: number;
  lastError: string | null;
  nextRunAtMs: number | null;
}

const DEFAULT_INTERVAL_MS = 4 * 60 * 60_000;
const BOOT_DELAY_MS = 10 * 60_000;
const CHANNEL_ID = "main";

class OrphanCleanupWorkerImpl {
  private timer: NodeJS.Timeout | null = null;
  private nextRunAtMs: number | null = null;
  private stats: CleanupStats = {
    lastRunAtMs: null,
    lastRunDurationMs: null,
    totalRuns: 0,
    lastOrphanedRefCount: 0,
    lastOrphanedRefsDeactivated: 0,
    orphanedRefCandidates: [],
    lastStaleSessiosClosed: 0,
    lastError: null,
    nextRunAtMs: null,
  };

  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    const scheduleRecurring = (): void => {
      this.nextRunAtMs = Date.now() + intervalMs;
      this.stats.nextRunAtMs = this.nextRunAtMs;
      this.timer = setInterval(() => {
        void this.sweep().catch((err) =>
          logger.warn({ err }, "[orphan-cleanup] sweep error"),
        );
      }, intervalMs);
      this.timer.unref?.();
    };
    this.nextRunAtMs = Date.now() + BOOT_DELAY_MS;
    this.stats.nextRunAtMs = this.nextRunAtMs;
    const boot = setTimeout(() => {
      void this.sweep()
        .catch((err) => logger.warn({ err }, "[orphan-cleanup] initial sweep error"))
        .finally(scheduleRecurring);
    }, BOOT_DELAY_MS);
    boot.unref?.();
    this.timer = boot;
    logger.info(
      { intervalMs, bootDelayMs: BOOT_DELAY_MS },
      "[orphan-cleanup] scheduled",
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getStats(): CleanupStats {
    return { ...this.stats };
  }

  async sweep(): Promise<void> {
    const start = Date.now();
    this.stats.totalRuns += 1;
    logger.info("[orphan-cleanup] sweep starting");
    this.nextRunAtMs = null;
    this.stats.nextRunAtMs = null;

    try {
      // ── 1. Event log trim ──────────────────────────────────────────────────
      await eventLogRepo.trim(CHANNEL_ID);

      // ── 2. Orphaned broadcast_queue rows (video hard-deleted) ──────────────
      const q = schema.broadcastQueueTable;
      const v = schema.videosTable;
      const orphans = await db
        .select({ id: q.id, title: q.title, videoId: q.videoId })
        .from(q)
        .leftJoin(v, eq(q.videoId, v.id))
        .where(
          and(
            eq(q.isActive, true),
            isNotNull(q.videoId),
            isNull(v.id),
          ),
        );

      const candidates = orphans.map((r) => ({
        id: r.id,
        title: r.title,
        videoId: r.videoId!,
      }));

      let deactivatedCount = 0;
      if (candidates.length > 0) {
        const ids = candidates.map((c) => c.id);
        try {
          await db
            .update(q)
            .set({ isActive: false })
            .where(inArray(q.id, ids));
          deactivatedCount = candidates.length;
          logger.warn(
            { count: deactivatedCount, deactivated: ids },
            "[orphan-cleanup] auto-deactivated broadcast_queue items referencing deleted videos",
          );
        } catch (deactivErr) {
          logger.warn(
            { err: deactivErr, candidates },
            "[orphan-cleanup] failed to auto-deactivate orphaned queue items (non-fatal)",
          );
        }
      }

      // ── 3. Stale viewer_sessions (abandoned without ended_at) ─────────────
      // Viewers who close the app or lose connectivity without sending a
      // `completed`/`abandoned` event leave sessions open forever.  We close
      // them by setting ended_at = last_heartbeat_at so they stop inflating
      // the active-viewer count and so the table does not grow unboundedly.
      const staleThreshold = new Date(
        Date.now() - STALE_SESSION_THRESHOLD_MINS * 60_000,
      );
      let staleSessionsClosed = 0;
      try {
        const result = await db.execute(
          sql`UPDATE viewer_sessions
              SET    ended_at = last_heartbeat_at
              WHERE  ended_at IS NULL
                AND  last_heartbeat_at < ${staleThreshold}`,
        );
        staleSessionsClosed = result.rowCount ?? 0;
        if (staleSessionsClosed > 0) {
          logger.info(
            { closed: staleSessionsClosed, thresholdMins: STALE_SESSION_THRESHOLD_MINS },
            "[orphan-cleanup] closed stale viewer sessions",
          );
        }
      } catch (sessErr) {
        logger.warn(
          { err: sessErr },
          "[orphan-cleanup] stale session cleanup failed (non-fatal)",
        );
      }

      // ── 4. Notification table retention ────────────────────────────────────
      // scheduled_notifications and sent_notifications grow without bound.
      // Rows older than 90 days are beyond any audit window we'd ever need
      // operationally. We only prune terminal-state rows (status sent/failed
      // for scheduled; all rows for sent_notifications) so in-flight rows
      // are never touched.
      let prunedScheduled = 0;
      let prunedSent = 0;
      const notifCutoff = new Date(Date.now() - 90 * 24 * 60 * 60_000);
      try {
        // LIMIT 5000 prevents a single sweep from holding a long-running
        // lock on a heavily-backlogged table. Rows beyond the limit are
        // picked up on the next scheduled sweep (every 6 h by default).
        const scheduledResult = await db.execute(
          sql`DELETE FROM scheduled_notifications
              WHERE id IN (
                SELECT id FROM scheduled_notifications
                WHERE status IN ('sent', 'failed')
                  AND created_at < ${notifCutoff}
                LIMIT 5000
              )`,
        );
        prunedScheduled = scheduledResult.rowCount ?? 0;

        const sentResult = await db.execute(
          sql`DELETE FROM sent_notifications
              WHERE id IN (
                SELECT id FROM sent_notifications
                WHERE sent_at < ${notifCutoff}
                LIMIT 5000
              )`,
        );
        prunedSent = sentResult.rowCount ?? 0;

        if (prunedScheduled > 0 || prunedSent > 0) {
          logger.info(
            { prunedScheduled, prunedSent, cutoffDays: 90 },
            "[orphan-cleanup] pruned old notification rows",
          );
        }
      } catch (notifErr) {
        logger.warn(
          { err: notifErr },
          "[orphan-cleanup] notification retention cleanup failed (non-fatal)",
        );
      }

      this.stats.lastRunAtMs = start;
      this.stats.lastRunDurationMs = Date.now() - start;
      this.stats.lastOrphanedRefCount = candidates.length;
      this.stats.lastOrphanedRefsDeactivated = deactivatedCount;
      this.stats.orphanedRefCandidates = candidates;
      this.stats.lastStaleSessiosClosed = staleSessionsClosed;
      this.stats.lastError = null;
      logger.info(
        {
          orphanedRefs: candidates.length,
          deactivated: deactivatedCount,
          staleSessions: staleSessionsClosed,
          prunedScheduledNotifs: prunedScheduled,
          prunedSentNotifs: prunedSent,
          durationMs: this.stats.lastRunDurationMs,
        },
        "[orphan-cleanup] sweep complete",
      );
    } catch (err) {
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      this.stats.lastRunAtMs = start;
      this.stats.lastRunDurationMs = Date.now() - start;
      logger.warn({ err }, "[orphan-cleanup] sweep failed (non-fatal)");
    }
  }
}

export const orphanCleanupWorker = new OrphanCleanupWorkerImpl();
