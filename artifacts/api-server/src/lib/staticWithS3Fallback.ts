import express from "express";
import { promises as fs, createReadStream } from "fs";
import path from "path";
import {
  isS3Configured,
  headObject,
  getObjectStream,
} from "./s3Storage";
import { sendRangedGet } from "./s3Ranged";
import { logger } from "./logger";

/**
 * Static-asset middleware with automatic S3 fallback.
 *
 * Why this exists
 * ───────────────
 * Render's container filesystem is ephemeral — every deploy or restart wipes
 * `uploads/` and `uploads/hls/`. The transcoder writes HLS variants to local
 * disk and only "best-effort" copies them to S3, so after any restart all
 * previously-transcoded videos break: the DB still points at /api/hls/<id>/...
 * but the local files are gone, and `express.static` 404s.
 *
 * This middleware preserves the fast path (local disk) for hot data and
 * transparently falls through to S3 for anything that isn't on disk.  Range
 * requests are honoured end-to-end so the browser's `<video>` seek bar keeps
 * working even when the bytes are flowing from S3.
 *
 * Usage
 * ─────
 *   app.use(
 *     "/api/hls",
 *     setHlsHeaders,
 *     express.static(localHlsDir, { fallthrough: true, acceptRanges: true }),
 *     s3FallbackMiddleware({ s3Prefix: "hls/", localDir: localHlsDir }),
 *   );
 *
 * `express.static` calls `next()` (instead of sending the response) when the
 * file is missing because we set `fallthrough: true`. The S3 middleware then
 * receives the request and streams the object from the bucket.
 */

interface FallbackOptions {
  /** S3 key prefix that mirrors this URL mount (e.g. `"hls/"`, `"videos/"`). */
  s3Prefix: string;
  /**
   * Optional local directory. When provided we double-check on disk before
   * hitting S3 — this guards against `express.static` being skipped when a
   * caller mounts the middleware standalone without a static layer in front.
   */
  localDir?: string;
}

