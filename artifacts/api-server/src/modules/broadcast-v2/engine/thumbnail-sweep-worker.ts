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
 *
 * Uses workerSupervisor for circuit-breaker, deadman-switch, and Prometheus
 * metrics. A hung ffprobe call no longer freezes the worker permanently —
 * the supervisor's deadman fires after 2× the interval and marks a failure.
 */

import { autoGenerateMissingThumbnails } from "../../admin-videos/thumbnail-generator.service.js";
import { workerSupervisor } from "./worker-supervisor.js";
import { logger } from "../../../infrastructure/logger.js";

const WORKER_NAME    = "thumbnail-sweep";
const INTERVAL_MS    = Number(process.env["THUMBNAIL_SWEEP_INTERVAL_MS"] ?? 10 * 60_000);
const INITIAL_DELAY  = 2 * 60_000; // 2 min boot delay so HLS jobs start first

async function runSweep(): Promise<void> {
  const result = await autoGenerateMissingThumbnails(5);
  if (result.processed > 0) {
    logger.info(result, "[thumbnail-sweep] sweep complete");
  }
}

export function startThumbnailSweepWorker(): void {
  workerSupervisor.spawn({
    name:           WORKER_NAME,
    fn:             runSweep,
    intervalMs:     INTERVAL_MS,
    initialDelayMs: INITIAL_DELAY,
    backoffMs:      [30_000, 60_000, 5 * 60_000],
  });
  logger.info({ intervalMs: INTERVAL_MS }, "[thumbnail-sweep] worker registered with supervisor");
}

export function stopThumbnailSweepWorker(): void {
  workerSupervisor.remove(WORKER_NAME);
}
