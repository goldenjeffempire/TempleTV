import { Router } from "express";
import { db, pushTokensTable, notificationsTable } from "@workspace/db";
import { randomUUID } from "crypto";
import {
  broadcastLiveEvent,
  addSSEClient,
  removeSSEClient,
  startSSEHeartbeat,
  type LiveStatusSnapshot,
} from "../lib/liveEvents";
import { emitBroadcastState } from "./broadcast";
import { cache } from "../lib/cache";
import { logger } from "../lib/logger";

const router = Router();

const CHANNEL_ID = "UCPFFvkE-KGpR37qJgvYriJg";
const CHANNEL_HANDLE = "templetvjctm";
const UPLOADS_PLAYLIST_ID = "UUPFFvkE-KGpR37qJgvYriJg";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY ?? "";

const BROWSER_HEADERS = {
  Accept: "application/xml, text/xml, */*",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes in ms
const YOUTUBE_VIDEOS_CACHE_KEY = "youtube:videos";
const YOUTUBE_RSS_CACHE_KEY = "youtube:rss";
const LIVE_POLL_NORMAL_MS = 60 * 1000;
const LIVE_POLL_BURST_MS = 15 * 1000;
const BURST_WINDOW_MS = 10 * 60 * 1000;
const EXPO_PUSH_API = "https://exp.host/--/api/v2/push/send";

export interface LiveStatus {
  isLive: boolean;
  videoId: string | null;
  title: string | null;
  checkedAt: number;
  detectionMethod?: string;
}

let cachedLiveStatus: LiveStatus = {
  isLive: false,
  videoId: null,
  title: null,
  checkedAt: 0,
};

let lastStateChangeAt = 0;
let lastNotifiedVideoId: string | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let liveSessionStartedAt: number | null = null;
let currentPollIntervalMs = LIVE_POLL_NORMAL_MS;
let currentViewerCount: number | null = null;

export interface LiveEventRecord {
  ts: number;
  isLive: boolean;
  videoId: string | null;
  title: string | null;
  method: string | null;
}

export interface ViewerSnapshot {
  ts: number;
  count: number;
}

const MAX_HISTORY = 50;
const MAX_VIEWER_SNAPSHOTS = 120;
const liveHistory: LiveEventRecord[] = [];
const viewerHistory: ViewerSnapshot[] = [];

export function getLiveStatus(): LiveStatus {
  return { ...cachedLiveStatus };
}

export function getLiveMonitorData() {
  const uptimeSecs =
    cachedLiveStatus.isLive && liveSessionStartedAt
      ? Math.floor((Date.now() - liveSessionStartedAt) / 1000)
      : 0;
  return {
    current: {
      ...cachedLiveStatus,
      staleSec: Math.floor((Date.now() - cachedLiveStatus.checkedAt) / 1000),
      uptimeSecs,
      liveSessionStartedAt,
      viewerCount: currentViewerCount,
    },
    polling: {
      intervalMs: currentPollIntervalMs,
      mode: currentPollIntervalMs === LIVE_POLL_BURST_MS ? "burst" : "normal",
      lastStateChangeAt,
    },
    history: [...liveHistory].reverse(),
    viewerHistory: [...viewerHistory],
  };
}

async function checkViaOembed(): Promise<{ isLive: boolean; videoId: string | null; title: string | null }> {
  const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/@${CHANNEL_HANDLE}/live&format=json`;
  const response = await fetch(oembedUrl, {
    signal: AbortSignal.timeout(6000),
    headers: BROWSER_HEADERS,
  });
  if (!response.ok) return { isLive: false, videoId: null, title: null };
  const data = (await response.json()) as { title?: string; thumbnail_url?: string };
  const title = data.title ?? null;
  const thumbnailUrl = data.thumbnail_url ?? "";
  const videoIdMatch = thumbnailUrl.match(/\/vi\/([^/]+)\//);
  const videoId = videoIdMatch ? videoIdMatch[1] : null;
  const isLive = !!videoId && !!title;
  return { isLive, videoId, title };
}

async function checkViaYouTubeLivePage(): Promise<{ isLive: boolean; videoId: string | null; title: string | null }> {
  const url = `https://www.youtube.com/@${CHANNEL_HANDLE}/live`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: {
      ...BROWSER_HEADERS,
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) return { isLive: false, videoId: null, title: null };
  const html = await response.text();

  const isLiveMatch = html.match(/"isLiveNow"\s*:\s*true/);
  const videoIdMatch = html.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
  const titleMatch = html.match(/"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]+)"/);

  if (isLiveMatch && videoIdMatch) {
    return {
      isLive: true,
      videoId: videoIdMatch[1] ?? null,
      title: titleMatch?.[1] ?? "Live Stream",
    };
  }
  return { isLive: false, videoId: null, title: null };
}

