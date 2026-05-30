---
name: Comprehensive platform audit — sprint 10
description: 13 bugs fixed across API, DB schema, TV app, and Mobile app in sprint 10.
---

## Fixes applied

### API Server
1. **device-link/claim TOCTOU race** (`auth.routes.ts`) — Two concurrent `/device-link/claim` requests could both pass the `row.claimedAt` check and both write a claim. Fix: UPDATE WHERE `claimedAt IS NULL` + check 0 rows returned → 409.
2. **media-proxy PII in logs** (`media-proxy.routes.ts`) — `logger.warn({ targetUrl })` logged the full URL including query params (tokens, signed paths). Fix: extract `.host` only and log `{ targetHost }`.
3. **dead `export { desc }` + import** (`broadcast.service.ts`) — Accidental re-export of a Drizzle helper with no callers. Removed export and the now-unused `desc` import.

### DB Schema
4. **Missing `video_id` index on `user_watch_history`** (`user-watch-history.ts`) — "Has user watched this video?" JOIN queries and batch video-history lookups did full sequence scans. Added `user_watch_history_video_id_idx`.

### TV App
5. **HLS instant-swap missing `startWatchdog()`** (`HlsVideoPlayer.tsx`) — The fast-path that swaps to a preloaded slot skipped `startWatchdog()`, leaving the newly active video unmonitored for stalls. Added `startWatchdog()` to the instant-swap path.
6. **HLS instant-swap outgoing slot not cleared** (`HlsVideoPlayer.tsx`) — After a swap the outgoing slot's `loadedUrl` ref retained the old URL; the next `nextHlsUrl` that matched it would false-positive "already preloaded". Added `setLoaded(slot, null)` after swap.
7. **Samsung/Tizen AVPlay path missing `setLoaded`** (`HlsVideoPlayer.tsx`) — `video.src = url` returned without calling `setLoaded(slot, url)`, so instant-swap detection and preload dedup never worked on Tizen devices. Added `setLoaded` and `video.load()`.

### Mobile
8. **`fetchWithRetry` missing 408 retry** (`fetchWithRetry.ts`) — 408 Request Timeout is common on mobile zombie connections but was not in the retryable set. Added `res.status === 408` to `defaultIsRetryable`.
9. **Missing foreground notification handler** (`_layout.tsx`) — Only `addNotificationResponseReceivedListener` (tap from background) was registered; `addNotificationReceivedListener` (fires when app is open) was absent. Operators starting a live broadcast couldn't trigger in-app "Live now" banners for open viewers. Added handler + `liveNotificationBus` to emit to subscribed screens.
10. **New `liveNotificationBus` service** (`services/liveNotificationBus.ts`) — Lightweight in-process event bus; any screen can `subscribe()` and show a "Live now" banner when a live push arrives in the foreground.

## False positives from audit (confirmed OK, no fix needed)
- **Dashboard `.catch(() => null)` on engineHealth** — Intentional resilience: returns null on error, checked as `isEngineStuck` guard. Main stats errors DO surface via `statsError`.
- **TV ChatClient 8 s reconnect cap** — Appropriate for memory-constrained TV runtimes; pong handler exists (server sends pings, client observes).
- **`isKnownAppPath` paths** — Already includes `/donate` and `/link` at lines 200-207.
- **KeyboardAvoidingView `"height"` on Android** — Already uses `"height"` (not `undefined`) at PrayerRequestModal line 85; audit report was inaccurate.