function pickContentType(urlPath: string, fromS3: string | null): string {
  if (fromS3) return fromS3;
  const ext = path.extname(urlPath).toLowerCase();
  switch (ext) {
    case ".m3u8":
      return "application/vnd.apple.mpegurl";
    case ".ts":
      return "video/mp2t";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

function parseRangeHeader(
  rangeHeader: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) return null;
  const spec = rangeHeader.slice("bytes=".length).split(",")[0].trim();
  const [startStr, endStr] = spec.split("-");
  const startNum = startStr === "" ? NaN : Number(startStr);
  const endNum = endStr === "" ? NaN : Number(endStr);

  if (Number.isFinite(startNum) && Number.isFinite(endNum)) {
    return { start: startNum, end: Math.min(endNum, size - 1) };
  }
  if (Number.isFinite(startNum)) {
    return { start: startNum, end: size - 1 };
  }
  if (Number.isFinite(endNum)) {
    // Suffix range: last N bytes.
    return { start: Math.max(0, size - endNum), end: size - 1 };
  }
  return null;
}

export function s3FallbackMiddleware(opts: FallbackOptions): express.RequestHandler {
  const { s3Prefix, localDir } = opts;

  return async function s3Fallback(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return next();
    }

    // Defence-in-depth: if a static layer was somehow skipped and the file
    // *is* on disk, prefer the disk copy (it's an order of magnitude faster
    // than a round-trip to S3).
    if (localDir) {
      const safePath = decodeURIComponent(req.path).replace(/^\/+/, "");
      // Block any traversal attempt; express normalises but be explicit.
      if (safePath.includes("..")) {
        return next();
      }
      const onDisk = path.join(localDir, safePath);
      try {
        const stat = await fs.stat(onDisk);
        if (stat.isFile()) {
          // Hand it back to the static layer style: we stream it ourselves
          // with proper range support.
          return streamLocal(req, res, onDisk, stat.size);
        }
      } catch {
        // Not on disk — proceed to S3 fallback below.
      }
    }

    if (!isS3Configured()) {
      return next(); // Let the 404 handler take it.
    }

    // Build the S3 key. Trim leading slash so prefix concatenation works:
    // req.path === "/abc/master.m3u8" → key === "hls/abc/master.m3u8".
    const relPath = decodeURIComponent(req.path).replace(/^\/+/, "");
    if (!relPath || relPath.includes("..")) return next();

    const key = `${s3Prefix}${relPath}`;

    let head;
    try {
      head = await headObject(key);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), key },
        "S3 fallback: HEAD failed",
      );
      return next(err);
    }
    if (!head) {
      return next(); // 404 — neither local nor S3 has it.
    }

    const totalSize = head.contentLength ?? 0;
    const contentType = pickContentType(req.path, head.contentType);
    const etag = head.etag ?? undefined;
    const lastModified = head.lastModified ?? undefined;
    const cacheControl =
      head.cacheControl ??
      (req.path.endsWith(".m3u8")
        ? "public, max-age=30"
        : req.path.endsWith(".ts")
          ? "public, max-age=3600, immutable"
          : "public, max-age=3600");

    // Conditional GET — let CDNs / browsers reuse cached bytes when possible.
    const ifNoneMatch = req.headers["if-none-match"];
    if (etag && typeof ifNoneMatch === "string" && ifNoneMatch === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", cacheControl);
    res.setHeader("Accept-Ranges", "bytes");
    if (etag) res.setHeader("ETag", etag);
    if (lastModified) res.setHeader("Last-Modified", lastModified.toUTCString());
    res.setHeader("X-Storage-Source", "s3");

    if (req.method === "HEAD") {
      if (totalSize > 0) res.setHeader("Content-Length", String(totalSize));
      res.status(200).end();
      return;
    }

    const range = totalSize > 0 ? parseRangeHeader(req.headers.range, totalSize) : null;

    if (range) {
      const { start, end } = range;
      if (start < 0 || end < start || start >= totalSize) {
        res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).end();
        return;
      }

      // Re-issue a ranged GET against the same bucket. The high-level
      // `getObjectStream` doesn't accept a Range parameter, so we use the
      // dedicated helper that mirrors the SDK plumbing.
      try {
        const result = await sendRangedGet(key, `bytes=${start}-${end}`);
        if (!result) {
          return next();
        }
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
        res.setHeader("Content-Length", String(end - start + 1));
        result.body.on("error", (err) => {
          logger.warn({ err: err.message, key }, "S3 fallback: range stream errored");
          res.destroy(err);
        });
        result.body.pipe(res);
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), key, start, end },
          "S3 fallback: ranged GET failed",
        );
        return next(err);
      }
      return;
    }

    // Whole-object GET — stream the body unchanged.
    const obj = await getObjectStream(key);
    if (!obj) return next();
    if (totalSize > 0) res.setHeader("Content-Length", String(totalSize));
    res.status(200);
    obj.body.on("error", (err) => {
      logger.warn({ err: err.message, key }, "S3 fallback: full stream errored");
      res.destroy(err);
    });
    obj.body.pipe(res);
  };
}

/**
 * Local-disk streaming with HTTP Range support. Mirrors what `express.static`
 * does but lives in the same module so the fast path stays inline.
 */
function streamLocal(
  req: express.Request,
  res: express.Response,
  filePath: string,
  size: number,
): void {
  const contentType = pickContentType(req.path, null);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("X-Storage-Source", "disk");

  const range = parseRangeHeader(req.headers.range, size);
  if (range) {
    const { start, end } = range;
    if (start < 0 || end < start || start >= size) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
      return;
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    if (req.method === "HEAD") return void res.end();
    const stream = createReadStream(filePath, { start, end });
    stream.on("error", (err) => res.destroy(err));
    stream.pipe(res);
    return;
  }

  res.setHeader("Content-Length", String(size));
  if (req.method === "HEAD") return void res.end();
  const stream = createReadStream(filePath);
  stream.on("error", (err) => res.destroy(err));
  stream.pipe(res);
}
