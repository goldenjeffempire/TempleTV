import { logger } from "../../../infrastructure/logger.js";

export async function runHlsStartupIntegrityScan(): Promise<void> {
  logger.info("[hls-startup-integrity] scan disabled — MP4-only pipeline active");
}
