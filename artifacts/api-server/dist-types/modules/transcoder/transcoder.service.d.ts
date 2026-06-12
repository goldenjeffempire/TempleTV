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
 *
 * @param isInterlaced - When true, prepends a yadif deinterlace filter before
 *   the scale step for every rendition. Set this when probeIsInterlaced() returns
 *   true — i.e. the source was captured with field-based scanning (1080i/720i from
 *   broadcast cameras, video capture cards, or legacy camcorders). Without yadif,
 *   interlaced sources produce combing artifacts (horizontal zigzag edges) on
 *   progressive displays at every motion boundary. Safe to leave false for all
 *   modern progressive camera sources (field_order = progressive or unknown).
 */
declare function buildFfmpegArgs(input: string, outDir: string, renditions: RenditionSpec[], hasAudio?: boolean, isInterlaced?: boolean): string[];
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
 * Phase 1 — Front scan (64 KiB, box-boundary parser):
 *   Quickly detects moov-at-front (common after faststart) and confirms mdat
 *   presence. Returns false immediately if moov is found or mdat is absent.
 *
 * Phase 2 — Full-file ffprobe (only when mdat found but moov not at front):
 *   The previous implementation used a 64 KiB tail byte-scan to check for
 *   moov-at-EOF. This was insufficient: for 30-minute+ sermon recordings
 *   (H.264 with B-frames) the moov atom is 1–5 MiB, placing its box header
 *   well outside the 64 KiB window and causing false-positive CORRUPT_SOURCE
 *   classifications. The ffprobe approach has no window size limitation — it
 *   seeks through the entire container and finds moov regardless of its size
 *   or position. Only returns true (unrecoverable) when ffprobe explicitly
 *   reports zero streams due to a missing moov atom.
 *
 * Returns true ONLY when mdat is present AND ffprobe confirms moov is absent.
 * Returns false on any I/O or subprocess error so the caller falls through to
 * the normal remux path.
 */
export declare function detectMdatWithoutMoov(inputPath: string): Promise<boolean>;
/**
 * Verify a locally-downloaded source file is present, non-empty, large enough
 * to be a valid video container, and does not contain obvious non-video content
 * (HTML error pages, JSON responses, images, etc.) that slipped past the
 * upload MIME gate.
 *
 * Throws with a structured `{ code }` error on failure — callers map the code
 * to either CORRUPT_SOURCE (permanent) or DOWNLOAD_TRUNCATED (transient).
 *
 * Exported so faststart.service.ts can share the same gate.
 */
export declare function validateLocalSourceFile(filePath: string, expectedSizeBytes?: number): Promise<void>;
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
 * Download an assembled video from object storage to a temp file and run a
 * two-stage validation:
 *
 *   Stage 0 — validateLocalSourceFile:
 *     existence, non-zero size, min-size (1 KiB), and magic-bytes check.
 *     Catches HTML error pages, zero-byte downloads, and obvious non-video
 *     content before any subprocess is spawned.
 *
 *   Stage 1 — probeContainerIsValid (ffprobe):
 *     Verifies the moov atom is present and the container header is parseable.
 *
 *   Stage 2 — probeCanDecodeFirstFrame (ffmpeg):
 *     Decodes one video frame from the first 2 s of mdat to verify the media
 *     payload is intact — not just the container structure. Catches files
 *     where moov is valid but mdat is truncated or bit-corrupted.
 *
 * Returns `{ valid: true }` when all stages pass, or when storage is
 * unavailable (probe is skipped rather than blocking the pipeline).
 * Returns `{ valid: false, error }` when any stage detects a problem.
 *
 * Non-throwing — any infrastructure exception is caught and returned as
 * `{ valid: true }` (fail-open) so a transient download error does not
 * permanently mark a healthy video as corrupt; faststart and the HLS
 * transcoder will discover real corruption on their own passes.
 */
export declare function probeUploadedContainerValidity(objectKey: string): Promise<{
    valid: boolean;
    unrecoverable?: boolean;
    kind?: string;
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
