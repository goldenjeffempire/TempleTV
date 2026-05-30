---
name: Comprehensive platform audit — sprint 14
description: 10 bugs fixed across security, API, player-core, TV, and admin surfaces.
---

## Fixes

### Security
- **auth.ts getCachedSessionsValidAfter stale-cache fail-open** — on DB error, previously returned `null` (fail open, accepts revoked tokens). Fix: return stale cached entry if available; only fall back to `null` on cold start (no prior cache). Stale data still enforces the last-known revocation fence.

### API
- **device-link /exchange double-exchange race** — `refreshTokens` insert and `deviceLinkCodes` consumed-at update were two separate statements; concurrent calls could issue two token pairs. Fix: wrapped both in a `db.transaction()` with a re-read inside to fail if code is already consumed.
- **GET /user/favorites unbounded query** — fetched ALL rows; no limit. Fix: added `limit`/`offset` Zod-validated querystring (default 50, max 200).
- **POST /user/favorites check-then-insert TOCTOU** — concurrent requests both passed the "exists?" check and both attempted INSERT → unique constraint error. Fix: replaced with `db.insert().onConflictDoUpdate()` upsert. Required upgrading the regular index to `uniqueIndex("user_favorites_user_video_uniq_idx")` and running `db push`.

**Why:** `onConflictDoUpdate` requires a unique index target; a plain `index()` causes Drizzle to throw at runtime.

### Player Core (machine.ts)
- **lastSequence regression on out-of-order SSE** — `onSnapshot()` unconditionally set `lastSequence = server.sequence`; a replayed low-sequence event would regress the resume cursor and trigger duplicate bind/seek. Fix: only advance if `server.sequence > this.snapshot.lastSequence`.
- **Missing `destroy()` method** — `sourceExpiryTimer` kept the machine alive after session teardown, firing snapshot requests into a dead transport. Fix: added public `destroy()` that calls `clearSourceExpiryTimer()` and clears the listeners set.

### TV (HlsVideoPlayer.tsx)
- **GPU VRAM leak on unmount** — `hls.destroy()` detaches MSE but does NOT release the YUV frame buffer on Samsung Tizen / LG webOS. Fix: in the cleanup `useEffect`, after `destroy()`, call `video.removeAttribute('src'); video.load()` on both slots to release the GPU texture.
- **4K (2160p) quality label missing** — `levelLabel(h)` fell through to "1080p" for 2160p sources. Fix: added `if (h >= 2160) return "4K"` guard.

### TV (SermonCard.tsx)
- **Missing keyboard handler on role="button"** — card had `role="button"` and `tabIndex={0}` but no `onKeyDown`; keyboard / remote Enter/Space did nothing. Fix: added `onKeyDown` handler that calls `onClick()` on `Enter` or `Space` with `preventDefault()`.

### Admin (App.tsx)
- **Prefetch timers not cancelled on logout** — `prefetchCommonPages()` returned `void`; if the user logged out before the 2/5/10 s timers fired, the closures ran anyway referencing stale module imports. Fix: refactored to return timer ID array; `AuthenticatedApp` useEffect cleanup iterates and calls `clearTimeout` on each.