async function scrapeViewerCount(videoId: string): Promise<number | null> {
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { ...BROWSER_HEADERS, Accept: "text/html,application/xhtml+xml" },
    });
    if (!response.ok) return null;
    const html = await response.text();

    const patterns = [
      /"concurrentViewers"\s*:\s*"(\d+)"/,
      /"viewCount"\s*:\s*\{\s*"videoViewCountRenderer"\s*:\s*\{\s*"viewCount"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([\d,]+)/,
      /"viewCount"\s*:\s*"(\d+)"/,
      /"watching_now"\s*:\s*(\d+)/,
      /(\d[\d,]*)\s+(?:watching|viewers?\s+now)/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        const count = parseInt(match[1].replace(/,/g, ""), 10);
        if (!isNaN(count) && count > 0) return count;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function checkYouTubeLive(): Promise<{ isLive: boolean; videoId: string | null; title: string | null; method: string }> {
  try {
    const result = await checkViaOembed();
    if (result.isLive) return { ...result, method: "oembed" };
  } catch {}

  try {
    const result = await checkViaYouTubeLivePage();
    if (result.isLive) return { ...result, method: "live-page" };
  } catch {}

  return { isLive: false, videoId: null, title: null, method: "all-failed" };
}

async function sendLiveAutoNotification(title: string, videoId: string | null) {
  try {
    const tokenRows = await db.select({ token: pushTokensTable.token }).from(pushTokensTable);
    const tokens = tokenRows.map((r) => r.token);
    if (tokens.length === 0) return;

    const messages = tokens.map((token) => ({
      to: token,
      title: "🔴 Temple TV is LIVE!",
      body: title,
      sound: "default",
      data: { type: "live", ...(videoId ? { videoId } : {}) },
    }));

    let sent = 0;
    let failed = 0;
    const CHUNK_SIZE = 100;
    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
      const chunk = messages.slice(i, i + CHUNK_SIZE);
      try {
        const res = await fetch(EXPO_PUSH_API, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(chunk),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const result = (await res.json()) as { data?: Array<{ status: string }> };
          for (const s of result.data ?? []) {
            if (s.status === "ok") sent++;
            else failed++;
          }
        } else {
          failed += chunk.length;
        }
      } catch {
        failed += chunk.length;
      }
    }

    await db.insert(notificationsTable).values({
      id: randomUUID(),
      title: "Temple TV is LIVE!",
      body: title,
      type: "live",
      videoId: videoId ?? null,
      sentCount: sent,
    });

    logger.info({ sent, total: tokens.length }, "[LivePoller] Auto-notification sent");
  } catch (err) {
    logger.error({ err }, "[LivePoller] Failed to send auto-notification");
  }
}

async function pollLiveStatus() {
  const result = await checkYouTubeLive();
  const wasLive = cachedLiveStatus.isLive;
  const previousVideoId = cachedLiveStatus.videoId;

  const stateChanged = result.isLive !== wasLive || result.videoId !== previousVideoId;
  const now = Date.now();

  cachedLiveStatus = {
    isLive: result.isLive,
    videoId: result.videoId,
    title: result.title,
    checkedAt: now,
    detectionMethod: result.method,
  };

  if (stateChanged) {
    lastStateChangeAt = now;

    if (result.isLive && !wasLive) {
      liveSessionStartedAt = now;
      viewerHistory.length = 0;
    } else if (!result.isLive && wasLive) {
      liveSessionStartedAt = null;
      currentViewerCount = null;
    }

    const record: LiveEventRecord = {
      ts: now,
      isLive: result.isLive,
      videoId: result.videoId,
      title: result.title,
      method: result.method,
    };
    liveHistory.push(record);
    if (liveHistory.length > MAX_HISTORY) liveHistory.shift();

    broadcastLiveEvent("yt-status", {
      isLive: result.isLive,
      videoId: result.videoId,
      title: result.title,
      checkedAt: cachedLiveStatus.checkedAt,
    });
    emitBroadcastState("youtube-live-changed", {
      isLive: result.isLive,
      videoId: result.videoId,
      title: result.title,
      checkedAt: cachedLiveStatus.checkedAt,
    });
  }

  if (result.isLive && result.videoId) {
    const count = await scrapeViewerCount(result.videoId);
    if (count !== null) {
      currentViewerCount = count;
      viewerHistory.push({ ts: now, count });
      if (viewerHistory.length > MAX_VIEWER_SNAPSHOTS) viewerHistory.shift();
    }
  }

  const justWentLive = result.isLive && (!wasLive || result.videoId !== previousVideoId);
  const isNewStream = result.isLive && result.videoId && result.videoId !== lastNotifiedVideoId;

  if (justWentLive && isNewStream && result.title) {
    lastNotifiedVideoId = result.videoId;
    logger.info(
      { method: result.method, title: result.title, videoId: result.videoId },
      "[LivePoller] New live stream detected",
    );
    await sendLiveAutoNotification(result.title, result.videoId);
  }

  const isInBurstWindow = now - lastStateChangeAt < BURST_WINDOW_MS;
  currentPollIntervalMs = isInBurstWindow ? LIVE_POLL_BURST_MS : LIVE_POLL_NORMAL_MS;

  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(pollLiveStatus, currentPollIntervalMs);
}

pollLiveStatus();
startSSEHeartbeat();

interface VideoItem {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string;
  channelName: string;
  duration: string;
  viewCount: string;
}

// In-memory fallback if Redis not available (cache module handles tier selection)
let _videosCacheFallback: { videos: VideoItem[]; timestamp: number } | null = null;

async function fetchAllVideosFromApi(): Promise<VideoItem[] | null> {
  if (!YOUTUBE_API_KEY) return null;

  try {
    const videos: VideoItem[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        key: YOUTUBE_API_KEY,
        playlistId: UPLOADS_PLAYLIST_ID,
        part: "snippet",
        maxResults: "50",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) {
        const errText = await res.text();
        logger.error({ errText }, "YouTube playlistItems API error");
        return null;
      }

      const data = (await res.json()) as {
        nextPageToken?: string;
        items?: Array<{
          snippet: {
            title: string;
            description: string;
            publishedAt: string;
            channelTitle: string;
            resourceId: { videoId: string };
            thumbnails: {
              high?: { url: string };
              medium?: { url: string };
              default?: { url: string };
            };
          };
        }>;
      };

      const items = data.items ?? [];
      const videoIds = items
        .map((i) => i.snippet?.resourceId?.videoId)
        .filter(Boolean) as string[];

      let detailsMap: Record<string, { duration: string; viewCount: string }> = {};
      if (videoIds.length > 0) {
        const detailParams = new URLSearchParams({
          key: YOUTUBE_API_KEY,
          id: videoIds.join(","),
          part: "contentDetails,statistics",
        });
        const detailRes = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?${detailParams.toString()}`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (detailRes.ok) {
          const detailData = (await detailRes.json()) as {
            items?: Array<{
              id: string;
              contentDetails: { duration: string };
              statistics: { viewCount?: string };
            }>;
          };
          for (const d of detailData.items ?? []) {
            detailsMap[d.id] = {
              duration: d.contentDetails?.duration ?? "",
              viewCount: d.statistics?.viewCount ?? "0",
            };
          }
        }
      }

      for (const item of items) {
        const s = item.snippet;
        const vid = s?.resourceId?.videoId;
        if (!vid) continue;
        const thumb =
          s.thumbnails?.high?.url ||
          s.thumbnails?.medium?.url ||
          s.thumbnails?.default?.url ||
          `https://img.youtube.com/vi/${vid}/hqdefault.jpg`;
        videos.push({
          videoId: vid,
          title: s.title,
          description: s.description,
          publishedAt: s.publishedAt,
          thumbnailUrl: thumb,
          channelName: s.channelTitle || "Temple TV JCTM",
          duration: detailsMap[vid]?.duration ?? "",
          viewCount: detailsMap[vid]?.viewCount ?? "0",
        });
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    return videos.length > 0 ? videos : null;
  } catch (err) {
    logger.error({ err }, "fetchAllVideosFromApi error");
    return null;
  }
}

function videosToXml(videos: VideoItem[]): string {
  const entries = videos
    .map((v) => {
      const safeTitle = v.title
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `
  <entry>
    <yt:videoId>${v.videoId}</yt:videoId>
    <title>${safeTitle}</title>
    <published>${v.publishedAt}</published>
    <media:thumbnail url="${v.thumbnailUrl}"/>
    <media:description><![CDATA[${v.description}]]></media:description>
    <name>${v.channelName}</name>
  </entry>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">${entries}</feed>`;
}

async function fetchDirect(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: BROWSER_HEADERS,
    });
    if (!response.ok) return null;
    const text = await response.text();
    return text.includes("<entry>") ? text : null;
  } catch {
    return null;
  }
}

async function fetchViaAllOrigins(rssUrl: string): Promise<string | null> {
  try {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(rssUrl)}`;
    const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) return null;
    const json = (await response.json()) as { contents?: string };
    const contents = json.contents ?? "";
    return contents.includes("<entry>") ? contents : null;
  } catch {
    return null;
  }
}

async function fetchViaRss2Json(rssUrl: string): Promise<string | null> {
  try {
    const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`;
    const response = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      status: string;
      items?: Array<{
        title: string;
        link: string;
        pubDate: string;
        description: string;
        thumbnail: string;
        author: string;
      }>;
    };
    if (json.status !== "ok" || !json.items?.length) return null;

    const items = json.items
      .map((item) => {
        const vidMatch = item.link.match(/v=([^&]+)/);
        const videoId = vidMatch?.[1] ?? "";
        if (!videoId) return "";
        const thumbUrl =
          item.thumbnail ||
          `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        return `
  <entry>
    <yt:videoId>${videoId}</yt:videoId>
    <title>${item.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</title>
    <published>${item.pubDate}</published>
    <media:thumbnail url="${thumbUrl}"/>
    <media:description><![CDATA[${item.description}]]></media:description>
    <name>${item.author || "Temple TV JCTM"}</name>
  </entry>`;
      })
      .filter(Boolean)
      .join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">${items}</feed>`;
  } catch {
    return null;
  }
}

async function fetchVideosFromRss(): Promise<VideoItem[] | null> {
  const DIRECT_RSS_URLS = [
    `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    `https://www.youtube.com/feeds/videos.xml?user=${CHANNEL_HANDLE}`,
  ];

  let xml: string | null = null;
  for (const url of DIRECT_RSS_URLS) {
    xml = await fetchDirect(url);
    if (xml) break;
  }
  if (!xml) xml = await fetchViaAllOrigins(DIRECT_RSS_URLS[0]!);
  if (!xml) xml = await fetchViaRss2Json(DIRECT_RSS_URLS[0]!);
  if (!xml) return null;

  const videos: VideoItem[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(xml)) !== null) {
    const entry = match[1];
    const videoIdMatch = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (!videoIdMatch) continue;
    const videoId = videoIdMatch[1].trim();
    const titleMatch = entry.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() : "";
    const publishedMatch = entry.match(/<published>([^<]+)<\/published>/i);
    const published = publishedMatch ? publishedMatch[1].trim() : "";
    const thumbMatch = entry.match(/<media:thumbnail[^>]+url="([^"]+)"/i);
    const thumbnailUrl = thumbMatch ? thumbMatch[1] : `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    const descMatch = entry.match(/<media:description[^>]*>([\s\S]*?)<\/media:description>/i);
    const description = descMatch ? descMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "";
    const nameMatch = entry.match(/<name>([^<]+)<\/name>/i);
    const channelName = nameMatch ? nameMatch[1].trim() : "Temple TV JCTM";
    if (videoId && title) {
      videos.push({ videoId, title, description, publishedAt: published, thumbnailUrl, channelName, duration: "", viewCount: "0" });
    }
  }
  return videos.length > 0 ? videos : null;
}

router.get("/youtube/videos", async (req, res) => {
  try {
    const cached = await cache.get<VideoItem[]>(YOUTUBE_VIDEOS_CACHE_KEY);
    if (cached !== null) {
      res.setHeader("X-Cache", "HIT");
      return res.json({ videos: cached, total: cached.length });
    }

    let videos = await fetchAllVideosFromApi();

    if (!videos || videos.length === 0) {
      videos = await fetchVideosFromRss();
    }

    if (!videos || videos.length === 0) {
      // Serve stale memory fallback if available rather than returning an error
      if (_videosCacheFallback) {
        res.setHeader("X-Cache", "STALE");
        return res.json({ videos: _videosCacheFallback.videos, total: _videosCacheFallback.videos.length });
      }
      return res.status(502).json({ error: "Could not fetch videos from YouTube." });
    }

    await cache.set(YOUTUBE_VIDEOS_CACHE_KEY, videos, CACHE_TTL_MS);
    _videosCacheFallback = { videos, timestamp: Date.now() };
    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("X-Source", videos[0]?.duration ? "youtube-api" : "rss");
    return res.json({ videos, total: videos.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/youtube/rss", async (req, res) => {
  try {
    const cachedXml = await cache.get<string>(YOUTUBE_RSS_CACHE_KEY);
    if (cachedXml !== null) {
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("X-Cache", "HIT");
      return res.send(cachedXml);
    }

    if (YOUTUBE_API_KEY) {
      const cachedVideos = await cache.get<VideoItem[]>(YOUTUBE_VIDEOS_CACHE_KEY);
      if (cachedVideos !== null) {
        const xml = videosToXml(cachedVideos);
        await cache.set(YOUTUBE_RSS_CACHE_KEY, xml, CACHE_TTL_MS);
        res.setHeader("Content-Type", "application/xml; charset=utf-8");
        res.setHeader("X-Source", "youtube-api-cached");
        return res.send(xml);
      }
      const videos = await fetchAllVideosFromApi();
      if (videos && videos.length > 0) {
        await cache.set(YOUTUBE_VIDEOS_CACHE_KEY, videos, CACHE_TTL_MS);
        _videosCacheFallback = { videos, timestamp: Date.now() };
        const xml = videosToXml(videos);
        await cache.set(YOUTUBE_RSS_CACHE_KEY, xml, CACHE_TTL_MS);
        res.setHeader("Content-Type", "application/xml; charset=utf-8");
        res.setHeader("X-Source", "youtube-api");
        return res.send(xml);
      }
    }

    const DIRECT_RSS_URLS = [
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
      `https://www.youtube.com/feeds/videos.xml?user=${CHANNEL_HANDLE}`,
    ];

    let xml: string | null = null;
    for (const url of DIRECT_RSS_URLS) {
      xml = await fetchDirect(url);
      if (xml) { res.setHeader("X-Source", "direct"); break; }
    }
    if (!xml) {
      xml = await fetchViaAllOrigins(DIRECT_RSS_URLS[0]!);
      if (xml) res.setHeader("X-Source", "allorigins");
    }
    if (!xml) {
      xml = await fetchViaRss2Json(DIRECT_RSS_URLS[0]!);
      if (xml) res.setHeader("X-Source", "rss2json");
    }

    if (!xml) {
      return res.status(502).json({
        error: "Could not fetch YouTube RSS feed. Fallback data will be used.",
      });
    }

    await cache.set(YOUTUBE_RSS_CACHE_KEY, xml, CACHE_TTL_MS);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.send(xml);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/youtube/live", async (req, res) => {
  try {
    const result = await checkYouTubeLive();
    cachedLiveStatus = {
      isLive: result.isLive,
      videoId: result.videoId,
      title: result.title,
      checkedAt: Date.now(),
      detectionMethod: result.method,
    };
    res.json({ isLive: result.isLive, videoId: result.videoId, title: result.title });
  } catch {
    res.json({ isLive: false, videoId: null, title: null });
  }
});

