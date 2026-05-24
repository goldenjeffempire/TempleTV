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
/**
 * Build the FFmpeg filter_complex + per-rendition output args for multi-rendition HLS.
 * Accepts the specific renditions to encode so the caller can filter for upscaling.
 */
declare function buildFfmpegArgs(input: string, outDir: string, renditions: RenditionSpec[], hasAudio?: boolean): string[];
/**
 * FFmpeg-based HLS transcoder.
 *
 * Downloads the source video from DatabaseObjectStorage (storage_blobs table)
 * to a local temp file, runs ffmpeg to produce a multi-rendition VOD HLS
 * package (master playlist + per-rendition playlists + MPEG-TS segments),
 * then uploads all output files back to storage_blobs under a stable key
 * prefix and returns the public API proxy URL of the master playlist.
 *
 * Rendition selection is resolution-aware: the source video is probed for
 * its actual height and only renditions with height ≤ source height are
 * included — preventing quality loss from upscaling low-resolution sources.
 * At least the lowest available rendition (360p) is always included.
 *
 * Output layout in storage_blobs:
 *   transcoded/<videoId>/master.m3u8
 *   transcoded/<videoId>/v0/playlist.m3u8
 *   transcoded/<videoId>/v0/seg_00000.ts ...
 *   transcoded/<videoId>/v1/playlist.m3u8
 *   transcoded/<videoId>/v1/seg_00000.ts ...
 *   (v2, v3 only when source height ≥ 720 / 1080)
 */
export declare function runTranscode(req: TranscodeRequest): Promise<TranscodeResult>;
/**
 * Probes the duration of a newly-uploaded source file via ffprobe.
 * Downloads the object to a temp file, runs ffprobe (exits as soon as the
 * format header is read), and returns the duration in seconds.
 * Non-fatal: returns null on any failure.
 */
export declare function probeUploadedDuration(sourceObjectKey: string): Promise<number | null>;
/**
 * Generates a quick preview thumbnail for a newly-uploaded video by
 * extracting a single JPEG frame at t=1s from the source object in
 * storage_blobs. Designed to run immediately after upload completion —
 * before the full HLS transcode starts — so the admin UI shows a thumbnail
 * preview without waiting for the transcoder.
 *
 * Stored at `transcoded/<videoId>/thumbnail.jpg` — the same key that
 * `runTranscode` uses. When the transcoder later runs, it overwrites with a
 * fresher version from the properly-encoded source; the proxy URL never changes.
 *
 * Non-fatal: returns null on any failure (no ffmpeg binary, DB error, etc.)
 */
export declare function generateQuickThumbnail(sourceObjectKey: string, videoId: string): Promise<string | null>;
/**
 * Normalise any raw image buffer (JPEG, PNG, WebP) to an exactly 640×360 JPEG
 * using the same black-letterbox/pillarbox strategy as generateThumbnail.
 *
 * - Scales the input down to fit within 640×360 preserving its aspect ratio.
 * - Pads to exactly 640×360 with black bars (letterbox or pillarbox).
 * - Always outputs JPEG at q:v 2 regardless of input format.
 *
 * Returns null (non-fatal) if ffmpeg is unavailable or the conversion fails.
 */
export declare function normalizeThumbnailBuffer(input: Buffer): Promise<Buffer | null>;
export declare const _internal: {
    buildFfmpegArgs: typeof buildFfmpegArgs;
    ALL_RENDITIONS: RenditionSpec[];
};
/**
 * Probe whether the `ffmpeg` binary is reachable and executable.
 * Runs `ffmpeg -version` and resolves true on exit-code 0, false on any
 * error (binary not found, permission denied, non-zero exit, etc.).
 * Never throws — callers use the boolean to decide whether to emit an alert.
 */
export declare function checkFfmpegAvailable(): Promise<boolean>;
export {};
