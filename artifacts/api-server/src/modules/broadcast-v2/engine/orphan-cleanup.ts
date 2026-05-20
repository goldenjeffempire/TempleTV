/**
 * Background orphan-state cleanup worker.
 *
 * Periodically sweeps the database for stale/orphaned broadcast state that
 * cannot affect the running orchestrator but accumulates over time:
 *
 *   1. broadcast_event_log rows beyond MAX_RETENTION_PER_CHANNEL (1 000) —
 *      already handled by eventLogRepo.trim() every 60 s in the orchestrator,
 *      but we run an additional weekly deep-trim on the per-channel basis.
 *
 *   2. broadcast_queue rows where the video was hard-deleted (videoId set but
 *      no joined video row) — these are logged as candidates for deactivation.
 *      We never auto-deactivate here; operator action required.
 *
 * Runs every 4 hours with a 10-minute boot delay to avoid competing with
 * startup DB work. Results exposed via /diagnostics.
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { eventLogRepo } from "../repository/event-log.repo.js";

export interface CleanupStats {
  lastRunAtMs: number | null;
  lastRunDurationMs: number | null;
  totalRuns: number;
  lastOrphanedRefCount: number;
  orphanedRefCandidates: Array<{ id: string; title: string; videoId: string }>;
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
    orphanedRefCandidates: [],
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
      await eventLogRepo.trim(CHANNEL_ID);

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

      if (candidates.length > 0) {
        logger.warn(
          { count: candidates.length, candidates },
          "[orphan-cleanup] active queue items reference deleted videos — manual deactivation recommended",
        );
      }

      this.stats.lastRunAtMs = start;
      this.stats.lastRunDurationMs = Date.now() - start;
      this.stats.lastOrphanedRefCount = candidates.length;
      this.stats.orphanedRefCandidates = candidates;
      this.stats.lastError = null;
      logger.info(
        { orphanedRefs: candidates.length, durationMs: this.stats.lastRunDurationMs },
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
