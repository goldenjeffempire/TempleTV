/**
 * broadcast-scheduler — OMEGA Broadcast Automation
 *
 * Runs every 10 seconds and autonomously:
 *   1. Expires live overrides whose `endsAt` has passed.
 *   2. Auto-starts scheduled overrides whose `scheduledFor` has arrived.
 *   3. Validates broadcast engine health and triggers reload if stale.
 *   4. Emits appropriate OMEGA signals so all clients stay in sync.
 *
 * This is the "system operates itself" component of the OMEGA spec —
 * admin staff supervise, the scheduler enforces the calendar.
 */

import { and, eq, gt, lte } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { logger } from "../../infrastructure/logger.js";
import { broadcastEngine } from "../broadcast/queue.engine.js";
import { overrideBus } from "../live-overrides/override-bus.js";
import { broadcastSignal } from "../network/signal-bus.js";

const overrides = schema.liveOverridesTable;

/**
 * Raised from 10 s → 30 s → 60 s.  Override expiry / auto-start precision
 * of ±60 s is fully acceptable for broadcast scheduling (live overrides are
 * operator-initiated events, not millisecond-precision automation), and
 * doubling the interval eliminates 2 DB queries per tick × 2 extra ticks/min
 * = 4 DB ops/min that were running unconditionally at idle even with no
 * active or scheduled overrides.
 */
const SCHEDULER_INTERVAL_MS = 60_000;

let schedulerInterval: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  const now = new Date();
  const channelId = broadcastEngine.channelId;

  try {
    // ── 1. Expire overrides whose endsAt has passed ──────────────────────
    const expired = await db
      .update(overrides)
      .set({ isActive: false, endsAt: now })
      .where(
        and(
          eq(overrides.isActive, true),
          lte(overrides.endsAt, now),
        ),
      )
      .returning({ id: overrides.id, title: overrides.title });

    if (expired.length > 0) {
      overrideBus.notifyStopped();
      // Reload the engine so it recomputes the schedule chain timing from
      // the current wall-clock position. Without this the engine's in-memory
      // snapshot is stale relative to the cycle that was interrupted by the
      // override period (compare to the manual /stop route which always calls
      // broadcastEngine.reload() before notifyStopped).
      try {
        await broadcastEngine.reload();
      } catch (reloadErr) {
        logger.warn({ reloadErr }, "[scheduler] engine reload after override expiry failed (non-fatal)");
      }
      broadcastSignal("PROGRAM_CHANGED", channelId, {
        message: `Live override expired: ${expired[0]?.title ?? "unknown"}`,
        payload: { expiredIds: expired.map((r) => r.id) },
      });
      logger.info({ expired: expired.map((r) => r.id) }, "[scheduler] expired live override(s)");
    }

    // ── 2. Auto-start scheduled overrides whose scheduledFor has arrived ──
    // Only activate if no other override is currently live.
    if (!overrideBus.active) {
      const due = await db
        .select()
        .from(overrides)
        .where(
          and(
            eq(overrides.isActive, false),
            lte(overrides.scheduledFor, now),
            // scheduledFor must be set (not null — those are unscheduled)
            // and not too far in the past (grace window: 5 minutes) to
            // prevent replaying stale schedules after a server restart.
            gt(overrides.scheduledFor, new Date(now.getTime() - 5 * 60_000)),
          ),
        )
        .orderBy(overrides.scheduledFor)
        .limit(1);

      const next = due[0];
      if (next && (next.hlsStreamUrl || next.youtubeVideoId)) {
        // Deactivate any residual active rows (safety net).
        await db
          .update(overrides)
          .set({ isActive: false, endsAt: now })
          .where(eq(overrides.isActive, true));

        // Activate the scheduled override.
        const [started] = await db
          .update(overrides)
          .set({ isActive: true, autoStarted: true })
          .where(eq(overrides.id, next.id))
          .returning();

        if (started) {
          overrideBus.notifyStarted({
            id: started.id,
            title: started.title,
            hlsStreamUrl: started.hlsStreamUrl,
            youtubeVideoId: started.youtubeVideoId,
            startedAt: started.startedAt.toISOString(),
            endsAt: started.endsAt?.toISOString() ?? null,
          });
          broadcastSignal("PROGRAM_CHANGED", channelId, {
            message: `Scheduled broadcast started: ${started.title}`,
            payload: { overrideId: started.id, title: started.title, autoStarted: true },
          });
          logger.info({ id: started.id, title: started.title }, "[scheduler] auto-started scheduled override");
        }
      }
    }

    // ── 3. Engine health check ────────────────────────────────────────────
    const lastSnapshotAgeMs = broadcastEngine.getLastSnapshotAgeMs();
    const engineRunning = broadcastEngine.isRunning();
    // Threshold raised to 600 s (10 min): the v1 engine is no longer the
    // primary broadcast driver (v2 handles playback). Its snapshot age
    // naturally exceeds 2 min during normal v2 operation, causing false-
    // positive stale warnings every 120 s. The v2 orchestrator has its own
    // self-heal poll (every 20–30 s), so 10 min here is a last-resort
    // safety net rather than the primary health signal.
    const isStale = lastSnapshotAgeMs > 600_000 && engineRunning;

    if (isStale) {
      // The v1 engine is no longer the primary broadcast driver (v2 handles
      // playback). It naturally goes silent between cycles, so this fires
      // every ~10 minutes as expected behaviour rather than a real alert.
      // Downgraded from WARN → INFO to prevent log-monitoring false positives.
      logger.info({ lastSnapshotAgeMs }, "[scheduler] v1 broadcast engine cycle idle — nudging reload");
      try {
        await broadcastEngine.reload();
        broadcastSignal("SYNC_REQUIRED", channelId, {
          message: "Engine reloaded after stale detection — clients resync",
          payload: { triggerMs: lastSnapshotAgeMs },
        });
      } catch (err) {
        logger.error({ err }, "[scheduler] engine reload failed");
        broadcastSignal("STREAM_FAILED", channelId, {
          message: "Broadcast engine reload failed — stream may be down",
          payload: { staleMs: lastSnapshotAgeMs },
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, "[scheduler] tick error (non-fatal)");
  }
}

export const broadcastScheduler = {
  start(): void {
    if (schedulerInterval) return;
    // Run immediately on start, then on interval.
    void tick();
    schedulerInterval = setInterval(() => void tick(), SCHEDULER_INTERVAL_MS);
    schedulerInterval.unref?.();
    logger.info({ intervalMs: SCHEDULER_INTERVAL_MS }, "[scheduler] broadcast scheduler started");
  },

  stop(): void {
    if (schedulerInterval) {
      clearInterval(schedulerInterval);
      schedulerInterval = null;
    }
  },
  
  /** Validates and cleans up the scheduler on process exit. */
  async shutdown(): Promise<void> {
    this.stop();
  },

  /** Force an immediate tick (e.g., after admin state change). */
  async runNow(): Promise<void> {
    await tick();
  },
};
