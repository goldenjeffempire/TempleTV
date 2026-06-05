---
name: Admin panel comprehensive audit sprint 44
description: 10 bugs fixed across YouTube sync, admin-videos, faststart, queue validator, media scanner, users page, and dashboard. 1 pre-existing TS error fixed.
---

## Bug 1 (HIGH) — YouTube quota exhaustion bypass
- `syncYouTubeChannel` only checked `apiKey != null` to decide API vs RSS; quota state was tracked but never consulted before making the call
- Consequence: when `quotaUsed >= QUOTA_TOTAL`, the sync still calls the Data API, wastes a round-trip, logs a 403, THEN falls back to RSS
- Fix: added `export function isQuotaExhausted()` to `youtube-sync.service.ts` + changed the API/RSS branch decision to also call `isQuotaExhausted()` — early RSS when quota is locally exhausted, with a WARN log explaining why
- File: `artifacts/api-server/src/modules/youtube-sync/youtube-sync.service.ts`

**Why:** `trackQuota` emits a WARN at 95% saying "falling back to RSS" but that log message was misleading — the code did NOT actually fall back; it was just a log. The real fallback happened only when Google returned 403.

## Bug 2 (MEDIUM) — admin-videos.routes.ts: unsafe `::timestamptz` casts (2 locations)
- Both the WHERE filter (line 185) and the "published" ORDER BY (line 229) used direct `::timestamptz` casts on `published_at`
- The public `/videos` route already had a `SAFE_PUB_AT` guard for exactly this reason (PostgreSQL's planner doesn't guarantee filter pushdown before cast)
- Fix: added `ADMIN_SAFE_PUB_AT` local const with the same `CASE WHEN ~ '^[0-9]{4}' THEN ...::timestamptz ELSE NULL` pattern; used in both filter and order-by
- File: `artifacts/api-server/src/modules/admin-videos/admin-videos.routes.ts`

**Why:** A single malformed `published_at` string in the DB causes the entire admin library listing to 500.

## Bug 3 (MEDIUM) — faststart duration sync threshold `> 10` ignores short videos
- The broadcast_queue duration sync in faststart success path was guarded by `durationSecs > 10`
- Short bumpers, intros, countdown clips (1–10 s) never had their duration corrected from the 1800s upload-time placeholder
- Consequence: orchestrator allocated 30 min of air time to a 5-second clip, then auto-skipped when natural end didn't fire
- Fix: changed threshold to `> 0` — any positive real duration from ffprobe is valid and should be written
- File: `artifacts/api-server/src/modules/transcoder/faststart.service.ts`

## Bug 4 (MEDIUM) — queue integrity validator reverse-recovery reactivates in-progress transcodes
- The MISSING_VIDEO_JOIN reverse pass re-activated queue items when a managed_videos row reappeared with `local_video_url OR hls_master_url IS NOT NULL`
- But `transcoding_status = 'encoding'` or `'processing'` rows can have a `local_video_url` (the original upload path) while HLS is still being generated
- Consequence: orchestrator sees the item as active, tries to play the raw upload URL → stall/skip cycle until transcoding finishes
- Fix: added `AND mv.transcoding_status NOT IN ('encoding', 'processing')` to the reverse-recovery SQL query
- File: `artifacts/api-server/src/modules/broadcast-v2/engine/queue-integrity-validator.ts`

## Bug 5 (MEDIUM) — media integrity scanner: `res.text()` unbounded body read
- `probeHlsManifest` used `res.text()` with no size cap; if a CDN returns a garbage multi-MB response for a "200 OK" manifest URL (e.g. a video file at the HLS URL), the scanner worker would buffer the entire body
- AbortController timeout was for the initial connection, not the body streaming phase
- Fix: added 64 KB streaming reader with `ReadableStream.getReader()` — reads chunks, cancels the stream after 64 KB; also added Content-Length pre-check to reject oversized responses immediately
- File: `artifacts/api-server/src/modules/broadcast-v2/engine/media-integrity-scanner.ts`

## Bug 6 (MEDIUM) — users.tsx role dropdown contains `"moderator"` — API rejects it
- The "Set Role" dropdown showed `["editor", "moderator", "user"]`
- `UpdateUserRoleBodySchema` in `admin.schemas.ts` only accepts `["user", "editor", "admin"]`
- Clicking "Set as moderator" triggered a 400 error with no useful feedback
- Fix: changed to `["editor", "user"]` — removed `"moderator"` since the API doesn't accept it
- File: `artifacts/admin/src/pages/users.tsx`

## Bug 7 (LOW) — users.tsx client-side filter used immediate `search` state instead of `debouncedSearch`
- Server query keyed on `debouncedSearch` (350ms debounce), but client-side filter used raw `search`
- During the debounce window, the filter used a search term that didn't match the currently loaded page (different debouncedSearch value) → list appeared empty while typing
- Fix: changed filter to use `debouncedSearch` to match the server query's state
- File: `artifacts/admin/src/pages/users.tsx`

## Bug 8 (LOW) — dashboard.tsx transcoding queue silently swallowed all API errors
- `.catch(() => ({ jobs: [] }))` on the transcoding queue query made all backend errors (network failure, API crash, transcoder down) look identical to "no pending jobs"
- The dashboard card showed "All jobs complete" with a green checkmark even when the API was unreachable
- Fix: removed the `.catch()`, added `isError: transcodingError` destructuring, added an error branch in the card UI showing "Transcoding queue unavailable" with a red AlertCircle
- File: `artifacts/admin/src/pages/dashboard.tsx`

## Bug 9 (LOW) — broadcast/auto-enqueue.service.ts: TypeScript `videoSource` type narrowing
- `row.videoSource` was typed as `string` (Drizzle infers from schema) but `addToQueue()` expected `"youtube" | "local" | "hls"` literal union
- Caused `tsc --build` to fail with TS2322 — was a pre-existing error not introduced by this sprint
- Fix: added `as "youtube" | "local" | "hls"` cast; the DB column has a check constraint ensuring only valid values enter
- File: `artifacts/api-server/src/modules/broadcast/auto-enqueue.service.ts`

## Confirmed false positives from audit
- **Ban rank check `>=` vs `>`**: the `>=` guard is intentional — "equal or higher privileges" are protected. An admin (3) cannot ban another admin (3); only system (4) can. This is a deliberate security escalation design. NOT a bug.
- **Stale sync log recovery**: already fully implemented in `db.ts:recoverStaleSyncLogs()` called from `main.ts`. FALSE POSITIVE.
- **Dispatcher unused `isQuotaExhausted` import**: correctly removed — the check lives inside `syncYouTubeChannel` in the service, not the dispatcher.
- **inFlight zombie cleanup in faststart-recovery**: already has 30-min TTL eviction with a cleanup loop before each `dispatchOne()` call. Confirmed fine for single-process deployments.
- **Multi-replica sync race**: `_syncInProgress` boolean is per-process; in multi-replica setups concurrent syncs are technically possible. NOT fixed — multi-replica is not the deployment model.
- **Delete /admin/videos/:id orphan cleanup non-atomic**: cleanup runs in fire-and-forget IIFE after primary video row delete; this is a documented trade-off (orphan cleanup is non-fatal and idempotent). NOT changed.
