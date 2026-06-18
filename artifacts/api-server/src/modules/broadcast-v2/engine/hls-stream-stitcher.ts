/**
 * HLS Broadcast Stream Stitcher
 *
 * Generates a live HLS manifest that stitches the current and next broadcast
 * queue items into a single continuously-playing stream. Mobile and TV clients
 * can subscribe to this URL and receive uninterrupted playback across item
 * boundaries — no client-side rebinding, no black-screen gaps.
 *
 * Architecture:
 *   - Reads current + next items from the orchestrator snapshot
 *   - For HLS items: fetches variant playlist via localhost (bypasses CDN auth)
 *   - Calculates remaining segments from elapsed wall-clock time (startsAtMs)
 *   - Stitches remaining current segments + first N next-item segments
 *     with #EXT-X-DISCONTINUITY between items
 *   - Live manifest (no EXT-X-ENDLIST): HLS player re-fetches every
 *     targetDuration seconds and always gets fresh segments
 *   - Result cached for STITCH_CACHE_MS (2 s), invalidated on item advance
 *
 * Served at: GET /api/broadcast-v2/stream.m3u8
 */

import { env } from "../../../config/env.js";
import { logger } from "../../../infrastructure/logger.js";
import { withHlsToken } from "../../../shared/hls-token.js";
import { broadcastOrchestrator } from "./broadcast-orchestrator.js";
import type { V2Item } from "../domain/types.js";

const STITCH_CACHE_MS = 2_000;
const FETCH_TIMEOUT_MS = 5_000;
/**
 * Number of next-item segments to include in the stitched manifest so
 * the HLS player can pre-buffer the transition before it re-fetches.
 * 6 × ~6 s segments = 36 s look-ahead — enough to cover any manifest
 * re-fetch interval without pre-loading too much of the next item.
 */
const NEXT_ITEM_SEGMENT_LOOKAHEAD = 6;

interface ParsedPlaylist {
  segments: Array<{ uri: string; duration: number }>;
  targetDuration: number;
  mediaSequence: number;
}

interface StitchCache {
  manifest: string;
  generatedAtMs: number;
  currentItemId: string;
}

let _stitchCache: StitchCache | null = null;

// ── URL helpers ───────────────────────────────────────────────────────────────

/**
 * Convert any URL pointing to our own API into a 127.0.0.1:{PORT} URL so
 * segment fetches stay in-process and never round-trip through CDN or DNS.
 */
