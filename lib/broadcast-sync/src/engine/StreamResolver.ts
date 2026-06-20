/**
 * StreamResolver — Resolves a queue item to a concrete playable URL.
 *
 * Priority order (MP4-first policy — HLS is async optimization, not a gate):
 *   1. Raw MP4 / local video URL   — immediately available post-upload
 *   2. HLS master playlist (.m3u8) — only when no MP4 is present
 *   3. YouTube embed ID            — iframe-based, limited platform support
 *
 * This module is a stateless utility — no instances, no side effects.
 */

import type { BroadcastNextItem } from "@workspace/broadcast-types";

export type ResolvedSourceKind = "hls" | "mp4" | "youtube" | "unknown";

export interface ResolvedSource {
  kind:   ResolvedSourceKind;
  url:    string;
  /** True when the URL came from the HLS transcoder output. */
  isHls:  boolean;
  /** True when the URL is a YouTube video ID (not an HTTP URL). */
  isYt:   boolean;
}

/**
 * Resolve an item to its best available playable source.
 * Returns null if no playable URL can be determined.
 */
export function resolveSource(
  item: BroadcastNextItem | null | undefined,
): ResolvedSource | null {
  if (!item) return null;

  if (item.localVideoUrl) {
    const isHlsExt = /\.m3u8(\?|$)/i.test(item.localVideoUrl);
    return {
      kind:  isHlsExt ? "hls" : "mp4",
      url:   item.localVideoUrl,
      isHls: isHlsExt,
      isYt:  false,
    };
  }

  if (item.hlsMasterUrl) {
    return { kind: "hls", url: item.hlsMasterUrl, isHls: true, isYt: false };
  }

  if (item.youtubeId) {
    return { kind: "youtube", url: item.youtubeId, isHls: false, isYt: true };
  }

  return null;
}

/**
 * Returns true when the given URL is a plain MP4/WebM/MOV (not HLS).
 * Used by players to decide between hls.js and native <video> src assignment.
 */
export function isPlainVideoUrl(url: string): boolean {
  if (/\.(mp4|webm|ogg|mov|avi|mkv|m4v|flv|wmv|ts)(\?[^#]*)?$/i.test(url)) return true;
  if (/\/api\/videos\/[^/]+\/source(\?[^#]*)?$/.test(url)) return true;
  if (/\/api\/uploads\/[^/]+(?!\.(m3u8|ts))(\?[^#]*)?$/.test(url)) return true;
  return false;
}

/**
 * Determine the best available source URL from an item, applying an optional
 * URL normalizer (mobile: relative → absolute).
 */
export function resolveUrl(
  item: BroadcastNextItem | null | undefined,
  normalizeUrl?: (u: string) => string,
): string | null {
  const src = resolveSource(item);
  if (!src || src.isYt) return null;
  return normalizeUrl ? normalizeUrl(src.url) : src.url;
}
