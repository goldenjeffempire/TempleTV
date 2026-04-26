/**
 * YouTube URL parsing & live-stream validation.
 *
 * Supports every common YouTube URL form an admin might paste:
 *   • https://www.youtube.com/watch?v=XXXXXXXXXXX
 *   • https://www.youtube.com/watch?v=XXXXXXXXXXX&feature=...
 *   • https://youtu.be/XXXXXXXXXXX
 *   • https://www.youtube.com/live/XXXXXXXXXXX
 *   • https://www.youtube.com/embed/XXXXXXXXXXX
 *   • https://youtube.com/shorts/XXXXXXXXXXX (rejected — not a live stream form, but parsed for ID)
 *   • bare 11-char ID:    XXXXXXXXXXX
 *
 * Validates the resolved ID is exactly 11 chars and contains only the
 * YouTube alphabet ([A-Za-z0-9_-]). This is the canonical YouTube video
 * ID shape — mismatches are rejected before they reach the DB.
 */

const YT_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

const HOST_ALLOWLIST = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export function extractYouTubeVideoId(
  raw: unknown,
): { ok: true; videoId: string } | { ok: false; error: string } {
  if (raw === null || raw === undefined) {
    return { ok: false, error: "URL is required" };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: "URL must be a string" };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, error: "URL is required" };
  }

  // Bare ID shortcut.
  if (YT_ID_REGEX.test(trimmed)) {
    return { ok: true, videoId: trimmed };
  }

  // URL parse path.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Not a valid URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "URL must use http or https" };
  }

  const host = parsed.hostname.toLowerCase();
  if (!HOST_ALLOWLIST.has(host)) {
    return { ok: false, error: "URL must be a youtube.com or youtu.be link" };
  }

  let candidate: string | null = null;

  // youtu.be/<id>
  if (host === "youtu.be") {
    candidate = parsed.pathname.replace(/^\//, "").split("/")[0] ?? null;
  } else {
    // youtube.com paths: /watch?v=…, /live/<id>, /embed/<id>, /shorts/<id>
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const first = pathParts[0]?.toLowerCase();

    if (first === "watch") {
      candidate = parsed.searchParams.get("v");
    } else if (first === "live" || first === "embed" || first === "shorts" || first === "v") {
      candidate = pathParts[1] ?? null;
    } else if (parsed.searchParams.has("v")) {
      candidate = parsed.searchParams.get("v");
    }
  }

  if (!candidate) {
    return { ok: false, error: "Could not find a video ID in that URL" };
  }
  if (!YT_ID_REGEX.test(candidate)) {
    return { ok: false, error: "Resolved video ID is not a valid YouTube ID" };
  }
  return { ok: true, videoId: candidate };
}

export interface YouTubeStreamProbe {
  videoId: string;
  exists: boolean;
  isLive: boolean;
  title: string | null;
  thumbnailUrl: string | null;
  /** Free-text reason when `exists=false` or `isLive=false`. */
  reason: string | null;
  /** Which detection path produced this verdict. */
  method: "oembed" | "live-page" | "none";
}

const PROBE_TIMEOUT_MS = 6_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; TempleTV-LiveControl/1.0; +https://templetv.org.ng)";

/**
 * Probe a YouTube video ID for existence + liveness.
 *
 * Strategy: oembed first (single fast JSON call, confirms the video exists
 * and is publicly viewable). If oembed succeeds we then probe the watch page
 * for live-stream markers. Falls back gracefully — a non-live but valid
 * video still returns `exists: true, isLive: false` so the admin sees a
 * meaningful error message instead of a generic "URL invalid".
 */
export async function validateYouTubeLiveStream(
  videoId: string,
): Promise<YouTubeStreamProbe> {
  if (!YT_ID_REGEX.test(videoId)) {
    return {
      videoId,
      exists: false,
      isLive: false,
      title: null,
      thumbnailUrl: null,
      reason: "Invalid video ID format",
      method: "none",
    };
  }

  const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
  let title: string | null = null;
  let exists = false;

  // Step 1 — oembed: confirms public visibility + gives us the title.
  try {
    const oembedRes = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );
    if (oembedRes.ok) {
      const data = (await oembedRes.json().catch(() => null)) as
        | { title?: string; author_name?: string }
        | null;
      if (data?.title) {
        exists = true;
        title = data.title;
      }
    } else if (oembedRes.status === 401 || oembedRes.status === 403) {
      return {
        videoId,
        exists: false,
        isLive: false,
        title: null,
        thumbnailUrl: null,
        reason: "Video is private or not embeddable",
        method: "oembed",
      };
    } else if (oembedRes.status === 404) {
      return {
        videoId,
        exists: false,
        isLive: false,
        title: null,
        thumbnailUrl: null,
        reason: "Video does not exist or has been removed",
        method: "oembed",
      };
    }
  } catch {
    // Network error — fall through to live-page probe.
  }

  // Step 2 — watch-page probe: looks for live-stream markers.
  // YouTube's watch page emits explicit JSON markers for live broadcasts.
  let isLive = false;
  let method: YouTubeStreamProbe["method"] = "oembed";
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (pageRes.ok) {
      const html = await pageRes.text();
      // Markers YouTube emits for live broadcasts:
      //   "isLiveContent":true          (always — applies even after end)
      //   "isLiveNow":true              (only while currently live)
      //   "liveBroadcastDetails":{…"isLiveNow":true…}
      // We require BOTH `isLiveContent:true` and a "now" marker to be
      // confident the stream is actually airing right now.
      const hasLiveContent = /"isLiveContent"\s*:\s*true/.test(html);
      const hasLiveNow =
        /"isLiveNow"\s*:\s*true/.test(html) ||
        /"liveBroadcastDetails"[^}]*"isLiveNow"\s*:\s*true/.test(html);
      if (hasLiveContent) exists = true;
      if (hasLiveContent && hasLiveNow) {
        isLive = true;
        method = "live-page";
      }
      if (!title) {
        const titleMatch = html.match(/<meta\s+name="title"\s+content="([^"]+)"/i);
        if (titleMatch) title = titleMatch[1];
      }
    }
  } catch {
    // Probe failed — keep the oembed verdict.
  }

  if (!exists) {
    return {
      videoId,
      exists: false,
      isLive: false,
      title: null,
      thumbnailUrl: null,
      reason: "Video could not be verified — check the URL is public",
      method: "none",
    };
  }

  return {
    videoId,
    exists: true,
    isLive,
    title,
    thumbnailUrl,
    reason: isLive ? null : "Video exists but is not currently live",
    method,
  };
}
