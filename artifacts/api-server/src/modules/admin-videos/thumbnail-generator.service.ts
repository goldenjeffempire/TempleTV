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

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { storage } from "../../infrastructure/storage.js";
import { logger } from "../../infrastructure/logger.js";
import { env } from "../../config/env.js";

const vt = schema.videosTable;

const THUMB_TIMEOUT_MS = 45_000;
const THUMB_KEY_PREFIX = "thumbnails/";

function videoThumbnailKey(videoId: string): string {
  return `${THUMB_KEY_PREFIX}${videoId}.jpg`;
}

/** Absolutize a relative localVideoUrl for ffmpeg's -i argument. */
function toInternalVideoUrl(localVideoUrl: string): string {
  if (/^https?:\/\//i.test(localVideoUrl)) return localVideoUrl;
  const port = env.PORT ?? 8080;
  return `http://127.0.0.1:${port}${localVideoUrl.startsWith("/") ? "" : "/"}${localVideoUrl}`;
}

/**
 * Extract a single JPEG frame at `seekSecs` seconds into the video.
 * Returns the raw JPEG Buffer, or null on any failure.
 */
async function extractFrameBuffer(
  sourceUrl: string,
  seekSecs: number,
  scratchDir: string,
): Promise<Buffer | null> {
  const outPath = join(scratchDir, "thumb.jpg");
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-ss", String(Math.max(0, seekSecs)),
      "-i", sourceUrl,
      "-vframes", "1",
      "-q:v", "3",
      "-vf", "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:black,setsar=1",
      outPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    proc.unref();

    let settled = false;
    const settle = (v: Buffer | null) => { if (!settled) { settled = true; resolve(v); } };

    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* noop */ }
      logger.warn({ sourceUrl }, "[thumbnail-gen] ffmpeg timed out");
      settle(null);
    }, THUMB_TIMEOUT_MS);
    timer.unref();

    proc.on("error", (err) => { clearTimeout(timer); logger.warn({ err }, "[thumbnail-gen] spawn error"); settle(null); });
    proc.on("close", async (code) => {
      clearTimeout(timer);
      if (code !== 0) { settle(null); return; }
      try {
        const { readFile } = await import("node:fs/promises");
        const buf = await readFile(outPath);
        settle(buf);
      } catch (err) {
        logger.warn({ err }, "[thumbnail-gen] failed to read thumb file");
        settle(null);
      }
    });
  });
}

/** Probe video duration using ffprobe. Returns seconds, or 60 as a safe fallback. */
async function probeDuration(sourceUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-i", sourceUrl,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    proc.unref();
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("error", () => resolve(60));
    proc.on("close", () => {
      try {
        const parsed = JSON.parse(out) as { format?: { duration?: string } };
        const d = parseFloat(parsed.format?.duration ?? "0");
        resolve(d > 0 ? d : 60);
      } catch {
        resolve(60);
      }
    });
    setTimeout(() => { try { proc.kill(); } catch { /* noop */ } resolve(60); }, 15_000).unref();
  });
}

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
export async function generateThumbnailForVideo(
  videoId: string,
  force = false,
): Promise<ThumbnailResult> {
  const [video] = await db
    .select({
      id: vt.id,
      localVideoUrl: vt.localVideoUrl,
      thumbnailUrl: vt.thumbnailUrl,
      hasCustomThumbnail: vt.hasCustomThumbnail,
      videoSource: vt.videoSource,
      durationSecs: vt.duration,
    })
    .from(vt)
    .where(eq(vt.id, videoId))
    .limit(1);

  if (!video) return { videoId, thumbnailUrl: "", generated: false, error: "Video not found" };
  if (video.hasCustomThumbnail && !force) {
    return { videoId, thumbnailUrl: video.thumbnailUrl ?? "", generated: false, error: "Custom thumbnail set — skipped" };
  }
  if (!force && video.thumbnailUrl && video.thumbnailUrl.length > 0) {
    return { videoId, thumbnailUrl: video.thumbnailUrl, generated: false, error: "Thumbnail exists — skipped" };
  }
  if (video.videoSource === "youtube") {
    return { videoId, thumbnailUrl: video.thumbnailUrl ?? "", generated: false, error: "YouTube video — skipped" };
  }
  if (!video.localVideoUrl) {
    return { videoId, thumbnailUrl: "", generated: false, error: "No local video URL" };
  }

  const sourceUrl = toInternalVideoUrl(video.localVideoUrl);
  const durationSecs = video.durationSecs ? parseFloat(video.durationSecs) : null;

  const scratchDir = join(tmpdir(), `thumb-${videoId}-${Date.now()}`);
  await mkdir(scratchDir, { recursive: true });

  try {
    // Use ~30% into the video as the thumbnail frame — usually past any titles or
    // colour-bars and deep enough into the content to be representative.
    const probedDuration = durationSecs && durationSecs > 0 ? durationSecs : await probeDuration(sourceUrl);
    const seekSecs = Math.max(1, Math.floor(probedDuration * 0.3));

    const thumbBuf = await extractFrameBuffer(sourceUrl, seekSecs, scratchDir);
    if (!thumbBuf) {
      // Fallback: try t=1s
      const fallback = await extractFrameBuffer(sourceUrl, 1, scratchDir);
      if (!fallback) return { videoId, thumbnailUrl: "", generated: false, error: "ffmpeg frame extraction failed" };
    }

    const finalBuf = thumbBuf ?? (await extractFrameBuffer(sourceUrl, 1, scratchDir))!;
    const key = videoThumbnailKey(videoId);
    await (storage()).putObject({ key, body: finalBuf, contentType: "image/jpeg" });

    // Build the public thumbnail URL using the same /api/v1/uploads/<key> pattern.
    const apiOrigin = env.API_ORIGIN ?? "";
    const thumbnailUrl = `${apiOrigin}/api/v1/uploads/${key}`;

    await db
      .update(vt)
      .set({ thumbnailUrl })
      .where(eq(vt.id, videoId));

    logger.info({ videoId, key, seekSecs }, "[thumbnail-gen] thumbnail generated successfully");
    return { videoId, thumbnailUrl, generated: true };
  } catch (err: unknown) {
    logger.warn({ err, videoId }, "[thumbnail-gen] thumbnail generation failed");
    return { videoId, thumbnailUrl: "", generated: false, error: String(err) };
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Background sweep: generate thumbnails for all eligible local videos that
 * have no thumbnail yet. Processes up to `batchSize` videos per run to avoid
 * OOM under concurrent HLS transcoding jobs.
 */
export async function autoGenerateMissingThumbnails(batchSize = 5): Promise<{ processed: number; generated: number }> {
  const candidates = await db
    .select({ id: vt.id })
    .from(vt)
    .where(
      and(
        eq(vt.videoSource, "local"),
        eq(vt.hasCustomThumbnail, false),
        isNotNull(vt.localVideoUrl),
        or(isNull(vt.thumbnailUrl), eq(vt.thumbnailUrl, "")),
      ),
    )
    .limit(batchSize);

  if (candidates.length === 0) return { processed: 0, generated: 0 };

  let generated = 0;
  for (const { id } of candidates) {
    const result = await generateThumbnailForVideo(id, false);
    if (result.generated) generated++;
  }
  return { processed: candidates.length, generated };
}
