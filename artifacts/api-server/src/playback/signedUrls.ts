/**
 * Source resolver — turns a queue/override/schedule item into a direct,
 * ready-to-play URL. The new playback engine never serves a 302: clients
 * receive the final URL inline and fetch it directly from S3 (or YouTube).
 *
 * Resolution rules:
 *   - HLS path (`localVideoUrl` ending in .m3u8): kept as-is. The HLS
 *     manifest itself stays small and is served by `/api/hls/...` with
 *     short-cache; the inner segments (.ts) reference signed S3 URLs once
 *     the transcoder uploads them. We don't presign the manifest itself —
 *     that's still a tiny `/api/hls/<id>/master.m3u8` URL.
 *   - MP4 / audio path (`localVideoUrl` of `/api/uploads/<uuid>.<ext>`):
 *     extract the S3 key, mint a signed GET URL, return that. This bypasses
 *     the legacy `/api/uploads/*` route entirely — no API hop, no 302.
 *   - YouTube (`videoSource: "youtube"`): pass through `youtubeId` as the
 *     "url"; the client uses its YouTube player.
 *   - Anything else (absolute https URL on a third-party CDN, etc.): pass
 *     through unchanged.
 */

import { URL } from "node:url";
import { eq } from "drizzle-orm";
import { db, broadcastQueueTable, videosTable } from "@workspace/db";
import { getSignedGetUrl, isS3Configured } from "../lib/s3Storage";
import { logger } from "../lib/logger";
import type { PlaybackSource } from "./types";

type BroadcastItem = typeof broadcastQueueTable.$inferSelect;

const SIGNED_URL_TTL_SEC = 3600;

/** Cheap match: anything that ends in .m3u8 (case-insensitive). */
function isHlsUrl(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url);
}

function pathFromUrl(rawUrl: string): string | null {
  try {
    if (/^https?:\/\//i.test(rawUrl)) {
      return new URL(rawUrl).pathname;
    }
    return rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  } catch {
    return null;
  }
}

/**
 * Pull the S3 key out of a `/api/uploads/<uuid>.<ext>` URL.
 * The S3 layout (set in `app.ts` -> `s3RedirectFirstForLargeMedia`) mirrors
 * the URL path under the `videos/` prefix, so `<uuid>.<ext>` becomes
 * `videos/<uuid>.<ext>`. Returns null if the URL doesn't fit the pattern.
 */
function s3KeyFromUploadsUrl(rawUrl: string): string | null {
  const path = pathFromUrl(rawUrl);
  if (!path) return null;
  const m = path.match(/^\/api\/uploads\/([^/?#]+)$/i);
  if (!m) return null;
  const filename = decodeURIComponent(m[1]!);
  if (filename.includes("..") || filename.includes("/")) return null;
  return `videos/${filename}`;
}

/**
 * Extract the video id from a legacy `/api/videos/<uuid>/source` URL. Those
 * URLs are the redirect endpoint that historically issued a 302 to a freshly
 * signed S3 URL — the engine resolves them inline via a DB lookup so the
 * client is never asked to follow a redirect.
 */
function videoIdFromSourceUrl(rawUrl: string): string | null {
  const path = pathFromUrl(rawUrl);
  if (!path) return null;
  const m = path.match(/^\/api\/videos\/([0-9a-fA-F-]{8,64})\/source$/);
  return m ? m[1]! : null;
}

/** Returns now + ttl in epoch ms (matches the expiry the presigner mints). */
function expiryFromNow(ttlSec: number): number {
  return Date.now() + ttlSec * 1000;
}

export async function resolvePlaybackSource(
  item: Pick<BroadcastItem, "videoSource" | "youtubeId" | "localVideoUrl">,
): Promise<PlaybackSource | null> {
  if (item.videoSource === "youtube" && item.youtubeId) {
    return { kind: "youtube", url: item.youtubeId, expiresAtMs: null };
  }

  const raw = item.localVideoUrl?.trim();
  if (!raw) return null;

  // HLS manifest — leave untouched. The manifest URL is small and re-issued
  // every viewer; the segments inside are CDN-cacheable on their own.
  if (isHlsUrl(raw)) {
    return {
      kind: "hls",
      url: raw,
      expiresAtMs: null,
    };
  }

  // 1. /api/uploads/<uuid>.<ext>  →  presign videos/<uuid>.<ext>
  const uploadsKey = s3KeyFromUploadsUrl(raw);
  if (uploadsKey && isS3Configured()) {
    try {
      const signed = await getSignedGetUrl(uploadsKey, SIGNED_URL_TTL_SEC);
      return {
        kind: "mp4",
        url: signed,
        expiresAtMs: expiryFromNow(SIGNED_URL_TTL_SEC),
      };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), s3Key: uploadsKey },
        "playback.resolvePlaybackSource: presign failed; falling back to raw URL",
      );
    }
  }

  // 2. /api/videos/<id>/source  →  DB lookup for objectPath, then presign
  const videoId = videoIdFromSourceUrl(raw);
  if (videoId && isS3Configured()) {
    try {
      const rows = await db
        .select({ objectPath: videosTable.objectPath })
        .from(videosTable)
        .where(eq(videosTable.id, videoId))
        .limit(1);
      const objectPath = rows[0]?.objectPath?.trim();
      if (objectPath) {
        const signed = await getSignedGetUrl(objectPath, SIGNED_URL_TTL_SEC);
        return {
          kind: "mp4",
          url: signed,
          expiresAtMs: expiryFromNow(SIGNED_URL_TTL_SEC),
        };
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), videoId },
        "playback.resolvePlaybackSource: video-source lookup failed",
      );
    }
  }

  // 3. Already-signed S3 URL or third-party absolute URL — pass through.
  return {
    kind: "mp4",
    url: raw,
    expiresAtMs: null,
  };
}
