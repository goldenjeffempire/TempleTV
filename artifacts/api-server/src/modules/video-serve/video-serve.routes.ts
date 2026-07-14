import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { storage } from "../../infrastructure/storage.js";
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

/**
 * No-op stubs retained for the memory watchdog's dynamic import contract.
 * HLS segment proxying has been removed (MP4-only pipeline).
 */
export function trimHlsSegmentCache(_targetMb: number): number { return 0; }
export function setHlsConcurrencyOverride(_n: number | null): void { }
export function getHlsConcurrent(): number { return 0; }

let _headMetaCacheClearFn: (() => void) | null = null;
export function clearHeadMetaCache(): void { _headMetaCacheClearFn?.(); }

export async function videoServeRoutes(app: FastifyInstance) {

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
  // Register with the diagnostics system so the memory watchdog can see it,
  // and wire the module-level clear hook so the watchdog can drain it during
  // a self-healing relief pass.
  registerNamedStore("hls-head-meta-cache", () => headMetaCache.size);
  _headMetaCacheClearFn = () => headMetaCache.clear();

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
    // Never cache a size-zero entry.  This occurs when faststart's
    // completeMultipartUpload is mid-assembly: the storage_blobs row briefly
    // holds size_bytes=0 while parts are being appended.  Caching that zero
    // would cause all subsequent Range requests for the file to receive 416
    // "Range Not Satisfiable" for up to HEAD_CACHE_TTL_MS (60 s) even after
    // the blob is fully written.
    if (contentLength === 0) return;
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

            if (total === 0) {
              // Blob is temporarily size-zero — faststart multipart assembly
              // is in progress. Return 503 Retry-After so the client retries
              // in a few seconds instead of treating this as a permanent error.
              return reply
                .code(503)
                .header("Retry-After", "5")
                .header("Content-Range", `bytes */${total}`)
                .send({ error: "File is temporarily being assembled; please retry shortly" });
            }
            if (start > end || start >= total) {
              // Range Not Satisfiable
              return reply
                .code(416)
                .header("Content-Range", `bytes */${total}`)
                .send({ error: "Range Not Satisfiable" });
            }

            // Pass the pre-fetched head metadata to avoid a second headObject()
            // DB call inside getObjectRange() for chunked blobs.  For legacy
            // BYTEA blobs this is irrelevant (the first SUBSTRING query already
            // serves as the existence check), but for new chunked blobs it saves
            // one SELECT per Range request — which fires on every video seek.
            const rangeObj = await s.getObjectRange(key, start, end, head);
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

        // A contentLength of 0 means the blob row exists but size_bytes is
        // still zero — this happens during faststart's multipart assembly
        // window.  Serving a 200 with an empty body would look like a corrupt
        // or missing file to video players.  Return 503 Retry-After instead
        // so clients back off and retry once assembly is done.
        if (obj.contentLength === 0) {
          try { obj.body.destroy(); } catch { /* ignore */ }
          return reply
            .code(503)
            .header("Retry-After", "5")
            .send({ error: "File is temporarily being assembled; please retry shortly" });
        }

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
        })
        .from(schema.videosTable)
        .where(eq(schema.videosTable.id, id))
        .limit(1);

      const row = rows[0];
      if (!row) {
        return reply.code(404).send({ error: "Video not found" });
      }

      const rawUrl = row.localVideoUrl;

      const s = storage();

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



}