router.get("/youtube/live/status", (_req, res) => {
  res.json({
    isLive: cachedLiveStatus.isLive,
    videoId: cachedLiveStatus.videoId,
    title: cachedLiveStatus.title,
    checkedAt: cachedLiveStatus.checkedAt,
    staleSec: Math.floor((Date.now() - cachedLiveStatus.checkedAt) / 1000),
    detectionMethod: cachedLiveStatus.detectionMethod,
  });
});

// ---------------------------------------------------------------------------
// Automatic YouTube channel catalogue sync
// ---------------------------------------------------------------------------
// Strategy:
//  1. On server boot run one sync immediately (warmup).
//  2. On warmup we seed the "known video IDs" set from whatever the YouTube
//     API returns so we DON'T spam every legacy video as a "new upload" push.
//  3. Every CATALOGUE_SYNC_INTERVAL_MS thereafter, refresh and detect any
//     IDs not in the set as freshly-uploaded → log + send a push.
//  4. The same routine is reused by the admin-triggered POST endpoint, but
//     callers from the endpoint pass `notifyOnNew=false` (avoid duplicates).
// ---------------------------------------------------------------------------
const CATALOGUE_SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const knownVideoIds = new Set<string>();
let catalogueWarmupComplete = false;
let catalogueSyncTimer: ReturnType<typeof setTimeout> | null = null;
let lastCatalogueSyncAt = 0;
let lastCatalogueSyncResult: {
  ok: boolean;
  total?: number;
  inserted?: number;
  updated?: number;
  newVideoIds?: string[];
  error?: string;
  elapsedMs?: number;
  at: number;
} | null = null;

