export interface RssVideo {
  videoId: string;
  title: string;
  published: string;
  thumbnailUrl: string;
  description: string;
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

export function parseYouTubeRss(xml: string): RssVideo[] {
  const videos: RssVideo[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryPattern.exec(xml)) !== null) {
    const entry = match[1];

    const videoIdMatch = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (!videoIdMatch) continue;
    const videoId = videoIdMatch[1].trim();

    const title = extractTag(entry, "title") || extractTag(entry, "media:title");
    const published = extractTag(entry, "published");
    const description = extractTag(entry, "media:description") || "";
    const thumbnailUrl =
      extractAttr(entry, "media:thumbnail", "url") ||
      `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    const channelName = extractTag(entry, "name");

    if (videoId && title) {
      videos.push({ videoId, title, published, thumbnailUrl, description, channelName });
    }
  }

  return videos;
}

export function formatRelativeDate(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) > 1 ? "s" : ""} ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} month${Math.floor(diffDays / 30) > 1 ? "s" : ""} ago`;
  return `${Math.floor(diffDays / 365)} year${Math.floor(diffDays / 365) > 1 ? "s" : ""} ago`;
}
