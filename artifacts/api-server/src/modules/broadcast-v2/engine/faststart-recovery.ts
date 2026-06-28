import { logger } from "../../../infrastructure/logger.js";

export const faststartRecoveryWorker = {
  async runSweep(): Promise<void> {
    logger.debug("[faststart-recovery] disabled — MP4-only pipeline active");
  },
  clearGivenUp(_videoId?: string): void {},
  /**
   * No-op: faststart retry-attempt counters are only relevant for the HLS
   * transcoding pipeline which is disabled on this deployment (MP4-only).
   * Called by the /reload route to reset any per-video backoff state before
   * triggering a queue reload — safe to no-op here.
   */
  resetAttempts(): void {},
  /**
   * No-op alias for runSweep kept for call-site compatibility.
   * The /reload route calls sweep() to trigger an immediate recovery pass
   * before reloading the queue. On the MP4-only pipeline there is nothing
   * to sweep, so this is a resolved Promise no-op.
   */
  async sweep(): Promise<void> {},
};
