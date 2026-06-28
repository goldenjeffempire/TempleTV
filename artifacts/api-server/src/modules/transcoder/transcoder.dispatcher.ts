import { logger } from "../../infrastructure/logger.js";

const DISABLED_HEARTBEAT = {
  ffmpegAvailable: false,
  stopped: true,
  isRunning: false,
  circuitOpen: false,
  circuitOpenRemainingMs: 0,
  currentJobId: null as string | null,
  currentJobVideoId: null as string | null,
  lastHeartbeatAt: null as number | null,
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
