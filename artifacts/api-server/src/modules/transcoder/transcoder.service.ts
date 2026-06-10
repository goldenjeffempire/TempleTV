import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, open as fsOpen, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { storage } from "../../infrastructure/storage.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";

// ── Download pipeline reliability constants ───────────────────────────────
/** Maximum per-download attempts before propagating the error. */
const DOWNLOAD_MAX_ATTEMPTS = 3;
/** Base back-off delay between retry attempts: 2 s → 6 s (× 3 per attempt). */
const DOWNLOAD_RETRY_BASE_MS = 2_000;
/**
 * In-process per-destination-path download lock.
 *
 * Prevents two concurrent callers from writing to the same `destPath`
 * simultaneously (would interleave bytes and corrupt the file).
 * Keyed by the resolved absolute path; value is the Promise from the active
 * download.  Waiters `await` it and then re-check whether the file arrived
 * before deciding to download themselves.
 */
const _downloadInProgress = new Map<string, Promise<void>>();

export interface TranscodeRequest {
  jobId: string;
  videoId: string;
  sourceObjectKey: string;
  onProgress?: (percent: number) => void | Promise<void>;
}

export interface TranscodeResult {
  masterPlaylistKey: string;
  masterPlaylistUrl: string;
  renditions: Array<{ name: string; bitrateKbps: number; width: number; height: number; segmentCount: number }>;
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

// All renditions ordered from lowest to highest.
// runTranscode filters this list to avoid upscaling by checking the source
// video's actual height and dropping any renditions taller than the source.
const ALL_RENDITIONS: RenditionSpec[] = [
  // level "3.0" — baseline decoder for legacy STBs and Smart TV chipsets.
  // Bitrate raised 400→500k (+25%) for sharper SD output on portrait-heavy
  // sermon content; maxrate/bufsize ratio kept at 1.4×/2.8× for VBV stability.
  { name: "360p",  width: 640,  height: 360,  videoBitrateK: 500,  maxrateK: 700,  bufsizeK: 1400, audioBitrateK: 96,  level: "3.0" },
  // level "3.1" — covers 720p@30 and lower; widely supported across all smart TV SDKs.
  // 480p raised 800→1000k, audio 96→128k for clear face+text sharpness at mid-range.
  { name: "480p",  width: 854,  height: 480,  videoBitrateK: 1000, maxrateK: 1300, bufsizeK: 2600, audioBitrateK: 128, level: "3.1" },
  // 720p raised 1800→2500k — perceptible quality jump vs. 1080p for ABR step-up.
  { name: "720p",  width: 1280, height: 720,  videoBitrateK: 2500, maxrateK: 3200, bufsizeK: 6400, audioBitrateK: 160, level: "3.1" },
  // level "4.0" — required for 1080p@30; supported on all modern devices (2013+).
  // 1080p raised 3500→4500k for cinema-grade sharpness on large displays.
  { name: "1080p", width: 1920, height: 1080, videoBitrateK: 4500, maxrateK: 5800, bufsizeK: 11600, audioBitrateK: 192, level: "4.0" },
];

// 2-second segments align with the 2-second keyframe interval so every
// segment starts with an IDR frame — required for seamless ABR switching and
// accurate seeking. Shorter segments (vs. the old 4 s) also reduce:
//   • Time-to-first-frame: players can begin rendering after buffering just
//     one 2 s segment instead of waiting for a full 4 s segment to arrive.
//   • Seek latency: the nearest IDR frame is at most 2 s away from any
//     wall-clock position, so ExoPlayer/AVPlayer refetches less data after a
//     clock-calibrated seek (important for synchronized broadcast playback).
//   • Android ExoPlayer black-screen gap: the initial buffer-fill window
//     (manifest + first segment) shrinks from ~4 s to ~2 s of media time.
const HLS_SEGMENT_SECS = 2;
const KEYFRAME_INTERVAL_SECS = 2;
const FFMPEG_PRESET = env.TRANSCODER_PRESET;
const FFMPEG_CRF = String(env.TRANSCODER_CRF);
const THUMBNAIL_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 30_000;
const RESOLUTION_PROBE_TIMEOUT_MS = 15_000;
/** Hard deadline for the frame-decode integrity probe in probeCanDecodeFirstFrame. */
const FRAME_DECODE_TIMEOUT_MS = 30_000;
// Max concurrent file uploads when copying HLS segments to object storage.
const UPLOAD_CONCURRENCY = 10;
// Max concurrent uploads during the progressive in-flight segment uploader.
const PROGRESSIVE_UPLOAD_CONCURRENCY = 4;
// How often (ms) the progressive uploader polls for newly-written segments.
const PROGRESSIVE_POLL_MS = 1_000;

/**
 * Build the FFmpeg filter_complex + per-rendition output args for multi-rendition HLS.
 * Accepts the specific renditions to encode so the caller can filter for upscaling.
 */
function buildFfmpegArgs(
  input: string,
  outDir: string,
  renditions: RenditionSpec[],
  hasAudio: boolean = true,
): string[] {
  const filterParts: string[] = [];
  filterParts.push(`[0:v]split=${renditions.length}` + renditions.map((_, i) => `[vsplit${i}]`).join(""));
  renditions.forEach((r, i) => {
    // flags=lanczos: Lanczos resampling gives significantly sharper results than
    // the FFmpeg bilinear default when downscaling HD source to 360p/480p/720p.
    // setsar=1: normalises the Sample Aspect Ratio to 1:1 after pad so players
    // receive an unambiguous DAR and do not apply unexpected stretch corrections.
    filterParts.push(
      `[vsplit${i}]scale=w=${r.width}:h=${r.height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
      `pad=${r.width}:${r.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}out]`,
    );
  });

  const args: string[] = [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-progress", "pipe:1",
    "-stats_period", "5",
    // Limit FFmpeg thread count to avoid starving other processes on shared
    // Replit/Render instances. "-threads 0" (unlimited) claims all available
    // cores, which starves the Fastify event loop and upstream HTTP connections
    // during active transcoding. Default 2 keeps encode speed reasonable while
    // leaving enough headroom for the API and DB pool. Override per-deployment
    // via TRANSCODER_THREADS env var (e.g. set to "4" on a dedicated worker).
    "-threads", (process.env["TRANSCODER_THREADS"] ?? "2"),
    "-i", input,
    // Prevent "Too many packets buffered for output stream" muxer errors that
    // occur when input audio/video streams have high bitrate-mismatch. Raises
    // the internal demuxer packet queue from the FFmpeg default of 1000 to
    // 9999, allowing the filter graph time to drain any burst of buffered
    // audio/video packets without aborting the job.
    "-max_muxing_queue_size", "9999",
    // Normalize any negative presentation timestamps present in the source to
    // zero. Some consumer cameras and screen-recording apps write streams with
    // negative DTS values; without this flag FFmpeg emits a non-fatal warning
    // but the resulting timestamps are shifted, causing HLS segment durations
    // to mismatch #EXTINF declarations and confusing some player ABR engines.
    "-avoid_negative_ts", "make_zero",
    "-filter_complex", filterParts.join(";"),
  ];

  renditions.forEach((r, i) => {
    args.push(
      "-map", `[v${i}out]`,
      `-c:v:${i}`, "libx264",
      `-profile:v:${i}`, r.height >= 720 ? "high" : "main",
      // Explicit H.264 level per rendition. Without this, some encoder/muxer
      // combinations emit a too-high level (e.g. 4.1) that Samsung Tizen, LG
      // webOS, and older Fire TV decoders refuse to play. Each level is chosen
      // as the lowest that accommodates the target resolution and frame rate:
      //   360p → 3.0,  480p/720p → 3.1,  1080p → 4.0
      `-level:v:${i}`, r.level,
      `-preset:v:${i}`, FFMPEG_PRESET,
      `-crf:v:${i}`, FFMPEG_CRF,
      `-b:v:${i}`, `${r.videoBitrateK}k`,
      `-maxrate:v:${i}`, `${r.maxrateK}k`,
      `-bufsize:v:${i}`, `${r.bufsizeK}k`,
      // GOP (Group of Pictures) alignment — cap to 60 frames (2 s at 30 fps).
      // Combined with force_key_frames this guarantees every HLS segment begins
      // on an IDR frame, which is required for seamless ABR level switching.
      // Without -g the encoder may place IDR frames up to 250 frames apart
      // (FFmpeg default = 12×fps) causing cross-segment B/P-frame references
      // that break independent_segments decoding on Samsung/LG decoders.
      `-g:v:${i}`, "60",
      `-keyint_min:v:${i}`, "48",
      // BT.709 color metadata — required for modern HDR-capable displays to
      // apply the correct EOTF. Without these flags the container signals
      // "unspecified" color primaries and the display applies a default (often
      // BT.601/sRGB) that causes the image to appear desaturated or washed-out
      // on calibrated monitors, Samsung QLED/LG OLED, and Apple displays.
      `-colorspace:v:${i}`, "bt709",
      `-color_primaries:v:${i}`, "bt709",
      `-color_trc:v:${i}`, "bt709",
    );
  });

  // Apply pixel format globally once after all per-stream video options.
  // yuv420p is required for maximum decoder compatibility (Tizen, webOS,
  // Fire TV, iOS). Applying it per-rendition was redundant and could
  // confuse option parsing in some FFmpeg 7.x builds.
  args.push("-pix_fmt", "yuv420p");

  // Enhanced motion estimation — overrides the 'fast' preset defaults of
  // me=hex / subme=6 / direct=spatial with perceptibly sharper options:
  //
  //   me=umh     Uneven Multi-Hexagon search: wider, more thorough motion-
  //              vector search that finds better matches for sermon content's
  //              mix of fine text, faces, and fast-motion camera pans. The hex
  //              default misses vectors in highly-structured content (on-screen
  //              graphics, lower-thirds) that umh catches.
  //
  //   subme=7    Full rate-distortion evaluation for I-frame sub-pixel
  //              interpolation (vs subme=6 which uses SATD only for I-frames).
  //              Results in noticeably crisper edges at high-contrast boundaries
  //              (text on screen, suit collars, microphone stands) with no
  //              bitrate increase — the bit savings from better prediction are
  //              reallocated to detail areas by AQ.
  //
  //   direct=auto  Selects spatial vs temporal B-frame direct mode
  //              automatically per scene. The 'fast' preset fixes direct=spatial
  //              which is suboptimal for static-background / talking-head shots
  //              (the dominant mode in live-service recordings). auto picks
  //              temporal for these and spatial for complex motion, giving
  //              consistently lower PSNR degradation.
  //
  // CPU overhead: ~6–8 % vs the fast preset baseline. Acceptable for
  // background transcoding on a Replit instance.
  // me=umh:subme=7:direct=auto: see comment above.
  // deblock=-1,-1: reduce deblocking aggressiveness by one step on both
  //   alpha (luma) and beta (chroma) axes. The 'fast' preset's default is
  //   deblock=0,0 which applies moderate loop deblocking — visually blurring
  //   high-contrast edges. At CRF=21 and our raised bitrates, the encode has
  //   enough bits to represent fine detail; reducing deblocking lets that
  //   detail survive to the output. Most noticeable on on-screen text, speaker
  //   name lower-thirds, and fine fabric textures in worship/sermon footage.
  //   At 360p/480p the marginal effect is also positive — the higher bitrates
  //   ensure macroblocks are already well-coded, so softer deblocking sharpens
  //   rather than exposing artefacts.
  //
  //   NOTE: the deblock alpha/beta pair MUST be comma-separated (`-1,-1`), NOT
  //   colon-separated. Inside `-x264-params` the colon (`:`) is the option
  //   delimiter, so `deblock=-1:-1` is parsed as `deblock=-1` followed by a
  //   stray `-1` token, which makes libx264 reject the entire param string
  //   ("Error setting option x264-params ... Invalid argument") and ffmpeg
  //   exits 234 on every job. This broke all HLS transcoding under ffmpeg 7.x.
  args.push("-x264-params", "me=umh:subme=7:direct=auto:deblock=-1,-1");

  args.push("-force_key_frames", `expr:gte(t,n_forced*${KEYFRAME_INTERVAL_SECS})`);
  args.push("-sc_threshold", "0");

  // Audio mapping: only emit per-rendition AAC outputs when the source actually
  // has an audio stream. If the source is video-only (silent screen recording,
  // audio-stripped MP4, etc.) we MUST skip the audio map entirely AND emit a
  // video-only var_stream_map — otherwise the HLS muxer fails with
  // "Unable to map stream at a:0 / incorrect codec parameters" (exit 234)
  // because var_stream_map references audio outputs that don't exist.
  if (hasAudio) {
    renditions.forEach((r, i) => {
      args.push(
        "-map", "a:0?",
        `-c:a:${i}`, "aac",
        `-b:a:${i}`, `${r.audioBitrateK}k`,
        `-ac:a:${i}`, "2",
        // Normalize all audio to 48 kHz. Source files can arrive at 44.1 kHz,
        // 32 kHz, 22.05 kHz, etc. Mixed sample rates across HLS segments cause
        // stuttering and decoder resets on Tizen, webOS, and some Chromecast
        // builds that expect a constant sample rate across the entire playlist.
        `-ar:a:${i}`, "48000",
      );
    });
  }

  const varStreamMap = renditions
    .map((_, i) => (hasAudio ? `v:${i},a:${i}` : `v:${i}`))
    .join(" ");

  args.push(
    "-f", "hls",
    "-hls_time", String(HLS_SEGMENT_SECS),
    // hls_init_time: target duration (seconds) of the FIRST segment only.
    // Setting this to 1 s (half the normal 2 s segment) means ExoPlayer /
    // AVPlayer can begin rendering after buffering just ~1 s of media instead
    // of a full 2 s segment — halving cold-start time-to-first-frame on a
    // fresh load. The splice is IDR-aligned (force_key_frames ensures an IDR
    // at t=1 s), so the first segment is independently decodable and safe for
    // ABR. Subsequent segments remain at HLS_SEGMENT_SECS (2 s).
    "-hls_init_time", "1",
    "-hls_playlist_type", "vod",
    "-hls_segment_type", "mpegts",
    // independent_segments: every segment can be decoded independently —
    //   required for ABR switching and accurate ExoPlayer/AVPlayer seeking.
    // split_by_time: cut segments at wall-clock boundaries rather than at
    //   GOP boundaries that drift past the target duration. Combined with
    //   the force_key_frames expression above (IDR every KEYFRAME_INTERVAL_SECS)
    //   this keeps segment duration within ±1 frame of HLS_SEGMENT_SECS even
    //   when the source framerate is not an integer divisor of the segment length.
    "-hls_flags", "independent_segments+split_by_time",
    "-hls_list_size", "0",
    "-hls_segment_filename", path.join(outDir, "v%v", "seg_%05d.ts"),
    "-master_pl_name", "master.m3u8",
    "-var_stream_map", varStreamMap,
    path.join(outDir, "v%v", "playlist.m3u8"),
  );

  return args;
}

/**
 * Inject CODECS attribute into each #EXT-X-STREAM-INF line of an HLS master
 * playlist. FFmpeg does not emit CODECS strings in its master.m3u8 output, but
 * they are required for strict HLS parsers — most notably Samsung Tizen 2.x/3.x,
 * LG webOS 3.x, and certain ExoPlayer builds that default to software decoding
 * for streams lacking a CODECS attribute, resulting in 4K/1080p black screens
 * or decoder-selection failures.
 *
 * The function matches each stream to its rendition by the RESOLUTION attribute
 * (which FFmpeg always emits), then splices in the H.264 codec string and the
 * AAC-LC codec string before returning the modified playlist text.
 *
 * H.264 codec string format: avc1.PPCCLL
 *   PP = profile_idc hex  (main = 0x4D)
 *   CC = constraint_flags (0x40 for main — high-compatibility constraint set)
 *   LL = level_idc hex    (3.0 = 0x1E, 3.1 = 0x1F, 4.0 = 0x28, 4.1 = 0x29)
 *
 * AAC-LC codec string: mp4a.40.2 (standardised — same for all bitrates).
 */
function injectCodecsIntoMaster(
  content: string,
  renditions: RenditionSpec[],
  hasAudio: boolean,
): string {
  const H264_LEVEL_HEX: Record<string, string> = {
    "3.0": "1E",
    "3.1": "1F",
    "4.0": "28",
    "4.1": "29",
  };
  function h264CodecStr(level: string, profile: "main" | "high"): string {
    if (profile === "high") {
      // High profile (0x64 = 100), no constraints (0x00), level.
      // Used for 720p and 1080p renditions — enables 8×8 DCT, CABAC, and
      // higher quality at the same bitrate. The CODECS attribute MUST reflect
      // the actual encoder profile; mismatched values cause Samsung Tizen 2.x/3.x
      // and strict ExoPlayer builds to refuse the stream or fall back to
      // software decoding for 720p/1080p content.
      return `avc1.6400${H264_LEVEL_HEX[level] ?? "1F"}`;
    }
    // Main profile (0x4D = 77), high-compatibility constraints (0x40), level.
    return `avc1.4D40${H264_LEVEL_HEX[level] ?? "1F"}`;
  }

  const lines = content.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("#EXT-X-STREAM-INF:") && !trimmed.includes("CODECS=")) {
      const resMatch = /RESOLUTION=(\d+)x(\d+)/i.exec(trimmed);
      if (resMatch) {
        const w = parseInt(resMatch[1]!, 10);
        const h = parseInt(resMatch[2]!, 10);
        const rendition = renditions.find((r) => r.width === w && r.height === h);
        if (rendition) {
          // Mirror the FFmpeg encoder profile selection in buildFfmpegArgs:
          // 720p and above use -profile:v high; below that use -profile:v main.
          const h264Profile = rendition.height >= 720 ? "high" : "main";
          const videoCodec = h264CodecStr(rendition.level, h264Profile);
          const codecs = hasAudio ? `${videoCodec},mp4a.40.2` : videoCodec;
          out.push(`${trimmed},CODECS="${codecs}"`);
          continue;
        }
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Probe the duration of a video file via ffprobe.
 * Returns seconds or null on any failure.
 */
async function probeDurationSecs(inputUrl: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputUrl,
    ]);
    proc.unref();
    let out = "";
    let settled = false;
    const settle = (val: number | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
      logger.warn({ inputUrl }, "transcoder: ffprobe duration timed out after 30 s");
      settle(null);
    }, PROBE_TIMEOUT_MS);
    timer.unref();
    proc.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    proc.on("error", () => { clearTimeout(timer); settle(null); });
    proc.on("close", () => {
      clearTimeout(timer);
      const v = parseFloat(out.trim());
      settle(Number.isFinite(v) && v > 0 ? v : null);
    });
  });
}

/**
 * Probe whether the input file contains at least one audio stream.
 * Returns true on probe success when an audio stream exists, false otherwise.
 * Defaults to FALSE on any failure (probe timeout, ffprobe unavailable, etc.)
 * — a missing audio map in the HLS args is recoverable (video-only stream),
 * but a stale `v:i,a:i` var_stream_map against a no-audio input kills the
 * entire transcode (exit 234). Failing safe = preferring video-only output.
 */
async function probeHasAudio(inputPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0",
      inputPath,
    ]);
    proc.unref();
    let out = "";
    let settled = false;
    const settle = (val: boolean) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
      logger.warn(
        { inputPath, timeoutMs: RESOLUTION_PROBE_TIMEOUT_MS },
        "transcoder: audio stream probe timed out — defaulting to video-only HLS. " +
        "If the source has audio the output will be silent. Re-upload or retry the job to attempt the probe again.",
      );
      settle(false);
    }, RESOLUTION_PROBE_TIMEOUT_MS);
    timer.unref();
    proc.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    proc.on("error", (err) => {
      clearTimeout(timer);
      logger.warn({ err, inputPath }, "transcoder: audio probe process error — defaulting to video-only HLS");
      settle(false);
    });
    proc.on("close", () => {
      clearTimeout(timer);
      settle(out.includes("audio"));
    });
  });
}

/**
 * Probe the width and height of the first video stream in a local file.
 * Returns null on any failure (ffprobe unavailable, corrupt file, etc.).
 * Used to avoid upscaling by filtering renditions to those ≤ source height.
 */
async function probeResolution(inputPath: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=x:p=0",
      inputPath,
    ]);
    proc.unref();
    let out = "";
    let settled = false;
    const settle = (val: { width: number; height: number } | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
      settle(null);
    }, RESOLUTION_PROBE_TIMEOUT_MS);
    timer.unref();
    proc.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    proc.on("error", () => { clearTimeout(timer); settle(null); });
    proc.on("close", () => {
      clearTimeout(timer);
      const parts = out.trim().split("x");
      if (parts.length === 2) {
        const w = parseInt(parts[0]!, 10);
        const h = parseInt(parts[1]!, 10);
        if (w > 0 && h > 0) { settle({ width: w, height: h }); return; }
      }
      settle(null);
    });
  });
}

/**
 * Download a source object from object storage (or a remote HTTP(S) URL)
 * to a local temp file with full reliability guarantees:
 *
 *  1. Atomic write  — data is written to `${destPath}.part` then atomically
 *     renamed (rename(2)) so the final path never contains a partial file.
 *  2. Stale-part cleanup — any leftover `.part` file from a prior failed
 *     attempt is removed before each attempt begins.
 *  3. In-process per-path lock — prevents two concurrent callers from
 *     writing to the same destination path simultaneously.
 *  4. Metadata validation — rejects blobs whose stored `size_bytes` is 0
 *     or null before any bytes are fetched (corrupt / incomplete storage
 *     record — re-upload required).
 *  5. Byte-count validation — bytes written to disk are counted during
 *     streaming and compared against both the Content-Length header (remote)
 *     and the DB-reported `size_bytes` (local).  Truncated downloads fail
 *     loudly here instead of silently producing a short file that makes
 *     ffmpeg emit the misleading "moov atom not found".
 *  6. Retry with back-off — up to DOWNLOAD_MAX_ATTEMPTS for transient I/O
 *     errors (DB blip, HTTP 5xx, broken pipe).  Terminal errors (missing
 *     blob, invalid metadata, HTTP 4xx) are NOT retried.
 */
async function downloadSourceToTempFile(rawObjectKey: string, destPath: string): Promise<void> {
  // Defensive normalisation: jobs already sitting in the DB may have been
  // enqueued with localVideoUrl (/api/v1/uploads/…) instead of the bare
  // storage key (uploads/…). Strip the API prefix so getObject() finds the
  // blob. Remote http(s):// keys pass through unchanged.
  const objectKey = /^https?:\/\//i.test(rawObjectKey)
    ? rawObjectKey
    : rawObjectKey.startsWith("/")
      ? rawObjectKey.replace(/^\/(?:api\/(?:v\d+\/)?)?/, "")
      : rawObjectKey;

  // ── Per-path lock: serialise concurrent downloads to the same destination ──
  // Two callers writing to the same destPath would interleave bytes.
  // Wait for any in-flight download to the same path to finish, then
  // return early if it succeeded (file exists and non-empty).
  const lockKey = path.resolve(destPath);
  const inflight = _downloadInProgress.get(lockKey);
  if (inflight !== undefined) {
    await inflight.catch(() => { /* ignore error from parallel download */ });
    try {
      const s = await stat(destPath);
      if (s.size > 0) {
        logger.debug(
          { objectKey, destPath },
          "transcoder: download dequeued — reusing result from parallel download",
        );
        return;
      }
    } catch {
      // File absent or empty after the parallel download — fall through and
      // attempt the download ourselves.
    }
  }

  let releaseLock!: () => void;
  const lockPromise = new Promise<void>((resolve) => { releaseLock = resolve; });
  _downloadInProgress.set(lockKey, lockPromise);

  try {
    await _downloadWithRetry(objectKey, destPath);
  } finally {
    _downloadInProgress.delete(lockKey);
    releaseLock();
  }
}

/**
 * Retry wrapper — attempts the download up to DOWNLOAD_MAX_ATTEMPTS times
 * with exponential back-off for transient errors.
 *
 * Uses an atomic `.part` file pattern: bytes are written to `${destPath}.part`
 * and only renamed to `destPath` on successful completion, so the final path
 * never contains a partial file regardless of crash or error.
 */
async function _downloadWithRetry(objectKey: string, destPath: string): Promise<void> {
  const partPath = `${destPath}.part`;
  let lastErr: Error = new Error("download did not attempt");

  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    // Remove any stale .part file left by the previous failed attempt so each
    // attempt starts with a fresh, empty file.
    await rm(partPath, { force: true }).catch(() => undefined);

    const t0 = Date.now();
    try {
      if (/^https?:\/\//i.test(objectKey)) {
        await _downloadRemoteUrl(objectKey, partPath);
      } else {
        await _downloadLocalStorage(objectKey, partPath);
      }

      // Atomic promotion: .part → final path.
      // On Linux, rename(2) is guaranteed atomic within the same filesystem,
      // so readers of destPath never observe a partial file.
      await rename(partPath, destPath);

      const elapsedMs = Date.now() - t0;
      const finalSize = await stat(destPath).then((s) => s.size).catch(() => null);
      logger.info(
        { objectKey, destPath, attempt, elapsedMs, sizeBytes: finalSize },
        "transcoder: source download succeeded",
      );
      return; // ← success

    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));

      // Clean up any partial .part file left by the failed attempt.
      await rm(partPath, { force: true }).catch(() => undefined);

      // Terminal errors: retrying is futile — propagate immediately.
      if (_isTerminalDownloadError(lastErr)) {
        logger.warn(
          { objectKey, attempt, err: lastErr.message },
          "transcoder: source download failed with terminal error — not retrying",
        );
        throw lastErr;
      }

      if (attempt < DOWNLOAD_MAX_ATTEMPTS) {
        const delayMs = DOWNLOAD_RETRY_BASE_MS * (3 ** (attempt - 1)); // 2 s, 6 s
        logger.warn(
          {
            objectKey,
            attempt,
            maxAttempts: DOWNLOAD_MAX_ATTEMPTS,
            delayMs,
            err: lastErr.message,
          },
          "transcoder: source download failed — will retry",
        );
        await new Promise<void>((r) => { setTimeout(r, delayMs).unref(); });
      }
    }
  }

  throw new Error(
    `transcoder: source download failed after ${DOWNLOAD_MAX_ATTEMPTS} attempts ` +
    `(objectKey=${objectKey}): ${lastErr.message}`,
  );
}

/**
 * Download a remote HTTP(S) source URL.
 * Used for prod-sync queue items whose blob lives on the production API rather
 * than in local object storage.
 *
 * Enforces:
 *  - Non-OK HTTP status → throw (4xx = terminal, 5xx = retryable).
 *  - Content-Length presence → size validation after download.
 *  - Per-byte counting via a passthrough Transform so the streamed byte
 *    count can be compared against both on-disk size and Content-Length.
 *  - Hard failure on 0-byte result.
 */
async function _downloadRemoteUrl(url: string, partPath: string): Promise<void> {
  const ac = new AbortController();
  const timeoutTimer = setTimeout(() => { ac.abort(); }, 20 * 60_000);
  timeoutTimer.unref();

  let expectedSize: number | null = null;
  let bytesWritten = 0;

  try {
    const res = await fetch(url, { signal: ac.signal });

    if (!res.ok) {
      throw Object.assign(
        new Error(
          `transcoder: remote source download failed — HTTP ${res.status} ${res.statusText} ` +
          `(url=${url})` +
          (res.status >= 400 && res.status < 500
            ? ". Client error — check the URL and access permissions."
            : ". Server error — will retry if attempts remain."),
        ),
        { httpStatus: res.status },
      );
    }
    if (!res.body) {
      throw new Error(`transcoder: remote source returned no response body (url=${url})`);
    }

    // Extract expected size from Content-Length for post-download validation.
    // Header absence means we skip the size check (valid for chunked responses),
    // but truncation will still be caught by the 0-byte guard below.
    const clHeader = res.headers.get("content-length");
    if (clHeader) {
      const parsed = parseInt(clHeader, 10);
      if (Number.isFinite(parsed) && parsed > 0) expectedSize = parsed;
    }

    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytesWritten += chunk.length;
        cb(null, chunk);
      },
    });

    await pipeline(
      res.body as unknown as NodeJS.ReadableStream,
      counter,
      createWriteStream(partPath),
    );
  } finally {
    clearTimeout(timeoutTimer);
  }

  // ── Post-download validation ───────────────────────────────────────────────
  const actualSize = (await stat(partPath)).size;

  if (actualSize === 0) {
    throw new Error(
      `transcoder: remote source download produced an empty file (0 bytes). URL: ${url}`,
    );
  }

  if (bytesWritten !== actualSize) {
    throw new Error(
      `transcoder: remote source write mismatch — ${bytesWritten} bytes counted in stream ` +
      `but ${actualSize} bytes on disk (url=${url}). Possible disk I/O error.`,
    );
  }

  if (expectedSize !== null && actualSize !== expectedSize) {
    throw new Error(
      `transcoder: remote source truncated — Content-Length was ${expectedSize} bytes but ` +
      `only ${actualSize} bytes were received (url=${url}). ` +
      `This typically manifests as "moov atom not found" in ffmpeg. ` +
      `Will retry if attempts remain.`,
    );
  }
}

/**
 * Download a source from local object storage (PostgreSQL BYTEA blobs).
 *
 * Enforces:
 *  - headObject MUST succeed — a failure surfaces the infrastructure error
 *    so the retry loop can decide whether to retry, rather than silently
 *    skipping all size validation (the old `.catch(() => null)` behaviour).
 *  - Blob not-found → SOURCE_MISSING (terminal — re-upload required).
 *  - size_bytes = 0 or NULL → CORRUPT_SOURCE (terminal — invalid storage
 *    record, re-upload required).
 *  - Byte-count validation after the pipeline completes, compared against
 *    the DB-reported size_bytes.
 */
async function _downloadLocalStorage(objectKey: string, partPath: string): Promise<void> {
  // ── Pre-download metadata validation ──────────────────────────────────────
  // headObject failure is a DB/storage infrastructure error (connection blip,
  // pool timeout) — treat as transient so the retry loop can recover.
  let head: { exists: boolean; contentLength?: number; contentType?: string };
  try {
    head = await storage().headObject(objectKey);
  } catch (headErr) {
    throw new Error(
      `transcoder: headObject("${objectKey}") failed — DB may be temporarily unavailable. ` +
      `Error: ${headErr instanceof Error ? headErr.message : String(headErr)}`,
    );
  }

  if (!head.exists) {
    throw Object.assign(
      new Error(
        `transcoder: source object not found in storage (key="${objectKey}"). ` +
        `The upload blob may have been deleted or never fully assembled. ` +
        `Re-upload the source file to recover.`,
      ),
      { code: "SOURCE_MISSING" },
    );
  }

  const expectedSize = head.contentLength;

  if (expectedSize == null || expectedSize <= 0) {
    throw Object.assign(
      new Error(
        `transcoder: invalid source metadata — size_bytes=${expectedSize} for key="${objectKey}". ` +
        `The storage record is corrupt or the multipart upload was never fully assembled. ` +
        `Re-upload the source file to recover.`,
      ),
      { code: "CORRUPT_SOURCE" },
    );
  }

  logger.debug(
    { objectKey, expectedSize },
    "transcoder: source metadata validated — beginning download",
  );

  // ── Stream source to part file with byte counting ─────────────────────────
  const { body } = await storage().getObject(objectKey);

  let bytesWritten = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytesWritten += chunk.length;
      cb(null, chunk);
    },
  });

  await pipeline(body, counter, createWriteStream(partPath));

  // ── Post-download size validation ─────────────────────────────────────────
  const actualSize = (await stat(partPath)).size;

  if (actualSize === 0) {
    throw new Error(
      `transcoder: storage object "${objectKey}" downloaded as empty file (0 bytes). ` +
      `The storage record may be corrupt. Re-upload the source file.`,
    );
  }

  if (bytesWritten !== actualSize) {
    throw new Error(
      `transcoder: download write mismatch for "${objectKey}" — ` +
      `${bytesWritten} bytes counted in stream but ${actualSize} bytes on disk. ` +
      `Possible disk I/O error.`,
    );
  }

  if (actualSize !== expectedSize) {
    throw new Error(
      `transcoder: source download truncated for "${objectKey}" — ` +
      `expected ${expectedSize} bytes (from storage metadata) but received ${actualSize} bytes on disk. ` +
      `This typically manifests as "moov atom not found" from ffmpeg. ` +
      `The partial file has been removed; the job will retry.`,
    );
  }
}

/**
 * Returns true for errors where retrying the download will always produce the
 * same result — propagated immediately without burning retry slots.
 *
 *  SOURCE_MISSING   — blob is gone from storage; re-upload required.
 *  CORRUPT_SOURCE   — storage metadata is invalid; re-upload required.
 *  HTTP 4xx ≠ 429   — client error (wrong URL / permissions); the same
 *                     request will fail identically on every retry.
 *  zero-byte result — corrupt storage record; re-upload required.
 *  invalid metadata — corrupt storage record; re-upload required.
 */
function _isTerminalDownloadError(err: Error): boolean {
  const code = (err as Error & { code?: string }).code;
  if (code === "SOURCE_MISSING" || code === "CORRUPT_SOURCE") return true;

  const httpStatus = (err as Error & { httpStatus?: number }).httpStatus;
  if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
    return true;
  }

  if (err.message.includes("empty file (0 bytes)")) return true;
  if (err.message.includes("invalid source metadata")) return true;

  return false;
}

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
export async function probeContainerIsValid(inputPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_type",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);
    proc.unref();
    let out = "";
    let err = "";
    let settled = false;
    const settle = (val: boolean) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
      settle(false);
    }, PROBE_TIMEOUT_MS);
    timer.unref();
    proc.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    proc.stderr.on("data", (b: Buffer) => { err = (err + b.toString()).slice(-2000); });
    proc.on("error", () => {
      // Spawn failed (ENOENT, EACCES, …) — ffprobe is not available on PATH.
      // We cannot determine validity, so give the file the benefit of the
      // doubt: treat it as structurally valid and let faststart / the HLS
      // transcoder discover any real corruption during their own passes.
      // Returning false here would permanently fail every upload on systems
      // without ffprobe installed, which is far worse than a missed early gate.
      clearTimeout(timer);
      settle(true);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      // Hard fail when ffprobe exits non-zero OR stderr emits one of the
      // container-corruption signatures that ALSO break the HLS muxer.
      const containerErrorPattern =
        /moov atom not found|invalid data found|partial file|EOF before frame|error reading header|no video stream|no streams were found|codec not currently supported in container|output file is empty/i;
      if (code !== 0 || containerErrorPattern.test(err)) {
        settle(false);
        return;
      }
      // Clean exit + at least one video stream detected = safe to encode.
      settle(out.includes("video"));
    });
  });
}

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
export async function detectMdatWithoutMoov(inputPath: string): Promise<boolean> {
  const SCAN_BYTES = 65536;
  let fd: import("node:fs/promises").FileHandle | null = null;
  try {
    const { open: fsOpen } = await import("node:fs/promises");
    fd = await fsOpen(inputPath, "r");

    // ── Phase 1: Front scan ──────────────────────────────────────────────────
    // Parse ISO base-media top-level boxes from the beginning of the file.
    // Each box starts with: 4-byte big-endian size + 4-byte ASCII type.
    // A size of 0 means "extends to EOF"; a size of 1 means 64-bit extended
    // size (rare — just skip past the box to avoid infinite looping).
    const frontBuf = Buffer.allocUnsafe(SCAN_BYTES);
    const { bytesRead: frontRead } = await fd.read(frontBuf, 0, SCAN_BYTES, 0);
    let pos = 0;
    let hasMdat = false;
    while (pos + 8 <= frontRead) {
      const boxSize = frontBuf.readUInt32BE(pos);
      const boxType = frontBuf.slice(pos + 4, pos + 8).toString("ascii");
      if (boxType === "moov") return false; // moov at front → not the pathological case
      if (boxType === "mdat") hasMdat = true;
      if (boxSize === 0) break; // extends to EOF — stop scanning
      if (boxSize < 8) break;  // malformed size — stop scanning
      pos += boxSize;
    }

    if (!hasMdat) return false; // no mdat in front → this pathology doesn't apply

    // ── Phase 2: Full-file ffprobe ───────────────────────────────────────────
    // mdat found in front but moov not yet seen. Use ffprobe (no -read_intervals)
    // for a full-container seek that finds moov regardless of its position or
    // size. This replaces the old 64 KiB tail byte-scan which missed moov atoms
    // larger than 64 KiB (common for recordings longer than ~15 minutes).
    await fd.close().catch(() => undefined);
    fd = null;

    return await new Promise<boolean>((resolve) => {
      const proc = spawn("ffprobe", [
        "-v", "error",
        "-show_entries", "stream=codec_type",
        "-of", "csv=p=0",
        inputPath,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      proc.unref();
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      // Safety valve: a legitimately absent moov means ffprobe exits quickly;
      // cap at 60 s to handle large files on slow storage without hanging.
      const timer = setTimeout(() => { proc.kill(); resolve(false); }, 60_000);
      timer.unref();
      proc.on("close", (code) => {
        clearTimeout(timer);
        // Any stream found → moov exists → NOT unrecoverable (remux can fix it).
        if (stdout.trim().length > 0) { resolve(false); return; }
        // No streams + non-zero exit with a moov-related error → truly unrecoverable.
        if (code !== 0) {
          const moovMissing = /moov atom not found|Invalid data found when processing input|no streams were found/i.test(stderr);
          resolve(moovMissing);
          return;
        }
        // Exit 0 but no streams: unusual edge case — conservatively allow remux.
        resolve(false);
      });
      proc.on("error", () => { clearTimeout(timer); resolve(false); });
    });
  } catch {
    return false; // treat I/O failures as "unknown" — let remux attempt run
  } finally {
    await fd?.close().catch(() => undefined);
  }
}

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
export async function validateLocalSourceFile(
  filePath: string,
  expectedSizeBytes?: number,
): Promise<void> {
  const MIN_VIDEO_SIZE_BYTES = 1024; // 1 KiB — smallest possible valid container

  let fileSize: number;
  try {
    fileSize = (await stat(filePath)).size;
  } catch (statErr) {
    throw Object.assign(
      new Error(
        `Source file does not exist or is not readable at "${filePath}". ` +
        `Expected the file to be present after download. ` +
        `Error: ${statErr instanceof Error ? statErr.message : String(statErr)}`,
      ),
      { code: "SOURCE_MISSING" },
    );
  }

  if (fileSize === 0) {
    throw Object.assign(
      new Error(
        `Source file is empty (0 bytes) at "${filePath}". ` +
        `The download may have been truncated or the storage record is corrupt. ` +
        `Re-upload the source file to recover.`,
      ),
      { code: "CORRUPT_SOURCE" },
    );
  }

  if (fileSize < MIN_VIDEO_SIZE_BYTES) {
    throw Object.assign(
      new Error(
        `Source file is too small to be a valid video container: ` +
        `${fileSize} bytes at "${filePath}" (minimum ${MIN_VIDEO_SIZE_BYTES} bytes). ` +
        `The file may be a stub, error response, or corrupt storage record.`,
      ),
      { code: "CORRUPT_SOURCE" },
    );
  }

  if (expectedSizeBytes != null && expectedSizeBytes > 0 && fileSize !== expectedSizeBytes) {
    throw new Error(
      `Source file size mismatch at "${filePath}": ` +
      `expected ${expectedSizeBytes} bytes (from storage metadata) but found ${fileSize} bytes on disk. ` +
      `The download was truncated or the storage record is stale.`,
    );
  }

  // ── Magic-bytes container signature check ──────────────────────────────────
  // Read the first 12 bytes to detect obviously-wrong file types before
  // calling ffprobe. Reject non-video content (HTML, JSON, ZIP, image) that
  // slipped past the MIME-type gate at upload time. Unrecognised container
  // box types (MKV, AVI, WebM, MPEG-TS) are logged at debug and passed
  // through — only content that is definitively NOT a video is rejected.
  try {
    const fd = await fsOpen(filePath, "r");
    try {
      const header = Buffer.allocUnsafe(12);
      const { bytesRead } = await fd.read(header, 0, 12, 0);
      if (bytesRead >= 4) {
        const sig0 = header[0]!;
        const sig1 = header[1]!;
        const sig2 = header[2]!;
        const sig3 = header[3]!;
        const sigStr = header.subarray(0, 4).toString("binary");
        const isHtml  = sigStr.startsWith("<");
        const isJson  = sigStr.startsWith("{") || sigStr.startsWith("[");
        const isZip   = sig0 === 0x50 && sig1 === 0x4b;          // PK — ZIP/Office/EPUB
        const isJpeg  = sig0 === 0xff && sig1 === 0xd8;           // JFIF/EXIF
        const isPng   = sig0 === 0x89 && sig1 === 0x50 && sig2 === 0x4e && sig3 === 0x47;
        const isGif   = sigStr.startsWith("GIF");
        const isPdf   = sigStr.startsWith("%PDF");
        const isXml   = sigStr.startsWith("<?xm") || sigStr.startsWith("<?XM");
        const isId3   = sigStr.startsWith("ID3");                 // MP3 ID3 tag
        const isBmp   = sig0 === 0x42 && sig1 === 0x4d;           // BM
        const isWebp  = bytesRead >= 12 && header.subarray(8, 12).toString("ascii") === "WEBP";

        if (isHtml || isJson || isZip || isJpeg || isPng || isGif || isPdf || isXml || isId3 || isBmp || isWebp) {
          const detected =
            isHtml ? "HTML" : isJson ? "JSON" : isZip ? "ZIP/Office" :
            isJpeg ? "JPEG image" : isPng ? "PNG image" : isGif ? "GIF image" :
            isPdf ? "PDF document" : isXml ? "XML/text" : isId3 ? "MP3 audio" :
            isBmp ? "BMP image" : "WebP image";
          throw Object.assign(
            new Error(
              `Source file at "${filePath}" appears to be ${detected}, not a video container. ` +
              `Magic bytes: 0x${header.subarray(0, 4).toString("hex")}. ` +
              `The uploaded file's content does not match its declared MIME type. ` +
              `Please re-upload a valid video file.`,
            ),
            { code: "CORRUPT_SOURCE" },
          );
        }

