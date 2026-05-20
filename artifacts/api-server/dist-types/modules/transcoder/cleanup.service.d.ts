/**
 * Post-Transcode Source Cleanup Service
 *
 * After a video's HLS transcoding completes successfully, the original raw
 * source blob (stored under `uploads/…` in storage_blobs) is no longer
 * needed for playback — the HLS renditions are the authoritative copy.
 * Keeping the source blob wastes significant database storage (a 1-hour
 * sermon at 1080p can be 4–8 GiB as raw video).
 *
 * This service implements a robust, idempotent cleanup pipeline:
 *
 *  1. scheduleSourceCleanup(videoId, sourceObjectPath)
 *     Called by the transcoder dispatcher immediately after a job succeeds.
 *     Validates the HLS output, then either deletes the source immediately
 *     (if the retention window is already satisfied) or marks it 'scheduled'
 *     so the sweep picks it up after the window expires.
 *
 *  2. CleanupWorker.start() / .stop()
 *     A background sweep that runs every CLEANUP_SWEEP_MS (default 5 min).
 *     Picks up any videos with sourceCleanupStatus='scheduled' whose
 *     sourceCleanupAfter has passed (covers restarts, failures, backlog).
 *
 * HLS Validation (performed before any deletion):
 *   - master.m3u8 exists in storage_blobs
 *   - All rendition playlist entries referenced in master.m3u8 exist
 *   - Each rendition playlist references ≥1 .ts segment
 *   - At least one segment for each rendition exists in storage_blobs
 *
 * If validation fails the source is NOT deleted and the status is left as
 * 'scheduled' so it will be retried on the next sweep. After
 * CLEANUP_MAX_ATTEMPTS consecutive failures it is flipped to 'failed' so
 * operators can inspect it without the sweep hammering it endlessly.
 *
 * Concurrency safety:
 *   The sweep uses an UPDATE … SET sourceCleanupStatus='running' RETURNING
 *   pattern so multiple processes / replicas never double-delete the same blob.
 *   (Actual status value 'running' is internal to the sweep; it is replaced by
 *   'deleted' or 'scheduled' before the transaction completes.)
 */
/**
 * Called by the transcoder dispatcher immediately after a job succeeds.
 *
 * If the retention window is 0 the source is validated and deleted right away.
 * Otherwise, the video is marked 'scheduled' with a sourceCleanupAfter
 * timestamp so the sweep worker processes it after the window expires.
 *
 * This function never throws — all errors are logged and surfaced via the
 * sourceCleanupStatus column for operator visibility.
 */
export declare function scheduleSourceCleanup(videoId: string, sourceObjectKey: string | null | undefined): Promise<void>;
/**
 * Run one sweep iteration:
 *  - Find up to CLEANUP_MAX_PER_SWEEP videos where:
 *      sourceCleanupStatus = 'scheduled'
 *      sourceCleanupAfter <= NOW()
 *      objectPath IS NOT NULL
 *  - For each: validate HLS + delete source blob.
 *
 * Uses a SELECT…FOR UPDATE SKIP LOCKED pattern to be multi-replica safe.
 */
export declare function runCleanupSweep(): Promise<{
    processed: number;
    deleted: number;
    deferred: number;
    errors: number;
}>;
/**
 * Long-running sweep worker that calls runCleanupSweep() on a configurable
 * interval. Wire into main.ts alongside the transcoder dispatcher.
 */
declare class CleanupWorker {
    private timer;
    private stopped;
    private running;
    start(): void;
    stop(): void;
}
export declare const cleanupWorker: CleanupWorker;
export {};
