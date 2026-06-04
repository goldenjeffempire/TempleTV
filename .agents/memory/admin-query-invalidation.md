---
name: Admin panel query invalidation matrix
description: Which admin mutations must invalidate which TanStack Query keys; catalog cache prefix bug; cross-page bulk-selection hazard.
---

## Rules

### Video delete (single + bulk)
Must invalidate: `admin-videos`, `admin-stats`, `broadcast-queue`, `series`, `series-episodes`, `playlists`, `youtube-library-videos`.
- `youtube-library-videos` is required or the Library tab shows ghost entries until stale time.
- `admin-stats` is required or the Dashboard total-videos counter goes stale.

### YouTube sync (syncMutation.onSuccess + useSSEEvent "videos-library-updated")
Must invalidate: `youtube-sync-status`, `youtube-library-videos`, `youtube-sync-history`, `admin-stats`, **and `admin-videos`**.
- Without `admin-videos`, newly synced videos don't appear in the Videos tab until stale time.

### Series episode add/remove
Must invalidate: `series-episodes`, `series`, **and `admin-stats`**.
- Without `admin-stats`, dashboard episode counts go stale.

### Broadcast-v2 reprobe duration
Must invalidate: `broadcast-queue`, **and `broadcast-v2-transcoding-panel`**.
- Without `broadcast-v2-transcoding-panel`, updated duration doesn't appear in the transcoding panel until next poll.

## Catalog cache key prefix bug (fixed)
`invalidateVideosCatalogCache()` in `videos.routes.ts` had two bugs:
1. Key prefix: used `catalog:g` but `catalogCacheKey()` generates `catalog2:g` — the proactive `del` never matched any real key.
2. Generation: tried to del the NEW generation key (which didn't exist yet) instead of the OLD one.

**Fix:** save `oldGen = catalogGeneration` before incrementing, then `del(\`videos:catalog2:g${oldGen}:newest:1:50\`)`.

Correctness was never broken (generation bump makes old keys unreachable regardless), but the proactive del was a no-op.

## Cross-page bulk-selection hazard (fixed)
`selectedIds` in `videos.tsx` was NOT cleared when the user navigated pages via the prev/next buttons.
- Selecting items on page 1, going to page 2, then clicking "Delete Selected" deleted invisible page-1 items.
- Fix: `useEffect(() => { setSelectedIds(new Set()); }, [page])`.
- Filter/search handlers already clear selection explicitly; the useEffect only covers pagination buttons.

**Why:** TanStack Query mutations fire against every ID in `selectedIds` regardless of which page is visible.

## Library sync history loading skeleton
The `history` query is `enabled: showHistory` — it fires only when the panel is opened. Without a loading guard, the panel flashed empty ("No sync history yet") while the request was in flight. Added `isLoading: historyLoading` and 3-row skeleton placeholders.
