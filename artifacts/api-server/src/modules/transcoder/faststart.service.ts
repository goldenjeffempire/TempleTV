import { logger } from "../../infrastructure/logger.js";

export interface FaststartResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  durationMs?: number;
  objectKey?: string;
}

export interface FaststartOptions {
  skipStatusUpdate?: boolean;
  force?: boolean;
}

export async function runFaststart(
  _videoId: string,
  _objectKey: string,
  _opts?: FaststartOptions,
): Promise<FaststartResult> {
  logger.info("[faststart] disabled — MP4-only pipeline active");
  return { ok: true, skipped: true, reason: "faststart disabled in MP4-only pipeline" };
}

export function cancelAllFaststartJobs(): void {}