export function getCatalogueSyncStatus() {
  return {
    lastRunAt: lastCatalogueSyncAt,
    intervalMs: CATALOGUE_SYNC_INTERVAL_MS,
    knownVideoCount: knownVideoIds.size,
    warmupComplete: catalogueWarmupComplete,
    lastResult: lastCatalogueSyncResult,
  };
}

async function sendNewVideoNotification(video: VideoItem) {
  try {
    const tokenRows = await db.select({ token: pushTokensTable.token }).from(pushTokensTable);
    const tokens = tokenRows.map((r) => r.token);
    if (tokens.length === 0) return;

    const messages = tokens.map((token) => ({
      to: token,
      title: "🆕 New on Temple TV",
      body: video.title,
      sound: "default",
      data: { type: "video", videoId: video.videoId },
    }));

    let sent = 0;
    const CHUNK_SIZE = 100;
    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
      const chunk = messages.slice(i, i + CHUNK_SIZE);
      try {
        const res = await fetch(EXPO_PUSH_API, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(chunk),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const result = (await res.json()) as { data?: Array<{ status: string }> };
          for (const s of result.data ?? []) if (s.status === "ok") sent++;
        }
      } catch {
        // ignore per-chunk failure; continue to next chunk
      }
    }

    await db.insert(notificationsTable).values({
      id: randomUUID(),
      title: "New on Temple TV",
      body: video.title,
      type: "video",
      videoId: video.videoId,
      sentCount: sent,
    });

    logger.info({ videoId: video.videoId, sent }, "[YouTubeSync] New-video notification sent");
  } catch (err) {
    logger.error({ err }, "[YouTubeSync] Failed to send new-video notification");
  }
}

