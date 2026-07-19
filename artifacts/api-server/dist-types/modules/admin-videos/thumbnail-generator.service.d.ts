/**
 * Thumbnail Generator Service
 *
 * Extracts a JPEG still frame from a locally-stored video at ~30% of its
 * duration using ffmpeg, then stores the result in BYTEA object storage and
 * updates `managed_videos.thumbnailUrl`.
 *
 * Designed to run both on-demand (admin "Regenerate Thumbnail" button) and as
 * a background sweep that fills in missing thumbnails for all eligible videos.
 *
 * A video is eligible for auto-generation when ALL of these are true:
 *   • video_source = 'local' (YouTube videos get thumbnails from YouTube CDN)
 *   • has_custom_thumbnail = false (never overwrite operator-uploaded thumbs)
 *   • localVideoUrl IS NOT NULL (no HTTP path → nothing to feed ffmpeg)
 *   • thumbnailUrl IS NULL or thumbnailUrl = '' (skip re-generation unless forced)
 *
 * The generated thumbnail key is `thumbnails/<videoId>.jpg`.  Serving happens
 * through the existing `/api/v1/uploads/<key>` route.
 */
export interface ThumbnailResult {
    videoId: string;
    thumbnailUrl: string;
    generated: boolean;
    error?: string;
}
/**
 * Generate (or regenerate) a thumbnail for a single video.
 *
 * @param videoId  The `managed_videos.id` to generate a thumbnail for.
 * @param force    If true, regenerate even if `thumbnailUrl` already exists
 *                 (but never overwrite `hasCustomThumbnail = true`).
 */
export declare function generateThumbnailForVideo(videoId: string, force?: boolean): Promise<ThumbnailResult>;
/**
 * Background sweep: generate thumbnails for all eligible local videos that
 * have no thumbnail yet. Processes up to `batchSize` videos per run to avoid
 * OOM under concurrent HLS transcoding jobs.
 */
export declare function autoGenerateMissingThumbnails(batchSize?: number): Promise<{
    processed: number;
    generated: number;
}>;
