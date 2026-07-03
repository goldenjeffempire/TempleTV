---
name: Upload-to-broadcast pipeline audit findings
description: Permanent fixes applied during deep audit of upload and broadcast pipeline — 3 bug classes, 6 total fix sites.
---

## Bug 1 — validationStatus gate missing from isPlayableForBroadcast

`isPlayableForBroadcast()` in `auto-enqueue.service.ts` accepted the `validationStatus` field but never checked it. Videos that definitively failed the 9-check ffprobe/codec/container validation pipeline were being admitted to the broadcast queue.

**Fix:** Added `if (row.validationStatus === "failed") return false;` after the terminal error code check. Only the explicit `"failed"` status blocks admission — `null/pending/running/passed/warn` all continue to pass so uploads that predate the validation worker are never silently blocked.

**Why:** The validation pipeline (video-validation.service.ts) writes `passed`/`warn`/`failed` to `managed_videos.validation_status`. Without this gate, codec-incompatible or corrupt MP4s entered the broadcast queue and caused dead air.

## Bug 2 — Drizzle ne() SQL NULL trap for category filter

`ne(videosTable.category, "midnight-prayers")` appeared in 4 query sites:
- `scanLibraryAndEnqueue()` in auto-enqueue.service.ts
- `uploadQueueReconciler` scan query
- `youtube-shuffle-fallback.ts` catalog query (2 occurrences)

In SQL, `NULL != 'midnight-prayers'` evaluates to NULL (falsy in WHERE), so Drizzle's `ne()` silently excluded all rows where `category IS NULL`. Since freshly uploaded videos have `category = null` until explicitly set, this prevented NULL-category uploads from ever entering the broadcast queue or YouTube shuffle.

**Fix:** All 4 sites changed to `or(isNull(videosTable.category), ne(videosTable.category, "midnight-prayers"))`. Added `isNull, or` to imports in upload-queue-reconciler.ts and youtube-shuffle-fallback.ts.

**How to apply:** Any time `ne(col, val)` is used as a WHERE clause filter and the column is nullable, it must be wrapped as `or(isNull(col), ne(col, val))` to correctly pass NULL rows through.

## Bug 3 — Validation not wired into upload finalize path

`scheduleVideoValidation()` was only called from admin-videos.routes.ts (manual admin UI trigger). New uploads via the chunked upload finalize flow never had validation scheduled, so `validation_status` stayed `null` forever (meaning the `validationStatus === "failed"` gate above would never block anything from real uploads).

**Fix:** Added `scheduleVideoValidation(videoId, objectKey)` call at the end of the finalize background assembly task in `chunked-upload.routes.ts`, after `enqueueIfMissing()` completes. Fire-and-forget, non-blocking.

## Bug 4 — Queue integrity validator didn't evict validation-failed items

Even with the `isPlayableForBroadcast` gate, videos already in `broadcast_queue` when they later fail validation would stay there indefinitely. The queue integrity validator (`queue-integrity-validator.ts`) had no `VALIDATION_FAILED` check.

**Fix:**
1. Added `vValidationStatus: v.validationStatus` to the JOIN query select
2. Added `VALIDATION_FAILED` issue detection in the per-row check loop
3. Added auto-deactivation auto-fix block that sets `isActive=false, validatorDeactivatedReason='validation_failed'` for all flagged items
4. Emits `broadcast-queue-updated` + `videos-library-updated` + `sendBroadcastWebhook("item_deactivated")` on deactivation

**Why:** The validator runs every 2 minutes. This closes the window between when validation completes with `failed` and when the item is evicted from the active rotation.

## Confirmed non-bugs

- `ne(videosTable.videoSource, "youtube")` — `videoSource` is non-nullable; no NULL trap
- `auto-queue-refill.ts` category filter — uses raw SQL `(mv.category IS NULL OR mv.category != 'midnight-prayers')` already correct
- `queue-health-guard.ts` `reactivateSystemDeactivated` — correctly handles NULLs
- Assembly lock, advisory lock in completeMultipartUpload, stale-session recovery — all correctly implemented
