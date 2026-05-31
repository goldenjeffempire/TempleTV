---
name: Comprehensive platform audit — sprint 24
description: 10 bugs fixed across schema, API, broadcast sync, and admin frontend from full parallel audit
---

# Sprint 24 — Audit Findings & Fixes

## Rule
Series `episodeCount` must always be updated inside a `db.transaction()` together with the INSERT/DELETE. The unique constraints on `series_episodes(series_id, episode_number)` and `(series_id, video_id)` are what make the 23505 retry logic in series.routes.ts actually work — without them, duplicate episode numbers can accumulate silently.

**Why:** Without transactions, a DB failure between the INSERT and the UPDATE leaves `episodeCount` permanently wrong. Without the unique constraints, the retry-on-conflict logic catches nothing.

## Fixes applied

1. **`lib/db/src/schema/series.ts`** — Added `uniqueIndex` on `(series_id, episode_number)` and `(series_id, video_id)` in `seriesEpisodesTable`. The episode-add route's 23505-retry logic requires this constraint to function.

2. **`series.routes.ts`** — Episode add and remove now wrapped in `db.transaction()`. Both the INSERT/DELETE and the `episodeCount` UPDATE are atomic.

3. **`transcoder.dispatcher.ts`** — `resetStuckJobs` now adds `ne(videos.transcodingStatus, "hls_ready")` guard. Without it, a concurrent replica could complete a job between the stuck-job scan and the status update, reverting a finished video to "queued".

4. **`chunked-upload.routes.ts`** — Empty chunk on DB fallback now throws (fail-fast). Silently skipping produced corrupt/truncated video assemblies that passed finalize without error.

5. **`media-uploads.routes.ts`** — `persistSessionToDb` void call now has a `.catch()` that logs errors. Previously, DB failures were silent and operators had no visibility.

6. **`auth.routes.ts`** — `forgotPassword` catch now logs at ERROR level. SMTP/DB failures were completely invisible before.

7. **`broadcast-v2/io/sse.gateway.ts`** — SSE replay failure now logs a WARN. Previously fully silent, making it impossible to diagnose DB performance issues under reconnect storms.

8. **`lib/broadcast-sync/src/engine/StateSyncService.ts`** — `applyWire` guard changed from `<` to `<=`. Prevents a stale HTTP snapshot arriving in the same millisecond as a fresh WS event from overwriting it.

9. **`admin/src/pages/security.tsx` (CodeDisplay)** — Timer now stored in `timerRef` and cleared on unmount via `useEffect` cleanup. Rapid clicks no longer stack timers.

10. **`admin/src/pages/security.tsx` (QrCode)** — `.catch(() => {})` replaced with `setQrError(true)`. User now sees "QR code could not be generated" instead of a blank canvas.

## False positives documented
- `machine.ts` sourceExpiryTimer: `destroy()` already calls `clearSourceExpiryTimer()`. No leak.
- `useTVNav.ts` capture mismatch: both add and remove use `{ capture: true }`. Correct.
- `wsConnectionsPerIp` sweep: belt-and-suspenders as documented. Not a bug.
- `broadcast_event_log` missing index: already has `uniqueIndex` on `(channel_id, sequence)` which serves range queries.
- Auth `/refresh` banned-user check: no `isBanned`/`isActive` column in schema; `sessionsValidAfter` is the revocation mechanism.
- `videos.tsx` page not reset on filter change: already reset to 1 in all filter onChange handlers.
