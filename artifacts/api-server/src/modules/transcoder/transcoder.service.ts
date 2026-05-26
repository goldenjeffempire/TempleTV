import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { storage } from "../../infrastructure/storage.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";

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
  // level "3.0" — baseline decoder for legacy STBs and Smart TV chipsets
  { name: "360p",  width: 640,  height: 360,  videoBitrateK: 400,  maxrateK: 550,  bufsizeK: 800,  audioBitrateK: 64,  level: "3.0" },
  // level "3.1" — covers 720p@30 and lower; widely supported across all smart TV SDKs
  { name: "480p",  width: 854,  height: 480,  videoBitrateK: 800,  maxrateK: 1000, bufsizeK: 1500, audioBitrateK: 96,  level: "3.1" },
  { name: "720p",  width: 1280, height: 720,  videoBitrateK: 1800, maxrateK: 2200, bufsizeK: 3300, audioBitrateK: 128, level: "3.1" },
  // level "4.0" — required for 1080p@30; supported on all modern devices (2013+)
  { name: "1080p", width: 1920, height: 1080, videoBitrateK: 3500, maxrateK: 4500, bufsizeK: 6750, audioBitrateK: 192, level: "4.0" },
];

const HLS_SEGMENT_SECS = 4;
const KEYFRAME_INTERVAL_SECS = 2;
const FFMPEG_PRESET = env.TRANSCODER_PRESET;
const FFMPEG_CRF = String(env.TRANSCODER_CRF);
const THUMBNAIL_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 30_000;
const RESOLUTION_PROBE_TIMEOUT_MS = 15_000;
// Max concurrent file uploads when copying HLS segments to object storage.
const UPLOAD_CONCURRENCY = 6;

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
    filterParts.push(
      `[vsplit${i}]scale=w=${r.width}:h=${r.height}:force_original_aspect_ratio=decrease,` +
      `pad=${r.width}:${r.height}:(ow-iw)/2:(oh-ih)/2[v${i}out]`,
    );
  });

  const args: string[] = [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-progress", "pipe:1",
    "-stats_period", "5",
    "-i", input,
    "-filter_complex", filterParts.join(";"),
  ];

  renditions.forEach((r, i) => {
    args.push(
      "-map", `[v${i}out]`,
      `-c:v:${i}`, "libx264",
      `-profile:v:${i}`, "main",
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
    );
  });

  // Apply pixel format globally once after all per-stream video options.
  // yuv420p is required for maximum decoder compatibility (Tizen, webOS,
  // Fire TV, iOS). Applying it per-rendition was redundant and could
  // confuse option parsing in some FFmpeg 7.x builds.
  args.push("-pix_fmt", "yuv420p");

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
    "-hls_playlist_type", "vod",
    "-hls_segment_type", "mpegts",
    "-hls_flags", "independent_segments",
    "-hls_list_size", "0",
    "-hls_segment_filename", path.join(outDir, "v%v", "seg_%05d.ts"),
    "-master_pl_name", "master.m3u8",
    "-var_stream_map", varStreamMap,
    path.join(outDir, "v%v", "playlist.m3u8"),
  );

  return args;
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
 * Download a source object from object storage to a local temp file.
 * All ffprobe/ffmpeg calls go against the local path so they work without
 * any special network access or auth tokens.
 *
 * Verifies the downloaded file's byte count matches storage's HEAD. A
 * truncated download (network glitch, storage hiccup, partial read) leaves
 * an MP4 with a missing tail — and since the moov atom is often at EOF,
 * ffmpeg fails with the misleading "moov atom not found" instead of a
 * size-mismatch error. Failing here forces the dispatcher's retry loop to
 * re-download the source instead of running ffmpeg against bad bytes.
 */
