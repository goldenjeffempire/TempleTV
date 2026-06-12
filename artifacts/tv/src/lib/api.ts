import type {
  BroadcastItem,
  LiveStatus,
} from "@workspace/broadcast-types";

export type { BroadcastItem, LiveStatus };

const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Resolves the API base URL for TV app requests.
 *
 * Resolution order:
 *   1. VITE_API_URL  — explicit override set at build time (e.g.
 *      "https://api.templetv.org.ng"). Strip trailing slash and /api
 *      suffix so callers always get a normalised origin-only base.
 *   2. Same-origin fallback — uses window.location.origin so the Vite
 *      dev proxy (/api → localhost:5000) keeps working without config.
 */
export function resolveApiOrigin(): string {
  const override = (import.meta.env.VITE_API_URL as string | undefined)?.trim();
  if (override) {
    return override.replace(/\/+$/, "").replace(/\/api$/, "");
  }
  // Packaged TV apps loaded via file:// have window.location.origin === "null".
  // In that case the only correct fallback is the production API origin —
  // localhost would silently break every Samsung/LG/FireTV install in the
  // wild.
  const origin = window.location.origin;
  if (!origin || origin === "null" || origin.startsWith("file:")) {
    return "https://api.templetv.org.ng";
  }
  return origin;
}

function apiUrl(path: string): string {
  return `${resolveApiOrigin()}/api${path}`;
}

export interface VideoItem {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string;
  channelName: string;
  duration: string;
  viewCount: string;
  videoSource: "youtube" | "local";
  localVideoUrl: string | null;
  /** Category as set by the admin (e.g. "sermon", "music"). Used directly for local uploads. */
  apiCategory: string;
  /**
   * YouTube live broadcast status.
   * 'live'        — stream is actively airing on YouTube right now.
   * 'rebroadcast' — stream ended; video is a VOD/replay.
   * null          — not applicable.
   */
  youtubeLiveStatus?: "live" | "rebroadcast" | null;
}

/**
 * TV-specific broadcast current snapshot shape.
 *
 * Uses {@link BroadcastItem} from @workspace/broadcast-types so the queue
 * item shape stays in sync with Mobile automatically. The outer envelope
 * remains TV-local because TV's /api/playback/state endpoint returns a richer
 * shape than the legacy /api/broadcast/current endpoint Mobile still uses;
 * the two will be unified in BroadcastCurrentState once Mobile migrates.
 */
export interface BroadcastCurrent {
  item: BroadcastItem | null;
  nextItem: BroadcastItem | null;
  positionSecs: number;
  totalSecs: number;
  progressPercent: number;
  queueLength: number;
  syncedAt: string;
  serverTimeMs: number;
  /**
   * Epoch ms when the current item is expected to finish on the server's
   * authoritative clock. Surfaces the same value `useLiveSync` exposes so
   * the cinematic hero can perform a client-side proactive advance to the
   * next item ~200 ms before the SSE arrives — eliminating the visible
   * "frozen last frame" gap between queue items.
   */
  currentItemEndsAtMs?: number | null;
  /** Epoch seconds when the current item started — companion to the above. */
  itemStartEpochSecs?: number | null;
  /**
   * Backup HLS URL clients should switch to when primary playback fails.
   * Propagated from the server's BROADCAST_FAILOVER_HLS_URL env var through
   * /api/playback/state so the REST cold-start path (fetchBroadcastCurrent)
   * exposes the same failover URL that the WebSocket path (useLiveSync) does.
   * The TV player consumes this in its Primary → Backup failover step.
   */
  failoverHlsUrl?: string | null;
  activeSchedule?: {
    id?: string;
    title?: string;
    contentType: string;
    contentId?: string | null;
    /** ISO-8601 — used by `useLiveCountdown` for the pre-live "Starts in
     *  MM:SS" pill on the off-air hero. */
    startTime?: string;
    endTime?: string | null;
  } | null;
  /**
   * Admin-driven live override. When set by the "Activate live stream"
   * action in the admin panel, this is the single source of truth for
   * what the platform is currently broadcasting — it wins over the YouTube
   * channel auto-detect (`/api/youtube/live/status`) and over the 24/7
   * queue. Both `youtubeVideoId` and `hlsStreamUrl` are surfaced so the
   * REST poll fallback exposes the same fields the SSE payload carries.
   */
  liveOverride?: {
    title: string;
    youtubeVideoId?: string | null;
    hlsStreamUrl?: string | null;
  } | null;
}

