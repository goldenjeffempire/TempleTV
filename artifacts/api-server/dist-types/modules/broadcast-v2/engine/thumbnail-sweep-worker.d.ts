/**
 * Thumbnail Sweep Worker
 *
 * Background worker that auto-generates missing thumbnails for local videos.
 * Runs every 10 minutes (configurable via THUMBNAIL_SWEEP_INTERVAL_MS).
 * Processes up to 5 videos per sweep to avoid contending with HLS transcoding.
 *
 * Skips:
 *   • YouTube videos (they get thumbnails from YouTube CDN)
 *   • Videos with hasCustomThumbnail = true
 *   • Videos that already have a thumbnailUrl
 *   • Videos without a localVideoUrl (no source to extract from)
 *
 * Uses workerSupervisor for circuit-breaker, deadman-switch, and Prometheus
 * metrics. A hung ffprobe call no longer freezes the worker permanently —
 * the supervisor's deadman fires after 2× the interval and marks a failure.
 */
export declare function startThumbnailSweepWorker(): void;
export declare function stopThumbnailSweepWorker(): void;
