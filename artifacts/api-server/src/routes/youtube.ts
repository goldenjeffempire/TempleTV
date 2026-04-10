import { Router } from "express";

const router = Router();

const CHANNEL_ID = "UCsXVk37biltHxV1aGl-AAxg";
const CHANNEL_HANDLE = "templetvjctm";

const DIRECT_RSS_URLS = [
  `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
  `https://www.youtube.com/feeds/videos.xml?user=${CHANNEL_HANDLE}`,
];

const BROWSER_HEADERS = {
  Accept: "application/xml, text/xml, */*",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

let rssCache: { xml: string; timestamp: number } | null = null;
const RSS_CACHE_MS = 10 * 60 * 1000;

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
      feed?: { title?: string };
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

router.get("/youtube/rss", async (req, res) => {
  try {
    if (rssCache && Date.now() - rssCache.timestamp < RSS_CACHE_MS) {
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("X-Cache", "HIT");
      return res.send(rssCache.xml);
    }

    let xml: string | null = null;

    for (const url of DIRECT_RSS_URLS) {
      xml = await fetchDirect(url);
      if (xml) {
        res.setHeader("X-Source", "direct");
        break;
      }
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
