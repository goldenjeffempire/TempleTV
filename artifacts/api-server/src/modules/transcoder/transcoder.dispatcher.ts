import { logger } from "../../infrastructure/logger.js";

export const transcoderDispatcher = {
  start() {
    logger.info("[transcoder] dispatcher disabled — MP4-only pipeline active");
  },
  stop() {},
};
