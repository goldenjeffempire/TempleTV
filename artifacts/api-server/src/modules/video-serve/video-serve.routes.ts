import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { makeHlsToken } from "../../shared/hls-token.js";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { storage } from "../../infrastructure/storage.js";
import { env } from "../../config/env.js";
import { logger } from "../../infrastructure/logger.js";
import { registerNamedStore } from "../../infrastructure/cache.js";

/**
 * Video-serve gateway — restores the three URL patterns that the old
 * production API served from disk / direct S3 access and that are now
 * referenced as absolute `https://api.templetv.org.ng/api/…` URLs in the
 * database.
 *
 * Routes (each registered under both /api and /api/v1 by the dual-prefix
 * registration in app.ts):
 *
 *   GET /uploads/:filename
 *     302 → signed S3 download URL for key uploads/{filename}
 *
 *   GET /videos/:id/source
 *     DB lookup → 302 to best available playback URL.
 *     Never creates a redirect loop.
 *
 *   GET /hls/:videoId/*
 *     Authenticated S3 proxy for the HLS tree stored at
 *     transcoded/{videoId}/…  (master.m3u8, v0/seg_00001.ts …).
 *     Because the bucket is private, we stream the bytes directly
 *     rather than issuing a redirect. For .m3u8 files we also rewrite
 *     any absolute S3 segment URLs back to our own /api/hls/… proxy
 *     path so every subsequent segment fetch is also authenticated.
 *
 *   GET /hls-token/:videoId                            (A3: Security)
 *     Returns a short-lived HMAC token that the client appends as ?t=TOKEN
 *     to HLS requests when REQUIRE_HLS_TOKEN=true. 1-hour default TTL.
 */

// ── A5: HLS proxy concurrency limiter ────────────────────────────────────────
// In-memory counter for simultaneous in-flight HLS proxy requests.
// Prevents a burst of cold-start clients from overwhelming the S3
// connection pool. 503 is returned immediately; clients fall back to
// their failoverHlsUrl after the first segment load failure.
let hlsConcurrent = 0;
const HLS_MAX = () => env.HLS_MAX_CONCURRENT;

// ── A6: In-process HLS segment LRU cache ─────────────────────────────────────
// Immutable .ts segments are content-addressed by the transcoder (path =
// `transcoded/{videoId}/v0/seg_NNNNN.ts`). Caching them in-process lets
// repeated requests from multiple viewers skip the two DB round-trips
// (headObject + BYTEA getObject) that otherwise dominate hot-path latency.
//
// Design:
//   • Byte-size-aware LRU: evicts LRU entries when totalBytes > maxBytes.
//   • TTL: 1 hour — segments are immutable after creation; the limit is
//     generous to prevent holding old content after a video rotation.
//   • Only caches entries ≤ maxEntryBytes (default 16 MB) to avoid caching
//     pathologically large segments that would displace many smaller ones.
//   • Registered with the diagnostics registry so the memory watchdog
//     can track cache size over time.
//   • Disabled at startup when HLS_SEGMENT_CACHE_MB = 0.
class HlsSegmentLru {
  private readonly map = new Map<string, { data: Buffer; ct: string; at: number }>();
  private totalBytes = 0;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly ttlMs = 60 * 60 * 1_000; // 1 hour
  hits = 0;
  misses = 0;

  constructor(maxMb: number) {
    this.maxBytes = maxMb * 1024 * 1024;
    // Cap per-entry at 1/4 of total so one large segment can't displace all others
    this.maxEntryBytes = Math.max(1, Math.floor(this.maxBytes / 4));
  }

  get enabled() { return this.maxBytes > 0; }

  read(key: string): { data: Buffer; ct: string } | null {
    if (!this.enabled) return null;
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > this.ttlMs) {
      this.map.delete(key);
      this.totalBytes = Math.max(0, this.totalBytes - entry.data.length);
      return null;
    }
    // Promote to MRU (delete + re-insert moves to Map tail)
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return { data: entry.data, ct: entry.ct };
  }

  write(key: string, data: Buffer, ct: string): void {
    if (!this.enabled) return;
    if (data.length > this.maxEntryBytes) return; // too large — skip
    if (this.map.has(key)) return;                // already cached

    // Evict LRU entries until we have room
    while (this.totalBytes + data.length > this.maxBytes && this.map.size > 0) {
      const lruKey = this.map.keys().next().value;
      if (lruKey === undefined) break;
      const lru = this.map.get(lruKey)!;
      this.map.delete(lruKey);
      this.totalBytes = Math.max(0, this.totalBytes - lru.data.length);
    }
    this.map.set(key, { data, ct, at: Date.now() });
    this.totalBytes += data.length;
    this.misses++;
  }

  get size() { return this.map.size; }
  get bytesMb() { return this.totalBytes / (1024 * 1024); }

  /**
   * Evict LRU entries until `totalBytes ≤ targetMb × 1 MiB`.
   * Called by the memory watchdog under RSS / heap pressure to reclaim
   * Buffer memory (which shows up in `process.memoryUsage().arrayBuffers`
   * and `external`).  Returns the number of bytes freed.
   */
  trim(targetMb: number): number {
    const targetBytes = Math.max(0, targetMb * 1024 * 1024);
    let freed = 0;
    while (this.totalBytes > targetBytes && this.map.size > 0) {
      const lruKey = this.map.keys().next().value;
      if (lruKey === undefined) break;
      const lru = this.map.get(lruKey)!;
      this.map.delete(lruKey);
      freed += lru.data.length;
      this.totalBytes = Math.max(0, this.totalBytes - lru.data.length);
    }
    return freed;
  }
}

// Lazy-initialised after env is parsed (module top-level runs before env.ts
// is imported on some test paths).  The first call to hlsSegments() initialises.
let _hlsSegments: HlsSegmentLru | null = null;
function hlsSegments(): HlsSegmentLru {
  if (!_hlsSegments) {
    _hlsSegments = new HlsSegmentLru(env.HLS_SEGMENT_CACHE_MB);
    registerNamedStore("hls-segment-cache", () => _hlsSegments!.size);
    if (_hlsSegments.enabled) {
      logger.info(
        { maxMb: env.HLS_SEGMENT_CACHE_MB },
        "[hls-proxy] in-process segment cache enabled",
      );
    }
  }
  return _hlsSegments;
}

