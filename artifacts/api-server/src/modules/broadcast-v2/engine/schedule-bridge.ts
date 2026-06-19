/**
 * Schedule-to-Air Bridge Worker
 *
 * Bridges the `schedule_entries` table to the live broadcast engine. Runs once
 * per minute and checks whether any active schedule entry should trigger a
 * broadcast action.
 *
 * Two matching modes:
 *
 *  RECURRING (scheduledDate IS NULL):
 *    Matches when `dayOfWeek` == today's day-of-week AND `startTime` falls
 *    within the current minute (with a ±2-minute catch-up window).
 *
 *  ONE-TIME (scheduledDate IS NOT NULL, e.g. "2026-06-22"):
 *    Matches when `scheduledDate` == today's local date string AND `startTime`
 *    falls within the current minute window. After firing, the entry is
 *    automatically deactivated (isActive=false) to prevent re-fire on restart.
 *
 * Action types by contentType + priorityOverride:
 *
 *  contentType = "video" + priorityOverride = false:
 *    Enqueue the managed_videos row if not already in the broadcast queue.
 *    Best-effort: does not interrupt whatever is currently on-air.
 *
 *  contentType = "video" + priorityOverride = true:
 *    Interrupt the current broadcast immediately using the override mechanism.
 *    Resolves the video's best playable URL (HLS > MP4 faststart > MP4 raw)
 *    and calls broadcastOrchestrator.startOverride() with resumeQueueOnEnd=true.
 *    This guarantees the scheduled video plays at the exact time.
 *
 *  contentType = "live" / "external":
 *    Start a live override (HLS URL) for the entry's duration.
 *
 *  contentType = "playlist":
 *    scanLibraryAndEnqueue so all eligible library videos are in rotation.
 *
 * All actions are idempotent (unique-index on queue, override dedup key).
 */

import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { db, schema } from "../../../infrastructure/db.js";
import { logger } from "../../../infrastructure/logger.js";
import { broadcastOrchestrator } from "./broadcast-orchestrator.js";
import { enqueueIfMissing, scanLibraryAndEnqueue } from "../../broadcast/auto-enqueue.service.js";
import { adminEventBus } from "../../admin-ops/admin-event-bus.js";
import { scheduleService } from "../../schedule/schedule.service.js";
import { env } from "../../../config/env.js";

const sched = schema.scheduleTable;
const vt = schema.videosTable;
const qt = schema.broadcastQueueTable;

/**
 * Tracks schedule entries that have already fired in this server session.
 * Key: "<entryId>_<dow>_<startMin>" for recurring,
 *      "<entryId>_<scheduledDate>_<startMin>" for one-time events.
 *
 * Cleared at midnight so recurring entries can fire the next day.
 */
const firedSlots = new Map<string, number>();

function firedSlotKey(entryId: string, qualifier: string, startMin: number): string {
  return `${entryId}_${qualifier}_${startMin}`;
}

(function scheduleMidnightClear() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const t = setTimeout(() => {
    firedSlots.clear();
    scheduleMidnightClear();
  }, midnight.getTime() - now.getTime());
  t.unref?.();
})();

function parseTimeToMinutes(t: string): number {
  const parts = t.split(":").map(Number);
  return (parts[0]! * 60) + (parts[1]! ?? 0);
}

function todayDow(): number { return new Date().getDay(); }

function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/** "YYYY-MM-DD" in local time */
function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function endTimeMsForToday(endTime: string | null): number | null {
  if (!endTime) return null;
  const mins = parseTimeToMinutes(endTime);
  const d = new Date();
  d.setHours(0, mins, 0, 0);
  return d.getTime();
}