        // Log a debug note for non-MP4 containers (MKV, WebM, MPEG-TS, AVI)
        // so operators can trace unusual source formats without failing the job.
        if (bytesRead >= 8) {
          const boxType = header.subarray(4, 8).toString("ascii");
          const knownMp4Boxes = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip", "junk", "pnot"]);
          if (!knownMp4Boxes.has(boxType)) {
            logger.debug(
              { filePath, boxType, firstBytes: header.subarray(0, 8).toString("hex") },
              "transcoder: source file has non-standard MP4 box type — may be MKV/WebM/TS/AVI (ffprobe will verify)",
            );
          }
        }
      }
    } finally {
      await fd.close().catch(() => undefined);
    }
  } catch (err) {
    if ((err as { code?: string }).code === "CORRUPT_SOURCE") throw err;
    // Any other I/O error reading the header is non-fatal — ffprobe will
    // discover real corruption on its own (avoids spurious failures on
    // unusual filesystems or extremely small read budgets).
    logger.warn(
      { err, filePath },
      "transcoder: could not read source file header for magic-bytes check (non-fatal — proceeding to ffprobe)",
    );
  }
}

/**
 * Attempt to decode the first video frame of a local file to verify that its
 * media data (mdat) is intact and decodable — not just that the container
 * structure (moov atom) is parseable.
 *
 * This closes the gap that probeContainerIsValid misses: files where moov is
 * valid (correct stream counts, codec parameters, sample tables) but mdat is
 * truncated, bit-flipped, or otherwise corrupt. Such files pass the structural
 * probe because ffprobe reads stream info from moov only and does NOT read
 * the payload. They then enter the full HLS encode loop and fail after burning
 * a full 15+ minute transcoding attempt with a decode-error exit.
 *
 * Uses ffmpeg (not ffprobe) because only an actual decode pass exercises the
 * mdat payload. `-t 2.0` limits processing to the first 2 seconds so the
 * probe completes in < 1 s for normal files regardless of total duration.
 *
 * Returns:
 *   true  — at least one frame decoded successfully, OR the probe is
 *           unavailable (ffmpeg not on PATH) / times out — fail-open so
 *           transient slowness does not permanently reject healthy files.
 *   false — decode explicitly failed (clear media-data corruption signal).
 */
