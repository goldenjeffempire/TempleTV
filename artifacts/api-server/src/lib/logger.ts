import pino from "pino";
import { extractFatalEntry, getFatalAppender } from "./fatalLogBuffer";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});

// ── Fatal capture wrap ───────────────────────────────────────────────────────
// Every `logger.fatal(...)` call ALSO pushes a sanitized {ts, role, pid, msg,
// err, stack} entry into a per-role circular buffer in the distributed cache,
// so the admin Mission Control "Render deploy health" panel can show the most
// recent worker fatal lines without anyone having to open the Render dashboard.
//
// The wrap calls the original fatal() FIRST so that even if cache writes hang
// or fail, the operator's stdout/Sentry stream still receives the line. The
// appender is best-effort (never throws — see fatalLogBuffer.ts).
//
// Why we don't use a pino transport: transports run in a worker thread with
// their own module graph, which would force fatalLogBuffer + cache + db to
// boot a second time per process. A simple method wrap stays in-process and
// shares the cache singleton with the rest of the app.
const _origFatal = logger.fatal.bind(logger);
(logger as unknown as { fatal: (...args: unknown[]) => void }).fatal = (
  ...args: unknown[]
) => {
  // Forward to pino first so the original log line never gets lost if the
  // appender path throws/hangs.
  (_origFatal as (...a: unknown[]) => void)(...args);
  const append = getFatalAppender();
  if (!append) return; // appender not yet installed (very early boot)
  try {
    append(extractFatalEntry(args));
  } catch {
    // swallow — logging must never crash the process
  }
};
