import { logger } from "../../../infrastructure/logger.js";

export async function getStitchedBroadcastManifest(): Promise<string | null> {
  logger.debug("[hls-stitcher] disabled — MP4-only pipeline active");
  return null;
}

export function invalidateStitchCache(): void {}