async function probeCanDecodeFirstFrame(inputPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", [
      "-v", "error",
      "-t", "2.0",        // inspect first 2 s of media data only
      "-i", inputPath,
      "-vframes", "1",    // decode exactly one video frame
      "-f", "null",
      "-",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    proc.unref();
    let stderrTail = "";
    let settled = false;
    const settle = (val: boolean) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
      logger.warn(
        { inputPath, timeoutMs: FRAME_DECODE_TIMEOUT_MS },
        "transcoder: frame-decode probe timed out — treating file as decodable (fail-open)",
      );
      settle(true); // fail-open on timeout
    }, FRAME_DECODE_TIMEOUT_MS);
    timer.unref();
    proc.stderr?.on("data", (b: Buffer) => {
      stderrTail = (stderrTail + b.toString()).slice(-2000);
    });
    proc.on("error", () => {
      // ffmpeg not on PATH — fail open: systems without ffmpeg must not have
      // all uploads permanently rejected by a missing binary.
      clearTimeout(timer);
      settle(true);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        settle(true);
        return;
      }
      // Patterns that definitively indicate media-data corruption rather than
      // a transient environment issue ("Too many open files", "Out of memory").
      // The regex tests ffmpeg's -v error output only, so these patterns are
      // reliable markers of actual payload corruption.
      const mediaCorruptPattern =
        /moov atom not found|invalid data found when processing|error decoding|decode_slice_header|no decodable DTS|no frames decoded|Output file is empty|invalid nal unit size|error while decoding MB|bytes read mismatch|corrupted input|End of file/i;
      if (mediaCorruptPattern.test(stderrTail)) {
        logger.warn(
          { inputPath, stderrTail: stderrTail.slice(-500) },
          "transcoder: frame-decode probe failed — media data appears corrupt or undecodable",
        );
        settle(false);
        return;
      }
      // Non-zero exit but no clear corruption signal (codec quirk, incomplete
      // frames at the -t 2.0 boundary, etc.) — fail-open to avoid false-
      // positive rejections of unusual-but-valid source formats.
      logger.debug(
        { inputPath, exitCode: code, stderrTail: stderrTail.slice(-200) },
        "transcoder: frame-decode probe exited non-zero without a known corruption pattern — treating as decodable",
      );
      settle(true);
    });
  });
}

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
export async function remuxForFaststart(
  inputPath: string,
  outputPath: string,
  videoId: string,
): Promise<string | null> {
  // Helper that runs one ffmpeg attempt and resolves true/false.
  const tryFfmpeg = (args: string[], strategyName: string, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      proc.unref();
      let stderr = "";
      let settled = false;
      const settle = (val: boolean) => { if (!settled) { settled = true; resolve(val); } };
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* noop */ }
        logger.warn({ videoId, strategyName }, "transcoder: remux strategy timed out");
        settle(false);
      }, timeoutMs);
      timer.unref();
      proc.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
      proc.on("error", () => { clearTimeout(timer); settle(false); });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          logger.info({ videoId, strategyName }, "transcoder: remux-recovery succeeded");
          settle(true);
        } else {
          logger.warn(
            { videoId, strategyName, exitCode: code, stderr: stderr.slice(-400) },
            "transcoder: remux strategy failed — trying next",
          );
          settle(false);
        }
      });
    });

  const REMUX_TIMEOUT = 15 * 60_000; // 15 min per strategy

  // Strategy 1: standard stream-copy with faststart (handles moov-at-EOF).
  const s1 = await tryFfmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", inputPath,
    "-c", "copy", "-movflags", "+faststart",
    outputPath,
  ], "s1-copy-faststart", REMUX_TIMEOUT);
  if (s1) return outputPath;

  // Strategy 2: error-tolerant stream-copy with faststart (mildly corrupt containers,
  // discontinuous streams, DTS/PTS gaps). Discards corrupt packets and regenerates
  // timestamps so the muxer can write a valid moov.
  const s2 = await tryFfmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-fflags", "+genpts+discardcorrupt",
    "-err_detect", "ignore_err",
    "-i", inputPath,
    "-c", "copy", "-movflags", "+faststart",
    outputPath,
  ], "s2-tolerant-faststart", REMUX_TIMEOUT);
  if (s2) return outputPath;

  // Strategy 3: last-resort stream-copy without faststart. Useful when the
  // +faststart two-pass seek itself is what causes ffmpeg to abort. The
  // resulting file works for HLS encode even though moov is at EOF.
  const s3 = await tryFfmpeg([
    "-y", "-hide_banner", "-loglevel", "error",
    "-fflags", "+genpts+discardcorrupt",
    "-err_detect", "ignore_err",
    "-i", inputPath,
    "-c", "copy",
    "-ignore_unknown",
    outputPath,
  ], "s3-tolerant-no-faststart", REMUX_TIMEOUT);
  if (s3) return outputPath;

  logger.warn({ videoId }, "transcoder: all remux-recovery strategies exhausted — container is unrepairable");
  return null;
}

