import { logger } from "../../../infrastructure/logger.js";

export const faststartRecoveryWorker = {
  async runSweep(): Promise<void> {
    logger.debug("[faststart-recovery] disabled — MP4-only pipeline active");
  },
  clearGivenUp(_videoId?: string): void {},
};
