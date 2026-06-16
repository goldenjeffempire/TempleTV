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
/**
 * Main worker function — called once per minute by the WorkerSupervisor.
 */
export declare function scheduleBridgeScan(): Promise<void>;
