/**
 * MP4 faststart post-processor.
 *
 * Runs `ffmpeg -c copy -movflags +faststart` on a newly-uploaded video to
 * relocate the moov atom from the end of the file to the beginning. This is a
 * stream-copy (no re-encoding) so it completes in seconds even for 300 MB
 * files. After processing, the video starts playing from the very first byte
 * — browsers can parse metadata immediately without an HTTP Range round-trip.
 *
 * Lifecycle written to managed_videos.transcoding_status:
 *   queued (upload complete) → processing → ready     (success)
 *                                          → <prior>   (failure — restored, not 'failed')
 *
 * Always call as `void runFaststart(...)` — intentionally non-blocking so
 * the finalize HTTP response returns immediately.
 */
export interface FaststartResult {
    elapsedMs: number;
    outputSizeBytes: number;
    durationSecs: number | null;
}
export interface FaststartOptions {
    /**
     * When true, faststart will NOT update `transcodingStatus` on
     * managed_videos. Use this when the HLS transcoder is also running on the
     * same video so that faststart doesn't overwrite the authoritative
     * "encoding" / "hls_ready" state that the transcoder owns.
     * Duration and sizeBytes are always updated regardless of this flag.
     */
    skipStatusUpdate?: boolean;
}
/**
 * Apply MP4 faststart to an uploaded video stored in object storage.
 *
 * Steps:
 *   1. Snapshot priorTranscodingStatus; mark video as `processing`.
 *   2. Download the blob from storage to a local temp file.
 *   3. Run ffmpeg -c copy -movflags +faststart.
 *   4. Run ffprobe to measure exact duration.
 *   5. Re-upload via multipart: createMultipartUpload → uploadPart (8 MiB
 *      chunks) → completeMultipartUpload. The original key remains readable
 *      throughout — no 404 window, no data-loss risk if the upload fails.
 *   6. Update managed_videos: faststartApplied=true, transcodingStatus='ready',
 *      duration, sizeBytes.
 *   7. Fire videos-library-updated + broadcast-queue-updated so the admin UI
 *      refreshes and the orchestrator reloads without operator action.
 *
 * On failure:
 *   - The original blob at objectKey is NEVER deleted; it remains intact and
 *     playable (moov may still be at EOF, but the file is not lost).
 *   - transcodingStatus is restored to its pre-faststart value (not 'failed'),
 *     so the queue item stays admitted and the video continues to air.
 *   - Any in-progress multipart upload is aborted to clean up _parts/* rows.
 *
 * The scratch directory is always cleaned up in the finally block.
 */
export declare function runFaststart(videoId: string, objectKey: string, options?: FaststartOptions): Promise<FaststartResult>;
