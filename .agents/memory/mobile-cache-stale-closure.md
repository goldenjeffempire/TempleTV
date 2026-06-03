---
name: Mobile cache stale-closure pattern
description: Two recurring pitfalls when writing offline-first hooks with useCallback([]) and AuthContext sign-out cache clearing
---

## Rule 1 — `useCallback([])` cannot read current state: use a ref instead

When a hook uses `useCallback(async () => { ... }, [])` to prevent infinite re-renders, any state variable captured in the closure always holds its **initial value**, not the current one. This is the classic React stale-closure trap.

```ts
// BAD — `list` is always [] here even after setSeries(cached) fires
const load = useCallback(async () => {
  // ... cache fills list via setSeries(cached)
  try { ... setSeries(fetched); }
  catch (e) {
    if (list.length === 0) setError(String(e)); // stale: always 0
  }
}, []);

// GOOD — ref is mutable, always current
const hasDataRef = useRef(false);
const load = useCallback(async () => {
  if (cacheHit) { setSeries(cached); hasDataRef.current = true; }
  try { ... setSeries(fetched); hasDataRef.current = true; }
  catch (e) {
    if (!hasDataRef.current) setError(String(e)); // correct
  }
}, []);
```

**Why:** State setters (`setSeries`) enqueue an async React re-render; the closure sees the value from when `useCallback` was last evaluated (deps = `[]` means: only at mount). A ref write is synchronous and visible immediately to all code in the same closure.

**How to apply:** Any `useCallback([])` hook that has a "don't show error if we already have data" guard must use a ref (`hasDataRef`) rather than the state variable. Pattern: set `hasDataRef.current = true` right after `setList(data)` in both the cache path and the network path; check `!hasDataRef.current` in the catch.

Affected hooks in this codebase: `usePlaylists`, `usePlaylistDetail`, `useSeriesList` (in library.tsx).

---

## Rule 2 — `AuthContext.USER_SCOPED_STORAGE_PREFIXES` must cover every cache key prefix added

`clearUserScopedCaches()` in `AuthContext.tsx` does a prefix-match sweep over all AsyncStorage keys on sign-out. **Every new `@temple_tv/*` cache key written by a hook must have its prefix listed there.**

Critical: `@temple_tv/playlists` catches `playlists_v1` but NOT `playlist_detail_v1` (missing `s`). Always check: `"@temple_tv/playlist_detail_v1:id".startsWith("@temple_tv/playlists")` → **false**.

Public/non-user content (e.g. `@temple_tv/series_v1`) does not need to be listed — only per-user or session-tainted data.

**How to apply:** When adding a new `AsyncStorage.setItem("@temple_tv/xyz_v1:id", ...)` call in any hook, check the prefix list in `AuthContext.tsx` and add the prefix if the data is user-scoped.
