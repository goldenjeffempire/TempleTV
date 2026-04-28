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

import { boundedText } from "./boundedFetch";

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

// Watch-page HTML is ~1MB. 6s was too tight under typical Replit-egress
// latency to YouTube — the fetch+read would time out partway through, the
// regex would never match, and the validator would falsely say "not live."
// 10s leaves comfortable headroom while still bounding admin UI wait time.
const PROBE_TIMEOUT_MS = 10_000;
// Posing as a real browser User-Agent matters here: YouTube serves a
// stripped-down "compatibility" page to obvious bots that omits the
// `isLiveContent` / `isLiveNow` JSON markers entirely. The admin validator
// MUST get the full page to see the live markers — the LivePoller already
// uses a Chrome UA for the same reason.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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
  // Detection is heuristic by necessity (no public liveness API for arbitrary
  // video IDs without an OAuth-scoped key), so we accept ANY single strong
  // signal rather than requiring every marker to align — YouTube ships
  // multiple page variants (A/B layouts, geo-stripped pages, partial
  // hydration on slow renders) and a single missing field would otherwise
  // false-negative an actually-live stream. Earlier this code required
  // `isLiveContent:true` AND `isLiveNow:true` together; that lost real
  // streams in the wild (observed 2026-04-26: stream f51qV6XvQ40 was live
  // and detected by the LivePoller, but the admin validator rejected it).
  let isLive = false;
  let method: YouTubeStreamProbe["method"] = "oembed";

  const probeWatchPage = async (id: string) => {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${id}`, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!pageRes.ok) return null;
    // 256 KiB cap — see lib/boundedFetch.ts. Every marker we test for
    // (isLiveNow, hlsManifestUrl, isLiveContent, liveBroadcastDetails) lives
    // in the inlined ytInitialPlayerResponse JSON near the top of the page.
    return boundedText(pageRes);
  };

  try {
    const html = await probeWatchPage(videoId);
    if (html) {
      // Strong "currently live RIGHT NOW" markers — any one is sufficient.
      // `isLiveNow:true` is YouTube's canonical real-time flag; the LivePoller
      // already trusts it alone for the channel-wide live page.
      const hasLiveNow = /"isLiveNow"\s*:\s*true/.test(html);
      const hasLiveBroadcastNow =
        /"liveBroadcastDetails"[^}]*"isLiveNow"\s*:\s*true/.test(html);
      // Live broadcasts (only) ship an HLS manifest URL in their player
      // response — VOD videos do not. Strong corroborating signal.
      const hasHlsManifest = /"hlsManifestUrl"\s*:\s*"[^"]+/.test(html);
      // Block presence (without requiring the inner flag) — present for
      // any live event including upcoming/ended, so we use it only as
      // existence evidence not as a live verdict on its own.
      const hasLiveBroadcastBlock = /"liveBroadcastDetails"\s*:\s*\{/.test(html);
      // Catalogue marker — true for every live broadcast (including ended).
      // Used as `exists` evidence + as a tiebreaker, never on its own as
      // proof of CURRENT liveness.
      const hasLiveContent = /"isLiveContent"\s*:\s*true/.test(html);

      if (hasLiveContent || hasLiveBroadcastBlock || hasHlsManifest) {
        exists = true;
      }

      if (hasLiveNow || hasLiveBroadcastNow || hasHlsManifest) {
        isLive = true;
        method = "live-page";
      }

      if (!title) {
        const titleMatch = html.match(/<meta\s+name="title"\s+content="([^"]+)"/i);
        // Buffer.from(...).toString() materializes a fresh SeqString so the
        // title doesn't pin the 256 KiB HTML backing buffer when it propagates
        // up through validateLiveStream() into long-lived schedule state.
        if (titleMatch) title = Buffer.from(titleMatch[1], "utf8").toString("utf8");
      }
    }
  } catch {
    // Probe failed (timeout/network) — fall through to channel-page fallback
    // which is smaller and faster.
  }

  // Step 3 — channel-page fallback. If the watch-page probe was inconclusive
  // (timed out, or returned an A/B-tested layout with no markers), fall back
  // to the same `/live` URL the LivePoller hits. We don't know the channel
  // handle here, so we use the per-video `/live/<id>` form which YouTube
  // accepts for direct deep-links into a live broadcast. This second probe
  // only runs when the first didn't already confirm liveness — keeps the
  // happy path single-fetch.
  if (!isLive) {
    try {
      const pageRes = await fetch(`https://www.youtube.com/live/${videoId}`, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (pageRes.ok) {
        // 256 KiB cap — see lib/boundedFetch.ts.
        const html = await boundedText(pageRes);
        const hasLiveNow = /"isLiveNow"\s*:\s*true/.test(html);
        const hasHlsManifest = /"hlsManifestUrl"\s*:\s*"[^"]+/.test(html);
        if (hasLiveNow || hasHlsManifest) {
          isLive = true;
          exists = true;
          method = "live-page";
        }
      }
    } catch {
      // Both probes failed — keep whatever the oembed step gave us.
    }
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
