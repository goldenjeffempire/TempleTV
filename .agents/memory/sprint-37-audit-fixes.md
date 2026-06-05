---
name: Sprint 37 full-platform audit fixes
description: 16 bugs fixed across Admin UI, API security, DB schema, mobile, broadcast v1 modules
---

## Bugs Fixed

### Admin broadcast-v2.tsx — mutation invalidation gaps (5 bugs)
- `retryHlsMutation`: missing `broadcast-v2-diagnostics` + `broadcast-v2-queue-sync-status` invalidations
- `transcodeLocallyMutation`: same
- `reactivateMutation`: missing `broadcast-v2-queue-sync-status`
- `playNowMutation`: missing `broadcast-v2-diagnostics`
- `reorderMutation`: missing `broadcast-v2-diagnostics`

### Admin broadcast-v2.tsx — missing AlertDialog on "Clear failover" button
- "Force failover" had AlertDialog; "Clear failover" fired immediately (destructive — drops stream back to primary)
- Added `showClearFailoverConfirm` state + AlertDialog matching the Force failover pattern

### Mobile player.tsx — useEffect `[]` on view recording
- `useEffect(fn, [])` for `recordView` + `addToHistory` never re-fired when user navigated to a new video via `router.replace` within same mount
- Fixed: `[videoId]` dep

### Web push `Promise.allSettled` fan-out (push-delivery.ts)
- `deliverToWebPush` ran ALL subscribers concurrently (no limit); Expo path already chunked to 100
- Fixed: outer `for` loop with `WEB_PUSH_CHUNK_SIZE = 100`, mirrors Expo SDK's chunk pattern

### DB index: `device_watch_history (device_id, watched_at)`
- Primary query is `WHERE device_id = ? ORDER BY watched_at DESC LIMIT 100`
- Plain `device_id` index requires a separate sort; added composite `device_watch_history_device_watched_idx`
- Applied via `pnpm --filter @workspace/db run push`

### Auth security — 3 bugs
1. **`/mfa/verify` missing `sessionsValidAfter` gate**: `verifyMfaPendingToken` now returns `{ userId, issuedAtMs }`; handler fetches `sessionsValidAfter` and rejects if token pre-dates it
2. **`updateUserRole` missing `sessionsValidAfter` bump**: downgraded users retained JWT privileges until token expiry; now bumps `sessionsValidAfter: now`
3. **`mfa/disable` missing `sessionsValidAfter` bump**: disabling MFA didn't invalidate existing sessions; now bumps `sessionsValidAfter: now`

### Series routes — 2 bugs
1. **`GET /series/:slug` exposed unpublished series**: list filtered `isPublished=true` but detail did not; fixed with `AND isPublished = true` in WHERE
2. **Series slug 23505 → 500 instead of 409**: `POST /admin/series` didn't catch unique constraint; now maps code `23505` → `ConflictError`

### v1 Broadcast / Live-overrides — 2 transaction gaps
1. **`live-overrides.service.ts` `start()`**: deactivate-old + insert-new were sequential; if insert failed, no active override left; wrapped in `db.transaction`
2. **`broadcast-scheduler.ts` `tick()`**: deactivate-old + activate-new were sequential; same window; wrapped in `db.transaction`

## Key False Positives Cleared This Sprint
- TV history `GET/DELETE /tv/history/:deviceId` unprotected: intentional capability-based access (TV has no user auth)
- `restoreQuota()` void in dispatcher: internal try/catch, always resolves
- `resetStuckSending` void in notifications dispatcher: internal try/catch
- Mobile `router.push()` no try/catch: Expo Router handles navigation errors internally
- Drizzle `.unique()` vs `uniqueIndex()`: `.unique()` IS a unique constraint in Drizzle/PostgreSQL
- `viewCount` integer overflow: 2.1B threshold, not actionable for this platform
- React 18 setState-on-unmount: warning was removed; benign in RN and web
- `void tick()` in broadcast-scheduler: full internal try/catch at lines 39-156