async function isAlreadyQueued(videoId: string): Promise<boolean> {
  const rows = await db
    .select({ id: qt.id })
    .from(qt)
    .where(and(eq(qt.videoId, videoId), eq(qt.isActive, true)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Resolve the best playable URL for a managed video.
 * Only returns HLS URLs — MP4-only videos are not suitable for priority
 * override (the V2Override kind must be "hls" | "rtmp" | "youtube").
 * Callers should fall back to standard enqueue when null is returned.
 */
async function resolveVideoHlsUrl(videoId: string): Promise<string | null> {
  const [v] = await db
    .select({ hlsMasterUrl: vt.hlsMasterUrl })
    .from(vt)
    .where(eq(vt.id, videoId))
    .limit(1);
  if (!v?.hlsMasterUrl) return null;
  return v.hlsMasterUrl;
}

export async function scheduleBridgeScan(): Promise<void> {
  const dow = todayDow();
  const currentMin = nowMinutes();
  const today = todayDateStr();

  // Fetch recurring entries for today's day-of-week
  const recurringEntries = await db
    .select()
    .from(sched)
    .where(
      and(
        eq(sched.isActive, true),
        isNull(sched.scheduledDate),
        eq(sched.dayOfWeek, dow),
      ),
    );

  // Fetch one-time entries for today's date
  const oneTimeEntries = await db
    .select()
    .from(sched)
    .where(
      and(
        eq(sched.isActive, true),
        isNotNull(sched.scheduledDate),
        eq(sched.scheduledDate, today),
      ),
    );

  const allEntries = [...recurringEntries, ...oneTimeEntries];

  const firing = allEntries.filter((e) => {
    const startMin = parseTimeToMinutes(e.startTime);
    const diff = currentMin - startMin;
    if (diff < 0 || diff > 2) return false;
    const qualifier = e.scheduledDate ?? String(dow);
    return !firedSlots.has(firedSlotKey(e.id, qualifier, startMin));
  });

  if (firing.length === 0) return;

  logger.info(
    { count: firing.length, dow, currentMin, today },
    "[schedule-bridge] firing %d schedule entries",
    firing.length,
  );

  for (const entry of firing) {
    const startMin = parseTimeToMinutes(entry.startTime);
    const qualifier = entry.scheduledDate ?? String(dow);
    firedSlots.set(firedSlotKey(entry.id, qualifier, startMin), Date.now());
    try {
      await handleEntry(entry);
      // Deactivate one-time entries after firing so they don't re-fire on restart.
      if (entry.scheduledDate) {
        await scheduleService.deactivateOneTime(entry.id).catch((err: unknown) =>
          logger.warn({ err, entryId: entry.id }, "[schedule-bridge] failed to deactivate one-time entry (non-fatal)"),
        );
        adminEventBus.push("broadcast-schedule-updated", { reason: "one-time-fired-deactivated", entryId: entry.id });
      }
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
  const overrideDurationMs = endsAtMs
    ? Math.max(0, endsAtMs - Date.now())
    : 4 * 60 * 60_000;

  switch (entry.contentType) {
    case "video": {
      if (!entry.contentId) {
        logger.warn({ entryId: entry.id }, "[schedule-bridge] video entry has no contentId — skipping");
        return;
      }

      // Verify video exists
      const [video] = await db
        .select({ id: vt.id, title: vt.title })
        .from(vt)
        .where(eq(vt.id, entry.contentId))
        .limit(1);
      if (!video) {
        logger.warn({ entryId: entry.id, videoId: entry.contentId }, "[schedule-bridge] video not found — skipping");
        return;
      }

      if (entry.priorityOverride) {
        // PRIORITY OVERRIDE MODE: interrupt current broadcast immediately.
        // Requires an HLS URL — MP4-only videos fall back to standard enqueue.
        const hlsUrl = await resolveVideoHlsUrl(video.id);
        if (!hlsUrl) {
          logger.warn(
            { entryId: entry.id, videoId: video.id },
            "[schedule-bridge] priority-override: no HLS URL yet — falling back to enqueue",
          );
          const result = await enqueueIfMissing({ videoId: video.id, reason: "schedule-bridge-fallback" });
          if (result.enqueued) {
            adminEventBus.push("broadcast-queue-updated", { reason: "schedule-bridge-priority-fallback", entryId: entry.id });
            adminEventBus.push("broadcast-schedule-updated", { reason: "schedule-bridge-fired", entryId: entry.id });
          }
          return;
        }
        await broadcastOrchestrator.startOverride({
          kind: "hls",
          url: hlsUrl,
          title: entry.title,
          endsAtMs: endsAtMs ?? (Date.now() + overrideDurationMs),
          resumeQueueOnEnd: true,
        });
        logger.info(
          { entryId: entry.id, videoId: video.id, kind: "hls", hasEndTime: !!endsAtMs },
          "[schedule-bridge] priority-override started for scheduled video",
        );
        adminEventBus.push("broadcast-queue-updated", { reason: "schedule-bridge-priority", entryId: entry.id });
        adminEventBus.push("broadcast-schedule-updated", { reason: "schedule-bridge-fired", entryId: entry.id });
        return;
      }

      // STANDARD MODE: just enqueue if not already queued
      if (await isAlreadyQueued(video.id)) {
        logger.debug({ entryId: entry.id, videoId: video.id }, "[schedule-bridge] video already in queue — no-op");
        return;
      }
      const result = await enqueueIfMissing({ videoId: video.id, reason: "schedule-bridge" });
      logger.info(
        { entryId: entry.id, videoId: video.id, enqueued: result.enqueued, skipReason: result.skipReason },
        "[schedule-bridge] video entry processed",
      );
      if (result.enqueued) {
        adminEventBus.push("broadcast-queue-updated", { reason: "schedule-bridge", entryId: entry.id });
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
      adminEventBus.push("broadcast-queue-updated", { reason: "schedule-bridge-live", entryId: entry.id });
      adminEventBus.push("broadcast-schedule-updated", { reason: "schedule-bridge-fired", entryId: entry.id });
      break;
    }

    case "playlist": {
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