async function downloadSourceToTempFile(objectKey: string, destPath: string): Promise<void> {
  const head = await storage().headObject(objectKey).catch(() => null);
  const { body } = await storage().getObject(objectKey);
  await pipeline(body, createWriteStream(destPath));

  const expected = head?.contentLength;
  if (expected != null && expected > 0) {
    const actual = (await stat(destPath)).size;
    if (actual !== expected) {
      throw new Error(
        `transcoder: source download truncated — expected ${expected} bytes from storage, ` +
          `got ${actual} bytes on disk (objectKey=${objectKey}). ` +
          `This typically presents as "moov atom not found" when ffmpeg runs. ` +
          `The job will retry and re-download the source.`,
      );
    }
  }
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
    proc.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    proc.stderr.on("data", (b: Buffer) => { err = (err + b.toString()).slice(-2000); });
    proc.on("error", () => { clearTimeout(timer); settle(false); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      // Hard fail when ffprobe exits non-zero OR stderr emits one of the
      // container-corruption signatures that ALSO break the HLS muxer.
      const containerErrorPattern = /moov atom not found|invalid data found|partial file|EOF before frame|error reading header/i;
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
export async function detectMdatWithoutMoov(inputPath: string): Promise<boolean> {
  const SCAN_BYTES = 65536;
  let fd: import("node:fs/promises").FileHandle | null = null;
  try {
    const { open: fsOpen } = await import("node:fs/promises");
    fd = await fsOpen(inputPath, "r");

    // ── Front scan ───────────────────────────────────────────────────────────
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

    // ── Tail scan ────────────────────────────────────────────────────────────
    // mdat was found in the front but moov wasn't. Before declaring the file
    // unrecoverable, check the TAIL of the file — normal recordings (camera,
    // phone, OBS without faststart) write moov as the very last box. If moov
    // is there, the remux recovery path (remuxForFaststart) can fix it in
    // seconds using ffmpeg's stream-copy + movflags=+faststart.
    //
    // We scan byte-by-byte in the tail window rather than parsing box
    // boundaries (which may be misaligned relative to the tail offset).
    const fileSize = (await stat(inputPath)).size;
    if (fileSize > SCAN_BYTES) {
      const tailOffset = fileSize - SCAN_BYTES;
      const tailBuf = Buffer.allocUnsafe(SCAN_BYTES);
      const { bytesRead: tailRead } = await fd.read(tailBuf, 0, SCAN_BYTES, tailOffset);
      for (let i = 0; i + 8 <= tailRead; i++) {
        // Look for the 4-byte ASCII sequence "moov" anywhere in the tail window.
        if (
          tailBuf[i]     === 0x6d && // m
          tailBuf[i + 1] === 0x6f && // o
          tailBuf[i + 2] === 0x6f && // o
          tailBuf[i + 3] === 0x76    // v
        ) {
          return false; // moov at EOF → recoverable via remux, not truly absent
        }
      }
    }

    return true; // mdat present but moov absent from both front and tail — unrecoverable
  } catch {
    return false; // treat I/O failures as "unknown" — let remux attempt run
  } finally {
    await fd?.close().catch(() => undefined);
  }
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
      let stderr = "";
      let settled = false;
      const settle = (val: boolean) => { if (!settled) { settled = true; resolve(val); } };
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* noop */ }
        logger.warn({ videoId, strategyName }, "transcoder: remux strategy timed out");
        settle(false);
      }, timeoutMs);
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
        filePaths.push({ full, key: `${keyPrefix}/${childPrefix}` });
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
        throw new Error(
          "transcoder: source MP4 has media data (mdat) but NO moov atom. " +
          "The recording or export was interrupted before the moov could be written. " +
          "The codec configuration (SPS/PPS) stored in the moov is permanently lost — " +
          "no recovery is possible from the stored blob. Re-upload from the original source file.",
        );
      }

      logger.warn(
        { videoId: req.videoId, jobId: req.jobId, sourceObjectKey: req.sourceObjectKey },
        "transcoder: source container appears damaged (likely moov-at-EOF or truncated) — attempting remux recovery",
      );
      const remuxedPath = path.join(scratchDir, "source.remuxed.mp4");
      const recovered = await remuxForFaststart(sourceTempPath, remuxedPath, req.videoId);
      if (!recovered) {
        throw new Error(
          "transcoder: source MP4 container is unrepairable (moov atom missing and all remux strategies failed). " +
            "The upload may be corrupt — re-upload required.",
        );
      }
      activeSourcePath = recovered;
    }

    // Run duration, resolution, and audio probes in parallel (all are ffprobe calls).
    const [durationSecs, srcResolution, hasAudio] = await Promise.all([
      probeDurationSecs(activeSourcePath),
      probeResolution(activeSourcePath),
      probeHasAudio(activeSourcePath),
    ]);
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
      // Probe failed — fall back to safe default (480p + 720p only) to avoid
      // attempting 1080p on sources where the resolution is unknown.
      renditionsToUse = ALL_RENDITIONS.filter((r) => r.height <= 720);
      logger.warn({ videoId: req.videoId }, "transcoder: resolution probe failed — using 360p/480p/720p renditions");
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
      const requiredBytes = sourceSize * 3;
      if (availableBytes < requiredBytes) {
        throw Object.assign(
          new Error(
            `Insufficient disk space: need ~${Math.round(requiredBytes / 1024 / 1024)} MB for transcoding, ` +
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
          if (m && durationSecs && req.onProgress) {
            const sec = Number(m[1]) / 1_000_000;
            const pct = Math.min(99, Math.max(0, Math.round((sec / durationSecs) * 100)));
            void req.onProgress(pct);
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

    // Extract thumbnail first (non-critical; must precede any scratchDir rebuild
    // so the file is never silently dropped by a single-rendition fallback below).
    let thumbLocalPath = await generateThumbnail(activeSourcePath, scratchDir);

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

        const fallbackArgs = buildFfmpegArgs(activeSourcePath, scratchDir, renditionsToUse, hasAudio);
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("ffmpeg", fallbackArgs, { stdio: ["ignore", "ignore", "pipe"] });
          let tail = "";
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

        logger.info({ videoId: req.videoId }, "transcoder: 360p fallback encoding succeeded — regenerating thumbnail");
        // Re-extract thumbnail into the rebuilt scratch dir (non-fatal if it fails).
        thumbLocalPath = await generateThumbnail(activeSourcePath, scratchDir);
      } else {
        throw hlsErr;
      }
    }

    const keyPrefix = `transcoded/${req.videoId}`;
    const upload = await uploadDirRecursive(scratchDir, keyPrefix);

    const masterKey = `${keyPrefix}/master.m3u8`;
    const masterUrl = `/api/hls/${req.videoId}/master.m3u8`;

    const renditionsOut = renditionsToUse.map((r, i) => ({
      name: r.name,
      bitrateKbps: r.videoBitrateK,
      width: r.width,
      height: r.height,
      segmentCount: upload.segmentsByRendition[`v${i}`] ?? 0,
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
    const valid = await probeContainerIsValid(tmpPath);
    return { valid };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
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

      let settled = false;
      const settle = (val: boolean) => { if (!settled) { settled = true; resolve(val); } };

      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* noop */ }
        settle(false);
      }, 15_000);

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
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}
