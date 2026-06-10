---
name: Upload pipeline — disappearing video root causes
description: 3 bugs found and fixed in the Path A assembly + cancelJob flow that could cause uploaded videos to silently vanish or show wrong state.
---

## Bug 1 — `cancelJob` wrong `transcodingStatus` (transcoder.queue.ts)

**Rule:** `cancelJob()` must NOT unconditionally set `transcodingStatus = 'none'`.

**Why:** 'none' signals "raw upload, never processed". If a video already had faststart applied (`faststartApplied=true`) and `hlsMasterUrl IS NULL`, setting 'none' after cancel:
- Displays the video as unprocessed in the admin UI when it is actually playable
- Causes the auto-enqueue service to immediately re-queue it for HLS, creating a silent re-enqueue loop on repeated cancels

**Fix:** Inside the cancel transaction, query the video's `faststartApplied` and `hlsMasterUrl`, then:
- `faststartApplied=true` AND no `hlsMasterUrl` → restore to `'ready'`
- Otherwise → `'none'` is safe

`faststartApplied` column is `boolean NOT NULL DEFAULT false` (not nullable). Check with `=== true`.

---

## Bug 2 — `uploadTelemetry.success()` could propagate to outer catch and delete blob (chunked-upload.routes.ts)

**Rule:** Every call inside the Path A assembly outer `try` block that runs AFTER `completeMultipartUpload` must be wrapped in its own `try/catch`.

**Why:** The outer catch block deletes the assembled blob at `session.objectKey`. If `uploadTelemetry.success()` throws (DB pressure during telemetry insert), the outer catch fires and the fully-committed blob is permanently deleted while the video row still references it.

**Fix:** Wrap `uploadTelemetry.success(...)` in a `try { } catch (telErr) { log.warn(...) }`.

---

## Bug 3 — Outer catch deletes blob even when assembly already committed (chunked-upload.routes.ts)

**Rule:** The Path A outer catch must NEVER delete `session.objectKey` if `completeMultipartUpload` already committed the blob.

**Why:** Any future code added inside the outer `try` after `completeMultipartUpload` (e.g., a new telemetry or notification call) could inadvertently cause blob deletion on the assembled, valid video file.

**Fix:** Add `let assemblyCommitted = false;` before the `try`, set `assemblyCommitted = true` immediately after `completeMultipartUpload` succeeds. In the catch: guard the `deleteObject` with `if (!assemblyCommitted && session.objectKey)`.

**How to apply:** Always maintain this pattern in chunked-upload.routes.ts Path A background assembly block. The `assemblyCommitted` flag is the single source of truth for whether the blob has been committed and must be preserved.

---

## Confirmed clean (full read, no bugs)

- Path B (db_fallback) catch block — never deletes assembled blob
- `cleanup.service.ts` — validates ALL HLS segments before deleting source; sets objectPath=null after; idempotent
- `faststart-recovery.ts` — MAX_ATTEMPTS=3 in-memory only, admin "Re-apply faststart" bypasses it directly via REST
- `media-integrity-scanner.ts` — suspends queue items temporarily (TTL), never deletes
- `orphan-cleanup.ts` — never deletes managed_videos rows; only deactivates broadcast_queue references
- `transcoder.dispatcher.ts` resetStuckJobs / resetFaststartOrphans — guarded with `ne(videos.transcodingStatus, 'hls_ready')`
- `faststart.service.ts` catch — restores `safeRestoreStatus` (never "processing"); guards against racing "encoding" or "hls_ready"
