import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger";

const DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();

/**
 * Paths that legitimately stream for a long time (SSE, large media uploads,
 * HLS chunk delivery, video file streaming) and must NOT have a wall-clock
 * timeout applied. Match against `req.originalUrl` minus query string.
 */
const SKIP_PATTERNS: RegExp[] = [
  /^\/api\/uploads(\/|$)/,           // S3-redirect-first / disk-fallback large media
  /^\/api\/hls(\/|$)/,               // HLS .m3u8 + .ts segments
  /\/events(\?|$)/,                  // SSE endpoints (always end in /events)
  /^\/api\/admin\/videos\/upload/,   // chunked uploads + S3 multipart sign/complete
  /^\/api\/healthz/,                 // already fast; bypass to keep it deterministic
  /^\/api\/metrics/,                 // prom scrape endpoint
];

function shouldSkip(req: Request): boolean {
  const path = (req.originalUrl || req.url || "/").split("?")[0];
  for (const re of SKIP_PATTERNS) {
    if (re.test(path)) return true;
  }
  // Belt-and-braces: any client explicitly negotiating SSE.
  const accept = req.headers.accept;
  if (typeof accept === "string" && accept.includes("text/event-stream")) {
    return true;
  }
  return false;
}

/**
 * Wall-clock per-request timeout safety net.
 *
 * Express has no built-in per-route timeout. A handler that hangs (slow DB
 * query, unbounded external HTTP fetch, deadlock in the transcoder queue)
 * will hold the connection open indefinitely — eventually exhausting the
 * Node.js HTTP server's max-sockets pool and bringing the whole API down.
 *
 * This middleware fires `REQUEST_TIMEOUT_MS` (default 30s) after the request
 * is received. If the handler hasn't started writing a response by then, we:
 *   1. Log a warning with method + path so it surfaces in observability.
 *   2. Send 504 Gateway Timeout with a structured error body.
 *
 * If the handler DOES start writing later, it gets ERR_HTTP_HEADERS_SENT —
 * which is the correct signal that the client gave up. We deliberately do
 * NOT abort the underlying socket here, because that can leave open DB
 * transactions and dangling FFmpeg children. The handler is expected to
 * notice via `res.writableEnded` or its own AbortSignal wiring on the next
 * I/O attempt.
 *
 * Streaming endpoints (SSE, uploads, HLS, large media) are skipped.
 */
export function requestTimeout(timeoutMs: number = DEFAULT_TIMEOUT_MS) {
  return function requestTimeoutMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (shouldSkip(req)) {
      next();
      return;
    }

    const timer = setTimeout(() => {
      if (res.headersSent || res.writableEnded) return;
      const path = (req.originalUrl || req.url || "/").split("?")[0];
      logger.warn(
        {
          method: req.method,
          path,
          requestId: (req as Request & { id?: string }).id,
          timeoutMs,
        },
        "request_timeout",
      );
      try {
        res.status(504).json({
          error: "gateway_timeout",
          message: `Request exceeded ${timeoutMs}ms server timeout.`,
        });
      } catch {
        // If we can't even send the timeout response (very late race with
        // the handler also writing), there's nothing more we can do — let
        // the error handler chain take it from here.
      }
    }, timeoutMs);
    // Don't keep the event loop alive for the timer alone (graceful drain
    // would otherwise wait the full timeout window for in-flight requests
    // that have already finished).
    timer.unref?.();

    const clear = () => clearTimeout(timer);
    res.on("finish", clear);
    res.on("close", clear);

    next();
  };
}
