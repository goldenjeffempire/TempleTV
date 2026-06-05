---
name: Upload-to-broadcast pipeline audit fixes
description: 5 bugs found in the upload→library→broadcast-queue pipeline across transcoder dispatcher and finalize routes (Path A and Path B).
---

## Bug 1 (HIGH) — TranscoderDispatcher.nudge() bypasses TRANSCODER_DISABLE
- `stopped = false` by default; `nudge()` only checked `this.stopped`
- When `TRANSCODER_DISABLE=1`, `start()` is never called so `stopped` stays `false`
- Any call to `nudge()` would silently start the full polling loop
- **Fix**: Added `private started = false` field; `start()` sets `this.started = true`; `nudge()` checks `!this.started || this.stopped`
- File: `artifacts/api-server/src/modules/transcoder/transcoder.dispatcher.ts`

**Why:** The pattern `started=false` (never-started guard) + `stopped=false` (explicit stop guard) is the correct two-flag design for a dispatcher that may be permanently disabled at boot.

## Bug 2 (HIGH) — nudge() called unconditionally in both finalize paths
- Lines 1420 (Path A) and 1770 (Path B) of `chunked-upload.routes.ts` called `transcoderDispatcher.nudge()` without checking `TRANSCODER_DISABLE`
- **Fix**: Wrapped both with `if (!env.TRANSCODER_DISABLE) transcoderDispatcher.nudge()`
- Belt-and-suspenders on top of Bug 1 fix; makes call sites greppable as safe

## Bug 3 (MEDIUM) — Path B (db_fallback) thumbnail+duration probes ran in parallel
- Path A runs thumbnail then duration sequentially to keep /tmp peak at 1× source size
- Path B used `Promise.all([generateQuickThumbnail, probeUploadedDuration])` — doubles peak /tmp
- **Fix**: Converted to sequential: thumbnail await first, then duration await
- File: `artifacts/api-server/src/modules/media-uploads/chunked-upload.routes.ts` ~line 1634

## Bug 4 (MEDIUM) — Path B CORRUPT_UPLOAD faststart failure didn't deactivate broadcast queue
- Path A deactivated the queue entry (`broadcastQueueTable.isActive = false`) on CORRUPT_UPLOAD
- Path B only marked the video failed but left the queue row `is_active=true`
- Orchestrator kept loading the corrupt item every reload cycle, burning skip budget for up to 3 min
- **Fix**: Added `db.update(broadcastQueueTable).set({ isActive: false })` + `adminEventBus.push("broadcast-queue-updated")` to Path B's CORRUPT_UPLOAD handler
- File: `artifacts/api-server/src/modules/media-uploads/chunked-upload.routes.ts` ~line 1771

## Bug 5 (LOW) — enqueueIfMissing hardcoded videoSource: "local"
- `auto-enqueue.service.ts` passed `videoSource: "local"` to `addToQueue()` regardless of actual row value
- **Fix**: Changed to `videoSource: row.videoSource`
- File: `artifacts/api-server/src/modules/broadcast/auto-enqueue.service.ts` line ~126

## Confirmed-OK (not bugs)
- Admin library (`GET /api/v1/admin/videos`) has no `broadcastOnly` filter — all videos visible to admins ✓
- Pre-commit INSERT fires before finalize returns — library populated immediately ✓
- `isPlayableForBroadcast` admits `transcodingStatus='queued'` with `localVideoUrl` set ✓
- `loadActive()` admits `['none','queued','encoding']` without requiring faststartApplied ✓
- SSE + `uploadQueue.onComplete()` both invalidate admin-videos — dual safety net ✓
- `staleTime=60s` in QueryClient doesn't block SSE-triggered `invalidateQueries` ✓
