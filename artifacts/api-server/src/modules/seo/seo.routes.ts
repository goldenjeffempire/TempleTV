/**
 * SEO surfaces:
 *
 *   GET /sitemap-sermons.xml
 *     XML sitemap (Video extension) for all public sermons.
 *     Referenced by https://templetv.org.ng/sitemap.xml → crawled by Google.
 *     Cached 1 hour server-side. HTTP Cache-Control: 1 hour.
 *
 *   GET /podcast.xml
 *     RSS 2.0 feed with iTunes/Spotify extensions for all uploadedsermons.
 *     Submit this URL to Apple Podcasts, Spotify for Podcasters, Google Podcasts.
 *     Cached 15 min.
 *
 * Both endpoints are public (no auth) and rate-limited at 30 req/min.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { desc, eq, isNotNull, or } from "drizzle-orm";
import { db, schema } from "../../infrastructure/db.js";
import { cache } from "../../infrastructure/cache.js";
import { env } from "../../config/env.js";

const videos = schema.videosTable;

const SITE_URL = "https://templetv.org.ng";
const API_URL = env.API_ORIGIN ?? "https://api.templetv.org.ng";
const CHANNEL_TITLE = "Temple TV Sermons";
const CHANNEL_DESCRIPTION =
  "Uplifting sermons, teachings, and worship broadcasts from Temple TV (JCTM Broadcasting Network). Live broadcasts, sermon series, and on-demand messages.";
const CHANNEL_IMAGE = `${SITE_URL}/og-image.png`;
const CHANNEL_AUTHOR = "Temple TV";
const CHANNEL_EMAIL = "info@templetv.org.ng";
const CHANNEL_CATEGORY = "Religion & Spirituality";
const CHANNEL_LANGUAGE = "en";

const seoRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function parseDurationSecs(duration: string): number | null {
  // Accepts HH:MM:SS, MM:SS, or plain seconds string
  if (!duration) return null;
  const parts = duration.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return parts[0]!;
}

function durationToItunes(duration: string): string {
  // iTunes wants HH:MM:SS
  const secs = parseDurationSecs(duration);
  if (!secs) return "00:00:00";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function resolveVideoUrl(v: {
  videoSource: string;
  youtubeId: string | null;
  hlsMasterUrl: string | null;
  localVideoUrl: string | null;
}): string | null {
  if (v.videoSource === "youtube" && v.youtubeId) {
    return `https://www.youtube.com/watch?v=${v.youtubeId}`;
  }
  if (v.hlsMasterUrl) {
    // Absolutise relative URLs
    if (v.hlsMasterUrl.startsWith("/")) return `${API_URL}${v.hlsMasterUrl}`;
    return v.hlsMasterUrl;
  }
  if (v.localVideoUrl) {
    if (v.localVideoUrl.startsWith("/")) return `${API_URL}${v.localVideoUrl}`;
    return v.localVideoUrl;
  }
  return null;
}

// ── Fetch helpers (cached) ────────────────────────────────────────────────────

interface VideoRow {
  id: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  duration: string;
  category: string;
  preacher: string;
  publishedAt: string | null;
  importedAt: string;
  viewCount: number;
  videoSource: string;
  youtubeId: string | null;
  hlsMasterUrl: string | null;
  localVideoUrl: string | null;
}

async function fetchAllVideos(): Promise<VideoRow[]> {
  const cacheKey = "seo:all-videos";
  const c = cache();
  const cached = await c.get<VideoRow[]>(cacheKey);
  if (cached) return cached;

  const rows = await db
    .select({
      id: videos.id,
      title: videos.title,
      description: videos.description,
      thumbnailUrl: videos.thumbnailUrl,
      duration: videos.duration,
      category: videos.category,
      preacher: videos.preacher,
      publishedAt: videos.publishedAt,
      importedAt: videos.importedAt,
      viewCount: videos.viewCount,
      videoSource: videos.videoSource,
      youtubeId: videos.youtubeId,
      hlsMasterUrl: videos.hlsMasterUrl,
      localVideoUrl: videos.localVideoUrl,
    })
    .from(videos)
    .where(
      or(
        eq(videos.videoSource, "youtube"),
        isNotNull(videos.hlsMasterUrl),
        isNotNull(videos.localVideoUrl),
      ),
    )
    .orderBy(desc(videos.publishedAt))
    .limit(2000);

  const mapped: VideoRow[] = rows.map((r) => ({
    id: r.id,
    title: r.title ?? "",
    description: r.description ?? "",
    thumbnailUrl: r.thumbnailUrl ?? null,
    duration: r.duration ?? "",
    category: r.category ?? "Sermon",
    preacher: r.preacher ?? CHANNEL_AUTHOR,
    publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
    importedAt: new Date(r.importedAt).toISOString(),
    viewCount: r.viewCount ?? 0,
    videoSource: r.videoSource ?? "youtube",
    youtubeId: r.youtubeId ?? null,
    hlsMasterUrl: r.hlsMasterUrl ?? null,
    localVideoUrl: r.localVideoUrl ?? null,
  }));

  await c.set(cacheKey, mapped, 900); // 15-min TTL
  return mapped;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function seoRoutes(app: FastifyInstance) {
  /**
   * GET /sitemap-sermons.xml
   * Google Video Sitemap — one <url> per sermon with <video:video> extension tags.
   * Google uses this to show video rich results and index sermon pages.
   */
  app.get(
    "/sitemap-sermons.xml",
    { config: seoRateLimit, schema: { response: { 429: z.object({ error: z.string() }) } } },
    async (_req, reply) => {
      const cacheKey = "seo:sitemap-xml";
      const c = cache();
      const cached = await c.get<string>(cacheKey);
      if (cached) {
        reply.header("Content-Type", "application/xml; charset=utf-8");
        reply.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
        return reply.send(cached);
      }

      const rows = await fetchAllVideos();

      const urlEntries = rows
        .map((v) => {
          const pageUrl = `${SITE_URL}/player?id=${encodeURIComponent(v.id)}`;
          const thumbUrl = v.thumbnailUrl
            ? v.thumbnailUrl.startsWith("/")
              ? `${API_URL}${v.thumbnailUrl}`
              : v.thumbnailUrl
            : CHANNEL_IMAGE;
          const durationSecs = parseDurationSecs(v.duration);
          const pubDate = v.publishedAt ?? v.importedAt;
          const title = escXml(v.title);
          const description = escXml((v.description || v.title).slice(0, 2048));
          const contentUrl = resolveVideoUrl(v);

          return `  <url>
    <loc>${escXml(pageUrl)}</loc>
    <lastmod>${pubDate.slice(0, 10)}</lastmod>
    <video:video>
      <video:thumbnail_loc>${escXml(thumbUrl)}</video:thumbnail_loc>
      <video:title>${title}</video:title>
      <video:description>${description}</video:description>
      ${contentUrl ? `<video:content_loc>${escXml(contentUrl)}</video:content_loc>` : ""}
      ${durationSecs ? `<video:duration>${durationSecs}</video:duration>` : ""}
      ${pubDate ? `<video:publication_date>${pubDate}</video:publication_date>` : ""}
      <video:view_count>${v.viewCount}</video:view_count>
      <video:family_friendly>yes</video:family_friendly>
    </video:video>
  </url>`;
        })
        .join("\n");

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
${urlEntries}
</urlset>`;

      await c.set(cacheKey, xml, 3600);

      reply.header("Content-Type", "application/xml; charset=utf-8");
      reply.header("Cache-Control", "public, max-age=3600, s-maxage=3600");
      return reply.send(xml);
    },
  );

  /**
   * GET /podcast.xml
   * RSS 2.0 feed with iTunes/Spotify/Google extensions.
   * Submit this URL to podcast directories:
   *   Apple Podcasts:  https://podcastsconnect.apple.com
   *   Spotify:         https://podcasters.spotify.com
   *   Google Podcasts: submit via Google Search Console
   */
  app.get(
    "/podcast.xml",
    { config: seoRateLimit, schema: { response: { 429: z.object({ error: z.string() }) } } },
    async (_req, reply) => {
      const cacheKey = "seo:podcast-rss";
      const c = cache();
      const cached = await c.get<string>(cacheKey);
      if (cached) {
        reply.header("Content-Type", "application/rss+xml; charset=utf-8");
        reply.header("Cache-Control", "public, max-age=900, s-maxage=900");
        return reply.send(cached);
      }

      const rows = await fetchAllVideos();
      const now = new Date().toUTCString();

      const items = rows
        .map((v) => {
          const url = resolveVideoUrl(v);
          if (!url) return "";
          const pubDate = v.publishedAt
            ? new Date(v.publishedAt).toUTCString()
            : new Date(v.importedAt).toUTCString();
          const thumbUrl = v.thumbnailUrl
            ? v.thumbnailUrl.startsWith("/")
              ? `${API_URL}${v.thumbnailUrl}`
              : v.thumbnailUrl
            : CHANNEL_IMAGE;
          const durationSecs = parseDurationSecs(v.duration) ?? 0;
          const guid = v.videoSource === "youtube"
            ? `https://www.youtube.com/watch?v=${v.youtubeId}`
            : `${SITE_URL}/player?id=${v.id}`;
          const title = escXml(v.title);
          const desc = escXml((v.description || v.title).slice(0, 4000));
          const preacher = escXml(v.preacher || CHANNEL_AUTHOR);
          const category = escXml(v.category || CHANNEL_CATEGORY);

          const isYoutube = v.videoSource === "youtube";
          const mimeType = isYoutube ? "video/mp4" : "video/mp2t";

          return `    <item>
      <title>${title}</title>
      <description>${desc}</description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="true">${escXml(guid)}</guid>
      <link>${escXml(`${SITE_URL}/player?id=${v.id}`)}</link>
      <enclosure url="${escXml(url)}" length="${durationSecs * 128000}" type="${mimeType}" />
      <itunes:title>${title}</itunes:title>
      <itunes:author>${preacher}</itunes:author>
      <itunes:summary>${desc}</itunes:summary>
      <itunes:duration>${durationToItunes(v.duration)}</itunes:duration>
      <itunes:image href="${escXml(thumbUrl)}" />
      <itunes:keywords>${escXml(category)}, sermon, worship, gospel</itunes:keywords>
      <itunes:episodeType>full</itunes:episodeType>
    </item>`;
        })
        .filter(Boolean)
        .join("\n");

      const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escXml(CHANNEL_TITLE)}</title>
    <link>${SITE_URL}</link>
    <description>${escXml(CHANNEL_DESCRIPTION)}</description>
    <language>${CHANNEL_LANGUAGE}</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${API_URL}/podcast.xml" rel="self" type="application/rss+xml" />
    <itunes:author>${escXml(CHANNEL_AUTHOR)}</itunes:author>
    <itunes:owner>
      <itunes:name>${escXml(CHANNEL_AUTHOR)}</itunes:name>
      <itunes:email>${escXml(CHANNEL_EMAIL)}</itunes:email>
    </itunes:owner>
    <itunes:image href="${escXml(CHANNEL_IMAGE)}" />
    <image>
      <url>${escXml(CHANNEL_IMAGE)}</url>
      <title>${escXml(CHANNEL_TITLE)}</title>
      <link>${SITE_URL}</link>
    </image>
    <itunes:category text="${escXml(CHANNEL_CATEGORY)}">
      <itunes:category text="Christianity" />
    </itunes:category>
    <itunes:explicit>no</itunes:explicit>
    <itunes:type>episodic</itunes:type>
${items}
  </channel>
</rss>`;

      await c.set(cacheKey, rss, 900);

      reply.header("Content-Type", "application/rss+xml; charset=utf-8");
      reply.header("Cache-Control", "public, max-age=900, s-maxage=900");
      return reply.send(rss);
    },
  );
}
