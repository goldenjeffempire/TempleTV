import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { logger } from "../../infrastructure/logger.js";
import { trackQuota } from "../youtube-sync/youtube-sync.service.js";

/**
 * YouTube channel content proxy for @TEMPLETVJCTM.
 *
 * Priority:
 *   1. YouTube Data API v3  — full library (all videos, duration, view counts)
 *      Used when YOUTUBE_API_KEY is set. Paginates through the channel's
 *      uploads playlist so ALL videos are returned, not just the RSS-capped 15.
 *   2. RSS feed fallback    — last ~15 videos only (no API key needed)
 *
 * In-memory cache with 10-minute TTL to avoid quota burn on every page load.
 *
 * Routes (mounted under /youtube):
 *   GET /api/youtube/rss     → raw YouTube RSS XML (proxied, RSS only)
 *   GET /api/youtube/videos  → full video list as ApiVideo JSON
 */

// Prefer the operator-configured YOUTUBE_CHANNEL_ID env var so the channel
// can be updated without a code change. Fall back to the known Temple TV ID.
const CHANNEL_ID = env.YOUTUBE_CHANNEL_ID ?? "UCPFFvkE-KGpR37qJgvYriJg";
const RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const YT_API_BASE = "https://www.googleapis.com/youtube/v3";

interface ApiVideo {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string;
  channelName: string;
  duration: string;
  viewCount: string;
}

// --------------------------------------------------------------------------
// In-memory cache (shared between RSS and API paths)
// --------------------------------------------------------------------------
let cachedVideos: ApiVideo[] | null = null;
let cacheExpiresAt = 0;
let cachedXml: string | null = null;
let xmlCacheExpiresAt = 0;

// --------------------------------------------------------------------------
// YouTube Data API v3 — full library fetch
// --------------------------------------------------------------------------

async function getUploadsPlaylistId(apiKey: string): Promise<string> {
  const url = `${YT_API_BASE}/channels?part=contentDetails&id=${CHANNEL_ID}&key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  trackQuota("channels.list", 1);
  if (!res.ok) throw new Error(`channels API responded ${res.status}`);
  const data = await res.json() as {
    items?: { contentDetails: { relatedPlaylists: { uploads: string } } }[]
  };
  const playlistId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error("Could not retrieve uploads playlist ID");
  return playlistId;
}

interface PlaylistItem {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string;
}

async function getAllPlaylistItems(
  playlistId: string,
  apiKey: string,
): Promise<PlaylistItem[]> {
  const items: PlaylistItem[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      part: "snippet",
      playlistId,
      maxResults: "50",
      key: apiKey,
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await fetch(`${YT_API_BASE}/playlistItems?${params}`, {
      signal: AbortSignal.timeout(12_000),
    });
    trackQuota("playlistItems.list", 1);
    if (!res.ok) throw new Error(`playlistItems API responded ${res.status}`);
    const data = await res.json() as {
      nextPageToken?: string;
      items?: {
        snippet: {
          resourceId: { videoId: string };
          title: string;
          description: string;
          publishedAt: string;
          thumbnails?: {
            maxres?: { url: string };
            high?: { url: string };
            medium?: { url: string };
            default?: { url: string };
          };
        };
      }[];
    };

    for (const item of data.items ?? []) {
      const s = item.snippet;
      const videoId = s.resourceId.videoId;
      // Skip deleted/private videos (YouTube fills title with "Deleted video" / "Private video")
      if (!videoId || s.title === "Deleted video" || s.title === "Private video") continue;
      const thumb =
        s.thumbnails?.maxres?.url ??
        s.thumbnails?.high?.url ??
        s.thumbnails?.medium?.url ??
        s.thumbnails?.default?.url ??
        `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
      items.push({
        videoId,
        title: s.title,
        description: s.description ?? "",
        publishedAt: s.publishedAt,
        thumbnailUrl: thumb,
      });
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  return items;
}

interface VideoDetails {
  duration: string;
  viewCount: string;
}

async function getVideoDetails(
  videoIds: string[],
  apiKey: string,
): Promise<Map<string, VideoDetails>> {
  const map = new Map<string, VideoDetails>();
  // API allows up to 50 IDs per request
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const params = new URLSearchParams({
      part: "contentDetails,statistics",
      id: batch.join(","),
      key: apiKey,
    });
    try {
      const res = await fetch(`${YT_API_BASE}/videos?${params}`, {
        signal: AbortSignal.timeout(12_000),
      });
      trackQuota("videos.list", 1);
      if (!res.ok) continue;
      const data = await res.json() as {
        items?: {
          id: string;
          contentDetails: { duration: string };
          statistics: { viewCount?: string };
        }[];
      };
      for (const item of data.items ?? []) {
        map.set(item.id, {
          duration: item.contentDetails?.duration ?? "",
          viewCount: item.statistics?.viewCount ?? "",
        });
      }
    } catch (err) {
      logger.warn({ err }, "youtube-channel: video details batch failed (non-fatal)");
    }
  }
  return map;
}

