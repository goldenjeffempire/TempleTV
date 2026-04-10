import { Router } from "express";

const router = Router();

const RSS_URLS = [
  "https://www.youtube.com/feeds/videos.xml?user=templetvjctm",
  "https://www.youtube.com/feeds/videos.xml?channel_id=UCsXVk37biltHxV1aGl-AAxg",
];

let rssCache: { xml: string; timestamp: number } | null = null;
const RSS_CACHE_MS = 10 * 60 * 1000;

router.get("/youtube/rss", async (req, res) => {
  try {
    if (rssCache && Date.now() - rssCache.timestamp < RSS_CACHE_MS) {
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("X-Cache", "HIT");
      return res.send(rssCache.xml);
    }

    let xml: string | null = null;
    for (const url of RSS_URLS) {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: "application/xml, text/xml, */*", "User-Agent": "TempleTV/1.0" },
      });
      if (response.ok) {
        xml = await response.text();
        if (xml.includes("<entry>")) break;
      }
    }

    if (!xml) {
      return res.status(502).json({ error: "Could not fetch YouTube RSS feed" });
    }

    rssCache = { xml, timestamp: Date.now() };
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("X-Cache", "MISS");
    res.send(xml);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/youtube/live", async (req, res) => {
  try {
    const channel = "templetvjctm";
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/channel/@${channel}/live&format=json`;
    const response = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      return res.json({ isLive: false, videoId: null, title: null });
    }
    const data = await response.json() as { title?: string; thumbnail_url?: string };
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
