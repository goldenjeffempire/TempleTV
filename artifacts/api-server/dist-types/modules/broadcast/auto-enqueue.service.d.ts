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
    reason: "upload-finalize" | "yt-sync" | "library-scan" | "manual-import" | "upload-recovery-on-restart" | "repair-all" | "enqueue-missing" | "assembly-retry" | "assembly-recovered-on-restart" | "schedule-bridge" | "schedule-bridge-fallback" | "deep-recovery" | "manual-enqueue" | "bulk-enqueue" | "validation-remediated" | "stuck-assembly-scanner";
}): Promise<{
    enqueued: boolean;
    queueItemId?: string;
    skipReason?: string;
}>;
/**
 * Self-healing repair sweep: finds all local `managed_videos` rows where
 * `s3_mirrored_at IS NULL` (indicating the post-assembly stamp was either
 * never written or silently swallowed), confirms the storage blob actually
 * exists in `storage_blobs`, and stamps `s3_mirrored_at = NOW()` for every
 * confirmed match.
 *
 * WHY THIS EXISTS:
 *   The upload finalize path sets
 *   `s3MirroredAt` inside a `Promise.all` with `.catch(() => {})` that
 *   previously swallowed errors silently. If that UPDATE ever failed (transient
 *   pool exhaustion, statement timeout), the video's `s3_mirrored_at` would
 *   remain NULL permanently. `scanLibraryAndEnqueue` pre-filters out local
 *   videos whose `s3_mirrored_at IS NULL`, so those videos would never enter
 *   the broadcast queue — not at startup, not during self-heal, never.
 *
 *   This function runs before every `scanLibraryAndEnqueue` call to ensure that
 *   no valid, assembled video is permanently excluded by a stale NULL stamp.
 *
 * SAFETY:
 *   - Only repairs videos where the blob is confirmed present in storage_blobs
 *     (i.e., `completeMultipartUpload` actually committed the bytes). Pre-
 *     committed or partially-assembled rows have no blob row yet and are left
 *     untouched — they continue to be excluded from the scan until the
 *     assembly finishes and stamps the field correctly.
 *   - Excludes terminal error codes (ASSEMBLY_FAILED, CORRUPT_SOURCE,
 *     SOURCE_MISSING) so we don't re-admit permanently broken uploads.
 *   - Batch-updates with a single UPDATE … WHERE id IN (…) to minimise
 *     round-trips; the cap of 500 rows prevents runaway scans on large DBs.
 */
export declare function repairMissingS3MirroredAt(videoId?: string): Promise<{
    repaired: number;
}>;
/**
 * Startup blob audit: scans all local managed_videos rows that have a
 * `localVideoUrl` and confirms each one has a corresponding row in
 * `storage_blobs`.  Videos whose blob is absent are logged as errors so
 * operators can identify and re-upload them.  This is a read-only diagnostic
 * — it does NOT deactivate queue items (the queue integrity validator handles
 * that) or delete video rows.
 *
 * Returns a summary of how many videos were checked and how many are missing.
 */
export declare function auditMissingBlobs(): Promise<{
    checked: number;
    missing: number;
    missingIds: string[];
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
