import { logger } from "../../../infrastructure/logger.js";

export const storageReconciliationWorker = {
  async run(): Promise<void> {
    logger.info("[storage-reconciliation] disabled — MP4-only pipeline active");
  },
};
