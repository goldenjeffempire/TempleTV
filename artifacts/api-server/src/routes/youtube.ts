import { Router } from "express";

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

const CACHE_MS = 10 * 60 * 1000;

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

let videosCache: { videos: VideoItem[]; timestamp: number } | null = null;

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
        console.error("YouTube playlistItems API error:", errText);
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
    console.error("fetchAllVideosFromApi error:", err);
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
    if (videosCache && Date.now() - videosCache.timestamp < CACHE_MS) {
      res.setHeader("X-Cache", "HIT");
      return res.json({ videos: videosCache.videos, total: videosCache.videos.length });
    }

    let videos = await fetchAllVideosFromApi();

    if (!videos || videos.length === 0) {
      videos = await fetchVideosFromRss();
    }

    if (!videos || videos.length === 0) {
      return res.status(502).json({ error: "Could not fetch videos from YouTube." });
    }

    videosCache = { videos, timestamp: Date.now() };
    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("X-Source", videos[0]?.duration ? "youtube-api" : "rss");
    return res.json({ videos, total: videos.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

let rssCache: { xml: string; timestamp: number } | null = null;

router.get("/youtube/rss", async (req, res) => {
  try {
    if (rssCache && Date.now() - rssCache.timestamp < CACHE_MS) {
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("X-Cache", "HIT");
      return res.send(rssCache.xml);
    }

    if (YOUTUBE_API_KEY) {
      if (videosCache && Date.now() - videosCache.timestamp < CACHE_MS) {
        const xml = videosToXml(videosCache.videos);
        res.setHeader("Content-Type", "application/xml; charset=utf-8");
        res.setHeader("X-Source", "youtube-api-cached");
        return res.send(xml);
      }
      const videos = await fetchAllVideosFromApi();
      if (videos && videos.length > 0) {
        videosCache = { videos, timestamp: Date.now() };
        const xml = videosToXml(videos);
        rssCache = { xml, timestamp: Date.now() };
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

    rssCache = { xml, timestamp: Date.now() };
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
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/@${CHANNEL_HANDLE}/live&format=json`;
    const response = await fetch(oembedUrl, {
      signal: AbortSignal.timeout(5000),
      headers: BROWSER_HEADERS,
    });
    if (!response.ok) {
      return res.json({ isLive: false, videoId: null, title: null });
    }
    const data = (await response.json()) as {
      title?: string;
      thumbnail_url?: string;
    };
    const title = data.title ?? null;
    const thumbnailUrl = data.thumbnail_url ?? "";
    const videoIdMatch = thumbnailUrl.match(/\/vi\/([^/]+)\//);
    const videoId = videoIdMatch ? videoIdMatch[1] : null;
    const isLive = !!videoId && !!title;
    res.json({ isLive, videoId, title });
  } catch {
    res.json({ isLive: false, videoId: null, title: null });
  }
});

export default router;
