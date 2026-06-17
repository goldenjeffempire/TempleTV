/**
 * Schedule-to-Air Bridge Worker
 *
 * Bridges the `schedule_entries` table to the live broadcast engine. Runs once
 * per minute and checks whether any active schedule entry whose `startTime`
 * falls within the current minute should trigger a broadcast action:
 *
 *  - contentType = "video"    → auto-enqueue the managed_videos row if it is
 *                               not already in the broadcast queue.
 *  - contentType = "live"     → start a live override (HLS URL) for the entry's
 *                               duration (until endTime, or 4 h if not set).
 *  - contentType = "external" → start a live override with the contentId URL.
 *  - contentType = "playlist" → scanLibraryAndEnqueue so all eligible videos
 *                               are in rotation (best-effort playlist semantics).
 *
 * All actions are idempotent: duplicate fires within the same minute are no-ops
 * because the broadcast queue has a unique-per-active-video index and the
 * override system deduplicates by idempotency key.
 *
 * The worker is registered with the WorkerSupervisor so it has circuit-breaker
 * protection and structured error logging.
 */

import { and, eq } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { broadcastOrchestrator } from "./broadcast-orchestrator.js";
import { enqueueIfMissing, scanLibraryAndEnqueue } from "../../broadcast/auto-enqueue.service.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";

const sched = schema.scheduleTable;
const vt = schema.videosTable;
const qt = schema.broadcastQueueTable;

/**
 * Tracks schedule entries that have already fired in this server session.
 * Key: "<entryId>_<dayOfWeek>_<startMinutesSinceMidnight>"
 * Value: Unix timestamp (ms) when the entry fired.
 *
 * This enables a ±2-minute catch-up window: if the supervisor fires slightly
 * late (delayed by a prior long-running job), entries that should have started
 * up to 2 minutes ago are still dispatched on the next tick. The map prevents
 * double-fires when the same entry falls within the catch-up window on
 * consecutive ticks.
 *
 * The map is cleared at midnight so entries can re-fire the next day.
 * On server restart the map is empty — entries that already fired today may
 * re-fire once, but all actions are idempotent (unique-index on the queue,
 * override dedup key) so the only effect is a redundant log line.
 */
const firedSlots = new Map<string, number>();

function firedSlotKey(entryId: string, dow: number, startMin: number): string {
  return `${entryId}_${dow}_${startMin}`;
}

(function scheduleMidnightClear() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const msUntilMidnight = midnight.getTime() - now.getTime();
  const t = setTimeout(() => {
    firedSlots.clear();
    scheduleMidnightClear();
  }, msUntilMidnight);
  t.unref?.();
})();

/**
 * Parse "HH:MM" or "HH:MM:SS" into total minutes since midnight.
 */
function parseTimeToMinutes(t: string): number {
  const parts = t.split(":").map(Number);
  return (parts[0]! * 60) + (parts[1]! ?? 0);
}

/**
 * Returns today's day-of-week (0=Sun … 6=Sat) in local server time.
 * The schedule table uses the same convention (0-6).
 */
function todayDow(): number {
  return new Date().getDay();
}

/**
 * Returns the current wall-clock minute since midnight in local server time.
 */
function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Returns a ms timestamp for today's endTime, or null.
 */
function endTimeMsForToday(endTime: string | null): number | null {
  if (!endTime) return null;
  const mins = parseTimeToMinutes(endTime);
  const d = new Date();
  d.setHours(0, mins, 0, 0);
  return d.getTime();
}

/**
 * Check whether the managed_videos row is already in the active broadcast queue.
 */
