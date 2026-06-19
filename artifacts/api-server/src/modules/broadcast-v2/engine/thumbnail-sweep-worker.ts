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
 */

import { autoGenerateMissingThumbnails } from "../../admin-videos/thumbnail-generator.service.js";
import { logger } from "../../../infrastructure/logger.js";

const SWEEP_INTERVAL_MS = Number(process.env["THUMBNAIL_SWEEP_INTERVAL_MS"] ?? 10 * 60 * 1000);

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function runSweep() {
  if (running) return;
  running = true;
  try {
    const result = await autoGenerateMissingThumbnails(5);
    if (result.processed > 0) {
      logger.info(result, "[thumbnail-sweep] sweep complete");
    }
  } catch (err) {
    logger.warn({ err }, "[thumbnail-sweep] sweep error (non-fatal)");
  } finally {
    running = false;
  }
}

export function startThumbnailSweepWorker() {
  if (timer) return;
  const tick = () => {
    void runSweep();
    timer = setTimeout(tick, SWEEP_INTERVAL_MS);
    timer.unref();
  };
  // First run after 2 minutes so it doesn't race with HLS jobs on boot.
  timer = setTimeout(tick, 2 * 60 * 1000);
  timer.unref();
  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, "[thumbnail-sweep] worker started");
}

export function stopThumbnailSweepWorker() {
  if (timer) { clearTimeout(timer); timer = null; }
}
