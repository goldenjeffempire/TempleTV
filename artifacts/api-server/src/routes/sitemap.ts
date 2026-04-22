/**
 * SEO sitemap routes — served from the API origin (e.g. api.templetv.org.ng).
 *
 * Architecture:
 *   - The mobile web app at templetv.org.ng publishes a static sitemap-index
 *     that references both its static page sitemap and the dynamic sermons
 *     sitemap served here.
 *   - This file owns the dynamic content sitemap (every published sermon)
 *     so that Google can discover and rank individual video pages without
 *     a build step.
 *
 * Why a sitemap matters here:
 *   The Temple TV catalogue grows weekly. Without a dynamic sitemap, only
 *   the 5 static landing pages are indexable — the entire sermon library
 *   stays invisible to Google's crawl budget. This route closes that gap.
 */

import { Router, type Request, type Response } from "express";
import { getCachedVideosForSeo, type VideoItem } from "./youtube";
import { logger } from "../lib/logger";

const router = Router();

const SITE_URL = (process.env.PUBLIC_SITE_URL ?? "https://templetv.org.ng").replace(/\/$/, "");
const CHANNEL_NAME = "Jesus Christ Temple Ministry";
const CHANNEL_URL = "https://www.youtube.com/channel/UCPFFvkE-KGpR37qJgvYriJg";

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Strict YouTube video-id pattern. Skip anything that doesn't match — a bad
// id would emit an invalid <video:player_loc> URL and downgrade the entire
// sitemap's processing per Google Video Sitemap spec.
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function isValidHttpsUrl(input: string): boolean {
  if (!input) return false;
  try {
    const u = new URL(input);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

function buildVideoUrlEntry(v: VideoItem): string | null {
  if (!YOUTUBE_ID_RE.test(v.videoId)) return null;
  const loc = `${SITE_URL}/player?videoId=${encodeURIComponent(v.videoId)}`;
  const title = escapeXml((v.title || "Sermon").slice(0, 100));
  const description = escapeXml((v.description || v.title || "Sermon").slice(0, 2000));
  const thumb = isValidHttpsUrl(v.thumbnailUrl) ? escapeXml(v.thumbnailUrl) : "";
  // Only emit publication_date / lastmod when we have a real publishedAt from
  // YouTube. Synthesizing "now" pollutes structured-data quality signals and
  // can disqualify the entry from the Video search carousel.
  const realPubDate =
    v.publishedAt && !Number.isNaN(new Date(v.publishedAt).getTime())
      ? new Date(v.publishedAt).toISOString()
      : null;

  // Per Google Video Sitemap spec: for embedded videos use <video:player_loc>
  // only. <video:content_loc> must be a direct media-file URL (mp4/webm), NOT
  // a YouTube watch page — including a watch URL there invalidates the entry.
  const lines = [
    "  <url>",
    `    <loc>${loc}</loc>`,
    realPubDate ? `    <lastmod>${realPubDate}</lastmod>` : null,
    "    <changefreq>monthly</changefreq>",
    "    <priority>0.8</priority>",
    "    <video:video>",
    thumb ? `      <video:thumbnail_loc>${thumb}</video:thumbnail_loc>` : null,
    `      <video:title>${title}</video:title>`,
    `      <video:description>${description}</video:description>`,
    `      <video:player_loc allow_embed="yes" autoplay="autoplay=1">https://www.youtube.com/embed/${v.videoId}</video:player_loc>`,
    realPubDate ? `      <video:publication_date>${realPubDate}</video:publication_date>` : null,
    "      <video:family_friendly>yes</video:family_friendly>",
    "      <video:requires_subscription>no</video:requires_subscription>",
    "      <video:live>no</video:live>",
    `      <video:uploader info="${escapeXml(CHANNEL_URL)}">${escapeXml(CHANNEL_NAME)}</video:uploader>`,
    "    </video:video>",
    "  </url>",
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * Dynamic sitemap of every published sermon, with Google Video Sitemap
 * extensions so each sermon is eligible for the Video search carousel.
 *
 * Spec: https://developers.google.com/search/docs/crawling-indexing/sitemaps/video-sitemaps
 */
router.get("/sitemap-sermons.xml", async (_req: Request, res: Response) => {
  try {
    const videos = await getCachedVideosForSeo();
    const entries = videos
      .map(buildVideoUrlEntry)
      .filter((entry): entry is string => entry !== null)
      .join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
${entries}
</urlset>`;
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    // Refresh every 30 min on edge caches; Google re-crawls sitemaps daily.
    res.setHeader("Cache-Control", "public, max-age=1800, s-maxage=1800");
    res.setHeader("X-Sitemap-Entries", String(videos.length));
    return res.status(200).send(xml);
  } catch (err) {
    logger.error({ err }, "Failed to render sermons sitemap");
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    return res.status(200).send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`,
    );
  }
});

/**
 * Sitemap index served at the API origin — useful if Google discovers the
 * API host directly. The canonical index is at templetv.org.ng/sitemap.xml.
 */
router.get("/sitemap.xml", async (_req: Request, res: Response) => {
  const apiOrigin = process.env.API_PUBLIC_URL ?? "https://api.templetv.org.ng";
  const now = new Date().toISOString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${SITE_URL}/sitemap-pages.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>
  <sitemap>
    <loc>${apiOrigin}/sitemap-sermons.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>
</sitemapindex>`;
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
  return res.status(200).send(xml);
});

/**
 * Robots.txt fallback for the API host. Search engines should NOT index API
 * JSON endpoints, but the dynamic sermons sitemap should be discoverable.
 */
router.get("/robots.txt", (_req: Request, res: Response) => {
  const apiOrigin = process.env.API_PUBLIC_URL ?? "https://api.templetv.org.ng";
  const body = `# Temple TV API host
User-agent: *
Disallow: /api/
Disallow: /admin/
Allow: /sitemap-sermons.xml
Allow: /sitemap.xml

Sitemap: ${apiOrigin}/sitemap-sermons.xml
Sitemap: ${SITE_URL}/sitemap.xml
`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.status(200).send(body);
});

export default router;