function contentTypeFor(name: string): string {
  if (name.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (name.endsWith(".ts")) return "video/mp2t";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

/**
 * Extract a single JPEG frame from the source at t=1s.
 * Has a hard 30-second timeout — hangs on corrupt files are killed.
 * Non-fatal: returns null (local path) on any failure.
 */
async function generateThumbnail(sourceUrl: string, scratchDir: string): Promise<string | null> {
  const thumbPath = path.join(scratchDir, "thumbnail.jpg");
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-ss", "1",
      "-i", sourceUrl,
      "-vframes", "1",
      "-q:v", "2",
      "-vf", "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:black,setsar=1",
      thumbPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    proc.unref();

    let stderrTail = "";
    let settled = false;
    const settle = (val: string | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    // Kill FFmpeg if it hangs (e.g. on a corrupt or truncated source file).
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
      logger.warn({ sourceUrl }, "transcoder: thumbnail ffmpeg timed out after 30 s — skipping (non-fatal)");
      settle(null);
    }, THUMBNAIL_TIMEOUT_MS);
    timer.unref();

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      logger.warn({ err }, "transcoder: thumbnail spawn failed (non-fatal)");
      settle(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        settle(thumbPath);
      } else {
        logger.warn({ code, stderrTail }, "transcoder: thumbnail ffmpeg failed (non-fatal)");
        settle(null);
      }
    });
  });
}

