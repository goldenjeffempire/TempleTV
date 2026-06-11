/**
 * Temple TV — Consolidated Mobile API Client
 *
 * Single source of truth for all API calls from the mobile app.
 * Uses public endpoints for catalog/broadcast data (no auth required).
 * Uses authed endpoints for user-specific actions (reactions, prayers, profile).
 *
 * All functions are typed against the actual API response shapes.
 * Zero mock/stub data — every function hits a real API endpoint.
 */

import { getApiBase } from "@/lib/apiBase";
import { fetchWithRetry } from "@/lib/fetchWithRetry";
import { authFetch } from "@/services/authApi";

// ─── Internal helpers ────────────────────────────────────────────────────────

function url(path: string): string {
  return `${getApiBase()}${path}`;
}

/**
 * Fetch a public (unauthenticated) API endpoint with automatic retry.
 * Retries up to 3 times on network errors and 5xx responses using full-jitter
 * exponential backoff (350 ms base, 10 s cap). Fire-and-forget endpoints
 * (reactions, prayers, view counts) also go through this path — silently
 * catching in callers means transient network hiccups are recovered at the
 * fetch layer before the caller even sees an error.
 */
async function publicFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetchWithRetry(url(path), {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(12_000),
  });
  if (__DEV__ && !res.ok) {
    console.warn(`[api] publicFetch ${path} → HTTP ${res.status}`);
  }
  return res;
}

/**
 * Fetch an authenticated endpoint with automatic 401 → token-refresh → retry.
 * Delegates to authFetch from authApi so the full refresh-coordination logic
 * (single-flight inflightRefresh deduplication, session-expired signOut) is
 * shared with the auth module rather than duplicated here.
 */
async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await authFetch(path, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(12_000),
  });
  if (__DEV__ && !res.ok) {
    console.warn(`[api] authedFetch ${path} → HTTP ${res.status}`);
  }
  return res;
}

// ─── Video catalog types ─────────────────────────────────────────────────────

export interface ApiVideo {
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
  videoSource: "youtube" | "local";
  localVideoUrl: string | null;
  hlsMasterUrl: string | null;
  youtubeLiveStatus?: "live" | "rebroadcast" | null;
}

export interface VideosResponse {
  videos: ApiVideo[];
  total: number;
  totalPages: number;
  page: number;
  limit: number;
}

export interface FetchVideosOptions {
  limit?: number;
  page?: number;
  category?: string;
  search?: string;
  /**
   * "popular" is accepted here for convenience — it is mapped to "views"
   * before the API call since the server only accepts the canonical enum
   * ("newest" | "oldest" | "published" | "views" | "title").
   */
  sort?: "newest" | "oldest" | "popular" | "views" | "published" | "title";
  /**
   * Restrict the catalogue by ingestion source. The Library tab passes
   * "youtube" so it only ever displays YouTube-sourced content — locally
   * uploaded videos belong to the 24/7 Broadcasting module and must not
   * appear in the public catalogue.
   */
  source?: "youtube" | "local";
  /**
   * Optional ETag from a previous successful fetch. When supplied and the
   * server responds 304 Not Modified, fetchVideos returns null — the caller
   * should keep displaying its cached data unchanged.
   */
  ifNoneMatch?: string;
}

// ─── Broadcast types ─────────────────────────────────────────────────────────

export interface BroadcastCurrentItem {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  durationSecs: number;
  source: { kind: "hls" | "mp4" | "youtube"; url: string };
  startsAtMs: number;
  endsAtMs: number;
}

export interface BroadcastCurrentState {
  serverTimeMs: number;
  current: BroadcastCurrentItem | null;
  next: BroadcastCurrentItem | null;
  positionSecs: number;
  totalSecs: number;
  progressPercent: number;
  failoverHlsUrl: string | null;
  liveOverride: {
    title: string;
    youtubeVideoId: string | null;
    hlsStreamUrl: string | null;
  } | null;
  isLive: boolean;
}

// ─── Channel types ───────────────────────────────────────────────────────────

/**
 * Shape returned by GET /api/channels.
 * Kept in sync with the Zod response schema in channels.routes.ts.
 */
