import { cache } from "./cache";
import { broadcastLiveEvent } from "./liveEvents";

/**
 * Cache keys used by the public, CDN-cacheable list endpoints in
 * `routes/admin.ts`. Centralised here so any code path that mutates the
 * underlying data (admin routes, the transcoding worker, the YouTube
 * sync scheduler, etc.) can invalidate them without duplicating string
 * literals across the codebase.
 *
 * Trending uses parameterised keys (limit + sinceDays). The trending
 * endpoint registers every key it serves via `registerTrendingCacheKey`
 * so that an invalidation pass clears ALL variants the clients have
 * actually requested — not just the default. This matters because the
 * mobile app, TV app, and web admin can each request slightly different
 * limits/ranges, and stale results on any one of them defeats the
 * "uploads appear immediately" guarantee.
 */
export const PUBLIC_VIDEOS_TRENDING_DEFAULT_CACHE_KEY =
  "public:videos:trending:20:90";
export const PUBLIC_VIDEOS_FEATURED_CACHE_KEY = "public:videos:featured";
export const PUBLIC_PLAYLISTS_ACTIVE_CACHE_KEY = "public:playlists:active";

const trackedTrendingKeys = new Set<string>([
  PUBLIC_VIDEOS_TRENDING_DEFAULT_CACHE_KEY,
]);

/**
 * Called by `/videos/trending` on every request so the invalidator
 * later knows the full set of (limit, sinceDays) variants in active
 * use. Bounded by the endpoint's own input clamping (limit ≤ 50,
 * sinceDays ≤ 365), so the set can never grow unbounded.
 */
export function registerTrendingCacheKey(key: string): void {
  trackedTrendingKeys.add(key);
}

/**
 * Invalidate every public video list cache and notify connected
 * clients (web, mobile, smart TV) that the library has changed so
 * they can refetch immediately instead of waiting on the 60s TTL or
 * a manual tab switch.
 */
export async function invalidatePublicVideoCaches(): Promise<void> {
  const keys = [...trackedTrendingKeys, PUBLIC_VIDEOS_FEATURED_CACHE_KEY];
  await Promise.all(keys.map((k) => cache.del(k).catch(() => {})));
  // Push a real-time signal to every connected SSE consumer so the
  // mobile/TV/web library lists refetch within a few hundred ms instead
  // of catching up on the next poll boundary.
  broadcastLiveEvent("videos-library-updated", {
    at: new Date().toISOString(),
  });
}

/** Invalidate the well-known public playlist list cache. */
export async function invalidatePublicPlaylistCaches(): Promise<void> {
  await cache.del(PUBLIC_PLAYLISTS_ACTIVE_CACHE_KEY).catch(() => {});
}
