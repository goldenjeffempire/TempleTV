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
    /** H.264 level string (e.g. "3.1"). Constrains decoder complexity so
     *  Smart TVs, set-top boxes, and older mobile devices that refuse
     *  higher-level streams can play every rendition without error. */
    level: string;
}
/**
 * Build the FFmpeg filter_complex + per-rendition output args for multi-rendition HLS.
 * Accepts the specific renditions to encode so the caller can filter for upscaling.
 */
declare function buildFfmpegArgs(input: string, outDir: string, renditions: RenditionSpec[], hasAudio?: boolean): string[];
/**
 * Pre-flight probe to detect MP4 container damage BEFORE running HLS encode.
 *
 * Validity = ffprobe can enumerate at least one stream AND its stderr does
 * NOT contain a moov-atom / container-parse failure signature. We deliberately
 * do NOT require duration metadata to be present — some valid containers
 * (e.g. fragmented MP4, growing files, certain camera exports) report no
 * format-level duration but still transcode cleanly. The previous
 * format=duration check forced unnecessary remux passes on those inputs.
 *
 * Returns true on a clean probe; false only when ffprobe fails outright OR
 * its stderr signals a real container error (moov not found, invalid data
 * found, EOF before frame, etc.) — the exact patterns FFmpeg emits for the
 * production failure class we're fixing.
 */
export declare function probeContainerIsValid(inputPath: string): Promise<boolean>;
/**
 * Detect whether an MP4 file has a media-data (mdat) box but no moov atom
 * anywhere in the file. This is the signature of a completely unrecoverable
 * upload where the recording or export was interrupted before the moov could
 * be written — the codec configuration (SPS/PPS) in the moov's avcC box is
 * permanently lost and no remux strategy can reconstruct it.
 *
 * Scans both the FRONT (first 64 KiB) and the TAIL (last 64 KiB) of the
 * file. Normal camera recordings write mdat first and moov last (moov-at-EOF
 * layout). Scanning only the front misidentifies those files as unrecoverable
 * because mdat is found but moov is out of the scan window. The tail scan
 * catches the moov-at-EOF case and correctly returns false, allowing the
 * remux recovery path to run (strategy 1 — stream-copy with +faststart fixes
 * these in seconds with no re-encoding).
 *
 * Returns true ONLY when mdat is present AND moov is absent from both the
 * front and tail scan windows. Returns false on any I/O error so the caller
 * falls through to the normal remux path.
 */
export declare function detectMdatWithoutMoov(inputPath: string): Promise<boolean>;
/**
 * Recovery pass for MP4 files where the moov atom is at EOF, fragmented,
 * or otherwise unreadable by ffmpeg's HLS muxer. Tries three strategies in
 * sequence, stopping at the first success:
 *
 *   Strategy 1 — stream-copy with faststart (standard, handles moov-at-EOF)
 *   Strategy 2 — error-tolerant stream-copy with faststart (mild corruption)
 *   Strategy 3 — error-tolerant stream-copy without faststart (last resort)
 *
 * Returns the path to the remuxed file on success, or null when all three
 * strategies fail (the caller treats null as a hard error).
 *
 * Note: when the moov atom is completely absent (detected by
 * detectMdatWithoutMoov), none of these strategies can reconstruct it
 * because the codec configuration (SPS/PPS) is stored only in the moov's
 * avcC box. In that case callers should skip remux and throw immediately.
 */
export declare function remuxForFaststart(inputPath: string, outputPath: string, videoId: string): Promise<string | null>;
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
 * Download an assembled video from object storage to a temp file and run
 * `probeContainerIsValid` to determine whether its container can be decoded.
 *
 * Returns `{ valid: true }` when the container is healthy, or when storage
 * is unavailable (probe is skipped rather than blocking the pipeline).
 * Returns `{ valid: false, error }` when ffprobe detects a structural problem
 * (moov not found, invalid data found, partial file, EOF before frame, etc.).
 *
 * Non-throwing — any exception is caught and returned as `{ valid: false }`.
 * Callers use the result for diagnostic logging only; faststart.service.ts
 * handles the actual repair (remux recovery) during its own download pass.
 */
export declare function probeUploadedContainerValidity(objectKey: string): Promise<{
    valid: boolean;
    error?: string;
}>;
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