export interface ApiChannel {
  id: string;
  slug: string;
  name: string;
  description: string;
  color: string;
  isPrimary: boolean;
  sortOrder: number;
  viewerCount: number;
  isRunning: boolean;
}

// ─── Video catalog ───────────────────────────────────────────────────────────

/**
 * Fetch the public video catalog. Returns up to `limit` videos (default 200).
 * Maps query params to server filter/sort.
 *
 * Returns null when the server responds 304 Not Modified (caller should keep
 * displaying its currently-cached data unchanged). This only occurs when
 * `opts.ifNoneMatch` is set to the ETag from the previous successful fetch.
 */
export async function fetchVideos(opts: FetchVideosOptions = {}): Promise<VideosResponse | null> {
  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 200));
  if (opts.page && opts.page > 1) params.set("page", String(opts.page));
  if (opts.category && opts.category !== "All") params.set("category", opts.category);
  if (opts.search) params.set("search", opts.search);
  if (opts.sort) {
    // Map "popular" → "views" — the server Zod enum does not accept "popular"
    // directly but "views" is the equivalent server-side sort (desc viewCount).
    const apiSort = opts.sort === "popular" ? "views" : opts.sort;
    params.set("sort", apiSort);
  }
  if (opts.source) params.set("source", opts.source);

  const fetchHeaders: Record<string, string> = {};
  if (opts.ifNoneMatch) fetchHeaders["If-None-Match"] = opts.ifNoneMatch;

  const res = await publicFetch(`/api/videos?${params.toString()}`, {
    headers: fetchHeaders,
  });

  // 304 Not Modified — content unchanged, caller should use cached data.
  if (res.status === 304) return null;
  if (!res.ok) {
    // Server-error fallback: on 5xx try /featured so the home screen at least
    // shows top videos instead of an empty error wall. Only fires for the
    // unfiltered "give me everything" call — filtered/paginated requests
    // legitimately need the full endpoint and should surface the error.
    const isUnfiltered = !opts.search && !opts.category && (!opts.page || opts.page === 1);
    if (res.status >= 500 && isUnfiltered) {
      try {
        const featured = await fetchFeaturedVideos(Math.min(opts.limit ?? 50, 50));
        return {
          videos: featured,
          total: featured.length,
          totalPages: 1,
          page: 1,
          limit: featured.length,
        };
      } catch {
        /* fall through to the original error below */
      }
    }
    throw new Error(`We're having trouble reaching the library. Please try again in a moment.`);
  }
  const data = await res.json() as { videos?: ApiVideo[]; data?: ApiVideo[]; total?: number; totalPages?: number };
  const videos = data.videos ?? data.data ?? [];
  const total = data.total ?? videos.length;
  const totalPages = data.totalPages ?? 1;
  // Store the ETag for the unfiltered page-1 catalog so callers can supply it
  // in subsequent background-refresh calls to receive a 304 when unchanged.
  const isUnfilteredFirstPage = !opts.search && !opts.category && (!opts.page || opts.page === 1) && !opts.source;
  const etag = res.headers.get("etag");
  if (etag && isUnfilteredFirstPage) _lastCatalogEtag = etag;
  return { videos, total, totalPages, page: opts.page ?? 1, limit: opts.limit ?? 200 };
}

// Session-level ETag from the most recent unfiltered page-1 catalog fetch.
// Enables If-None-Match conditional GETs on background refresh cycles — the
// server returns 304 when the library is unchanged, saving ~30 KB of parsing.
let _lastCatalogEtag: string | null = null;

/** Returns the ETag from the most recent successful unfiltered catalog fetch, or null. */
export function getLastCatalogEtag(): string | null {
  return _lastCatalogEtag;
}

/**
 * Fetch the curated "featured" list (top videos by view count).
 * Used as a graceful fallback when /api/videos 5xxs so the home screen
 * still has something to show instead of an empty error state.
 */
export async function fetchFeaturedVideos(limit = 24): Promise<ApiVideo[]> {
  const res = await publicFetch(`/api/videos/featured?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to fetch featured videos (${res.status})`);
  const data = await res.json() as { videos?: ApiVideo[] };
  return data.videos ?? [];
}

/**
 * Fetch a single video by its database ID.
 */