// Shape returned by the public /api/videos endpoint (DB format).
interface DbVideo {
  id: string;
  youtubeId: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  duration: string;
  category: string;
  preacher: string;
  publishedAt: string | null;
  importedAt: string;
  viewCount: number;
  videoSource: string;
  localVideoUrl: string | null;
  hlsMasterUrl: string | null;
  youtubeLiveStatus?: "live" | "rebroadcast" | null;
}

function dbVideoToVideoItem(v: DbVideo): VideoItem {
  const isLocal = v.videoSource === "local";
  return {
    videoId: isLocal ? v.id : (v.youtubeId ?? v.id),
    title: v.title,
    description: v.description ?? "",
    publishedAt: v.publishedAt ?? v.importedAt ?? "",
    thumbnailUrl: v.thumbnailUrl ?? "",
    channelName: v.preacher || "Temple TV JCTM",
    duration: v.duration ?? "",
    viewCount: String(v.viewCount ?? 0),
    videoSource: isLocal ? "local" : "youtube",
    localVideoUrl: v.hlsMasterUrl ?? v.localVideoUrl ?? null,
    apiCategory: v.category ?? "",
    youtubeLiveStatus: v.youtubeLiveStatus ?? null,
  };
}

// ── Fetch retry helper ────────────────────────────────────────────────────
/**
 * Retry an async function up to maxAttempts times with exponential back-off
 * plus jitter. Smart TVs and set-top boxes frequently run on congested Wi-Fi;
 * a single transient network timeout should not leave the home screen empty
 * until the next 5-minute background poll.
 *
 * Back-off schedule (baseDelayMs=400): 400 ms → 800 ms → give up.
 * Total worst-case additional wait before the third failure: ~1.2 s.
 *
 * fn() may return null (304 sentinel) — null is NOT treated as an error;
 * it passes through immediately on the first call without retrying.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 400,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts - 1) throw err;
      // Exponential back-off with ±150 ms jitter.
      await new Promise<void>((res) =>
        setTimeout(res, baseDelayMs * 2 ** attempt + Math.random() * 300),
      );
    }
  }
  throw new Error("withRetry: unreachable");
}

// Session-level ETag for the TV catalog endpoint. Enables 304 Not Modified
// responses on the 5-minute background refresh cycles when the library
// hasn't changed — avoids re-parsing ~30 KB of JSON on every poll.
// Not persisted across app launches; localStorage handles cross-session
// caching. Reset on each page reload/cold start.
let tvCatalogEtag: string | null = null;

async function _fetchVideosOnce(): Promise<VideoItem[] | null> {
  const headers: HeadersInit = {};
  if (tvCatalogEtag) headers["If-None-Match"] = tvCatalogEtag;

  const res = await fetch(apiUrl("/videos?limit=200&source=youtube"), {
    headers,
    signal: AbortSignal.timeout(12000),
  });

  if (res.status === 304) return null;
  if (!res.ok) throw new Error(`Failed to fetch videos (${res.status})`);

  const etag = res.headers.get("etag");
  if (etag) tvCatalogEtag = etag;

  const data = await res.json() as { videos: DbVideo[] };
  return (data.videos ?? []).map(dbVideoToVideoItem);
}

/**
 * Fetch YouTube-sourced videos from the public catalogue endpoint.
 * The TV Library mirrors the mobile Library and lists only YouTube content —
 * locally-uploaded files are reserved for the 24/7 Broadcasting module and
 * never appear in the public catalogue.
 *
 * Returns null when the server replies 304 Not Modified — callers should
 * keep displaying their currently-cached content unchanged.
 *
 * Retried up to 3× with exponential back-off on transient failures so a
 * single Wi-Fi hiccup on a Smart TV doesn't leave the Library empty.
 */
export async function fetchVideos(): Promise<VideoItem[] | null> {
  return withRetry(_fetchVideosOnce, 3, 400);
}