/**
 * Upload all files in a directory tree to object storage with bounded concurrency.
 * Uses a semaphore (UPLOAD_CONCURRENCY) instead of Promise.all to avoid loading
 * hundreds of HLS segments into memory simultaneously.
 */
async function uploadDirRecursive(
  localDir: string,
  keyPrefix: string,
  /** Keys already uploaded by the progressive uploader — skip them. */
  skipKeys?: ReadonlySet<string>,
  /** Called after each file is persisted so callers can track upload progress. */
  onFileUploaded?: (bytes: number) => void,
): Promise<{ uploadedBytes: number; segmentsByRendition: Record<string, number> }> {
  let uploadedBytes = 0;
  const segmentsByRendition: Record<string, number> = {};

  // Collect all files first (tree walk is fast — only metadata reads).
  const filePaths: Array<{ full: string; key: string }> = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (e) => {
      const full = path.join(dir, e.name);
      const childPrefix = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(full, childPrefix);
      } else if (e.isFile()) {
        const key = `${keyPrefix}/${childPrefix}`;
        // Skip any key that was already persisted by the progressive uploader.
        if (!skipKeys?.has(key)) {
          filePaths.push({ full, key });
        }
      }
    }));
  }
  await walk(localDir, "");

  // Upload with bounded concurrency to avoid loading the entire HLS output
  // (potentially hundreds of segments × 500 KB each) into RAM at once.
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < filePaths.length) {
      const item = filePaths[idx++]!;
      const body = await readFile(item.full);
      await storage().putObject({
        key: item.key,
        body,
        contentType: contentTypeFor(path.basename(item.full)),
      });
      uploadedBytes += body.byteLength;
      onFileUploaded?.(body.byteLength);
      if (item.full.endsWith(".ts")) {
        const renditionDir = path.basename(path.dirname(item.full));
        segmentsByRendition[renditionDir] = (segmentsByRendition[renditionDir] ?? 0) + 1;
      }
    }
  }

  // Launch N workers that each pull from the shared `idx` counter.
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, () => worker()));

  return { uploadedBytes, segmentsByRendition };
}

/**
 * Progressive segment uploader — runs concurrently with FFmpeg to upload
 * completed MPEG-TS segments as they are written to disk.
 *
 * FFmpeg writes HLS segments sequentially: it finishes seg_N before beginning
 * seg_N+1. We exploit this property by uploading all segments except the
 * last one in each rendition directory (which may still be open for writing).
 * After FFmpeg exits, the caller performs a final `uploadDirRecursive` pass
 * that skips the already-uploaded keys and picks up the remaining files.
 *
 * This dramatically reduces the dead-air window between encode-complete and
 * first-playable: a 2-hour 1080p sermon (≈ 14 400 segments across 4 renditions)
 * can have most segments in storage by the time FFmpeg writes the last one,
 * so the final upload pass only needs to persist the last segment + playlists
 * rather than all 14 400 files serially.
 *
 * Safety invariants:
 *   - We always keep the last segment in each rendition directory unuploaded
 *     until FFmpeg exits, ensuring we never race on a partially-written file.
 *   - Any individual segment upload failure is logged and the key is removed
 *     from `uploadedKeys` so the final pass retries it.
 *   - The function itself never throws; all errors are caught internally.
 */
