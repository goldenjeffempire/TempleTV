import { inArray } from "drizzle-orm";
export declare function isAutoEnqueueEnabled(): boolean;
/**
 * Enqueue a single managed_video row into the broadcast queue if it isn't
 * already present. Returns true when a new row was inserted, false when the
 * video was already queued or auto-enqueue is disabled.
 *
 * `reason` is logged so on-call can grep for "auto-enqueue" and trace which
 * pipeline (upload / yt-sync / library-scan) produced each row.
 */
export declare function enqueueIfMissing(opts: {
    videoId: string;
    reason: "upload-finalize" | "yt-sync" | "library-scan" | "manual-import" | "upload-recovery-on-restart" | "repair-all" | "enqueue-missing" | "assembly-retry" | "schedule-bridge";
}): Promise<{
    enqueued: boolean;
    queueItemId?: string;
    skipReason?: string;
}>;
/**
 * Scan the entire library for playable videos that are NOT in the broadcast
 * queue, and enqueue every one of them. Two call sites:
 *
 *  1. After a YouTube sync run — picks up freshly-imported YT rows in bulk
 *     without us having to thread "inserted vs updated" diffs through the
 *     ingestion pipeline.
 *
 *  2. Orchestrator empty-queue self-heal — if the queue has been empty for
 *     more than one poll interval AND the library has playable content, we
 *     pull that content into the queue automatically so the broadcast can
 *     come back on-air without operator action.
 *
 * Enforces a hard `maxToAdd` cap so a fresh database with 5 000 imported
 * videos doesn't insert 5 000 queue rows in a single transaction. Items are
 * ordered by `imported_at DESC` so newest content airs first, matching the
 * UX users expect from "add to queue" on the library page.
 */
export declare function scanLibraryAndEnqueue(opts: {
    reason: "yt-sync" | "self-heal-empty" | "self-heal-all-blocked" | "manual" | "queue-health-guard" | "startup" | "schedule-bridge-playlist";
    maxToAdd?: number;
}): Promise<{
    scanned: number;
    enqueued: number;
    skipped: number;
}>;
/**
 * Bulk variant: enqueue a known set of video ids (e.g. the rows newly
 * inserted by an admin batch import). De-duped per-id inside enqueueIfMissing
 * so this is safe to call with any mix of new + existing ids.
 */
export declare function enqueueManyIfMissing(videoIds: string[], reason: "yt-sync" | "manual-import"): Promise<number>;
/**
 * List which managed_videos rows are currently NOT in the broadcast queue.
 * Exposed for diagnostics / admin "scan now" buttons; the orchestrator
 * never calls this directly.
 */
export declare function listMissingFromQueue(limit?: number): Promise<Array<{
    id: string;
    title: string;
    videoSource: string;
    reason: string;
}>>;
export { inArray };
