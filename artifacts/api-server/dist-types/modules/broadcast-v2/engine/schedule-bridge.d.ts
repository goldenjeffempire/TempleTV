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
export declare function scheduleBridgeScan(): Promise<void>;
