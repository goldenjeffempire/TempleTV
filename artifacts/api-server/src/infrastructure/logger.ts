import pino from "pino";
import { env, isProd } from "../config/env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "api", env: env.NODE_ENV },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.refreshToken",
      "*.accessToken",
    ],
    censor: "[REDACTED]",
  },
  transport: !isProd()
    ? {
        target: "pino-pretty",
        options: { colorize: true, singleLine: false, translateTime: "HH:MM:ss.l" },
      }
    : undefined,
});

export type Logger = typeof logger;
