export interface TranscodeRequest {
    jobId: string;
    videoId: string;
    sourceObjectKey: string;
    onProgress?: (percent: number) => void | Promise<void>;
}
export interface TranscodeResult {
    masterPlaylistKey: string;
    masterPlaylistUrl: string;
    renditions: Array<{
        name: string;
        bitrateKbps: number;
        width: number;
        height: number;
        segmentCount: number;
    }>;
    durationSecs: number | null;
    totalBytes: number;
    elapsedMs: number;
    /**
     * Proxy URL for the auto-generated thumbnail JPEG extracted at t=1s.
     * Stored alongside the HLS segments at `transcoded/<videoId>/thumbnail.jpg`
     * and served via the same /api/hls/:videoId/* proxy. Undefined when
     * thumbnail extraction failed (non-fatal — HLS transcoding still succeeded).
     */
    thumbnailUrl?: string;
}
interface RenditionSpec {
    name: string;
    width: number;
    height: number;
    videoBitrateK: number;
    maxrateK: number;
    bufsizeK: number;
    audioBitrateK: number;
}
declare function buildFfmpegArgs(input: string, outDir: string): string[];
/**
 * FFmpeg-based HLS transcoder.
 *
 * Downloads the source video from DatabaseObjectStorage (storage_blobs table)
 * to a local temp file, runs ffmpeg to produce a multi-rendition VOD HLS
 * package (master playlist + per-rendition playlists + MPEG-TS segments),
 * then uploads all output files back to storage_blobs under a stable key
 * prefix and returns the public API proxy URL of the master playlist.
 *
 * Designed to run inside the in-process worker dispatcher (one job at
 * a time per replica). For multi-replica deployments scale via
 * RUN_MODE=worker on dedicated hosts; the dispatcher's atomic claim
 * prevents double-processing.
 *
 * Output layout in storage_blobs:
 *   transcoded/<videoId>/master.m3u8
 *   transcoded/<videoId>/v0/playlist.m3u8
 *   transcoded/<videoId>/v0/seg_00000.ts ...
 *   transcoded/<videoId>/v1/playlist.m3u8
 *   transcoded/<videoId>/v1/seg_00000.ts ...
 */
export declare function runTranscode(req: TranscodeRequest): Promise<TranscodeResult>;
/**
 * Probes the duration of a newly-uploaded source file via ffprobe. Downloads
 * the object from storage_blobs to a temp file, runs ffprobe against it
 * (exits as soon as the format header is read), and returns the duration in
 * seconds. Designed to run immediately after upload completion so the video
 * card shows the correct runtime without waiting for HLS.
 *
 * Non-fatal: returns null on any failure (no ffprobe binary, DB error, etc.).
 */
export declare function probeUploadedDuration(sourceObjectKey: string): Promise<number | null>;
/**
 * Generates a quick preview thumbnail for a newly-uploaded video by
 * extracting a single JPEG frame at t=1s from the source object in
 * storage_blobs. Designed to run immediately after upload completion —
 * before the full HLS transcode starts — so the admin UI shows a thumbnail
 * preview without waiting for the transcoder.
 *
 * The thumbnail is stored at `transcoded/<videoId>/thumbnail.jpg` in
 * storage_blobs, the same key that `runTranscode` uses. When the transcoder
 * later runs, it overwrites it with a fresher version — the proxy URL never
 * changes and no DB surgery is required.
 *
 * Non-fatal: returns null on any failure (no ffmpeg binary, DB error, etc.)
 * so the caller can proceed with transcoding as normal.
 */
export declare function generateQuickThumbnail(sourceObjectKey: string, videoId: string): Promise<string | null>;
export declare const _internal: {
    buildFfmpegArgs: typeof buildFfmpegArgs;
    RENDITIONS: RenditionSpec[];
};
export {};