export async function fetchVideoById(id: string): Promise<ApiVideo> {
  const res = await publicFetch(`/api/videos/${id}`);
  if (!res.ok) throw new Error(`Video not found (${res.status})`);
  const data = await res.json() as { video?: ApiVideo } | ApiVideo;
  return ("video" in data && data.video) ? data.video : (data as ApiVideo);
}

// ─── Broadcast ───────────────────────────────────────────────────────────────

/**
 * Fetch the current broadcast state from /api/playback/state.
 * This is the REST cold-start path; the WS/SSE path keeps it live thereafter.
 */
export async function fetchBroadcastCurrent(): Promise<BroadcastCurrentState> {
  const res = await publicFetch("/api/playback/state");
  if (!res.ok) throw new Error(`Failed to fetch broadcast state (${res.status})`);

  type WireState = {
    serverTimeMs: number;
    current: BroadcastCurrentItem | null;
    next: BroadcastCurrentItem | null;
    failoverHlsUrl?: string | null;
    liveOverride?: { title: string; startedAtMs: number; endsAtMs: number | null } | null;
    source: "override" | "schedule" | "queue" | "empty";
  };

  const wire = await res.json() as WireState;
  const positionSecs = wire.current
    ? Math.max(0, (wire.serverTimeMs - wire.current.startsAtMs) / 1000)
    : 0;
  const totalSecs = wire.current?.durationSecs ?? 0;

  return {
    serverTimeMs: wire.serverTimeMs,
    current: wire.current,
    next: wire.next,
    positionSecs,
    totalSecs,
    progressPercent: totalSecs > 0 ? Math.min(100, (positionSecs / totalSecs) * 100) : 0,
    failoverHlsUrl: wire.failoverHlsUrl ?? null,
    isLive: wire.source === "override",
    liveOverride: wire.liveOverride
      ? {
          title: wire.liveOverride.title,
          youtubeVideoId:
            wire.current?.source.kind === "youtube" ? wire.current.source.url : null,
          hlsStreamUrl:
            wire.current?.source.kind === "hls" ? wire.current.source.url : null,
        }
      : null,
  };
}

// ─── Channels ────────────────────────────────────────────────────────────────

export async function fetchChannels(): Promise<ApiChannel[]> {
  const res = await publicFetch("/api/channels");
  if (!res.ok) throw new Error(`Failed to fetch channels (${res.status})`);
  const data = await res.json() as { channels?: ApiChannel[] } | ApiChannel[];
  return Array.isArray(data) ? data : (data.channels ?? []);
}

// ─── Live status ─────────────────────────────────────────────────────────────

export interface LiveStatus {
  isLive: boolean;
  videoId: string | null;
  title: string | null;
  startedAt: string | null;
}

export async function fetchLiveStatus(): Promise<LiveStatus> {
  const res = await publicFetch("/api/youtube/live/status");
  if (!res.ok) return { isLive: false, videoId: null, title: null, startedAt: null };
  return res.json() as Promise<LiveStatus>;
}

// ─── Interactions (fire-and-forget) ─────────────────────────────────────────

export type ReactionType = "amen" | "fire" | "hallelujah";

