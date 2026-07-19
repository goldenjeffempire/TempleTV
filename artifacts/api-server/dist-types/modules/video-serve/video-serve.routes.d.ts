import type { FastifyInstance } from "fastify";
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
export declare function trimHlsSegmentCache(_targetMb: number): number;
export declare function setHlsConcurrencyOverride(_n: number | null): void;
export declare function getHlsConcurrent(): number;
export declare function clearHeadMetaCache(): void;
export declare function videoServeRoutes(app: FastifyInstance): Promise<void>;