/**
 * Trim the HLS segment in-process LRU cache to at most `targetMb` MB of
 * Buffer memory.  Returns bytes freed.  Safe to call from the memory watchdog
 * even if the cache has not yet been initialised (returns 0 in that case).
 * The freed Buffers become eligible for GC on the next collection cycle.
 */
export function trimHlsSegmentCache(targetMb: number): number {
  if (!_hlsSegments) return 0;
  return _hlsSegments.trim(targetMb);
}

// ── A3: HMAC token helpers ────────────────────────────────────────────────────
// makeHlsToken is imported from the shared module so other server-side callers
// (media scanner, orchestrator probes) can sign tokens without duplicating the
// crypto implementation.
export { makeHlsToken };

export async function videoServeRoutes(app: FastifyInstance) {
  // ── Startup advisory: warn when running in production without a CDN ───────
  // HLS segment requests (can number in the thousands per viewer per hour)
  // all hit this origin server when CDN_BASE_URL is unset. Configure a CDN
  // edge layer and set CDN_BASE_URL=https://cdn.yourdomain.com to offload
  // that traffic and reduce latency for geographically distributed viewers.
  if (env.NODE_ENV === "production" && !env.CDN_BASE_URL) {
    logger.info(
      "video-serve: CDN_BASE_URL not set — HLS segments served from origin. " +
      "This is expected on free-tier deployments; HLS_MAX_CONCURRENT already caps " +
      "concurrent streams to protect origin. Set CDN_BASE_URL to a CDN edge URL " +
      "when upgrading to a plan that supports higher concurrency.",
    );
  }

  // ── HLS memory budget validation ────────────────────────────────────────────
  // Each concurrent HLS request allocates a 16 MiB hex string in the V8 heap
  // (pg BYTEA wire decoding) PLUS an 8 MiB external Buffer held until the
  // response is fully flushed.  If HLS_MAX_CONCURRENT × 16 MiB approaches the
  // V8 heap cap the GC is unable to keep up, causing latency spikes and OOM
  // crashes.  Detect this at startup so misconfiguration is caught immediately.
  {
    // Infer the V8 heap cap from --max-old-space-size=N, fall back to 460 MiB.
    const v8HeapCapMb = (() => {
      for (const arg of process.execArgv) {
        const m = /--max-old-space-size=(\d+)/.exec(arg);
        if (m) return parseInt(m[1], 10);
      }
      return 460;
    })();

    const hlsMax = HLS_MAX();
    // Peak V8 heap from concurrent BYTEA hex strings (transient but simultaneous).
    const hexHeapMb = hlsMax * 16;
    // Peak external Buffer memory held until clients acknowledge each segment.
    const bufferExternalMb = hlsMax * 8;
    // Conservative API baseline (JIT, DB pool, module cache, libuv, etc.).
    const baselineRssMb = 300;
    const estimatedPeakRssMb = baselineRssMb + hexHeapMb + bufferExternalMb;
    // The effective restart threshold respects the Math.max guard in memory-watchdog.ts.
    const effectiveRestartMb = Math.max(env.MEMORY_RESTART_RSS_MB, env.MEMORY_WARN_RSS_MB);

    if (hexHeapMb > v8HeapCapMb * 0.8) {
      logger.error(
        {
          hlsMaxConcurrent: hlsMax,
          hexHeapMb,
          v8HeapCapMb,
          safeMax: Math.floor(v8HeapCapMb * 0.8 / 16),
        },
        "video-serve: HLS_MAX_CONCURRENT is too high for this V8 heap cap. " +
        `${hlsMax} concurrent requests × 16 MiB pg hex strings = ${hexHeapMb} MiB ` +
        `exceeds 80% of the ${v8HeapCapMb} MiB V8 heap (--max-old-space-size). ` +
        "GC thrashing will cause latency spikes and likely OOM crashes under load. " +
        `Lower HLS_MAX_CONCURRENT to ≤${Math.floor(v8HeapCapMb * 0.8 / 16)} ` +
        `or raise --max-old-space-size above ${Math.ceil(hexHeapMb / 0.8)}.`,
      );
    } else if (estimatedPeakRssMb > effectiveRestartMb) {
      logger.warn(
        {
          hlsMaxConcurrent: hlsMax,
          estimatedPeakRssMb,
          effectiveRestartMb,
          memoryWarnMb: env.MEMORY_WARN_RSS_MB,
          memoryRestartMb: env.MEMORY_RESTART_RSS_MB,
        },
        "video-serve: HLS memory budget exceeds MEMORY_RESTART_RSS_MB. " +
        `${hlsMax} concurrent × (16 MiB hex + 8 MiB buffer) + ${baselineRssMb} MiB baseline ` +
        `= ${estimatedPeakRssMb} MiB estimated peak RSS, but the watchdog restarts at ` +
        `${effectiveRestartMb} MiB. Lower HLS_MAX_CONCURRENT or raise MEMORY_RESTART_RSS_MB.`,
      );
    } else {
      logger.info(
        { hlsMaxConcurrent: hlsMax, estimatedPeakRssMb, v8HeapCapMb, effectiveRestartMb },
        "video-serve: HLS memory budget OK",
      );
    }
  }

  // Guard against the hardcoded default secret reaching production with token
  // enforcement enabled. Without this, any client that knows the well-known
  // fallback value ("temple-tv-hls-default") can forge valid HLS tokens.
  if (env.NODE_ENV === "production" && !env.HLS_TOKEN_SECRET) {
    if (env.REQUIRE_HLS_TOKEN) {
      // Hard-fail: token enforcement is active but the secret is the public
      // default. Any client could forge a token — refuse to start.
      throw new Error(
        "video-serve: REQUIRE_HLS_TOKEN=true but HLS_TOKEN_SECRET is not set. " +
        "Set HLS_TOKEN_SECRET to a strong random value (≥32 chars) before " +
        "starting the server in production.",
      );
    }
    // Soft-warn: token enforcement is off, but operators should still set the
    // secret so they can enable REQUIRE_HLS_TOKEN safely without switching to
    // the known-public default. Use error level in production so it surfaces.
    logger.error(
      "video-serve: HLS_TOKEN_SECRET is not set in production — HLS token signing " +
      "falls back to the built-in default secret, which is publicly known. " +
      "Any client can forge a valid HLS token. " +
      "Set HLS_TOKEN_SECRET to a ≥32-char random hex string, then enable REQUIRE_HLS_TOKEN=true.",
    );
  }

  // ── GET /hls-token/:videoId ────────────────────────────────────────────
  // A3: Security — issue a short-lived HMAC token for a specific video.
  // Clients call this before starting HLS playback when REQUIRE_HLS_TOKEN
  // is set. The token is valid for HLS_TOKEN_TTL_SECONDS (default 1 hour)
  // and scoped to a single videoId so token leakage doesn't grant access
  // to other assets.
  //
  // No auth required on this endpoint — the token itself is worthless
  // without a matching videoId; segment bytes still require an S3 fetch.
  // Callers that need per-user auth should place this behind requireAuth.
  app.get<{ Params: { videoId: string } }>(
    "/hls-token/:videoId",
    async (req, reply) => {
      const { videoId } = req.params;
      if (!videoId || videoId.includes("..")) {
        return reply.code(400).send({ error: "Invalid videoId" });
      }
      const { token, expiresAt } = makeHlsToken(videoId);
      return reply
        .header("Cache-Control", "private, no-store")
        .send({ token, expiresAt, videoId });
    },
  );

  // ── Shared constant: storage namespaces that don't use the "uploads/" prefix ──
  // Referenced by both the HEAD and GET /uploads/* handlers.
  const NON_UPLOAD_STORAGE_PREFIXES = ["thumbnails/", "transcoded/", "_parts/", "_meta/"];

  // ── In-process TTL cache for HEAD /uploads/* ─────────────────────────────
  // Media players (VLC, Safari, broadcast orchestrator) send a HEAD before
  // every GET to discover Content-Length and Range support. Without a cache
  // each probe issues a cold S3 HeadObject round-trip (~600 ms on a new TLS
  // connection, ~100 ms on a warm one). The same URL is typically probed 3-5×
  // in a 90 s window, so caching for 60 s eliminates most of those S3 calls.
  //
  // Bounded at 500 entries — each entry is ~100 bytes so max footprint ≈ 50 kB.
  // ETag-style invalidation is not needed: uploads are write-once; once a key
  // exists its Content-Length never changes.
  const HEAD_CACHE_TTL_MS = 60_000;
  const HEAD_CACHE_MAX = 500;
  const headMetaCache = new Map<
    string,
    { contentLength?: number; contentType?: string; expiresAt: number }
  >();

  function headCacheGet(key: string) {
    const entry = headMetaCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      headMetaCache.delete(key);
      return null;
    }
    return entry;
  }

  function headCacheSet(key: string, contentLength?: number, contentType?: string) {
    // Simple FIFO eviction — Map preserves insertion order; delete the oldest
    // entry when the cache is full before inserting the new one.
    if (headMetaCache.size >= HEAD_CACHE_MAX) {
      const oldest = headMetaCache.keys().next().value;
      if (oldest !== undefined) headMetaCache.delete(oldest);
    }
    headMetaCache.set(key, {
      contentLength,
      contentType,
      expiresAt: Date.now() + HEAD_CACHE_TTL_MS,
    });
  }

  // ── Shared helper for /uploads/* content-type resolution ───────────────
  function resolveUploadMime(key: string, storedContentType?: string): string {
    const ext = key.split(".").pop()?.toLowerCase() ?? "";
    const mimeMap: Record<string, string> = {
      mp4: "video/mp4",
      mov: "video/quicktime",
      avi: "video/x-msvideo",
      mkv: "video/x-matroska",
      webm: "video/webm",
      m4v: "video/x-m4v",
      ts: "video/mp2t",
      // Mirror the extensions the upload pipeline accepts (`safeExt` in
      // chunked-upload.routes.ts). Without these, an `.mts` or `.flv`
      // upload comes back as `application/octet-stream`, which most
      // browsers refuse to play in <video> even though the bytes are valid.
      mts: "video/mp2t",
      m2ts: "video/mp2t",
      flv: "video/x-flv",
      wmv: "video/x-ms-wmv",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      m3u8: "application/vnd.apple.mpegurl",
    };
    // Prefer the stored Content-Type only if it's specific; some legacy
    // uploads landed in storage with `application/octet-stream` which we
    // should override using the extension-derived guess so playback works.
    if (storedContentType && storedContentType !== "application/octet-stream") {
      return storedContentType;
    }
    return mimeMap[ext] ?? "application/octet-stream";
  }

  function setUploadCorsHeaders(reply: import("fastify").FastifyReply, isImage: boolean): void {
    reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
      .header("Access-Control-Allow-Headers", "Range")
      .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
      .header("Cross-Origin-Resource-Policy", "cross-origin")
      .header("Timing-Allow-Origin", "*");
    if (!isImage) {
      reply.header("Accept-Ranges", "bytes");
    }
  }

  // ── OPTIONS /uploads/* — CORS preflight for Range requests ─────────────
  // Browsers send an OPTIONS preflight before a Range-bearing GET.
  // Without this, Chrome/Firefox block the media request cross-origin.
  app.options<{ Params: { "*": string } }>(
    "/uploads/*",
    async (_req, reply) => {
      return reply
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Allow-Headers", "Range, Content-Type")
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        .header("Access-Control-Max-Age", "86400")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .code(204)
        .send();
    },
  );

  // ── HEAD /uploads/* ─────────────────────────────────────────────────────
  // Many browsers and media players send HEAD before GET to discover
  // Content-Length and whether Range is supported. A missing HEAD handler
  // means they get a 404, which makes them think the asset doesn't exist.
  //
  // Uses headMetaCache (60 s TTL, 500 entries) so repeated availability
  // probes from the same media player skip the S3 HeadObject round-trip
  // entirely. Uploads are write-once so cached metadata stays correct for
  // the TTL window.
  app.head<{ Params: { "*": string } }>(
    "/uploads/*",
    async (req, reply) => {
      const suffix = (req.params as Record<string, string>)["*"] || "";
      if (suffix.includes("..") || suffix === "") {
        return reply.code(400).send();
      }
      // Keys for non-upload storage namespaces (custom thumbnails, HLS
      // transcoded files) are stored WITHOUT the "uploads/" prefix in
      // storage_blobs. publicUrl() strips "uploads/" for actual upload blobs
      // so their suffix starts with a date path (e.g. "2025/01/02/abc.mp4").
      // For other storage namespaces we use the suffix directly as the key.
      const key = NON_UPLOAD_STORAGE_PREFIXES.some((p) => suffix.startsWith(p))
        ? suffix
        : `uploads/${suffix}`;

      const ext = key.split(".").pop()?.toLowerCase() ?? "";
      const isImage = ["jpg", "jpeg", "png", "webp"].includes(ext);
      const cacheControl = isImage
        ? "public, max-age=2592000, immutable"
        : "public, max-age=3600, stale-while-revalidate=86400";

      // ── Cache hit: serve without any storage I/O ──────────────────────
      const cached = headCacheGet(key);
      if (cached) {
        const contentType = resolveUploadMime(key, cached.contentType);
        reply.header("Content-Type", contentType).header("Cache-Control", cacheControl);
        if (cached.contentLength) {
          reply.header("Content-Length", String(cached.contentLength));
        }
        setUploadCorsHeaders(reply, isImage);
        return reply.code(200).send();
      }

      // ── Cache miss: hit storage, then populate cache ──────────────────
      const s = storage();
      if (!s.enabled) {
        return reply.code(503).send();
      }
      try {
        const head = await s.headObject(key);
        if (!head.exists) {
          return reply.code(404).send();
        }
        headCacheSet(key, head.contentLength, head.contentType);
        const contentType = resolveUploadMime(key, head.contentType);
        reply.header("Content-Type", contentType).header("Cache-Control", cacheControl);
        if (head.contentLength) {
          reply.header("Content-Length", String(head.contentLength));
        }
        setUploadCorsHeaders(reply, isImage);
        return reply.code(200).send();
      } catch {
        return reply.code(404).send();
      }
    },
  );

  // ── GET /uploads/* ─────────────────────────────────────────────────────
  // Streams raw upload bytes directly from object storage with full HTTP
  // Range request support. The wildcard (*) handles both flat and
  // date-partitioned keys. Range support is required for:
  //   - MP4 seeking (the browser requests bytes around the moov atom)
  //   - Chrome's initial 2-byte probe: Range: bytes=0-1
  //   - Safari's multi-range requests for streaming
  //
  // Without Range support the <video> element reports a media error and
  // the player FSM classifies the source as stalled → "Source unavailable".
  app.get<{ Params: { "*": string } }>(
    "/uploads/*",
    async (req, reply) => {
      const suffix = (req.params as Record<string, string>)["*"] || "";
      if (suffix.includes("..") || suffix === "") {
        return reply.code(400).send({ error: "Invalid filename" });
      }
      // Same key-resolution logic as the HEAD handler above:
      // non-upload namespaces (thumbnails/, transcoded/) are stored without
      // the "uploads/" prefix, so we use the suffix directly for those.
      const key = NON_UPLOAD_STORAGE_PREFIXES.some((p) => suffix.startsWith(p))
        ? suffix
        : `uploads/${suffix}`;
      const s = storage();
      if (!s.enabled) {
        return reply.code(503).send({ error: "Object storage not configured" });
      }

      const ext = key.split(".").pop()?.toLowerCase() ?? "";
      const isImage = ["jpg", "jpeg", "png", "webp"].includes(ext);
      const cacheControl = isImage
        ? "public, max-age=2592000, immutable"
        : "public, max-age=3600, stale-while-revalidate=86400";

      // ── Range request path ────────────────────────────────────────────
      const rangeHeader = typeof req.headers["range"] === "string"
        ? req.headers["range"]
        : null;

      if (rangeHeader && !isImage) {
        // Parse "bytes=START-END" (suffix ranges like "bytes=-500" and
        // multi-range are uncommon for video; handle the common single-range form).
        const rangeMatch = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        if (rangeMatch) {
          try {
            // Need total size to compute open-ended ranges and Content-Range.
            const head = await s.headObject(key);
            if (!head.exists) {
              return reply.code(404).send({ error: "File not found in storage" });
            }
            const total = head.contentLength ?? 0;
            const contentType = resolveUploadMime(key, head.contentType);

            const rawStart = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
            // Open-ended "bytes=START-" means through the last byte.
            const rawEnd = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : total - 1;

            // Clamp to valid bounds.
            const start = Math.max(0, rawStart);
            const end = Math.min(rawEnd, total - 1);

            if (start > end || start >= total) {
              // Range Not Satisfiable
              return reply
                .code(416)
                .header("Content-Range", `bytes */${total}`)
                .send({ error: "Range Not Satisfiable" });
            }

            const rangeObj = await s.getObjectRange(key, start, end);
            if (!rangeObj) {
              return reply.code(404).send({ error: "File not found in storage" });
            }

            // Abort the upstream DB stream when the client disconnects so
            // in-flight SUBSTRING queries stop issuing mid-transfer.
            req.raw.once("close", () => { try { rangeObj.body.destroy(); } catch { /* ignore */ } });
            // Suppress expected disconnect errors (client seek / range switch).
            rangeObj.body.on("error", (e) => {
              const code = (e as NodeJS.ErrnoException).code ?? "";
              if (code === "ERR_STREAM_DESTROYED" || code === "ECONNRESET" || code === "ERR_STREAM_PREMATURE_CLOSE") return;
              req.log.debug({ err: e, key }, "[uploads] range stream error");
            });

            reply
              .code(206)
              .header("Content-Type", contentType)
              .header("Content-Range", `bytes ${start}-${end}/${total}`)
              .header("Content-Length", String(rangeObj.contentLength))
              .header("Cache-Control", cacheControl)
              .header("X-Accel-Buffering", "no");
            setUploadCorsHeaders(reply, isImage);
            return reply.send(rangeObj.body);
          } catch {
            return reply.code(404).send({ error: "File not found in storage" });
          }
        }
      }

      // ── Full-file path ────────────────────────────────────────────────
      try {
        const obj = await s.getObject(key);
        const contentType = resolveUploadMime(key, obj.contentType);
        // Abort the upstream DB stream when the client disconnects so
        // the chunked streaming generator stops issuing SUBSTRING queries.
        req.raw.once("close", () => { try { obj.body.destroy(); } catch { /* ignore */ } });
        // Suppress expected disconnect errors — client closed before transfer
        // finished (seek, close tab, reconnect).  Log anything unexpected.
        obj.body.on("error", (e) => {
          const code = (e as NodeJS.ErrnoException).code ?? "";
          if (code === "ERR_STREAM_DESTROYED" || code === "ECONNRESET" || code === "ERR_STREAM_PREMATURE_CLOSE") return;
          req.log.debug({ err: e, key }, "[uploads] full-file stream error");
        });
        reply
          .header("Cache-Control", cacheControl)
          .header("Content-Type", contentType)
          .header("Accept-Ranges", "bytes")
          .header("X-Accel-Buffering", "no");
        if (obj.contentLength) {
          reply.header("Content-Length", String(obj.contentLength));
        }
        setUploadCorsHeaders(reply, isImage);
        return reply.send(obj.body);
      } catch {
        return reply.code(404).send({ error: "File not found in storage" });
      }
    },
  );

  // ── GET /videos/:id/source ─────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/videos/:id/source",
    async (req, reply) => {
      const { id } = req.params;
      const rows = await db
        .select({
          localVideoUrl: schema.videosTable.localVideoUrl,
          hlsMasterUrl: schema.videosTable.hlsMasterUrl,
        })
        .from(schema.videosTable)
        .where(eq(schema.videosTable.id, id))
        .limit(1);

      const row = rows[0];
      if (!row) {
        return reply.code(404).send({ error: "Video not found" });
      }

      const hlsUrl = row.hlsMasterUrl;
      const rawUrl = row.localVideoUrl;

      const s = storage();

      // HLS: prefer the proxy path; convert legacy raw S3 URLs on-the-fly.
      if (hlsUrl) {
        let target = hlsUrl;
        if (hlsUrl.startsWith("http://") || hlsUrl.startsWith("https://")) {
          const u = new URL(hlsUrl);
          const m = u.pathname.match(/\/transcoded\/([^/]+)\/(.+)$/);
          target = m ? `/api/hls/${m[1]}/${m[2]}` : (u.pathname.startsWith("/api/") ? u.pathname : hlsUrl);
        }
        return reply.header("Cache-Control", "private, max-age=3600").redirect(target, 302);
      }

      // Raw upload: generate a signed S3 download URL.
      if (rawUrl && !rawUrl.includes("/api/videos/") && !rawUrl.includes("/source")) {
        if ((rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) && s.enabled) {
          try {
            const u = new URL(rawUrl);
            let key = u.pathname.slice(1);
            if (s.bucket && key.startsWith(`${s.bucket}/`)) {
              key = key.slice(s.bucket.length + 1);
            }
            if (key) {
              const proxyUrl = s.publicUrl(key);
              if (proxyUrl) {
                return reply.header("Cache-Control", "private, max-age=3600").redirect(proxyUrl, 302);
              }
            }
          } catch {
            // Fall through to direct redirect below.
          }
        }
        return reply.header("Cache-Control", "private, max-age=3600").redirect(rawUrl, 302);
      }

      // Last-resort: look up source key from transcoding_jobs.
      if (s.enabled) {
        const jobRows = await db
          .select({ videoPath: schema.transcodingJobsTable.videoPath })
          .from(schema.transcodingJobsTable)
          .where(eq(schema.transcodingJobsTable.videoId, id))
          .orderBy(desc(schema.transcodingJobsTable.createdAt))
          .limit(1);
        const jobRow = jobRows[0];
        if (jobRow?.videoPath && !jobRow.videoPath.startsWith("/")) {
          try {
            const proxyUrl = s.publicUrl(jobRow.videoPath);
            if (proxyUrl) {
              return reply
                .header("Cache-Control", "private, max-age=3600")
                .redirect(proxyUrl, 302);
            }
          } catch {
            // Object key invalid — fall through to 404.
          }
        }
      }

      return reply.code(404).send({ error: "No playback URL for this video" });
    },
  );

  // ── OPTIONS /hls/:videoId/* — CORS preflight ────────────────────────────
  // Browsers send an OPTIONS preflight before any cross-origin GET or HEAD
  // that includes custom headers (e.g. Range). Without this handler the
  // preflight returns Fastify's default 404 / 405 and the subsequent media
  // request is blocked by CORS, preventing playback in web and TV apps that
  // load HLS from a different origin than the page.
  app.options<{ Params: { videoId: string; "*": string } }>(
    "/hls/:videoId/*",
    async (_req, reply) => {
      return reply
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Allow-Headers", "Range, Content-Type")
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        .header("Access-Control-Max-Age", "86400")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .code(204)
        .send();
    },
  );

  // ── HEAD /hls/:videoId/* — TV / mobile player probe ─────────────────────
  // Samsung Tizen, LG webOS, Apple TV, and many mobile HLS implementations
  // send a HEAD request before the first GET to:
  //   1. Verify the asset exists (404 = don't even try to play).
  //   2. Read Content-Length and Accept-Ranges to decide whether seeking
  //      is possible before buffering anything.
  // Without this handler, Fastify returns its default 405 Method Not Allowed,
  // which most TV players interpret as "source unavailable" and show a blank
  // screen or immediately fall back to the failover source.
  app.head<{ Params: { videoId: string; "*": string }; Querystring: { t?: string } }>(
    "/hls/:videoId/*",
    async (req, reply) => {
      const { videoId } = req.params;
      const wildcard = (req.params as Record<string, string>)["*"] || "master.m3u8";

      if (wildcard.includes("..")) {
        return reply.code(400).send();
      }

      // HLS viewer routes are intentionally public — the S3 proxy already
      // protects the private bucket. Token enforcement (REQUIRE_HLS_TOKEN) is
      // NOT applied here so any player (TV, mobile, web, Chromecast) can
      // fetch manifests and segments without pre-obtaining a token.
      const key = `transcoded/${videoId}/${wildcard}`;
      const s = storage();
      if (!s.enabled) {
        return reply.code(503).send();
      }

      try {
        const head = await s.headObject(key);
        if (!head.exists) {
          return reply.code(404).send();
        }
        const isManifest = wildcard.endsWith(".m3u8");
        const contentType = isManifest
          ? "application/vnd.apple.mpegurl"
          : (head.contentType ?? "video/mp2t");
        reply
          .header("Content-Type", contentType)
          .header("Accept-Ranges", "bytes")
          .header("Access-Control-Allow-Origin", "*")
          .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
          .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
          .header("Cross-Origin-Resource-Policy", "cross-origin")
          .header("Timing-Allow-Origin", "*")
          .header(
            "Cache-Control",
            isManifest
              ? "public, max-age=2, s-maxage=2, stale-while-revalidate=1, stale-if-error=60"
              : "public, max-age=604800, immutable",
          );
        if (head.contentLength) {
          reply.header("Content-Length", String(head.contentLength));
        }
        return reply.code(200).send();
      } catch {
        return reply.code(404).send();
      }
    },
  );

  // ── GET /hls/:videoId/* ────────────────────────────────────────────────
  // Streams HLS manifest + segments directly from the private S3 bucket.
  //
  // A2: CDN Optimization
  //   When CDN_BASE_URL is configured, the master.m3u8 manifest response
  //   rewrites variant playlist and segment URLs to point at the CDN instead
  //   of this API proxy. Subsequent segment requests bypass the origin and
  //   hit the CDN edge. The CDN should be configured to cache TS segments
  //   (immutable content) for 7 days. Sub-playlists (.m3u8 variants) are
  //   not rewritten to CDN so they still flow through auth if needed.
  //
  // A3: Security (opt-in via REQUIRE_HLS_TOKEN=true)
  //   When enabled, the ?t=TOKEN query param is validated using an HMAC
  //   keyed with HLS_TOKEN_SECRET. Invalid or expired tokens get 401.
  //   TV and Mobile clients should call GET /api/hls-token/:videoId first.
  //
  // A5: Scalability
  //   In-flight request counter. When HLS_MAX_CONCURRENT is exceeded,
  //   requests receive 503 immediately with Retry-After: 5 so the client
  //   backs off rather than stacking connections.
  app.get<{ Params: { videoId: string; "*": string }; Querystring: { t?: string } }>(
    "/hls/:videoId/*",
    async (req, reply) => {
      const { videoId } = req.params;
      const wildcard = (req.params as Record<string, string>)["*"] || "master.m3u8";

      if (wildcard.includes("..")) {
        return reply.code(400).send({ error: "Invalid path" });
      }

      // HLS viewer routes are intentionally public — the private S3 bucket is
      // protected by this server acting as a proxy; no additional HMAC token
      // is required from viewers. This allows any player surface (TV, mobile,
      // web, Chromecast, VLC) to load HLS manifests and segments without first
      // calling /api/hls-token/:videoId.
      //
      // The REQUIRE_HLS_TOKEN env var is retained for the token-signing infra
      // (makeHlsToken / validateHlsToken) used by internal probes, but token
      // absence no longer causes a 401 for public viewer requests.

      // A5: Concurrency gate
      if (hlsConcurrent >= HLS_MAX()) {
        logger.warn({ hlsConcurrent, max: HLS_MAX() }, "[hls-proxy] concurrency limit reached");
        return reply
          .code(503)
          .header("Retry-After", "5")
          .header("X-Queue-Depth", String(hlsConcurrent))
          .send({ error: "HLS proxy busy — retry in 5 seconds" });
      }

      hlsConcurrent += 1;
      // Guard flag prevents double-decrement: both "finish" (data flushed) and
      // "close" (connection destroyed) fire on every response in Node.js HTTP.
      // Without the guard, each request would decrement the counter twice,
      // causing hlsConcurrent to undercount live requests and allowing more
      // concurrent requests than HLS_MAX_CONCURRENT through the gate.
      let _decremented = false;
      const decrementConcurrent = () => {
        if (_decremented) return;
        _decremented = true;
        hlsConcurrent = Math.max(0, hlsConcurrent - 1);
      };
      reply.raw.on("finish", decrementConcurrent);
      reply.raw.on("close", decrementConcurrent);

      const key = `transcoded/${videoId}/${wildcard}`;
      // Determine type early — needed both for Range pre-check and CDN rewriting.
      const isManifest = wildcard.endsWith(".m3u8");
      const s = storage();
      if (!s.enabled) {
        decrementConcurrent();
        return reply.code(503).send({ error: "Object storage not configured" });
      }

      // ── Range request path (segments only) ────────────────────────────────
      // Honour Range: bytes=START-END on .ts segments before issuing the full
      // getObject call. Required by:
      //   • Safari / AVFoundation — makes range requests for every HLS segment.
      //   • Smart TV players (Tizen, WebOS) — many require 206 for buffering.
      //   • Seek-into-segment scenarios where a client already has part of a
      //     segment in cache and wants only the remainder.
      //
      // Manifests (.m3u8) are always served whole — they are buffered for URL
      // rewriting anyway, and Range-for-manifests is not a real use case.
      const rangeHeader = typeof req.headers["range"] === "string"
        ? req.headers["range"]
        : null;

      // ── A6: Segment cache fast-path ────────────────────────────────────────
      // For full (non-range) non-manifest fetches, serve from the in-process LRU
      // cache if available — zero DB queries, <1 ms vs ~30-60 ms on a cache miss.
      // Range requests bypass the cache because they need a partial slice; the
      // full segment will be cached on the next non-range request.
      if (!isManifest && !rangeHeader) {
        const hit = hlsSegments().read(key);
        if (hit) {
          decrementConcurrent();
          return reply
            .code(200)
            .header("Content-Type", hit.ct)
            .header("Content-Length", String(hit.data.length))
            .header("Cache-Control", "public, max-age=604800, immutable")
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
            .header("Cross-Origin-Resource-Policy", "cross-origin")
            .header("Timing-Allow-Origin", "*")
            .header("X-Accel-Buffering", "no")
            .header("X-Cache", "HIT")
            .header("X-Queue-Depth", String(hlsConcurrent))
            .send(hit.data);
        }
      }

      if (!isManifest && rangeHeader) {
        const rangeMatch = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        if (rangeMatch) {
          try {
            const head = await s.headObject(key);
            if (!head.exists) {
              decrementConcurrent();
              if (env.PROD_SYNC_API_URL && env.NODE_ENV !== "production") {
                const prodBase = env.PROD_SYNC_API_URL.replace(/\/+$/, "");
                return reply.redirect(`${prodBase}/api/hls/${videoId}/${wildcard}`, 302);
              }
              return reply.code(404).send({ error: "HLS segment not found in storage" });
            }
            const total = head.contentLength ?? 0;
            const rawStart = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
            // Open-ended "bytes=START-" means through the last byte.
            const rawEnd = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : total - 1;
            const rangeStart = Math.max(0, rawStart);
            const rangeEnd = Math.min(rawEnd, total - 1);

            if (rangeStart > rangeEnd || rangeStart >= total) {
              decrementConcurrent();
              return reply
                .code(416)
                .header("Content-Range", `bytes */${total}`)
                .send({ error: "Range Not Satisfiable" });
            }

            const rangeObj = await s.getObjectRange(key, rangeStart, rangeEnd);
            if (!rangeObj) {
              decrementConcurrent();
              return reply.code(404).send({ error: "HLS segment not found in storage" });
            }

            return reply
              .code(206)
              .header("Content-Type", head.contentType ?? "video/mp2t")
              .header("Content-Range", `bytes ${rangeStart}-${rangeEnd}/${total}`)
              .header("Content-Length", String(rangeObj.contentLength))
              .header("Cache-Control", "public, max-age=604800, immutable")
              .header("Accept-Ranges", "bytes")
              // Instruct nginx/Caddy not to buffer HLS segments before forwarding
              // to the player. Without this header, reverse-proxy buffering delays
              // segment delivery and causes playback stalls on Smart TVs (Samsung
              // Tizen, LG webOS) where the player issues byte-range requests and
              // expects low-latency streaming delivery, not a fully-buffered reply.
              .header("X-Accel-Buffering", "no")
              .header("Access-Control-Allow-Origin", "*")
              .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
              .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
              .header("Cross-Origin-Resource-Policy", "cross-origin")
              .header("Timing-Allow-Origin", "*")
              .send(rangeObj.body);
          } catch (rangeErr) {
            decrementConcurrent();
            logger.warn({ err: rangeErr, videoId, wildcard }, "[hls-proxy] range request failed");
            return reply.code(404).send({ error: "HLS segment not found in storage" });
          }
        }
      }

      let obj: Awaited<ReturnType<typeof s.getObject>>;
      try {
        obj = await s.getObject(key);
      } catch (err) {
        decrementConcurrent();
        const e = err as { $metadata?: { httpStatusCode?: number }; message?: string };
        const status = e?.$metadata?.httpStatusCode;
        if (status === 403 || status === 404) {
          if (env.PROD_SYNC_API_URL && env.NODE_ENV !== "production") {
            const prodBase = env.PROD_SYNC_API_URL.replace(/\/+$/, "");
            return reply.redirect(`${prodBase}/api/hls/${videoId}/${wildcard}`, 302);
          }
          return reply.code(404).send({ error: "HLS asset not found in storage" });
        }
        throw err;
      }

      if (isManifest) {
        // Buffer the manifest so we can rewrite absolute S3 segment URLs.
        const chunks: Buffer[] = [];
        try {
          for await (const chunk of obj.body) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
          }
        } catch (streamErr) {
          decrementConcurrent();
          req.log.warn({ err: streamErr, videoId }, "HLS manifest stream failed mid-read");
          return reply.code(503).send({ error: "HLS manifest stream interrupted" });
        }
        let text = Buffer.concat(chunks).toString("utf8");

        // Rewrite absolute S3/CDN URLs pointing to our transcoded prefix
        // back to either the CDN base (when configured) or the API proxy path.
        const cdnBase = env.CDN_BASE_URL?.replace(/\/$/, "");

        // A2: CDN rewriting — applied to ALL manifests (master + variant).
        //
        // Previously only the master manifest had its variant/segment references
        // rewritten to the CDN. Variant playlists (.m3u8 files like v0/playlist.m3u8)
        // contain the actual segment (.ts) URIs; without rewriting them here those
        // segments are fetched from the API origin regardless of CDN config, bypassing
        // CDN caching entirely for all segment traffic.
        //
        // Fix: remove the `isMaster` guard so both the proxy-path and S3-URL patterns
        // are rewritten to the CDN base for every manifest (master or variant).
        // Segment files are immutable content-addressed blobs — CDN caching them
        // permanently is safe and reduces origin load dramatically.
        if (cdnBase) {
          // Rewrite /api/hls/:videoId/... references → CDN (master + variant)
          const proxyPathPattern = new RegExp(`/api(?:/v1)?/hls/${videoId}/([^\\s"'\\r\\n]+)`, "g");
          text = text.replace(proxyPathPattern, (_match, rest: string) => `${cdnBase}/api/hls/${videoId}/${rest}`);
        }

        // Always rewrite any absolute S3 URL that points into our transcoded prefix.
        const s3UrlPattern = new RegExp(
          `https?://[^\\s"']+/transcoded/${videoId}/([^\\s"'\\r\\n]+)`,
          "g",
        );
        if (cdnBase) {
          // Point directly at CDN for all manifest types
          text = text.replace(s3UrlPattern, (_match, rest: string) => `${cdnBase}/api/hls/${videoId}/${rest}`);
        } else {
          text = text.replace(s3UrlPattern, (_match, rest: string) => `/api/hls/${videoId}/${rest}`);
        }

        // A2: segment cache TTL on manifests — 2 s max-age keeps the CDN /
        // browser from serving stale segment lists more than one segment
        // duration behind the live edge. This is important for broadcast
        // sync: when the orchestrator advances to the next item the mobile
        // player needs to receive the updated position quickly so it can
        // seek to the correct point. The previous 10 s TTL caused up to
        // 10 s of position lag on cold-cache clients.
        //
        // stale-while-revalidate=1: serve the cached manifest for at most
        // 1 s past max-age while fetching a fresh copy in the background —
        // eliminates the manifest-fetch stall that would otherwise briefly
        // pause HLS.js / ExoPlayer while waiting for a fresh playlist.
        //
        // stale-if-error=60: if the origin is transiently unavailable (deploy
        // restart, DB blip) the CDN serves stale for up to 60 s rather than
        // returning a 5xx that would cause ExoPlayer/AVPlayer to abort playback.
        const manifestBuf = Buffer.from(text, "utf8");
        // ETag: sha1 of the rewritten manifest content (first 16 hex chars).
        // Allows HLS.js / ExoPlayer to skip re-downloading manifests that
        // haven't changed since the last poll (304 Not Modified), cutting
        // manifest traffic by ~80% when the playlist is stable between ticks.
        const manifestEtag = `"${createHash("sha1").update(manifestBuf).digest("hex").slice(0, 16)}"`;
        if (req.headers["if-none-match"] === manifestEtag) {
          decrementConcurrent();
          return reply.code(304).send();
        }
        return reply
          .header("Content-Type", "application/vnd.apple.mpegurl")
          .header("Cache-Control", "public, max-age=2, s-maxage=2, stale-while-revalidate=1, stale-if-error=60")
          .header("ETag", manifestEtag)
          .header("Content-Length", String(manifestBuf.byteLength))
          .header("Accept-Ranges", "bytes")
          .header("Access-Control-Allow-Origin", "*")
          .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
          .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, ETag")
          .header("Cross-Origin-Resource-Policy", "cross-origin")
          .header("Timing-Allow-Origin", "*")
          .header("X-Accel-Buffering", "no")
          .header("X-Queue-Depth", String(hlsConcurrent))
          .send(manifestBuf);
      }

      // A2: Binary segment — long cache TTL (7 days). TS segments are immutable
      // (content-addressed by the transcoder); a 7-day TTL is safe and dramatically
      // reduces origin load once the CDN or browser cache is warm.
      //
      // For non-range requests we materialise the full segment into a Buffer so we
      // can populate the in-process LRU cache (A6) before sending. Subsequent
      // requests for the same segment are served entirely from memory.
      // For range requests (handled above) we already returned early; this branch
      // only executes for full-segment non-range fetches and manifests (A1).
      const contentType = obj.contentType ?? "video/mp2t";
      // Collect the body stream into a Buffer for caching.  Individual .ts
      // segments are 250 KB–4 MB so the memory overhead is bounded and brief
      // (data is released once reply.send() drains the TCP write buffer).
      const chunks: Buffer[] = [];
      // Wire up disconnect abort so the DB SUBSTRING generator stops issuing
      // queries if the client closes the connection mid-segment.
      let _segAborted = false;
      const _abortSeg = () => { _segAborted = true; try { obj.body.destroy(); } catch { /* ignore */ } };
      req.raw.once("close", _abortSeg);
      try {
        for await (const chunk of obj.body as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      } catch (streamErr) {
        decrementConcurrent();
        req.raw.removeListener("close", _abortSeg);
        if (_segAborted) return; // Client disconnected — normal, nothing to log
        const code = (streamErr as NodeJS.ErrnoException).code ?? "";
        if (code === "ERR_STREAM_DESTROYED" || code === "ECONNRESET" || code === "ERR_STREAM_PREMATURE_CLOSE") return;
        req.log.warn({ err: streamErr, videoId, wildcard }, "[hls-proxy] segment stream error");
        return reply.code(503).send({ error: "Segment stream interrupted" });
      }
      req.raw.removeListener("close", _abortSeg);
      const segBuf = Buffer.concat(chunks);
      // Release the individual chunk Buffer references immediately after concat.
      // Without this, V8 keeps the source chunks array alive (and all its
      // constituent Buffers) alongside the concatenated segBuf until the
      // handler function returns — doubling peak heap pressure under concurrent
      // HLS requests.  Setting .length = 0 removes all element references
      // so the chunk Buffers become eligible for GC during the LRU write and
      // reply.send() calls that follow.
      chunks.length = 0;
      // Populate the LRU cache (write() is a no-op if the entry is too large
      // or caching is disabled via HLS_SEGMENT_CACHE_MB=0).
      hlsSegments().write(key, segBuf, contentType);
      return reply
        .header("Content-Type", contentType)
        .header("Content-Length", String(segBuf.length))
        .header("Cache-Control", "public, max-age=604800, immutable")
        .header("Accept-Ranges", "bytes")
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("Timing-Allow-Origin", "*")
        .header("X-Accel-Buffering", "no")
        .header("X-Cache", "MISS")
        .header("X-Queue-Depth", String(hlsConcurrent))
        .send(segBuf);
    },
  );
}