/** Send a broadcast reaction. Fire-and-forget — callers should not await. */
export async function sendReaction(type: ReactionType): Promise<void> {
  try {
    await publicFetch("/api/broadcast/reaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    /* intentionally silent */
  }
}

/** Submit a prayer request. Returns true on success. */
export async function submitPrayerRequest(
  name: string | null,
  message: string,
): Promise<boolean> {
  try {
    const res = await publicFetch("/api/broadcast/prayer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name ?? "Anonymous", message, platform: "mobile" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Submit a bug report or feedback. Returns true on success. */
export async function submitFeedback(payload: {
  type: "bug" | "suggestion" | "general";
  subject: string;
  message: string;
  platform?: string;
  appVersion?: string;
}): Promise<boolean> {
  try {
    const res = await publicFetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Record a view event for a video (best-effort). */
export async function recordView(videoId: string): Promise<void> {
  try {
    await publicFetch(`/api/videos/${videoId}/view`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    /* non-critical */
  }
}

/** Update the authenticated user's profile. */
export async function updateProfile(data: {
  displayName?: string;
  avatarUrl?: string;
}): Promise<void> {
  const res = await authedFetch("/api/auth/profile", {
    method: "PATCH",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update profile");
}

/** Change the authenticated user's password. */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const res = await authedFetch("/api/auth/password", {
    method: "PATCH",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? "Failed to change password");
  }
}

// ─── Playlists ────────────────────────────────────────────────────────────────

export interface ApiPlaylist {
  id: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  videoCount: number;
  category: string;
  createdAt: string;
}

export interface ApiPlaylistDetail extends ApiPlaylist {
  videos: ApiVideo[];
}

/** Fetch all published playlists. */
export async function fetchPlaylists(limit = 100): Promise<ApiPlaylist[]> {
  const res = await publicFetch(`/api/playlists?limit=${limit}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Failed to fetch playlists (${res.status})`);

  type RawPlaylistItem = {
    id: string;
    name?: string;
    title?: string;
    description?: string;
    thumbnailUrl?: string;
    videoCount?: number;
    category?: string;
    createdAt?: string;
  };
  const data = await res.json() as {
    playlists?: RawPlaylistItem[];
    items?: RawPlaylistItem[];
    data?: RawPlaylistItem[];
  };

  const raw = data.playlists ?? data.items ?? data.data ?? [];
  return raw.map((p) => ({
    id: p.id,
    title: p.title ?? p.name ?? "",
    description: p.description ?? "",
    thumbnailUrl: p.thumbnailUrl ?? "",
    videoCount: p.videoCount ?? 0,
    category: p.category ?? "",
    createdAt: p.createdAt ?? "",
  }));
}

/** Fetch a single playlist with its ordered videos. */
export async function fetchPlaylistById(id: string): Promise<ApiPlaylistDetail> {
  const res = await publicFetch(`/api/playlists/${id}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Playlist not found (${res.status})`);

  type RawPlaylistVideo = {
    id: string;
    videoId?: string;
    youtubeId?: string;
    title?: string;
    thumbnailUrl?: string;
    duration?: string;
    category?: string;
  };
  type RawPlaylistDetail = {
    id: string;
    name?: string;
    title?: string;
    description?: string;
    thumbnailUrl?: string;
    videoCount?: number;
    category?: string;
    createdAt?: string;
    videos?: RawPlaylistVideo[];
  };

  const raw = await res.json() as { playlist?: RawPlaylistDetail } | RawPlaylistDetail;
  const detail: RawPlaylistDetail =
    ("playlist" in raw && raw.playlist) ? raw.playlist : (raw as RawPlaylistDetail);

  const playlist: ApiPlaylist = {
    id: detail.id,
    title: detail.title ?? detail.name ?? "",
    description: detail.description ?? "",
    thumbnailUrl: detail.thumbnailUrl ?? "",
    videoCount: detail.videoCount ?? 0,
    category: detail.category ?? "",
    createdAt: detail.createdAt ?? "",
  };

  const videos: ApiVideo[] = (detail.videos ?? []).map((v) => ({
    id: v.videoId ?? v.id,
    youtubeId: v.youtubeId ?? "",
    title: v.title ?? "",
    description: "",
    thumbnailUrl: v.thumbnailUrl ?? "",
    duration: v.duration ?? "",
    category: v.category ?? "",
    preacher: "",
    publishedAt: null,
    importedAt: "",
    viewCount: 0,
    videoSource: (v.youtubeId ? "youtube" : "local") as ApiVideo["videoSource"],
    localVideoUrl: null,
    hlsMasterUrl: null,
    youtubeLiveStatus: (v as any).youtubeLiveStatus ?? null,
  }));

  return { ...playlist, videos };
}

// ─── Series list ─────────────────────────────────────────────────────────────

export interface ApiSeries {
  id: string;
  title: string;
  slug: string;
  description: string;
  thumbnailUrl: string;
  preacher: string | null;
  category: string;
  isOngoing: boolean;
  episodeCount: number;
}

/** Fetch all published sermon series. */
export async function fetchSeriesList(limit = 50): Promise<ApiSeries[]> {
  const res = await publicFetch(`/api/series?limit=${limit}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Failed to fetch series (${res.status})`);
  const data = await res.json() as { series?: ApiSeries[]; data?: ApiSeries[] };
  return data.series ?? data.data ?? [];
}
