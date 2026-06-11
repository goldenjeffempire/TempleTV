---
name: Catalog ETag + 2-stage mobile load
description: Mobile/TV catalog fetch optimizations — ETag conditional GET, 2-stage page loading, session ETag storage pattern.
---

## Rules

1. `mobile/services/api.ts::fetchVideos` returns `Promise<VideosResponse | null>` — `null` means server returned 304 Not Modified. All callers must guard for null.

2. Session ETag is stored in module-level `_lastCatalogEtag` in `api.ts`; read via `getLastCatalogEtag()`. Only set for unfiltered page-1 fetches. Not persisted — AsyncStorage covers cross-session caching.

3. Mobile `useVideos.ts` `load()` passes `ifNoneMatch: getLastCatalogEtag()` only when `silent=true` (background refresh). Cold-start (silent=false) never passes ETag so fresh data is always fetched.

4. TV `api.ts` uses module-level `tvCatalogEtag` set after every successful `/videos?limit=200&source=youtube` fetch. `fetchVideos` returns `VideoItem[] | null` — `useData.ts` handlers check `videos !== null` before updating state.

5. Mobile 2-stage pattern: `CATALOG_PAGE_SIZE=100` is a module-level constant. Stage 1 fetches page 1, paints UI, marks `loadedRef.current=true`. Stage 2 fetches pages 2..`min(totalPages, 10)` in a loop, merges into `allMapped`, updates state progressively. `loadGenRef` generation counter aborts stale background fetches when a new `load()` supersedes.

**Why:** Reduces bandwidth on every 5-min background poll when the library hasn't changed (~30 KB JSON skipped). 2-stage cuts mobile cold-start paint by ~80 ms by showing first 100 items before the full catalog arrives.

**How to apply:** `fetchWithRetry` passes 304 through (it's not `res.ok` but also not in `defaultIsRetryable`) so 304 reaches `fetchVideos` correctly without any retry loop changes.
