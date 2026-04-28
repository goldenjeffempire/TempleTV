import express from "express";
import { logger } from "./logger";
import { registerCacheStats } from "./cacheStats";

/**
 * Per-client concurrency + range-size guard for `/api/uploads/*`.
 *
 * Why this exists
 * ───────────────
 * A single buggy / aggressive HTML5 video player can open dozens of parallel
 * HTTP Range requests against the same source MP4 (initial probe, seek scrubs,
 * adaptive-bitrate "ladder" peeks, retried connections after a CDN drop, …).
 * Before the S3-redirect change in `staticWithS3Fallback.ts`, those parallel
 * requests caused the API process to OOM-kill on Render's small instances
 * because every concurrent request held its own multi-MB stream buffer.
 *
 * Now that `/api/uploads/*` 302-redirects to S3 for any file mirrored to the
 * bucket, those requests should resolve in milliseconds without the API
 * touching any video bytes — but this guard remains as defence-in-depth for:
 *
 *   - The brief disk fast-path window after a fresh upload, before the file
 *     mirrors to S3 (express.static streams from local disk).
 *   - The fall-through case where the S3 presigner momentarily fails and the
 *     middleware falls back to streaming.
 *   - A pathological client (or DDoS) hammering the redirect endpoint itself.
 *
 * Behaviour
 * ─────────
 *   - Caps simultaneous in-flight requests per (clientIP, file) tuple at
 *     `UPLOAD_RANGE_MAX_CONCURRENT` (default 4). Excess → HTTP 429 +
 *     Retry-After.
 *   - Caps the byte length of any single Range request at
 *     `UPLOAD_RANGE_MAX_BYTES` (default 16 MiB). Wider ranges are rewritten
 *     in place so the downstream layers honour the cap; the client receives
 *     a partial response and naturally re-issues the next chunk.
 *
 * Both limits are env-tunable so an operator can loosen them without a
 * redeploy if a legitimate workload needs more headroom.
 */

// Default raised from 4 → 8 after production traffic showed legitimate
// HLS/MP4 players (notably mobile WebView and some smart-TV browsers) routinely
// open 6–8 parallel range requests for the same source — initial probe + first
// few seek-ahead chunks + a retry triggered by a slow-to-respond fallback
// path was tipping over the previous cap and 429-ing real viewers. Eight is
// the comfortable headroom value: still bounded enough to defend the disk
// fast-path against a buggy client or DDoS, but high enough that a single
// real human watching one video never sees a 429. Operators can still tune
// via the env var without a redeploy.
const MAX_CONCURRENT_PER_KEY = Math.max(
  1,
  Number(process.env.UPLOAD_RANGE_MAX_CONCURRENT ?? "8"),
);
const MAX_RANGE_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.UPLOAD_RANGE_MAX_BYTES ?? String(16 * 1024 * 1024)),
);

// Per-(client, file) in-flight counter. Capped at MAX_INFLIGHT_KEYS so a
// distinct-IP scanner cannot grow this map without bound; entries are
// also released by the res.on("finish"/"close") handlers below, so the
// map normally hovers at the few hundred entries actually in flight.
// When the cap is reached we evict the oldest entry by insertion order
// (FIFO), matching the BoundedTtlMap policy used elsewhere.
const MAX_INFLIGHT_KEYS = 8192;
const inflight = new Map<string, number>();
registerCacheStats("uploadRangeGuard.inflight", () => inflight.size);

function recordInflight(key: string, value: number): void {
  // Keep MRU semantics so released slots get freed in roughly FIFO order
  // when the cap is hit.
  if (inflight.has(key)) inflight.delete(key);
  inflight.set(key, value);
  while (inflight.size > MAX_INFLIGHT_KEYS) {
    const oldest = inflight.keys().next();
    if (oldest.done) break;
    inflight.delete(oldest.value);
  }
}

function clientKey(req: express.Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const ip =
    (typeof fwd === "string" ? fwd.split(",")[0]?.trim() : undefined) ||
    req.ip ||
    req.socket.remoteAddress ||
    "unknown";
  return `${ip}::${req.path}`;
}

interface ParsedRange {
  start: number;
  end: number | null;
}

function parseRange(header: string | undefined): ParsedRange | null {
  if (!header || !header.startsWith("bytes=")) return null;
  const spec = header.slice("bytes=".length).split(",")[0]?.trim();
  if (!spec) return null;
  const [s, e] = spec.split("-");
  const start = s === "" ? NaN : Number(s);
  const end = e === undefined || e === "" ? null : Number(e);
  if (!Number.isFinite(start) || start < 0) return null;
  if (end !== null && (!Number.isFinite(end) || end < start)) return null;
  return { start, end };
}

export function uploadRangeGuard(): express.RequestHandler {
  return function rangeGuard(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    // ── Cap range size ─────────────────────────────────────────────────────
    const range = parseRange(req.headers.range);
    if (range) {
      const requestedLen =
        range.end !== null ? range.end - range.start + 1 : Infinity;
      if (requestedLen > MAX_RANGE_BYTES) {
        const cappedEnd = range.start + MAX_RANGE_BYTES - 1;
        req.headers.range = `bytes=${range.start}-${cappedEnd}`;
      }
    }

    // ── Cap per-(client, file) concurrency ────────────────────────────────
    const key = clientKey(req);
    const current = inflight.get(key) ?? 0;
    if (current >= MAX_CONCURRENT_PER_KEY) {
      logger.warn(
        { key, current, limit: MAX_CONCURRENT_PER_KEY },
        "uploadRangeGuard: rejecting request — concurrency limit reached",
      );
      res.setHeader("Retry-After", "1");
      res.status(429).json({
        error: "too_many_concurrent_requests",
        message: `At most ${MAX_CONCURRENT_PER_KEY} simultaneous range requests are allowed for the same file from the same client.`,
      });
      return;
    }
    recordInflight(key, current + 1);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const c = inflight.get(key) ?? 0;
      if (c <= 1) inflight.delete(key);
      else inflight.set(key, c - 1);
    };
    res.on("finish", release);
    res.on("close", release);

    return next();
  };
}
