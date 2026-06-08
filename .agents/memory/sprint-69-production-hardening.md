---
name: Production audit sprint 69
description: 10 targeted fixes across orchestrator resource leaks, upload init safety, transcoder CPU tuning, and admin UI invalidation gaps.
---

## Fixes applied

### 1. Orchestrator `_cbResetTimer` not cleared in `stop()` (resource leak)
**File:** `artifacts/api-server/src/modules/broadcast-v2/engine/broadcast-orchestrator.ts`
- Circuit-breaker reset timer was a local `const resetTimer` — not stored on `this`.
- `stop()` could not cancel it; after stop() the timer fired and called `scheduleSelfHealReload()` on a stopped orchestrator.
- **Fix:** Stored as `private _cbResetTimer: ReturnType<typeof setTimeout> | null = null;`; cleared in `stop()`; timer self-nulls on fire.

### 2. `persistBadUrlCache` in `stop()` missing `.catch()`
**File:** `broadcast-orchestrator.ts` `stop()`
- `void persistBadUrlCache(this.channelId)` with no catch — unhandled rejection on DB failure during shutdown.
- **Fix:** Added `.catch((err) => logger.warn(...))`.

### 3. `trimTimer` `setInterval` missing `void+catch`
**File:** `broadcast-orchestrator.ts` `start()`
- `setInterval(() => eventLogRepo.trim(...))` returned a Promise without `.catch()`.
- **Fix:** `() => void eventLogRepo.trim(...).catch((err) => logger.warn(...))`.

### 4. `reEnableAllSuspended` re-enabled ALL inactive items
**File:** `artifacts/api-server/src/modules/broadcast-v2/repository/queue.repo.ts`
- Previous: `WHERE is_active = false` — includes operator-manually-disabled items.
- **Fix:** Added `AND validator_deactivated_reason IS NOT NULL` guard — only recovers system-deactivated items; operator intent preserved.
- **Why:** "Reload from queue" blowing away deliberate operator pauses (flagged-for-review video, paused live event) is a correctness bug.

### 5. Upload init: no `abortMultipartUpload` on session DB insert failure
**File:** `artifacts/api-server/src/modules/media-uploads/chunked-upload.routes.ts`
- `storage().createMultipartUpload()` succeeded then `db.insert(sessions)` threw → orphaned `_parts/{uploadId}/...` rows in `storage_blobs` with no session to clean them up.
- **Fix:** Wrapped `db.insert(sessions)` in try/catch; calls `storage().abortMultipartUpload()` (best-effort, `.catch()` guarded) before re-throwing.

### 6. Transcoder `-threads 0` → 2 with `TRANSCODER_THREADS` env override
**File:** `artifacts/api-server/src/modules/transcoder/transcoder.service.ts`
- `-threads 0` (unlimited) claimed all available cores on shared Replit/Render instances, starving the Fastify event loop and DB pool during active HLS transcoding.
- **Fix:** Default `"2"` with `process.env["TRANSCODER_THREADS"]` override. Operators on dedicated workers can set `TRANSCODER_THREADS=4`.

### 7. `TranscodingProgressPanel` SSE missing `broadcast-queue` invalidation
**File:** `artifacts/admin/src/pages/broadcast-v2.tsx` `TranscodingProgressPanel`
- `transcoding-update` SSE only invalidated `transcoding-panel` and `remediation-report`.
- A newly `hls_ready` item never updated the HLS-ready badge or "Now / Next" header until the next queue poll (up to 15 s lag).
- **Fix:** Added `invalidateQueries({ queryKey: ["broadcast-queue"] })`.

### 8. `reprobeMutation` missing `engine-health` + `diagnostics` invalidation
**File:** `broadcast-v2.tsx`
- After a successful re-probe, engine health drift calculations and the diagnostics panel showed stale duration values.
- **Fix:** Added `broadcast-v2-engine-health` and `broadcast-v2-diagnostics` invalidations on success.

### 9. `handleReuploadFileSelected` missing `transcoding-panel` + `diagnostics` + `remediation-report` invalidations
**File:** `broadcast-v2.tsx`
- After triggering a re-upload, the transcoding panel didn't show the new queued job, and diagnostics/remediation-report reflected stale state.
- **Fix:** Added all three invalidations after successful enqueue.

### 10. `realtimeStallCount` phantom stall counts after server restart
**File:** `broadcast-v2.tsx`
- `prevDiagStallRef.current` was only updated when `delta > 0`. After a server restart `diagStalls` drops to 0, making `delta` negative — `prevDiagStallRef` was never updated to 0, so subsequent stalls computed a huge negative delta and no-op'd forever.
- **Fix:** Always update `prevDiagStallRef.current = diagStalls`. On `delta < 0` (server restart), reset `realtimeStallCount` to 0.

**Why:** Without this fix, after a server restart the `StreamQualityPanel` stall counter could accumulate unbounded phantom stalls from the old session.
