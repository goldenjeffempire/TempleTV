---
name: Production fixes — unhandled rejections + push OOM
description: Three real production issues fixed in the June 2026 audit; all others were confirmed false positives.
---

## Issues fixed

### 1. `youtube-live.poller.ts` — `poll()` missing outer try/catch
- **Root cause**: `private async poll()` had no enclosing try/catch. Any uncaught error from `pollRss()`, `fetchViewerCount()`, `pollApi()`, or `setState()` would propagate as an unhandled rejection. Node ≥15 terminates the process on unhandled rejections.
- **Fix**: Wrapped the entire body of `poll()` in `try { ... } catch (err) { logger.warn(...) }`.

### 2. `cleanup.service.ts` — `void runCleanupForVideo()` unguarded at call site
- **Root cause**: `runCleanupForVideo` has an internal try/catch starting at line 376, but the initial DB query (line 351) runs BEFORE that try block. If the DB throws (connection blip), the error escapes the function as an unhandled rejection. The call site at line 330 used bare `void runCleanupForVideo(...)` with no `.catch()`.
- **Fix**: Added `.catch((err) => logger.warn(...))` at the call site for zero-retention immediate cleanup.

### 3. `push-delivery.ts` — full subscriber table loaded into memory (OOM)
- **Root cause**: `deliverToExpo` and `deliverToWebPush` each called `db.select().from(table)` with no LIMIT, loading ALL tokens/subscriptions into a single Node.js array. At 100k+ subscribers this causes OOM on the 460 MiB heap budget.
- **Fix**: Both functions now use keyset pagination (`gt(id, lastId)` + `orderBy(id)` + `LIMIT 500`) processing one page at a time. Peak memory is bounded to O(500) entries. Stale token/subscription cleanup happens per-page. Also fixed a return value bug where `deliverToWebPush` was returning `dispatched` (last-page local) instead of `totalDispatched` (accumulated total).

## Confirmed false positives (no changes needed)
- `db.ts` `void runCleanup()` — function has full try/catch inside ✅
- `cleanup.service.ts:602` `void runCleanupSweep()` — already has `.catch()` ✅
- `auto-override.ts:177` `void evaluate(state)` — already has `.then().catch()` ✅  
- `dispatcher.ts` `void this.resetStuckSending()` — function has full try/catch inside ✅
- `transcoder.dispatcher.ts purgeOrphanedScratchDirs/scanAndKill` — both have outer try/catch ✅
- `invalidateVideosCatalogCache()` — function body already has `.catch(() => {})` on its sole await ✅
- `videos.tsx:1056` `data!.videos.map` — inside `(data?.videos?.length ?? 0) === 0` ternary; data is non-null at that branch ✅
- `youtube-sync.tsx:609` `history!.items.map` — inside `history?.items?.length === 0` else branch; history is non-null ✅
- `analytics.tsx` setInterval — already has `clearInterval` in effect cleanup ✅
- `app-layout.tsx`, `sidebar.tsx` keydown — already have `removeEventListener` in cleanup ✅
- All admin mutations flagged — already have `onError` handlers ✅

**Why:** Node ≥15 terminates on unhandled rejections. Every fire-and-forget `void fn()` that may throw before its own try/catch must have a `.catch()` at the call site.
