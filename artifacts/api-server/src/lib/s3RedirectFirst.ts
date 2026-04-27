import express from "express";
import { isS3Configured, headObject, getSignedGetUrl } from "./s3Storage";
import { logger } from "./logger";

/**
 * "S3-redirect-first" middleware for large media (full-length MP4s/audio).
 *
 * Why this exists
 * ───────────────
 * `s3FallbackMiddleware` only kicks in when `express.static` falls through
 * (i.e. the file is NOT on local disk). That worked great after a redeploy
 * when Render's ephemeral filesystem had been wiped — every request fell
 * through to the S3 redirect path. But during the steady-state window
 * BEFORE a redeploy, the source MP4 still sits on local disk, so
 * `express.static` happily streams hundreds of megabytes through the API
 * process for every viewer. Under parallel HTTP Range traffic this either
 *   (a) saturates the per-(client,file) concurrency cap and 429s legit
 *       viewers (observed in production logs), or
 *   (b) OOM-kills the container on small Render instances.
 *
 * For large immutable media we want the S3 redirect to happen REGARDLESS of
 * whether the file is also on local disk. The local copy is only useful for
 * the brief few-seconds window after a fresh upload before it mirrors to
 * S3 — and that's exactly the case this middleware skips (no S3 head → fall
 * through to express.static, which serves from disk).
 *
 * Behaviour
 * ─────────
 *   - GET/HEAD only; everything else falls through.
 *   - Restricted to media extensions configured by the caller — small
 *     assets (thumbnails, json, etc.) keep the cheap disk fast-path.
 *   - HEAD results are cached in-memory with a TTL so a popular video
 *     doesn't hit S3 on every viewer (the URL is also CDN-cacheable on
 *     the redirect itself, so the API process is touched even less).
 *   - On any S3 error we fall through silently — disk path or the
 *     existing s3FallbackMiddleware will handle the request.
 */

interface S3RedirectFirstOptions {
  /** S3 key prefix that mirrors this URL mount (e.g. `"videos/"`). */
  s3Prefix: string;
  /** Lifetime of the minted presigned URL, in seconds. */
  signedUrlTtlSec: number;
  /** Lowercase file extensions (with leading dot) eligible for redirect. */
  extensions: ReadonlyArray<string>;
  /** TTL for the in-memory S3 HEAD existence cache, in milliseconds. */
  headCacheTtlMs?: number;
}

interface HeadCacheEntry {
  exists: boolean;
  expiresAt: number;
}

interface HeadErrorEntry {
  expiresAt: number;
  loggedAt: number;
}

export function s3RedirectFirstForLargeMedia(
  opts: S3RedirectFirstOptions,
): express.RequestHandler {
  const {
    s3Prefix,
    signedUrlTtlSec,
    extensions,
    headCacheTtlMs = 5 * 60 * 1000,
  } = opts;
  const extSet = new Set(extensions.map((e) => e.toLowerCase()));
  const headCache = new Map<string, HeadCacheEntry>();
  // Negative cache for transient HEAD errors (auth blip, AWS 5xx, network):
  // without this the middleware re-issues a HEAD on EVERY viewer request,
  // re-throws, and floods the log with one warn line per request — observed
  // in production at multiple lines/sec for a single hot key. We cache the
  // failure for a short window so the disk fallback runs immediately, and
  // we log AT MOST one warn per key per error window.
  const HEAD_ERROR_TTL_MS = 60 * 1000;
  const HEAD_ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;
  const headErrors = new Map<string, HeadErrorEntry>();

  return async function s3RedirectFirst(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (!isS3Configured()) return next();

    const lowerPath = req.path.toLowerCase();
    const dotIdx = lowerPath.lastIndexOf(".");
    if (dotIdx < 0) return next();
    const ext = lowerPath.slice(dotIdx);
    if (!extSet.has(ext)) return next();

    const relPath = decodeURIComponent(req.path).replace(/^\/+/, "");
    if (!relPath || relPath.includes("..")) return next();

    const key = `${s3Prefix}${relPath}`;

    // ── HEAD existence check, with a short in-memory TTL cache ─────────────
    const now = Date.now();

    // Skip S3 entirely if we're inside the negative-cache window for this
    // key — the disk fallback or s3FallbackMiddleware will handle the
    // request, and we avoid the HEAD round-trip (which on a sustained AWS
    // outage was adding 1–2s to every single video request).
    const errEntry = headErrors.get(key);
    if (errEntry && errEntry.expiresAt > now) {
      return next();
    } else if (errEntry) {
      headErrors.delete(key);
    }

    let cached = headCache.get(key);
    if (cached && cached.expiresAt < now) {
      headCache.delete(key);
      cached = undefined;
    }

    let exists: boolean;
    if (cached) {
      exists = cached.exists;
    } else {
      try {
        const head = await headObject(key);
        exists = head !== null;
        headCache.set(key, { exists, expiresAt: now + headCacheTtlMs });
      } catch (err) {
        const prev = errEntry;
        const shouldLog =
          !prev || now - prev.loggedAt >= HEAD_ERROR_LOG_INTERVAL_MS;
        headErrors.set(key, {
          expiresAt: now + HEAD_ERROR_TTL_MS,
          loggedAt: shouldLog ? now : (prev?.loggedAt ?? now),
        });
        if (shouldLog) {
          logger.warn(
            {
              err: err instanceof Error ? err.message : String(err),
              key,
              suppressedForMs: HEAD_ERROR_LOG_INTERVAL_MS,
            },
            "s3RedirectFirst: HEAD failed — falling through to disk path (further log lines for this key suppressed)",
          );
        }
        return next();
      }
    }

    if (!exists) {
      // Not yet mirrored to S3 — let express.static serve the disk copy
      // (the post-upload mirror window) and fall through to the existing
      // s3FallbackMiddleware otherwise.
      return next();
    }

    // ── Mint the presigned URL and 302 ──────────────────────────────────────
    try {
      const signedUrl = await getSignedGetUrl(key, signedUrlTtlSec);
      // Cache the redirect for less than the signed URL lifetime so a stale
      // cached redirect can never outlive its underlying signature. `public`
      // (not `private`) is intentional: it lets a CDN edge cache the redirect
      // lookup itself so subsequent viewers of the same asset never round-
      // trip the API process at all.
      const maxAge = Math.max(60, Math.floor(signedUrlTtlSec / 2));
      res.setHeader("Cache-Control", `public, max-age=${maxAge}`);
      res.setHeader("X-Storage-Source", "s3-redirect-first");
      res.redirect(302, signedUrl);
      return;
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), key },
        "s3RedirectFirst: presign failed — falling through",
      );
      return next();
    }
  };
}