export async function runYoutubeCatalogueSync(opts: { notifyOnNew?: boolean } = {}): Promise<{
  ok: boolean;
  total?: number;
  inserted?: number;
  updated?: number;
  newVideoIds?: string[];
  error?: string;
  elapsedMs?: number;
}> {
  const startedAt = Date.now();
  if (!YOUTUBE_API_KEY) {
    const result = { ok: false, error: "youtube_api_key_missing", elapsedMs: 0 };
    lastCatalogueSyncAt = startedAt;
    lastCatalogueSyncResult = { ...result, at: startedAt };
    return result;
  }

  try {
    const fresh = await fetchAllVideosFromApi();
    if (!fresh || fresh.length === 0) {
      const result = { ok: false, error: "youtube_api_unavailable", elapsedMs: Date.now() - startedAt };
      lastCatalogueSyncAt = startedAt;
      lastCatalogueSyncResult = { ...result, at: startedAt };
      return result;
    }

    // Refresh in-memory + redis cache so /youtube/videos serves fast.
    await cache.set(YOUTUBE_VIDEOS_CACHE_KEY, fresh, CACHE_TTL_MS);
    _videosCacheFallback = { videos: fresh, timestamp: Date.now() };

    // Detect new videos relative to the in-memory known-set.
    const newVideos: VideoItem[] = [];
    if (catalogueWarmupComplete) {
      for (const v of fresh) {
        if (!knownVideoIds.has(v.videoId)) newVideos.push(v);
      }
    }
    for (const v of fresh) knownVideoIds.add(v.videoId);

    // Persist to DB so other surfaces (admin/videos table) reflect channel state.
    const { db: dbInstance, videosTable } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");

    let inserted = 0;
    let updated = 0;
    for (const v of fresh) {
      const result = await dbInstance
        .insert(videosTable)
        .values({
          id: randomUUID(),
          youtubeId: v.videoId,
          title: v.title,
          description: v.description ?? "",
          thumbnailUrl: v.thumbnailUrl ?? "",
          duration: v.duration ?? "",
          category: "sermon",
          preacher: "",
          publishedAt: v.publishedAt ?? null,
          viewCount: Number(v.viewCount) || 0,
          featured: false,
          videoSource: "youtube",
        })
        .onConflictDoUpdate({
          target: videosTable.youtubeId,
          set: {
            title: v.title,
            description: v.description ?? "",
            thumbnailUrl: v.thumbnailUrl ?? "",
            duration: v.duration ?? "",
            publishedAt: v.publishedAt ?? null,
            viewCount: sql`GREATEST(${videosTable.viewCount}, ${Number(v.viewCount) || 0})`,
          },
        })
        .returning({ id: videosTable.id, wasInsert: sql<boolean>`xmax = 0` });

      if (result[0]?.wasInsert) inserted += 1;
      else updated += 1;
    }

    if (!catalogueWarmupComplete) {
      catalogueWarmupComplete = true;
      logger.info({ totalSeeded: fresh.length }, "[YouTubeSync] Warmup complete (no notifications sent for seed)");
    } else if (opts.notifyOnNew && newVideos.length > 0) {
      // To avoid spamming, push notifications only for up to the 3 most recent new uploads.
      const sorted = [...newVideos].sort(
        (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
      );
      for (const v of sorted.slice(0, 3)) {
        await sendNewVideoNotification(v);
      }
    }

    const elapsedMs = Date.now() - startedAt;
    const summary = {
      ok: true as const,
      total: fresh.length,
      inserted,
      updated,
      newVideoIds: newVideos.map((v) => v.videoId),
      elapsedMs,
    };
    lastCatalogueSyncAt = startedAt;
    lastCatalogueSyncResult = { ...summary, at: startedAt };
    logger.info(summary, "[YouTubeSync] Catalogue sync complete");
    return summary;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    logger.error({ err, elapsedMs }, "[YouTubeSync] Catalogue sync failed");
    const result = { ok: false, error: "sync_failed", elapsedMs };
    lastCatalogueSyncAt = startedAt;
    lastCatalogueSyncResult = { ...result, at: startedAt };
    return result;
  }
}

export function startYoutubeCatalogueScheduler() {
  const tick = async () => {
    try {
      await runYoutubeCatalogueSync({ notifyOnNew: true });
    } catch (err) {
      logger.error({ err }, "[YouTubeSync] Scheduled tick crashed");
    }
    catalogueSyncTimer = setTimeout(tick, CATALOGUE_SYNC_INTERVAL_MS);
  };
  // Kick off first run immediately on startup; subsequent runs every interval.
  if (catalogueSyncTimer) clearTimeout(catalogueSyncTimer);
  catalogueSyncTimer = setTimeout(tick, 0);
  logger.info({ intervalMs: CATALOGUE_SYNC_INTERVAL_MS }, "[YouTubeSync] Scheduler started");
}

router.post("/admin/youtube/sync", async (req, res) => {
  const result = await runYoutubeCatalogueSync({ notifyOnNew: false });
  if (!result.ok) {
    const status = result.error === "youtube_api_key_missing" ? 503 : 502;
    res.status(status).json(result);
    return;
  }
  res.json(result);
});

router.get("/admin/youtube/sync/status", (_req, res) => {
  res.json(getCatalogueSyncStatus());
});

router.get("/youtube/live/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const client = addSSEClient(res);

  res.write(`event: connected\ndata: ${JSON.stringify({
    isLive: cachedLiveStatus.isLive,
    videoId: cachedLiveStatus.videoId,
    title: cachedLiveStatus.title,
    checkedAt: cachedLiveStatus.checkedAt,
    ts: Date.now(),
  })}\n\n`);

  req.on("close", () => removeSSEClient(client));
});

export default router;
