import { cache } from "./cache";

/**
 * Cache keys used by the public, CDN-cacheable list endpoints in
 * `routes/admin.ts`. Centralised here so any code path that mutates the
 * underlying data (admin routes, the transcoding worker, the YouTube
 * sync scheduler, etc.) can invalidate them without duplicating string
 * literals across the codebase.
 *
 * Trending uses parameterised keys (limit + sinceDays). We invalidate
 * only the default key (`20:90`) here — non-default callers will catch
 * up on the next 60s TTL boundary, which is acceptable because the UI
 * only ever requests the defaults.
 */
export const PUBLIC_VIDEOS_TRENDING_DEFAULT_CACHE_KEY =
  "public:videos:trending:20:90";
export const PUBLIC_PLAYLISTS_ACTIVE_CACHE_KEY = "public:playlists:active";

/** Invalidate the well-known public video list caches. */
export async function invalidatePublicVideoCaches(): Promise<void> {
  await cache.del(PUBLIC_VIDEOS_TRENDING_DEFAULT_CACHE_KEY).catch(() => {});
}

/** Invalidate the well-known public playlist list cache. */
export async function invalidatePublicPlaylistCaches(): Promise<void> {
  await cache.del(PUBLIC_PLAYLISTS_ACTIVE_CACHE_KEY).catch(() => {});
}
