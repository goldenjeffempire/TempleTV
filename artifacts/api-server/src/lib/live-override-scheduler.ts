import { db, liveOverridesTable } from "@workspace/db";
import { and, eq, isNotNull, lte, ne } from "drizzle-orm";
import { logger } from "./logger";
import { broadcastLiveEvent } from "./liveEvents";
import { cache } from "./cache";
import { buildLiveStatusPayload } from "./liveStatus";
import { emitBroadcastState } from "../routes/broadcast";

/**
 * Periodically activates live overrides whose `scheduled_for` time has
 * arrived. Lets admins queue a YouTube live URL ahead of time (e.g.
 * "Sunday service at 9am") and have it auto-go-live across TV / mobile
 * / web / radio without manual intervention.
 *
 * Mirrors the architecture of `notification-scheduler.ts`:
 *   - 30-second interval, single-instance re-entrancy guard
 *   - Self-recovers from DB hiccups (errors are logged, never throw)
 *   - Broadcasts the same SSE events as a manual Go Live so every
 *     viewer surface picks up the change in real time
 *
 * Multi-instance safety: when scaled horizontally, every API replica
 * runs this scheduler. The activation step uses an atomic conditional
 * UPDATE — only one replica will succeed at flipping `is_active=false
 * → true`, and the others are no-ops. SSE/cache fan-out only happens
 * for the replica that actually flipped the row.
 */

// Same cache keys used by `invalidateBroadcastCache()` in routes/admin.ts
// and routes/broadcast.ts. Duplicated here (instead of imported from
// admin.ts) because admin.ts is a heavyweight router module — cycle-free
// is preferred. If new keys are added there, mirror them here too.
const BROADCAST_CACHE_KEYS = [
  "broadcast:live_override",
  "broadcast:schedule_entries",
  "broadcast:queue",
] as const;

let running = false;

async function processDueOverrides() {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const due = await db
      .select()
      .from(liveOverridesTable)
      .where(
        and(
          eq(liveOverridesTable.isActive, false),
          eq(liveOverridesTable.autoStarted, false),
          isNotNull(liveOverridesTable.scheduledFor),
          lte(liveOverridesTable.scheduledFor, now),
        ),
      );

    if (due.length === 0) return;

    for (const row of due) {
      try {
        // Atomic claim — only one replica/process can flip this row.
        // Returning rows lets us know whether we actually won.
        const claimed = await db
          .update(liveOverridesTable)
          .set({ isActive: true, autoStarted: true, startedAt: now })
          .where(
            and(
              eq(liveOverridesTable.id, row.id),
              eq(liveOverridesTable.isActive, false),
              eq(liveOverridesTable.autoStarted, false),
            ),
          )
          .returning();

        if (claimed.length === 0) {
          // Another replica got there first — totally fine, skip.
          continue;
        }

        // Stand down any other active override (manual or scheduled).
        // Same rule as the manual `POST /admin/live/override/start`
        // route: only one override can be live at a time.
        await db
          .update(liveOverridesTable)
          .set({ isActive: false })
          .where(
            and(
              eq(liveOverridesTable.isActive, true),
              ne(liveOverridesTable.id, row.id),
            ),
          );

        // Fan out: viewers, admin dashboards, downstream caches.
        // This is the same three-step sequence the manual `POST
        // /admin/live/override/start` route does — cache invalidation
        // first, then the canonical `status` payload (so reconnecting
        // viewers see the new state immediately), then the lighter
        // `broadcast-control-updated` ping for clients listening only
        // for change notifications, then the broadcast-state event for
        // the admin dashboard's activity stream. Keeping these in
        // lockstep with the manual flow prevents subtle "scheduled
        // overrides don't show up on tablet until refresh" bugs.
        await Promise.all(BROADCAST_CACHE_KEYS.map((k) => cache.del(k)));
        buildLiveStatusPayload()
          .then((payload) => broadcastLiveEvent("status", payload))
          .catch((err) =>
            logger.warn({ err, overrideId: row.id }, "Failed to broadcast status after scheduled go-live"),
          );
        broadcastLiveEvent("broadcast-control-updated", {
          source: "scheduler",
          overrideId: row.id,
          startedAt: now.toISOString(),
        });
        emitBroadcastState("live-started", { id: row.id, source: "scheduler" });

        logger.info(
          { overrideId: row.id, title: row.title, youtubeVideoId: row.youtubeVideoId },
          "Scheduled live override auto-started",
        );
      } catch (err) {
        logger.error(
          { err, overrideId: row.id },
          "Failed to auto-start scheduled live override",
        );
      }
    }
  } catch (err) {
    logger.error({ err }, "live-override-scheduler tick failed");
  } finally {
    running = false;
  }
}

export function startLiveOverrideScheduler(): void {
  logger.info({ intervalMs: 30_000 }, "Live override scheduler started");
  processDueOverrides().catch((err) =>
    logger.error({ err }, "live-override-scheduler error on startup"),
  );
  const timer = setInterval(() => {
    processDueOverrides().catch((err) =>
      logger.error({ err }, "live-override-scheduler error"),
    );
  }, 30_000);
  timer.unref();
}