async function isAlreadyQueued(videoId: string): Promise<boolean> {
  const rows = await db
    .select({ id: qt.id })
    .from(qt)
    .where(and(eq(qt.videoId, videoId), eq(qt.isActive, true)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Main worker function — called once per minute by the WorkerSupervisor.
 */
export async function scheduleBridgeScan(): Promise<void> {
  const dow = todayDow();
  const currentMin = nowMinutes();

  // Fetch all active schedule entries for today whose startTime minute
  // matches the current wall-clock minute (±0 — the supervisor fires every
  // 60 s so we align to the minute boundary).
  const entries = await db
    .select()
    .from(sched)
    .where(
      and(
        eq(sched.isActive, true),
        eq(sched.dayOfWeek, dow),
      ),
    );

  const firing = entries.filter((e) => {
    const startMin = parseTimeToMinutes(e.startTime);
    // 2-minute catch-up window: fire if start was within the last 2 minutes.
    // This handles supervisor delays (previous job took >60 s, server briefly
    // paused, etc.) so a missed tick does not permanently skip the entry.
    const diff = currentMin - startMin;
    if (diff < 0 || diff > 2) return false;
    // Idempotency: skip if this exact slot already fired in this server session.
    return !firedSlots.has(firedSlotKey(e.id, dow, startMin));
  });

  if (firing.length === 0) return;

  logger.info(
    { count: firing.length, dow, currentMin },
    "[schedule-bridge] firing %d schedule entries for this minute",
    firing.length,
  );

  for (const entry of firing) {
    // Mark the slot as fired BEFORE handleEntry so that a throw inside
    // handleEntry does not cause the same entry to re-fire on the next tick.
    const startMin = parseTimeToMinutes(entry.startTime);
    firedSlots.set(firedSlotKey(entry.id, dow, startMin), Date.now());
    try {
      await handleEntry(entry);
    } catch (err: unknown) {
      logger.warn(
        { err, entryId: entry.id, title: entry.title, contentType: entry.contentType },
        "[schedule-bridge] entry handler failed (non-fatal)",
      );
    }
  }
}

type ScheduleRow = typeof sched.$inferSelect;

async function handleEntry(entry: ScheduleRow): Promise<void> {
  const endsAtMs = endTimeMsForToday(entry.endTime);
  // Default override duration: 4 hours if no endTime specified.
  const overrideDurationMs = endsAtMs
    ? Math.max(0, endsAtMs - Date.now())
    : 4 * 60 * 60_000;

  switch (entry.contentType) {
    case "video": {
      if (!entry.contentId) {
        logger.warn({ entryId: entry.id }, "[schedule-bridge] video entry has no contentId — skipping");
        return;
      }
      // Verify the video exists before attempting to enqueue it.
      const [video] = await db
        .select({ id: vt.id, title: vt.title })
        .from(vt)
        .where(eq(vt.id, entry.contentId))
        .limit(1);
      if (!video) {
        logger.warn({ entryId: entry.id, videoId: entry.contentId }, "[schedule-bridge] video not found — skipping");
        return;
      }
      if (await isAlreadyQueued(video.id)) {
        logger.debug({ entryId: entry.id, videoId: video.id }, "[schedule-bridge] video already in queue — no-op");
        return;
      }
      // Directly enqueue the specific scheduled video (not a library scan which
      // might pick a different video). enqueueIfMissing is idempotent and handles
      // the not-yet-playable / corrupt-source checks internally.
      const result = await enqueueIfMissing({ videoId: video.id, reason: "schedule-bridge" });
      logger.info(
        { entryId: entry.id, videoId: video.id, enqueued: result.enqueued, skipReason: result.skipReason },
        "[schedule-bridge] video entry processed",
      );
      if (result.enqueued) {
        adminEventBus.push("broadcast-queue-updated", { reason: "schedule-bridge", entryId: entry.id });
        // Notify the admin schedule page so it can reflect that this entry fired.
        adminEventBus.push("broadcast-schedule-updated", { reason: "schedule-bridge-fired", entryId: entry.id });
      }
      break;
    }

    case "live":
    case "external": {
      if (!entry.contentId) {
        logger.warn({ entryId: entry.id }, "[schedule-bridge] live/external entry has no contentId URL — skipping");
        return;
      }
      if (overrideDurationMs <= 0) {
        logger.warn({ entryId: entry.id }, "[schedule-bridge] live/external entry has already passed endTime — skipping");
        return;
      }
      await broadcastOrchestrator.startOverride({
        kind: "hls",
        url: entry.contentId,
        title: entry.title,
        endsAtMs: endsAtMs ?? Date.now() + overrideDurationMs,
        resumeQueueOnEnd: true,
      });
      logger.info(
        { entryId: entry.id, url: entry.contentId, endsAtMs },
        "[schedule-bridge] live/external override started",
      );
      // Notify both queue and schedule pages — an override changes broadcast
      // mode which affects both the Master Control queue view and the schedule
      // entry list.
      adminEventBus.push("broadcast-queue-updated", { reason: "schedule-bridge-live", entryId: entry.id });
      adminEventBus.push("broadcast-schedule-updated", { reason: "schedule-bridge-fired", entryId: entry.id });
      break;
    }

    case "playlist": {
      // Best-effort: ensure all eligible library videos are in the queue.
      const result = await scanLibraryAndEnqueue({ reason: "schedule-bridge-playlist", maxToAdd: 500 });
      logger.info(
        { entryId: entry.id, enqueued: result.enqueued },
        "[schedule-bridge] playlist scan complete",
      );
      if (result.enqueued > 0) {
        adminEventBus.push("broadcast-queue-updated", { reason: "schedule-bridge-playlist", entryId: entry.id });
        adminEventBus.push("broadcast-schedule-updated", { reason: "schedule-bridge-fired", entryId: entry.id });
      }
      break;
    }

    default:
      logger.warn(
        { entryId: entry.id, contentType: entry.contentType },
        "[schedule-bridge] unknown contentType — skipping",
      );
  }
}