function toLocalUrl(url: string): string {
  const port = env.PORT ?? 8080;
  if (url.startsWith("/")) return `http://127.0.0.1:${port}${url}`;
  try {
    const u = new URL(url);
    const ownHosts = [
      env.API_ORIGIN,
      process.env["RENDER_EXTERNAL_URL"],
      process.env["REPLIT_DEV_DOMAIN"]
        ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
        : null,
    ]
      .filter(Boolean)
      .map((h) => {
        try {
          return new URL(h!).hostname;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (
      ownHosts.includes(u.hostname) ||
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1"
    ) {
      u.hostname = "127.0.0.1";
      u.port = String(port);
      u.protocol = "http:";
      return u.toString();
    }
  } catch {
    /* not parseable — fall through and return as-is */
  }
  return url;
}

/**
 * Base URL (directory) of a given URL — used to resolve relative segment URIs.
 */
function baseUrl(url: string): string {
  return url.replace(/[^/]+(\?.*)?$/, "");
}

// ── HLS parsing ───────────────────────────────────────────────────────────────

/**
 * Fetch an HLS master playlist and resolve it to the best (highest-bandwidth)
 * variant playlist URL. Returns null on any fetch / parse failure.
 */
async function resolveMasterToVariant(masterUrl: string): Promise<string | null> {
  const localUrl = toLocalUrl(masterUrl);
  const tokenUrl = withHlsToken(localUrl);

  let text: string;
  try {
    const res = await fetch(tokenUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/vnd.apple.mpegurl, */*" },
    });
    if (!res.ok) return null;
    text = await res.text();
  } catch {
    return null;
  }

  if (!text.includes("#EXTM3U")) return null;

  // If the playlist already has #EXTINF it's already a variant — return as-is
  if (text.includes("#EXTINF")) return localUrl;

  // Parse #EXT-X-STREAM-INF lines for BANDWIDTH= and the following URI
  const lines = text.split("\n");
  let bestBandwidth = -1;
  let bestUri: string | null = null;
  let nextBandwidth = -1;

  for (const line of lines) {
    const bwm = line.match(/BANDWIDTH=(\d+)/i);
    if (bwm) {
      nextBandwidth = parseInt(bwm[1]!, 10);
      continue;
    }
    if (!line.startsWith("#") && line.trim()) {
      if (nextBandwidth > bestBandwidth) {
        bestBandwidth = nextBandwidth;
        bestUri = line.trim();
      }
      nextBandwidth = -1;
    }
  }

  if (!bestUri) return null;

  if (bestUri.startsWith("http")) return toLocalUrl(bestUri);
  return baseUrl(localUrl) + bestUri;
}

/**
 * Fetch a variant HLS playlist and return parsed segments with absolute
 * localhost-rewritten URIs (safe for server-internal re-fetching by the
 * stitcher, and correct absolute URLs for inclusion in the manifest response).
 */
async function fetchVariantPlaylist(
  variantUrl: string,
): Promise<ParsedPlaylist | null> {
  const localUrl = toLocalUrl(variantUrl);
  const tokenUrl = withHlsToken(localUrl);

  let text: string;
  try {
    const res = await fetch(tokenUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/vnd.apple.mpegurl, */*" },
    });
    if (!res.ok) return null;
    text = await res.text();
  } catch {
    return null;
  }

  const lines = text.split("\n");
  const segments: Array<{ uri: string; duration: number }> = [];
  let targetDuration = 6;
  let mediaSequence = 0;
  let nextDuration = 0;
  const variantBase = baseUrl(localUrl);

  for (const line of lines) {
    const tdm = line.match(/^#EXT-X-TARGETDURATION:(\d+)/);
    if (tdm) { targetDuration = parseInt(tdm[1]!, 10); continue; }

    const msm = line.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    if (msm) { mediaSequence = parseInt(msm[1]!, 10); continue; }

    const infm = line.match(/^#EXTINF:([\d.]+)/);
    if (infm) { nextDuration = parseFloat(infm[1]!); continue; }

    if (nextDuration > 0 && line.trim() && !line.startsWith("#")) {
      const seg = line.trim();
      // Resolve to absolute localhost URL and re-inject HLS token
      const absUri = seg.startsWith("http")
        ? withHlsToken(toLocalUrl(seg))
        : withHlsToken(variantBase + seg);
      segments.push({ uri: absUri, duration: nextDuration });
      nextDuration = 0;
    }
  }

  return { segments, targetDuration, mediaSequence };
}

// ── Segment slicer ────────────────────────────────────────────────────────────

/**
 * Return only the segments that have not yet played for a given queue item.
 * Always retains at least 1 segment so the manifest is never empty for a
 * just-started item.
 */
async function getRemainingSegments(item: V2Item): Promise<ParsedPlaylist | null> {
  if (item.source.kind !== "hls") return null;

  const variantUrl = await resolveMasterToVariant(item.source.url);
  if (!variantUrl) return null;

  const playlist = await fetchVariantPlaylist(variantUrl);
  if (!playlist || playlist.segments.length === 0) return null;

  const elapsedSecs = Math.max(0, (Date.now() - item.startsAtMs) / 1_000);
  let cumulativeSecs = 0;
  let firstIdx = 0;

  for (let i = 0; i < playlist.segments.length; i++) {
    if (cumulativeSecs >= elapsedSecs) {
      firstIdx = i;
      break;
    }
    cumulativeSecs += playlist.segments[i]!.duration;
    firstIdx = i + 1;
  }

  // Always expose at least 1 segment — clamp to length - 1
  firstIdx = Math.min(firstIdx, Math.max(0, playlist.segments.length - 1));

  return {
    ...playlist,
    segments: playlist.segments.slice(firstIdx),
    mediaSequence: playlist.mediaSequence + firstIdx,
  };
}

/**
 * Return the first N segments of a queue item (for look-ahead stitching).
 */
async function getLeadingSegments(
  item: V2Item,
  limit: number,
): Promise<ParsedPlaylist | null> {
  if (item.source.kind !== "hls") return null;

  const variantUrl = await resolveMasterToVariant(item.source.url);
  if (!variantUrl) return null;

  const playlist = await fetchVariantPlaylist(variantUrl);
  if (!playlist || playlist.segments.length === 0) return null;

  return { ...playlist, segments: playlist.segments.slice(0, limit) };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate and return the stitched live HLS broadcast manifest.
 *
 * Returns null when:
 *   - The orchestrator has no running snapshot
 *   - There is no current item on air
 *   - The current item's source is not HLS
 *   - The HLS fetch fails within the timeout
 */
export async function getStitchedBroadcastManifest(): Promise<string | null> {
  const now = Date.now();
  const snapshot = broadcastOrchestrator.snapshot();
  const current = snapshot?.current;

  if (!current || current.source.kind !== "hls") return null;

  // Return fresh cached manifest if still valid for this item
  if (
    _stitchCache &&
    _stitchCache.currentItemId === current.id &&
    now - _stitchCache.generatedAtMs < STITCH_CACHE_MS
  ) {
    return _stitchCache.manifest;
  }

  const next = snapshot?.next;

  // Fetch playlists concurrently — next item look-ahead is non-blocking
  const [currentPlaylist, nextPlaylist] = await Promise.all([
    getRemainingSegments(current),
    next?.source.kind === "hls"
      ? getLeadingSegments(next, NEXT_ITEM_SEGMENT_LOOKAHEAD)
      : Promise.resolve(null),
  ]);

  if (!currentPlaylist || currentPlaylist.segments.length === 0) return null;

  const targetDuration = Math.max(
    currentPlaylist.targetDuration,
    nextPlaylist?.targetDuration ?? 0,
  );

  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${currentPlaylist.mediaSequence}`,
    "#EXT-X-ALLOW-CACHE:NO",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-PROGRAM-DATE-TIME:${new Date(current.startsAtMs).toISOString()}`,
  ];

  for (const seg of currentPlaylist.segments) {
    lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
    lines.push(seg.uri);
  }

  if (nextPlaylist && nextPlaylist.segments.length > 0 && next) {
    lines.push("#EXT-X-DISCONTINUITY");
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(next.startsAtMs).toISOString()}`);
    for (const seg of nextPlaylist.segments) {
      lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
      lines.push(seg.uri);
    }
  }

  const manifest = lines.join("\n") + "\n";
  _stitchCache = { manifest, generatedAtMs: now, currentItemId: current.id };

  logger.debug(
    {
      currentItemId: current.id,
      currentSegs: currentPlaylist.segments.length,
      nextSegs: nextPlaylist?.segments.length ?? 0,
      mediaSequence: currentPlaylist.mediaSequence,
    },
    "[hls-stitcher] broadcast manifest generated",
  );

  return manifest;
}

/**
 * Invalidate the stitch cache. Called when the orchestrator advances to a
 * new item so the next manifest request immediately reflects the new state
 * rather than serving stale current-item segments.
 */
export function invalidateStitchCache(): void {
  _stitchCache = null;
}