export async function fetchLiveStatus(): Promise<LiveStatus> {
  return withRetry(async () => {
    const res = await fetch(apiUrl("/youtube/live/status"), {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Failed to fetch live status (${res.status})`);
    return res.json() as Promise<LiveStatus>;
  }, 3, 300);
}

/**
 * Fetch the current broadcast snapshot from the new playback engine
 * (`/api/playback/state`) and project it into the legacy `BroadcastCurrent`
 * shape so existing callers (`Home.tsx`'s cold-start hero) keep
 * working without changes.
 *
 * The new state ships direct, signed URLs — no 302 hop, no separate resolve
 * call — and includes a `nextNext` preload candidate which we surface via
 * `upcomingItems` for forward-compat with a future triple-buffer player.
 */
async function _fetchBroadcastCurrentOnce(): Promise<BroadcastCurrent> {
  const res = await fetch(apiUrl("/playback/state"), {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Failed to fetch broadcast (${res.status})`);
  type WireSource = { kind: "hls" | "mp4" | "youtube"; url: string };
  type WireItem = {
    id: string;
    title: string;
    thumbnailUrl: string | null;
    durationSecs: number;
    source: WireSource;
    startsAtMs: number;
    endsAtMs: number;
  };
  type WireState = {
    serverTimeMs: number;
    current: WireItem | null;
    next: WireItem | null;
    nextNext: WireItem | null;
    liveOverride: { title: string; startedAtMs: number; endsAtMs: number | null } | null;
    source: "override" | "schedule" | "queue" | "empty";
    /**
     * Backup HLS URL from BROADCAST_FAILOVER_HLS_URL on the server.
     * The WebSocket path (useLiveSync) already forwards this field.
     * Including it here ensures the REST cold-start / REST-fallback path
     * also surfaces the failover URL so the TV player can switch to it
     * when primary playback fails, instead of going dark.
     */
    failoverHlsUrl?: string | null;
  };
  const wire = (await res.json()) as WireState;
  const toBroadcastItem = (it: WireItem | null): BroadcastItem | null => {
    if (!it) return null;
    const isYoutube = it.source.kind === "youtube";
    const isHls = it.source.kind === "hls";
    return {
      id: it.id,
      videoId: it.id,
      youtubeId: isYoutube ? it.source.url : undefined,
      title: it.title,
      thumbnailUrl: it.thumbnailUrl ?? undefined,
      durationSecs: it.durationSecs,
      videoSource: isYoutube ? "youtube" : "local",
      hlsMasterUrl: isHls ? it.source.url : null,
      localVideoUrl: isYoutube || isHls ? null : it.source.url,
      startedAt: new Date(it.startsAtMs).toISOString(),
    };
  };
  const item = toBroadcastItem(wire.current);
  const nextItem = toBroadcastItem(wire.next);
  const positionSecs = wire.current
    ? Math.max(0, (wire.serverTimeMs - wire.current.startsAtMs) / 1000)
    : 0;
  const totalSecs = wire.current?.durationSecs ?? 0;
  return {
    item,
    nextItem,
    positionSecs,
    totalSecs,
    progressPercent: totalSecs > 0 ? Math.min(100, (positionSecs / totalSecs) * 100) : 0,
    queueLength: 0,
    syncedAt: new Date(wire.serverTimeMs).toISOString(),
    serverTimeMs: wire.serverTimeMs,
    currentItemEndsAtMs: wire.current?.endsAtMs ?? null,
    itemStartEpochSecs: wire.current ? Math.floor(wire.current.startsAtMs / 1000) : null,
    failoverHlsUrl: wire.failoverHlsUrl ?? null,
    activeSchedule: null,
    liveOverride: wire.liveOverride
      ? {
          title: wire.liveOverride.title,
          hlsStreamUrl: wire.current?.source.kind === "hls" ? wire.current.source.url : null,
          youtubeVideoId: wire.current?.source.kind === "youtube" ? wire.current.source.url : null,
        }
      : null,
  };
}

/**
 * Fetch the current broadcast snapshot with automatic retry on transient
 * network failures — ensures the TV home screen cold-start doesn't fail on a
 * single Wi-Fi hiccup (common on Smart TV / set-top-box environments).
 */
export function fetchBroadcastCurrent(): Promise<BroadcastCurrent> {
  return withRetry(_fetchBroadcastCurrentOnce, 3, 400);
}


/**
 * Send an emoji reaction to the live broadcast.
 * Mirrors mobile's `sendReaction` in services/broadcast.ts.
 * Fire-and-forget — TV callers should not await this.
 */
export async function sendReaction(type: "amen" | "fire" | "hallelujah"): Promise<void> {
  try {
    await fetch(apiUrl("/broadcast/reaction"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* fire-and-forget */
  }
}

/**
 * Submit a prayer request.
 * Mirrors mobile's `submitPrayerRequest` in services/broadcast.ts.
 */
export async function submitPrayerRequest(
  name: string | null,
  message: string,
): Promise<boolean> {
  try {
    const res = await fetch(apiUrl("/broadcast/prayer"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name ?? "Anonymous", message, platform: "tv" }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export { BASE_URL };
