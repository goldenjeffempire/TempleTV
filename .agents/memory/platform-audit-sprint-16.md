---
name: Comprehensive platform audit — sprint 16
description: 6 bugs fixed across API security, admin pages, mobile hooks, and mobile player component.
---

## Fixes

### 1. Rate-limit allowList path.includes bypass (app.ts)
`path.includes("/broadcast-v2/state")` and 7 similar calls allowed a crafted URL like `/api/v1/admin/foo/broadcast-v2/state` to bypass rate limiting. Replaced all 8 `includes` calls with two `startsWith` checks per namespace: `path.startsWith("/api/broadcast-v2/")` and `path.startsWith("/api/v1/broadcast-v2/")`. Same pattern applied to midnight-prayers paths.

**Why:** `includes` is a substring match; `startsWith` with the full API prefix is the only safe approach. Query-string stripping was already in place for a prior bypass (sprint 9), but path-segment bypass wasn't addressed.

### 2. radio.tsx — double audio instance + stale listener bug
`testStream()` only guarded against `testState === "playing"` before creating a new Audio. If called while `testState === "loading"`, a second Audio element was created with its own `playing`/`error` listeners that still closed over `setTestState`. The old element remained unreferenced and its listeners could fire after the page was conceptually "stopped".

Fix: extracted `stopAudio()` helper that clears `.onplaying`/`.onerror`, pauses, and nulls the ref. `testStream()` now calls `stopAudio()` unconditionally before creating a new Audio, and the guard covers both `"playing"` and `"loading"` states. Unmount `useEffect` now calls `stopAudio()` directly.

**Why:** Assigning `.onplaying = null` (rather than using `removeEventListener`) works because we control the handler assignment pattern; using `addEventListener` + `removeEventListener` requires keeping listener refs which is more verbose.

### 3. midnight-prayers.tsx — queueData query error never shown
The `useQuery` for the queue data had no `error` destructure; if the API call failed the page rendered blank with no user feedback. Added `error: queueError, refetch: refetchQueue` to the destructure and added an inline error banner with a Retry button above the main grid.

### 4. mobile player.tsx ReactionButton — setTimeout fires on unmounted component
`setTimeout(() => setSent(false), 1400)` was fire-and-forget. On rapid unmount the callback fired on a dead component. Fixed by storing the timer in `sentTimerRef.current`, clearing it before scheduling a new one (preventing double-timers), and adding a `useEffect` cleanup that clears it on unmount.

### 5. mobile useVideos.ts — loadMore silent catch
`catch(() => { /* silent */ })` swallowed all pagination errors. Added `loadMoreError: string | null` state to `PaginatedVideosState` (exposed via return object). `loadMore` now sets `loadMoreError` on failure (and clears it before the next attempt). Both `search.tsx` and `library.tsx` now render a tappable "Failed to load more — tap to retry" footer when `loadMoreError` is set, clearing naturally on the next successful `loadMore`.

### 6. TV HlsVideoPlayer.tsx controlsHideTimer — confirmed already handled
Audit flagged this as missing unmount cleanup. Confirmed the cleanup was already present at the end of the component's single `useEffect([], [])` block (lines 610–614) — it clears `controlsHideTimer`, `watchdogRef`, `stallTimerRef`, `seekOsdTimer`, and `progressTimer`, and also destroys both HLS instances and releases GPU video textures. No fix needed.

## False positives confirmed
- `chat.tsx` already has `<ErrorAlert>` (line 70–76)
- `radio.tsx` already has a full-page error state (lines 145–154)
- `HlsVideoPlayer.tsx` unmount cleanup already clears all timer refs
- DB schema: all claimed missing indexes/constraints already present (verified in prior sprints)
- `push-delivery.ts`: intentionally uses `Promise.allSettled`
- `useData.ts useLiveStatus`: empty catch is intentional resilience (timer continues regardless)
