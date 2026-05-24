/**
 * Thin wrapper around @sentry/node that degrades gracefully when SENTRY_DSN
 * is unset, the package is absent, or the SDK has not been initialized.
 *
 * Always uses dynamic imports so this file is safe to import anywhere —
 * including modules that load before instrument.mjs has run.
 *
 * Usage:
 *   import { captureEvent, captureException } from "../infrastructure/sentry.js";
 *   void captureEvent("Something bad happened", "error", { context: "value" });
 */

export type SentryLevel = "debug" | "info" | "warning" | "error" | "fatal";

export async function captureEvent(
  message: string,
  level: SentryLevel = "error",
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    const S = await import("@sentry/node");
    S.captureEvent({ message, level, extra });
  } catch {
    // non-fatal — Sentry unavailable or DSN unset
  }
}

export async function captureException(
  err: unknown,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    const S = await import("@sentry/node");
    S.captureException(err, extra ? { extra } : undefined);
  } catch {
    // non-fatal
  }
}
