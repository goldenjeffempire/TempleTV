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
import { secureStorage } from "@/lib/secureStorage";
import { STORAGE_KEYS } from "@/constants/config";

// ─── Internal helpers ────────────────────────────────────────────────────────

function url(path: string): string {
  return `${getApiBase()}${path}`;
}

async function publicFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(url(path), {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(12_000),
  });
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await secureStorage.getItem(STORAGE_KEYS.authToken);
  return fetch(url(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: init?.signal ?? AbortSignal.timeout(12_000),
  });
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
 */
export async function fetchVideos(opts: FetchVideosOptions = {}): Promise<VideosResponse> {
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

  const res = await publicFetch(`/api/videos?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch videos (${res.status})`);
  const data = await res.json() as { videos?: ApiVideo[]; data?: ApiVideo[]; total?: number; totalPages?: number };
  const videos = data.videos ?? data.data ?? [];
  const total = data.total ?? videos.length;
  const totalPages = data.totalPages ?? 1;
  return { videos, total, totalPages, page: opts.page ?? 1, limit: opts.limit ?? 200 };
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

/** Record a view event for a video (best-effort). */
export async function recordView(videoId: string): Promise<void> {
  try {
    await authedFetch(`/api/videos/${videoId}/view`, {
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
