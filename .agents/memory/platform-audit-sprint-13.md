---
name: Comprehensive platform audit — sprint 13
description: 6 bugs fixed — 3 missing DB transactions (channel deletion, transcoder queue, auth token rotation), start:prod source maps, notification double-send, mobile logout cache miss.
---

## Fixes applied

### API Server — Missing DB Transactions (Critical data-integrity bugs)

1. **`channels/channels.routes.ts` — channel deletion partial write** — Three sequential writes (channelRegistry.remove + db.delete channelQueue + db.delete channels) with no transaction. If the second delete failed, orphaned queue rows pointed at a non-existent channel. Fixed: wrapped both DB deletes in `db.transaction()`; registry.remove moved AFTER the transaction commits so a DB failure leaves registry consistent with DB state.

2. **`transcoder/transcoder.queue.ts` — enqueueTranscode partial write** — Both code paths (new job: `db.insert(jobs)` + `db.update(videos)` and re-arm failed: `db.update(jobs)` + `db.update(videos)`) were sequential without a transaction. A DB failure midway left the job/video in inconsistent states (e.g., job inserted but video still showing old status, or vice versa). Fixed: wrapped each pair in `db.transaction()`.

3. **`auth/auth.service.ts` — refresh token rotation partial write** — `db.update(refreshTokensTable, revokedAt)` then `issueTokens()` (which inserts new token) was non-atomic. A DB failure between the two steps permanently logged the user out (old token revoked, no new token issued). Fixed: generate JWT values (pure crypto, no DB) BEFORE transaction, then atomically `UPDATE revokedAt` + `INSERT new token` inside `db.transaction()`. No longer calls `issueTokens()` — inlines just the DB portion for transaction scope.

### API Server — Production Build

4. **`package.json` — `start:prod` missing `--enable-source-maps`** — Production deployments generated stack traces with minified byte offsets instead of source-mapped file/line references, making production debugging nearly impossible. Added `--enable-source-maps` to `start:prod` script (matches the existing `start` script).

### Admin Frontend

5. **`notifications.tsx` — "Send Now" button double-submission** — `AlertDialogAction` for the send-now confirm dialog had no `disabled` guard or `isPending` check. On slow networks, clicking multiple times sent the same push notification multiple times. Fixed: added `disabled={sendMutation.isPending}` and a loading spinner with "Sending…" label.

### Mobile App

6. **`context/AuthContext.tsx` — video catalog not cleared on sign-out** — `clearUserScopedCaches()` cleared favorites/history/playlists/cloud_sync but omitted `@temple_tv/videos_v2` (the catalog cache key from `useVideos.ts`). A second user signing in on the same device would see the first user's cached video library. Fixed: added `"@temple_tv/videos_v2"` to `USER_SCOPED_STORAGE_PREFIXES`.

## False positives from audit (confirmed OK, no fix needed)
- **auth.routes.ts `/register` rate limit** — already has `authRateLimit` config (confirmed at line 72)
- **youtube-sync.service.ts N+1 delete** — NOT a loop; single batch DELETE with a SQL WHERE clause (lines 1036-1041)
- **chunked-upload `/finalize` rate limit** — already has `{ max: 30, timeWindow: "1 minute" }` (confirmed at line 702)
- **mobile `inflightRefresh` race** — JS is single-threaded; the check-then-set is atomic; no real race condition
- **player-core `machine.ts` onSnapshot during HANDOFF** — has extensive stale-snapshot and post-natural-end guards (lines 402-458); intentional design
- **watchdog `disarm()`** — properly implemented at lines 91-97 with `clearInterval`
- **`broadcast-queue.ts` missing FK on `videoId`** — intentional: videoId is nullable by design (YouTube-only and prod-sync items have no managed_videos row)
- **series.tsx invalidations** — already invalidates `["series-episodes", series.id]` and `["series"]` in both addEpisode and removeEpisode
- **purge.tsx double-submit** — already has `disabled={confirmInput !== CONFIRMATION_PHRASE || purgeMutation.isPending}`
- **stream-health.tsx clearBadUrls invalidation** — already invalidates `["broadcast-v2-diagnostics-health"]` and `["broadcast-v2-engine-health"]`
