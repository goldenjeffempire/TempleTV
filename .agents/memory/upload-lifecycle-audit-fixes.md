---
name: Upload lifecycle audit — 3 fixes (June 2026)
description: Comprehensive audit of upload→transcoding→queue pipeline found 3 bugs; all fixed.
---

## Bug 1 (HIGH): Faststart orphan recovery never created missing transcoding jobs

**What happened:** When a server crashed mid-faststart (video at `transcodingStatus='processing'`), the periodic faststart-orphan watchdog in `TranscoderDispatcher.resetFaststartOrphans()` reset the status back to `'queued'`. BUT: `enqueueTranscode()` creates the row in `transcoding_jobs` that the dispatcher actually polls. If the crash happened between faststart starting and `enqueueTranscode()` being called, no `transcoding_jobs` row existed. The video was stuck in `'queued'` forever — visible in admin as "Queued for HLS" but never processed.

**Fix:** Extended `resetFaststartOrphans()` to also SELECT `object_path` and `hls_master_url`, then after the status reset calls `enqueueTranscode()` for every recovered video that has `object_path IS NOT NULL` AND `hls_master_url IS NULL`, then calls `this.nudge()` to wake the dispatcher immediately.

**Files:** `artifacts/api-server/src/modules/transcoder/transcoder.dispatcher.ts`
- Added `import { enqueueTranscode } from "./transcoder.queue.js"`
- Expanded `resetFaststartOrphans()` query + post-reset enqueue loop

---

## Bug 2 (MEDIUM): fillQueueFromLibrary could broadcast-queue pre-committed unassembled videos

**What happened:** The `fillQueueFromLibrary` self-heal sweep in `auto-enqueue.service.ts` ran every few minutes. Pre-committed video rows have `localVideoUrl` set (deterministic URL) but `s3MirroredAt = NULL` (blob not yet written — `completeMultipartUpload` still running in background). The sweep's `isPlayableForBroadcast()` check passed because `localVideoUrl` was non-null and `faststartApplied` was null. The video entered the broadcast queue before its storage blob existed; the orchestrator tried to play it and got an unresolvable URL, burning skip attempts.

**Fix:** Added SQL filter `(videoSource != 'local' OR s3_mirrored_at IS NOT NULL)` to the `fillQueueFromLibrary` candidates query. `s3MirroredAt` is set only after `completeMultipartUpload` succeeds in the background assembly task, so this correctly gates the sweep to fully-assembled blobs only.

**Files:** `artifacts/api-server/src/modules/broadcast/auto-enqueue.service.ts`
- Added `s3MirroredAt: videosTable.s3MirroredAt` to the SELECT
- Added the guard SQL clause to the WHERE

**Why:** `enqueueIfMissing()` called directly from the background task (after assembly) doesn't need this guard — it's already post-assembly. Only the self-heal scan path needs it.

---

## Bug 3 (LOW-MEDIUM): Pre-commit transcodingStatus='queued' was misleading

**What happened:** Both Path A (db backend) and Path B (db_fallback) pre-committed the video row with `transcodingStatus: "queued"`. This showed "Queued for HLS" in the admin panel during the entire assembly window (which can take minutes to hours for large files). The real sequence of status transitions is: assembly runs → faststart sets `"processing"` → `"ready"` → `enqueueTranscode` sets `"queued"` → transcoder sets `"encoding"` → `"hls_ready"`. Pre-setting `"queued"` conflated assembly status with transcoding status.

**Fix:** Changed both pre-commit inserts to `transcodingStatus: "none"`. This correctly signals "raw upload not yet processed". The admin panel shows the correct status progression: `"none"` during assembly → `"processing"` during faststart → `"ready"` after faststart → `"queued"` once the HLS job is enqueued.

**Files:** `artifacts/api-server/src/modules/media-uploads/chunked-upload.routes.ts`
- Line ~1475 (Path A): `"queued"` → `"none"`
- Line ~2067 (Path B db_fallback): `"queued"` → `"none"`

---

## What the audit confirmed is NOT broken

- `onReady` assembling-session recovery: correctly triages crash-recovered sessions (blob probe → recovered vs orphaned), calls `enqueueIfMissing` + `runFaststart` + `enqueueTranscode` for recovered ones, marks orphaned ones `ASSEMBLY_FAILED` (preserved row). 
- Public catalog (`GET /v1/videos`) is YouTube-only by design (`videoSource = 'youtube'`). Local uploads are broadcast-only. `broadcastOnly` flag only gates YouTube videos out of the catalog.
- `isPlayableForBroadcast`: `faststartApplied=null` (never run) correctly treated as playable; only `=== false` (explicitly failed) blocks broadcast.
- `faststartApplied=false` is NEVER set by `faststart.service.ts` — only by the admin retry-repair route. Normal faststart failure leaves the field NULL.
- `autoRetryRecoverableFailed` in dispatcher correctly re-queues failed transcoding jobs with retry budget remaining.
- The broadcast-queue integrity validator does not wrongly deactivate newly uploaded videos (CORRUPT_UPLOAD guard uses `faststartApplied === false`, never fires on fresh uploads).
