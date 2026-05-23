import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
}

// All renditions ordered from lowest to highest.
// runTranscode filters this list to avoid upscaling by checking the source
// video's actual height and dropping any renditions taller than the source.
const ALL_RENDITIONS: RenditionSpec[] = [
  { name: "360p",  width: 640,  height: 360,  videoBitrateK: 400,  maxrateK: 550,  bufsizeK: 800,  audioBitrateK: 64  },
  { name: "480p",  width: 854,  height: 480,  videoBitrateK: 800,  maxrateK: 1000, bufsizeK: 1500, audioBitrateK: 96  },
  { name: "720p",  width: 1280, height: 720,  videoBitrateK: 1800, maxrateK: 2200, bufsizeK: 3300, audioBitrateK: 128 },
  { name: "1080p", width: 1920, height: 1080, videoBitrateK: 3500, maxrateK: 4500, bufsizeK: 6750, audioBitrateK: 192 },
];

const HLS_SEGMENT_SECS = 4;
const KEYFRAME_INTERVAL_SECS = 2;
const FFMPEG_PRESET = process.env.TRANSCODER_PRESET ?? "veryfast";
const FFMPEG_CRF = process.env.TRANSCODER_CRF ?? "23";
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
      `-preset:v:${i}`, FFMPEG_PRESET,
      `-crf:v:${i}`, FFMPEG_CRF,
      `-b:v:${i}`, `${r.videoBitrateK}k`,
      `-maxrate:v:${i}`, `${r.maxrateK}k`,
      `-bufsize:v:${i}`, `${r.bufsizeK}k`,
      `-pix_fmt`, "yuv420p",
    );
  });

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
      settle(false);
    }, RESOLUTION_PROBE_TIMEOUT_MS);
    proc.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    proc.on("error", () => { clearTimeout(timer); settle(false); });
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
 */
async function downloadSourceToTempFile(objectKey: string, destPath: string): Promise<void> {
  const { body } = await storage().getObject(objectKey);
  await pipeline(body, createWriteStream(destPath));
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
    await downloadSourceToTempFile(req.sourceObjectKey, sourceTempPath);

    // Run duration, resolution, and audio probes in parallel (all are ffprobe calls).
    const [durationSecs, srcResolution, hasAudio] = await Promise.all([
      probeDurationSecs(sourceTempPath),
      probeResolution(sourceTempPath),
      probeHasAudio(sourceTempPath),
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

    const args = buildFfmpegArgs(sourceTempPath, scratchDir, renditionsToUse, hasAudio);

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

    const [, thumbLocalPath] = await Promise.all([
      hlsPromise,
      generateThumbnail(sourceTempPath, scratchDir),
    ]);

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
    if (process.env.TRANSCODER_KEEP_SCRATCH !== "1") {
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
