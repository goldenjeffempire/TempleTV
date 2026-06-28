import { logger } from "../../infrastructure/logger.js";

const DISABLED_HEARTBEAT = {
  ffmpegAvailable: false,
  stopped: true,
  isRunning: false,
  circuitOpen: false,
  circuitOpenRemainingMs: null as number | null,
  currentJobId: null as string | null,
  currentJobVideoId: null as string | null,
  lastHeartbeatAt: null as number | null,
  lastCompletedAt: null as number | null,
  lastCompletedJobId: null as string | null,
  lastCompletedStatus: null as "done" | "failed" | null,
  storageCircuitOpenUntil: 0,
  storageErrorStreak: 0,
};

export const transcoderDispatcher = {
  start() {
    logger.info("[transcoder] dispatcher disabled — MP4-only pipeline active");
  },
  stop() {},
  nudge() {},
  getHeartbeat() {
    return DISABLED_HEARTBEAT;
  },
};