async function progressiveSegmentUpload(
  scratchDir: string,
  keyPrefix: string,
  renditionCount: number,
  uploadedKeys: Set<string>,
): Promise<void> {
  const s = storage();
  for (let i = 0; i < renditionCount; i++) {
    const dir = path.join(scratchDir, `v${i}`);
    let files: string[];
    try {
      const all = await readdir(dir);
      files = all.filter((f) => f.endsWith(".ts")).sort();
    } catch {
      continue; // directory not yet created by FFmpeg
    }

    // Upload all but the last segment (which may still be written).
    const safeFiles = files.length > 1 ? files.slice(0, -1) : [];
    if (safeFiles.length === 0) continue;

    // Claim keys before spawning upload tasks to prevent concurrent poll
    // iterations from uploading the same segment twice.
    const pending: Array<{ fullPath: string; key: string }> = [];
    for (const f of safeFiles) {
      const key = `${keyPrefix}/v${i}/${f}`;
      if (!uploadedKeys.has(key)) {
        uploadedKeys.add(key);
        pending.push({ fullPath: path.join(dir, f), key });
      }
    }
    if (pending.length === 0) continue;

    // Upload with bounded concurrency per poll cycle.
    let pIdx = 0;
    async function uploadWorker(): Promise<void> {
      while (pIdx < pending.length) {
        const item = pending[pIdx++]!;
        try {
          const body = await readFile(item.fullPath);
          await s.putObject({ key: item.key, body, contentType: "video/mp2t" });
        } catch (err) {
          // Remove from the claimed set so the final pass retries this segment.
          uploadedKeys.delete(item.key);
          logger.warn({ err, key: item.key }, "transcoder: progressive segment upload failed — will retry");
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(PROGRESSIVE_UPLOAD_CONCURRENCY, pending.length) }, () => uploadWorker()),
    );
  }
}

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
export async function runTranscode(req: TranscodeRequest): Promise<TranscodeResult> {
  const startedAt = Date.now();
  const s = storage();
  if (!s.enabled) {
    throw new Error("Object storage is disabled — cannot run transcoder");
  }

  const scratchRoot = env.TRANSCODER_SCRATCH_DIR ?? path.join(os.tmpdir(), "transcoder");
  const scratchDir = path.join(scratchRoot, req.jobId);
  await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(scratchDir, { recursive: true });

  // Outer try/finally ensures scratch dir is cleaned up even if the source
  // download fails — previously the rm only ran inside the transcode try block.
  try {
    const srcExt = path.extname(req.sourceObjectKey) || ".mp4";
    const sourceTempPath = path.join(scratchDir, `source${srcExt}`);

    // Download source first (may throw — scratch dir cleanup still runs).
    // downloadSourceToTempFile verifies the local byte count matches the
    // storage HEAD so a truncated download fails fast here instead of
    // surfacing later as a misleading "moov atom not found" from ffmpeg.
    await downloadSourceToTempFile(req.sourceObjectKey, sourceTempPath);

    // ── Pre-ffprobe file integrity gate ───────────────────────────────────────
    // Verify the downloaded file is present, non-empty, meets the minimum size
    // for a valid video container, and does not contain obvious non-video
    // content (HTML error pages, JSON responses, images, etc.) that slipped
    // past the upload MIME gate. Throws with a structured code so the
    // dispatcher can classify the failure without parsing ffprobe stderr.
    await validateLocalSourceFile(sourceTempPath);

    // Pre-flight container validation.
    //
    // Detects MP4s where the moov atom is at EOF, fragmented, or otherwise
    // unreachable by ffmpeg's HLS muxer (the #1 cause of "moov atom not
    // found" job failures in production). When the source is bad, run a
    // stream-copy remux with +faststart to rebuild a clean container BEFORE
    // entering the HLS encode loop. This turns previously hard failures
    // into a ~few-second recovery pass with no re-encoding cost.
    //
    // The remux output replaces sourceTempPath for the remainder of the
    // pipeline — all subsequent probes and ffmpeg invocations consume the
    // healed file. We intentionally do NOT re-upload the remuxed file to
    // storage here: the orchestrator's faststart pipeline (runFaststart)
    // owns the canonical re-upload. This is a per-job temp-disk repair.
    let activeSourcePath = sourceTempPath;
    const containerValid = await probeContainerIsValid(sourceTempPath);
    if (!containerValid) {
      // Fast-path: detect the specific case of mdat-present-but-no-moov. This is an
      // unrecoverable condition (the codec configuration stored in the moov avcC box
      // is permanently lost) and no remux strategy can reconstruct it. Surface a clear
      // operator-facing error immediately instead of burning through remux attempts.
      const mdatNoMoov = await detectMdatWithoutMoov(sourceTempPath);
      if (mdatNoMoov) {
        throw Object.assign(
          new Error(
            "Video file is unrecoverable: the recording was interrupted before the moov atom " +
            "(codec configuration) could be written. The file has media data but no moov — " +
            "no repair is possible. Please re-upload from the original source.",
          ),
          { code: "CORRUPT_SOURCE" },
        );
      }

      logger.warn(
        { videoId: req.videoId, jobId: req.jobId, sourceObjectKey: req.sourceObjectKey },
        "transcoder: source container appears damaged (likely moov-at-EOF or truncated) — attempting remux recovery",
      );
      const remuxedPath = path.join(scratchDir, "source.remuxed.mp4");
      const recovered = await remuxForFaststart(sourceTempPath, remuxedPath, req.videoId);
      if (!recovered) {
        throw Object.assign(
          new Error(
            "Video container is unrepairable: all remux recovery strategies failed. " +
            "The file is structurally corrupt (missing or damaged moov atom). " +
            "Please re-upload from the original source.",
          ),
          { code: "CORRUPT_SOURCE" },
        );
      }
      activeSourcePath = recovered;
    }

    // ── Media-data decodability gate ──────────────────────────────────────────
    // probeContainerIsValid only reads the moov/stream-header structure — it
    // does NOT read the mdat payload. A file can have a perfectly valid moov
    // atom (correct stream counts, codec parameters, sample tables) but have
    // its mdat truncated, bit-flipped, or otherwise corrupt. Such files pass
    // the structural probe and enter the full HLS encode loop, where ffmpeg
    // fails with a decode error after burning 15+ minutes of compute.
    //
    // probeCanDecodeFirstFrame uses ffmpeg to decode exactly one video frame
    // from the first 2 s of media data. If the mdat payload is intact this
    // probe completes in < 1 s. If the mdat is corrupt the ffmpeg decode exits
    // non-zero with a clear error pattern and we throw CORRUPT_SOURCE.
    const firstFrameDecodable = await probeCanDecodeFirstFrame(activeSourcePath);
    if (!firstFrameDecodable) {
      throw Object.assign(
        new Error(
          "Video file passes container structure check but its media data cannot be decoded. " +
          "The mdat payload is likely truncated, bit-corrupted, or uses an unsupported codec variant. " +
          "Please re-upload from the original source file.",
        ),
        { code: "CORRUPT_SOURCE" },
      );
    }

    // Run duration and audio probes in parallel. Resolution is probed separately
    // with up to 3 attempts before falling back to 360p-only — a transient
    // ffprobe timeout must never permanently downgrade video quality for a
    // source file that is actually 1080p. Three attempts at 3 s each adds at
    // most 6 s to transcoding jobs where probeResolution fails transiently.
    const [durationSecs, hasAudio] = await Promise.all([
      probeDurationSecs(activeSourcePath),
      probeHasAudio(activeSourcePath),
    ]);

    const RESOLUTION_PROBE_ATTEMPTS = 3;
    const RESOLUTION_PROBE_RETRY_MS = 3_000;
    let srcResolution: { width: number; height: number } | null = null;
    for (let attempt = 1; attempt <= RESOLUTION_PROBE_ATTEMPTS; attempt++) {
      srcResolution = await probeResolution(activeSourcePath);
      if (srcResolution !== null) break;
      if (attempt < RESOLUTION_PROBE_ATTEMPTS) {
        logger.warn(
          { videoId: req.videoId, attempt, maxAttempts: RESOLUTION_PROBE_ATTEMPTS },
          `transcoder: resolution probe returned null (attempt ${attempt}/${RESOLUTION_PROBE_ATTEMPTS}) — retrying to avoid false 360p-only fallback`,
        );
        await new Promise<void>((r) => setTimeout(r, RESOLUTION_PROBE_RETRY_MS));
      }
    }
    if (!hasAudio) {
      logger.info(
        { videoId: req.videoId },
        "transcoder: source has no audio stream — encoding video-only HLS",
      );
    }

    // Select renditions: only include those whose height is ≤ the source height
    // to avoid upscaling. Always keep at least the lowest rendition (360p).
    let renditionsToUse: RenditionSpec[];
    if (srcResolution) {
      const filtered = ALL_RENDITIONS.filter((r) => r.height <= srcResolution.height);
      renditionsToUse = filtered.length > 0 ? filtered : [ALL_RENDITIONS[0]!];
      if (filtered.length < ALL_RENDITIONS.length) {
        logger.info(
          { videoId: req.videoId, srcHeight: srcResolution.height, renditions: renditionsToUse.map(r => r.name) },
          "transcoder: filtered renditions to avoid upscaling",
        );
      }
    } else {
      // Probe failed — cap at 360p ONLY as the safest conservative fallback.
      //
      // Why 360p-only rather than "everything up to 720p":
      //   If the source is a 360p file, using 360p/480p/720p would upscale it
      //   to 480p and 720p — producing larger segments with worse quality than
      //   the original AND confusing ExoPlayer/AVPlayer ABR engines that prefer
      //   higher renditions even when they're upscales. 360p is universally
      //   decodable (H.264 level 3.0) and never upscales any realistic source.
      //
      // Recovery path: operators can re-transcode the video after the root cause
      // of the probe failure is resolved (corrupt container, ffprobe unavailable,
      // etc.) to get the full multi-rendition ladder.
      renditionsToUse = [ALL_RENDITIONS[0]!];
      logger.warn(
        { videoId: req.videoId },
        "transcoder: resolution probe failed — using 360p-only (conservative anti-upscale fallback). " +
        "Re-transcode after fixing probe failure to restore the full quality ladder.",
      );
    }

    // Create per-rendition scratch subdirectories (v0, v1, …).
    for (let i = 0; i < renditionsToUse.length; i++) {
      await mkdir(path.join(scratchDir, `v${i}`), { recursive: true });
    }

    // Pre-flight disk space check: ensure sufficient scratch space before
    // starting FFmpeg. HLS output across all renditions is typically 1–2×
    // source size; require 3× to leave headroom for temp files, index files,
    // and the thumbnail. If statfs() is unavailable (unsupported filesystem)
    // the check is skipped non-fatally so the job proceeds anyway.
    try {
      const { bavail, bsize } = await statfs(scratchDir);
      const availableBytes = bavail * bsize;
      const sourceSize = (await stat(activeSourcePath)).size;
      // Disk requirement scales with the number of renditions being produced.
      // Each HLS rendition outputs roughly 0.7× the source size in .ts segments,
      // plus the source file itself occupies the scratch directory. For a full
      // 4-rendition ladder (360p/480p/720p/1080p) the actual scratch usage is:
      //   source (1×) + 4 renditions × ~0.7× + thumbnails/playlists overhead
      //   ≈ 3.8–4.0× source
      // A flat 3× multiplier (the old value) passes the pre-flight check and
      // then causes an ENOSPC mid-encode, burning a full FFmpeg attempt.
      // Fix: multiply by (renditions + 1) rounded up to at least 3, giving:
      //   1 rendition  → 3× (same as before — conservative single-rendition)
      //   2 renditions → 3× (still safe)
      //   3 renditions → 4×
      //   4 renditions → 5×
      const requiredBytes = sourceSize * Math.max(3, renditionsToUse.length + 1);
      if (availableBytes < requiredBytes) {
        throw Object.assign(
          new Error(
            `Insufficient disk space: need ~${Math.round(requiredBytes / 1024 / 1024)} MB for transcoding ` +
            `(${renditionsToUse.length} rendition(s), ~${Math.max(3, renditionsToUse.length + 1)}× source size), ` +
            `but only ${Math.round(availableBytes / 1024 / 1024)} MB available in ${scratchDir}. ` +
            `The job will retry automatically once disk space is freed.`,
          ),
          { code: "ENOSPC" },
        );
      }
      logger.info(
        {
          videoId: req.videoId,
          availableMB: Math.round(availableBytes / 1024 / 1024),
          requiredMB: Math.round(requiredBytes / 1024 / 1024),
        },
        "transcoder: disk space pre-flight passed",
      );
    } catch (diskErr) {
      if ((diskErr as NodeJS.ErrnoException).code === "ENOSPC") throw diskErr;
      logger.warn({ err: diskErr, videoId: req.videoId }, "transcoder: disk space pre-flight unavailable (non-fatal)");
    }

    const args = buildFfmpegArgs(activeSourcePath, scratchDir, renditionsToUse, hasAudio);

    // Run HLS transcoding and thumbnail extraction in parallel.
    const hlsPromise = new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      // unref() lets the Node process exit cleanly on SIGTERM/SIGKILL even while
      // FFmpeg is still encoding. Without this, a Replit memory-watchdog restart
      // or operator SIGTERM would block for up to TRANSCODER_JOB_TIMEOUT_MS
      // waiting for the orphaned FFmpeg child to finish or time out.
      proc.unref();
      let stderrTail = "";
      let stdoutBuf = "";

      // Hard deadline for the encoding process. Prevents a corrupt or
      // malformed source file from locking the dispatcher indefinitely
      // and starving every subsequent transcoding job. SIGKILL is used
      // (not SIGTERM) because FFmpeg traps SIGTERM to flush output which
      // may itself hang if the source stream is wedged.
      const jobTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* noop */ }
        logger.error(
          { videoId: req.videoId, jobId: req.jobId, timeoutMs: env.TRANSCODER_JOB_TIMEOUT_MS },
          "transcoder: ffmpeg encoding killed — exceeded TRANSCODER_JOB_TIMEOUT_MS",
        );
        reject(new Error(
          `ffmpeg encoding timed out after ${Math.round(env.TRANSCODER_JOB_TIMEOUT_MS / 60_000)} min — SIGKILL sent`,
        ));
      }, env.TRANSCODER_JOB_TIMEOUT_MS);

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) {
          const m = /^out_time_ms=(\d+)/.exec(line.trim());
          if (m && req.onProgress) {
            const sec = Number(m[1]) / 1_000_000;
            // Map FFmpeg encode time to 0–90 % of the overall job progress.
            // The remaining 10 % is reserved for the upload phase below so the
            // Admin progress bar never sits stuck at 99 % while segments are
            // being written to storage (which can take minutes for long content).
            //
            // When durationSecs is null (ffprobe failed to determine duration),
            // fall back to a 1-hour estimate so the progress bar still advances
            // and operators can distinguish a running job from a stuck one.
            // Capped at 85 % to preserve the visual gap until the upload phase.
            const pct = durationSecs && durationSecs > 0
              ? Math.min(90, Math.max(0, Math.round((sec / durationSecs) * 90)))
              : Math.min(85, Math.max(1, Math.round((sec / 3_600) * 85)));
            void Promise.resolve(req.onProgress(pct)).catch(() => { /* non-fatal — progress update failure must not crash encoding */ });
          }
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const s = chunk.toString();
        stderrTail = (stderrTail + s).slice(-4000);
      });

      proc.on("error", (err) => { clearTimeout(jobTimer); reject(err); });
      proc.on("close", (code) => {
        clearTimeout(jobTimer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderrTail.trim()}`));
      });
    });

    // Rejection guard — CRITICAL for 24/7 fault tolerance.
    // hlsPromise is created above but not awaited until further down (after the
    // `await generateThumbnail(...)` call and the progressive-uploader setup).
    // If FFmpeg fails *fast* — e.g. an invalid encoder option that makes it exit
    // before any encoding starts — the rejection lands in that async gap with no
    // handler attached yet. Node reports that as an unhandledRejection, which the
    // process-level handler escalates to a FATAL exit, taking the entire API and
    // broadcast engine down for a single bad transcode. Attaching a no-op catch
    // here marks the rejection as handled so it can never crash the process; the
    // real error handling (360p fallback / re-throw) still happens at the
    // `await hlsPromise` site below, because `.catch()` returns a *new* promise
    // and does not consume the rejection observed by that await.
    hlsPromise.catch(() => { /* handled at the `await hlsPromise` site below */ });

    // Extract thumbnail first (non-critical; must precede any scratchDir rebuild
    // so the file is never silently dropped by a single-rendition fallback below).
    let thumbLocalPath = await generateThumbnail(activeSourcePath, scratchDir);

    // Progressive segment uploader: runs concurrently with FFmpeg, uploading
    // completed .ts segments as they appear on disk so that the final post-
    // encode upload pass only needs to handle the last segment + playlists.
    const uploadedSegmentKeys = new Set<string>();
    const keyPrefix = `transcoded/${req.videoId}`;
    let progressiveActive = true;
    const progressiveLoop = (async () => {
      while (progressiveActive) {
        await new Promise<void>((r) => setTimeout(r, PROGRESSIVE_POLL_MS));
        if (!progressiveActive) break;
        try {
          await progressiveSegmentUpload(scratchDir, keyPrefix, renditionsToUse.length, uploadedSegmentKeys);
        } catch (progressiveErr) {
          // progressiveSegmentUpload handles per-file errors internally with logger.warn.
          // This outer catch covers unexpected structural failures (e.g. a bug in the
          // function itself). Log at warn so it shows up in the transcoding dashboard
          // rather than being silently swallowed, then continue looping.
          logger.warn(
            { videoId: req.videoId, jobId: req.jobId, err: String(progressiveErr) },
            "transcoder: progressive segment upload loop threw unexpectedly (non-fatal — will retry next poll)",
          );
        }
      }
    })();

    // Run HLS transcoding. On multi-rendition stream-mapping failures (FFmpeg
    // exit 234 / AVERROR_INVALIDDATA, or other codec-parameter errors) retry
    // automatically with a single 360p rendition. This prevents a source-file
    // codec quirk from consuming all maxAttempts retries without any HLS output.
    try {
      await hlsPromise;
    } catch (hlsErr) {
      const errStr = hlsErr instanceof Error ? hlsErr.message : String(hlsErr);
      // Heuristic: exit 234 = AVERROR_INVALIDDATA (most common for mapping/codec
      // issues); also catch common FFmpeg stderr patterns for the same class.
      const isMappingLike =
        errStr.includes("234") ||
        /stream.*map|invalid data|codec.*param|no such stream/i.test(errStr);

      if (isMappingLike && renditionsToUse.length > 1) {
        logger.warn(
          { videoId: req.videoId, jobId: req.jobId, errSnippet: errStr.slice(0, 300) },
          "transcoder: multi-rendition ffmpeg failed — retrying with 360p-only fallback",
        );

        // Stop the progressive uploader and delete any partially-uploaded
        // segments from the failed multi-rendition run. Without this cleanup,
        // stale HLS segment rows accumulate in storage_blobs (and object storage)
        // and are never GC'd — they are not referenced by any playlist because the
        // master m3u8 was never finalized for the failed rendition set.
        progressiveActive = false;
        await progressiveLoop.catch(() => {});

        if (uploadedSegmentKeys.size > 0) {
          const st = storage();
          // Delete all partially-uploaded segments in parallel; non-fatal since
          // the orphan-cleanup worker will eventually remove unreferenced objects.
          await Promise.allSettled(
            [...uploadedSegmentKeys].map((k) => st.deleteObject(k).catch((err: unknown) => {
              logger.warn({ err, key: k, videoId: req.videoId }, "transcoder: failed to delete orphaned segment during 360p fallback (non-fatal)");
            })),
          );
        }
        uploadedSegmentKeys.clear();

        // Reset progress to 0 so the Admin UI shows "Encoding (0%)" rather
        // than a stale partial percentage from the failed multi-rendition run.
        if (req.onProgress) {
          await Promise.resolve(req.onProgress(0)).catch(() => { /* non-fatal */ });
        }

        const prevRenditionCount = renditionsToUse.length;
        renditionsToUse = [ALL_RENDITIONS[0]!];

        // Remove only the rendition output subdirs (v0..vN-1); preserve the
        // source file (activeSourcePath lives inside scratchDir).
        for (let i = 0; i < prevRenditionCount; i++) {
          await rm(path.join(scratchDir, `v${i}`), { recursive: true, force: true }).catch(() => undefined);
        }
        // Remove stale thumbnail (will be regenerated after fallback succeeds).
        await rm(path.join(scratchDir, "thumbnail.jpg"), { force: true }).catch(() => undefined);
        thumbLocalPath = null;

        // Recreate the single-rendition output directory.
        await mkdir(path.join(scratchDir, "v0"), { recursive: true });

        // Re-start the progressive uploader for the 360p fallback run.
        // Build FFmpeg args BEFORE starting the loop: if buildFfmpegArgs
        // throws (e.g. unsupported rendition config), fallbackProgressiveLoop
        // would otherwise start and run indefinitely because the error escapes
        // to the outer catch block without ever setting progressiveActive=false.
        const fallbackArgs = buildFfmpegArgs(activeSourcePath, scratchDir, renditionsToUse, hasAudio);
        progressiveActive = true;
        const fallbackProgressiveLoop = (async () => {
          while (progressiveActive) {
            await new Promise<void>((r) => setTimeout(r, PROGRESSIVE_POLL_MS));
            if (!progressiveActive) break;
            try {
              await progressiveSegmentUpload(scratchDir, keyPrefix, renditionsToUse.length, uploadedSegmentKeys);
            } catch (progressiveErr) {
              logger.warn(
                { videoId: req.videoId, jobId: req.jobId, err: String(progressiveErr) },
                "transcoder: progressive segment upload loop threw unexpectedly in 360p fallback (non-fatal — will retry next poll)",
              );
            }
          }
        })();
        try {
          await new Promise<void>((resolve, reject) => {
            const proc = spawn("ffmpeg", fallbackArgs, { stdio: ["ignore", "pipe", "pipe"] });
            // Mirror the main-path unref() so a SIGTERM/watchdog restart during
            // the 360p fallback encode doesn't block the process from exiting.
            proc.unref();
            let tail = "";
            // Buffer stdout across chunks so out_time_ms= lines split over
            // two data events are assembled correctly (mirrors the main path).
            let fallbackStdoutBuf = "";
            proc.stdout?.on("data", (c: Buffer) => {
              fallbackStdoutBuf += c.toString();
              const lines = fallbackStdoutBuf.split("\n");
              fallbackStdoutBuf = lines.pop() ?? "";
              for (const line of lines) {
                const m = /^out_time_ms=(\d+)/.exec(line.trim());
                if (m && req.onProgress) {
                  const sec = Number(m[1]) / 1_000_000;
                  const pct = durationSecs && durationSecs > 0
                    ? Math.min(90, Math.max(0, Math.round((sec / durationSecs) * 90)))
                    : Math.min(85, Math.max(1, Math.round((sec / 3_600) * 85)));
                  void Promise.resolve(req.onProgress(pct)).catch(() => { /* non-fatal — progress update failure must not crash encoding */ });
                }
              }
            });
            proc.stderr?.on("data", (c: Buffer) => { tail = (tail + c.toString()).slice(-3000); });
            const t = setTimeout(() => {
              try { proc.kill("SIGKILL"); } catch { /* noop */ }
              reject(new Error(
                `ffmpeg 360p fallback timed out after ${Math.round(env.TRANSCODER_JOB_TIMEOUT_MS / 60_000)} min`,
              ));
            }, env.TRANSCODER_JOB_TIMEOUT_MS);
            proc.on("error", (err) => { clearTimeout(t); reject(err); });
            proc.on("close", (code) => {
              clearTimeout(t);
              if (code === 0) resolve();
              else reject(new Error(`ffmpeg 360p fallback exited ${code}: ${tail.trim()}`));
            });
          });
        } catch (fallbackErr) {
          // The 360p fallback itself failed. Stop and drain the progressive
          // uploader NOW — before re-throwing — or fallbackProgressiveLoop
          // continues running indefinitely after runTranscode() returns.
          // progressiveActive is still true at this point; the exception
          // escapes the if-block without reaching the cleanup lines below.
          progressiveActive = false;
          await fallbackProgressiveLoop.catch(() => {});
          throw fallbackErr;
        }

        // Stop the fallback progressive uploader before final upload pass.
        progressiveActive = false;
        await fallbackProgressiveLoop.catch(() => {});

        logger.info({ videoId: req.videoId }, "transcoder: 360p fallback encoding succeeded — regenerating thumbnail");
        // Re-extract thumbnail into the rebuilt scratch dir (non-fatal if it fails).
        thumbLocalPath = await generateThumbnail(activeSourcePath, scratchDir);
      } else {
        // Fatal error — stop the progressive uploader before re-throwing.
        progressiveActive = false;
        await progressiveLoop.catch(() => {});
        throw hlsErr;
      }
    }

    // Stop the primary progressive uploader now that FFmpeg has exited.
    progressiveActive = false;
    await progressiveLoop.catch(() => {});

    // ── CODECS injection ─────────────────────────────────────────────────────
    // FFmpeg does not emit a CODECS attribute in the master playlist it writes
    // to disk. Inject correct CODECS strings before uploading so that strict
    // HLS parsers (Samsung Tizen, LG webOS 3.x, older ExoPlayer builds) can
    // select the right hardware decoder without ambiguity.
    const masterLocalPath = path.join(scratchDir, "master.m3u8");
    try {
      const masterRaw = await readFile(masterLocalPath, "utf-8");
      const masterEnhanced = injectCodecsIntoMaster(masterRaw, renditionsToUse, hasAudio);
      await writeFile(masterLocalPath, masterEnhanced, "utf-8");
      logger.debug(
        { videoId: req.videoId, renditions: renditionsToUse.map((r) => `${r.name}@${r.level}`) },
        "transcoder: CODECS attribute injected into master.m3u8",
      );
    } catch (codecsErr) {
      // Fatal: uploading an HLS master playlist without CODECS attributes causes
      // hardware-decoder selection failures on Samsung Tizen (>=4.x) and LG webOS
      // (3.x), resulting in black screens for all TV viewers. Rather than uploading
      // broken output silently, fail the job so it retries automatically. The FFmpeg
      // encode succeeded — the failure is in post-processing, so a retry will
      // re-run the full encode from scratch and is likely to succeed.
      logger.error(
        { err: codecsErr, videoId: req.videoId },
        "transcoder: CODECS injection failed — aborting to prevent distributing black-screen HLS to Smart TVs; job will retry automatically",
      );
      throw Object.assign(
        new Error(
          `CODECS injection into master.m3u8 failed: ${codecsErr instanceof Error ? codecsErr.message : String(codecsErr)}. ` +
          "Upload aborted to prevent distributing broken HLS that causes black screens on Samsung Tizen / LG webOS.",
        ),
        { cause: codecsErr },
      );
    }

    // ── Final upload pass ────────────────────────────────────────────────────
    // Most .ts segments were already uploaded by the progressive uploader.
    // This pass handles: the last segment per rendition, all playlist files,
    // master.m3u8 (now CODECS-enhanced), and the thumbnail.
    //
    // Progress is mapped to 90–100 %: the progressive uploader ran during
    // the 0–90 % encode window, so the final pass moves the indicator from
    // 90 % up to 100 % based on bytes persisted in this pass.
    let uploadProgressPct = 90;
    // Estimate total bytes remaining for this final pass: start with
    // a rough heuristic (segment size ≈ 300 KB, remaining ≈ 1 per rendition
    // + playlists) and update dynamically as files are actually read.
    let estimatedRemainingBytes = 0;
    let actualUploadedBytes = 0;
    // We don't know the exact remaining byte count ahead of time, so use a
    // simple incremental approach: each file uploaded nudges the bar by a
    // proportional amount toward 100 % based on bytes seen so far.
    const upload = await uploadDirRecursive(
      scratchDir,
      keyPrefix,
      uploadedSegmentKeys,
      (bytes) => {
        if (!req.onProgress) return;
        estimatedRemainingBytes += bytes;
        actualUploadedBytes += bytes;
        // Use incremental square-root smoothing so early small files don't
        // spike the bar and long uploads stay readable. Cap at 99 so the
        // dispatcher's final onProgress(100) call is always visible.
        const uploadFraction = Math.min(1, actualUploadedBytes / Math.max(estimatedRemainingBytes, 1));
        const pct = Math.min(99, Math.round(90 + uploadFraction * 9));
        if (pct > uploadProgressPct) {
          uploadProgressPct = pct;
          void req.onProgress(pct);
        }
      },
    );

    const masterKey = `${keyPrefix}/master.m3u8`;
    const masterUrl = `/api/hls/${req.videoId}/master.m3u8`;

    // Compute the true per-rendition segment counts by reading the playlist
    // files from disk. This is necessary because the progressive uploader has
    // already persisted most segments to storage (they appear in
    // uploadedSegmentKeys) while upload.segmentsByRendition only reflects the
    // small number of segments uploaded in this final pass.
    const diskSegmentCounts: Record<string, number> = {};
    for (let i = 0; i < renditionsToUse.length; i++) {
      const vDir = path.join(scratchDir, `v${i}`);
      try {
        const entries = await readdir(vDir);
        diskSegmentCounts[`v${i}`] = entries.filter((f) => f.endsWith(".ts")).length;
      } catch {
        // Fall back to final-pass count if the directory is unavailable.
        diskSegmentCounts[`v${i}`] = upload.segmentsByRendition[`v${i}`] ?? 0;
      }
    }

    const renditionsOut = renditionsToUse.map((r, i) => ({
      name: r.name,
      bitrateKbps: r.videoBitrateK,
      width: r.width,
      height: r.height,
      segmentCount: diskSegmentCounts[`v${i}`] ?? 0,
    }));

    if (req.onProgress) await req.onProgress(100);

    const thumbnailUrl: string | undefined = thumbLocalPath
      ? `/api/hls/${req.videoId}/thumbnail.jpg`
      : undefined;

    if (thumbnailUrl) {
      logger.info({ videoId: req.videoId, thumbnailUrl }, "transcoder: thumbnail generated");
    } else {
      logger.warn({ videoId: req.videoId }, "transcoder: thumbnail generation skipped (non-fatal)");
    }

    return {
      masterPlaylistKey: masterKey,
      masterPlaylistUrl: masterUrl,
      renditions: renditionsOut,
      durationSecs,
      totalBytes: upload.uploadedBytes,
      elapsedMs: Date.now() - startedAt,
      thumbnailUrl,
    };
  } finally {
    // Always clean up scratch space — runs even if download or transcode threw.
    if (!env.TRANSCODER_KEEP_SCRATCH) {
      await rm(scratchDir, { recursive: true, force: true }).catch((err) => {
        logger.warn({ err, scratchDir }, "transcoder scratch cleanup failed");
      });
    }
  }
}

/**
 * Probes the duration of a newly-uploaded source file via ffprobe.
 * Downloads the object to a temp file, runs ffprobe (exits as soon as the
 * format header is read), and returns the duration in seconds.
 * Non-fatal: returns null on any failure.
 */
export async function probeUploadedDuration(sourceObjectKey: string): Promise<number | null> {
  const s = storage();
  if (!s.enabled) return null;
  const tmpDir = path.join(os.tmpdir(), `probe-${randomUUID()}`);
  try {
    await mkdir(tmpDir, { recursive: true });
    const ext = path.extname(sourceObjectKey) || ".mp4";
    const tmpPath = path.join(tmpDir, `source${ext}`);
    await downloadSourceToTempFile(sourceObjectKey, tmpPath);
    // Guard before ffprobe: a zero-byte or non-video download produces
    // a confusing "no duration" rather than a clear diagnostic otherwise.
    await validateLocalSourceFile(tmpPath);
    const dur = await probeDurationSecs(tmpPath);
    if (dur != null) {
      logger.info({ sourceObjectKey, durationSecs: dur }, "probe-duration: ok");
    }
    return dur;
  } catch (err) {
    logger.warn({ err, sourceObjectKey }, "probe-duration: failed (non-fatal)");
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

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
export async function probeUploadedContainerValidity(
  objectKey: string,
): Promise<{ valid: boolean; error?: string }> {
  const s = storage();
  if (!s.enabled) return { valid: true };
  const tmpDir = path.join(os.tmpdir(), `container-probe-${randomUUID()}`);
  try {
    await mkdir(tmpDir, { recursive: true });
    const extRaw = path.extname(objectKey).replace(/[^a-z0-9.]/gi, "");
    const ext = extRaw || ".mp4";
    const tmpPath = path.join(tmpDir, `source${ext}`);
    await downloadSourceToTempFile(objectKey, tmpPath);

    // Stage 0: existence, size, and magic-bytes gate (no subprocess).
    try {
      await validateLocalSourceFile(tmpPath);
    } catch (valErr) {
      const errMsg = valErr instanceof Error ? valErr.message : String(valErr);
      return { valid: false, error: `source file failed pre-flight validation: ${errMsg}` };
    }

    // Stage 1: structural integrity — moov atom present and parseable.
    const containerStructureValid = await probeContainerIsValid(tmpPath);
    if (!containerStructureValid) {
      return { valid: false, error: "container structure invalid (moov atom missing, partial file, or damaged container header)" };
    }

    // Stage 2: media-data decodability — mdat payload is intact.
    // probeContainerIsValid only reads the moov/stream-header; a file can
    // have a valid moov but a truncated or corrupt mdat that would pass the
    // structural check yet fail HLS encoding after 15+ minutes of wasted
    // compute. Decode the first frame to verify the payload.
    const mediaDataDecodable = await probeCanDecodeFirstFrame(tmpPath);
    if (!mediaDataDecodable) {
      return {
        valid: false,
        error:
          "media data undecodable: container structure is valid but the first video frame " +
          "cannot be decoded — mdat may be truncated, bit-corrupted, or the codec is unsupported",
      };
    }

    return { valid: true };
  } catch (err) {
    // Any exception here is an infrastructure failure (download error, tmp
    // directory I/O error, etc.) — NOT evidence of container corruption.
    // Return valid=true to give the file the benefit of the doubt: faststart
    // and the HLS transcoder will discover real corruption on their own probing
    // passes, where structured retries and better diagnostics exist.
    logger.warn(
      { err, objectKey },
      "transcoder: container probe infrastructure error (non-fatal) — assuming valid, proceeding to faststart",
    );
    return { valid: true };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

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
export async function generateQuickThumbnail(
  sourceObjectKey: string,
  videoId: string,
): Promise<string | null> {
  const s = storage();
  if (!s.enabled) return null;

  const scratchRoot = env.TRANSCODER_SCRATCH_DIR ?? path.join(os.tmpdir(), "transcoder");
  const scratchDir = path.join(scratchRoot, `thumb-${videoId}`);
  try {
    await mkdir(scratchDir, { recursive: true });
    const ext = path.extname(sourceObjectKey) || ".mp4";
    const sourceTempPath = path.join(scratchDir, `source${ext}`);
    await downloadSourceToTempFile(sourceObjectKey, sourceTempPath);
    // Guard before ffmpeg: a zero-byte or non-video download would produce a
    // confusing ffmpeg error; fail with a clear log entry instead.
    await validateLocalSourceFile(sourceTempPath);

    const thumbLocalPath = await generateThumbnail(sourceTempPath, scratchDir);
    if (!thumbLocalPath) return null;

    const body = await readFile(thumbLocalPath);
    const thumbKey = `transcoded/${videoId}/thumbnail.jpg`;
    await s.putObject({ key: thumbKey, body, contentType: "image/jpeg" });

    const proxyUrl = `/api/hls/${videoId}/thumbnail.jpg`;
    logger.info({ videoId, thumbKey }, "quick-thumbnail: generated and uploaded");
    return proxyUrl;
  } catch (err) {
    logger.warn({ err, videoId }, "quick-thumbnail: failed (non-fatal)");
    return null;
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

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
export async function normalizeThumbnailBuffer(input: Buffer): Promise<Buffer | null> {
  const tmpDir = path.join(os.tmpdir(), `thumb-norm-${randomUUID()}`);
  try {
    await mkdir(tmpDir, { recursive: true });
    const srcPath = path.join(tmpDir, "input.jpg");
    const outPath = path.join(tmpDir, "output.jpg");
    await writeFile(srcPath, input);

    const ok = await new Promise<boolean>((resolve) => {
      const proc = spawn("ffmpeg", [
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-i", srcPath,
        "-vf", "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:black,setsar=1",
        "-vframes", "1",
        "-q:v", "2",
        outPath,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      proc.unref();

      let settled = false;
      const settle = (val: boolean) => { if (!settled) { settled = true; resolve(val); } };

      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* noop */ }
        settle(false);
      }, 15_000);
      timer.unref();

      proc.on("error", () => { clearTimeout(timer); settle(false); });
      proc.on("close", (code) => { clearTimeout(timer); settle(code === 0); });
    });

    if (!ok) return null;
    return await readFile(outPath);
  } catch (err) {
    logger.warn({ err }, "thumbnail-normalize: failed (non-fatal)");
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const _internal = { buildFfmpegArgs, ALL_RENDITIONS };

/**
 * Probe whether the `ffmpeg` binary is reachable and executable.
 * Runs `ffmpeg -version` and resolves true on exit-code 0, false on any
 * error (binary not found, permission denied, non-zero exit, etc.).
 * Never throws — callers use the boolean to decide whether to emit an alert.
 */
export function checkFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    proc.unref();
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}
