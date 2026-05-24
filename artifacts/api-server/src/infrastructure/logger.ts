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
      "*.oldPassword",
      "*.newPassword",
      "*.confirmPassword",
      "*.currentPassword",
      "*.refreshToken",
      "*.accessToken",
      "*.token",
      "*.secret",
      "*.apiKey",
      "*.api_key",
      "*.totpSecret",
      "*.totp_secret",
      "*.backupCodes",
      "*.backup_codes",
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