async function fetchAllVideosViaApi(apiKey: string): Promise<ApiVideo[]> {
  const playlistId = await getUploadsPlaylistId(apiKey);
  const items = await getAllPlaylistItems(playlistId, apiKey);
  const videoIds = items.map((v) => v.videoId);
  const details = await getVideoDetails(videoIds, apiKey);

  return items.map((item) => {
    const d = details.get(item.videoId);
    return {
      videoId: item.videoId,
      title: item.title,
      description: item.description,
      publishedAt: item.publishedAt,
      thumbnailUrl: item.thumbnailUrl,
      channelName: "Temple TV JCTM",
      duration: d?.duration ?? "",
      viewCount: d?.viewCount ?? "",
    };
  });
}

// --------------------------------------------------------------------------
// RSS fallback
// --------------------------------------------------------------------------

interface RssVideo {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string;
  channelName: string;
}

function extractTag(xml: string, tag: string): string {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(pattern);
  return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "";
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const pattern = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i");
  const match = xml.match(pattern);
  return match ? match[1] : "";
}

function parseRss(xml: string): RssVideo[] {
  const videos: RssVideo[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(xml)) !== null) {
    const entry = match[1];
    const videoIdMatch = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (!videoIdMatch) continue;
    const videoId = videoIdMatch[1].trim();
    const title = extractTag(entry, "title") || extractTag(entry, "media:title");
    const publishedAt = extractTag(entry, "published");
    const description = extractTag(entry, "media:description") || "";
    const thumbnailUrl =
      extractAttr(entry, "media:thumbnail", "url") ||
      `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    const channelName = extractTag(entry, "name") || "Temple TV JCTM";
    if (videoId && title) {
      videos.push({ videoId, title, description, publishedAt, thumbnailUrl, channelName });
    }
  }
  return videos;
}

async function fetchRss(): Promise<string> {
  const now = Date.now();
  if (cachedXml && now < xmlCacheExpiresAt) return cachedXml;
  const res = await fetch(RSS_URL, {
    signal: AbortSignal.timeout(12_000),
    headers: { Accept: "application/xml, text/xml, */*", "User-Agent": "TempleTV-API/1.0" },
  });
  if (!res.ok) throw new Error(`YouTube RSS responded ${res.status}`);
  const xml = await res.text();
  if (!xml.includes("<entry>")) throw new Error("RSS feed returned no entries");
  cachedXml = xml;
  xmlCacheExpiresAt = now + CACHE_TTL_MS;
  return xml;
}

// --------------------------------------------------------------------------
// Main cached fetch — API preferred, RSS fallback
// --------------------------------------------------------------------------

async function fetchVideos(): Promise<ApiVideo[]> {
  const now = Date.now();
  if (cachedVideos && now < cacheExpiresAt) return cachedVideos;

  const apiKey = env.YOUTUBE_API_KEY;

  if (apiKey) {
    try {
      logger.info("youtube-channel: fetching full library via Data API v3");
      const videos = await fetchAllVideosViaApi(apiKey);
      logger.info({ count: videos.length }, "youtube-channel: Data API fetch complete");
      cachedVideos = videos;
      cacheExpiresAt = now + CACHE_TTL_MS;
      return videos;
    } catch (err) {
      logger.warn({ err }, "youtube-channel: Data API failed, falling back to RSS");
    }
  }

  // RSS fallback
  const xml = await fetchRss();
  const rssVideos = parseRss(xml);
  const videos: ApiVideo[] = rssVideos.map((v) => ({
    videoId: v.videoId,
    title: v.title,
    description: v.description,
    publishedAt: v.publishedAt,
    thumbnailUrl: v.thumbnailUrl,
    channelName: v.channelName,
    duration: "",
    viewCount: "",
  }));
  cachedVideos = videos;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return videos;
}

// --------------------------------------------------------------------------
// Route handlers
// --------------------------------------------------------------------------

export async function youtubeChannelRoutes(app: FastifyInstance) {
  /**
   * GET /api/youtube/rss
   * Proxies the YouTube RSS XML so web clients avoid CORS.
   */
  app.get("/rss", async (_req, reply) => {
    try {
      const xml = await fetchRss();
      reply
        .header("Content-Type", "application/xml; charset=utf-8")
        .header("Cache-Control", "public, max-age=300, stale-while-revalidate=600")
        .send(xml);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "youtube-channel: RSS proxy failed");
      reply.code(502).send({ error: "Failed to fetch YouTube RSS", detail: message });
    }
  });

  /**
   * GET /api/youtube/videos
   * Returns the channel's complete video library.
   * Uses YouTube Data API v3 when YOUTUBE_API_KEY is set (all videos),
   * otherwise falls back to RSS (last ~15 videos only).
   */
  app.get("/videos", async (_req, reply) => {
    try {
      const videos = await fetchVideos();
      reply
        .header("Cache-Control", "public, max-age=300, stale-while-revalidate=600")
        .send({
          videos,
          total: videos.length,
          source: env.YOUTUBE_API_KEY ? "youtube_api" : "rss",
          channelId: CHANNEL_ID,
        });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "youtube-channel: videos endpoint failed");
      reply.code(502).send({ error: "Failed to load YouTube videos", detail: message });
    }
  });
}
