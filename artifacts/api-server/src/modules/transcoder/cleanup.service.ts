import { logger } from "../../infrastructure/logger.js";

export const cleanupWorker = {
  start() {
    logger.info("[cleanup] post-transcode source cleanup disabled — MP4-only pipeline active");
  },
  stop() {},
};

export async function scheduleSourceCleanup(_videoId: string): Promise<void> {}
export async function runCleanupSweep(): Promise<{ cleaned: number; failed: number; skipped: number }> {
  return { cleaned: 0, failed: 0, skipped: 0 };
}
