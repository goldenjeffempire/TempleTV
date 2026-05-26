---
name: Transcoding pipeline root causes & fixes
description: Diagnosed root causes of near-total transcoding job failures; documents fixes applied and why.
---

## Root causes of systemic transcoding failures

### 1. maxAttempts = 3 (too low)
`lib/db/src/schema/transcoding.ts` — default was 3. With exponential backoff (2→4→8 min), 3 transient failures (storage blip, temp OOM, DB timeout) permanently kill a job. Changed to 5.

**Why:** Production sermons are large, transient infra blips are real. 3 retries over ~14 min is too few for any transient system issue.

**How to apply:** If jobs are permanently failing after only a few attempts, check this default.

### 2. resetStuckJobs() didn't increment attempts
`transcoder.dispatcher.ts` — the periodic watchdog reset stuck `processing` jobs back to `queued` without touching `attempts`. A job that consistently hangs (zombie FFmpeg, D-state process) would be reset indefinitely, never reaching maxAttempts, never alerting operators.

**Why:** Per-job atomic UPDATE now increments attempts and flips to `failed` when exceeded.

**How to apply:** Any future stuck-job watchdog must consume retry budget.

### 3. TRANSCODER_JOB_TIMEOUT_MS = 4h (too long)
Default changed to 2h. A 4h hang blocks the entire queue for 4h+ before the watchdog fires. For typical 30–90 min sermon transcoding, 2h is still generous.

### 4. -pix_fmt yuv420p applied per rendition (N times) instead of once globally
`buildFfmpegArgs()` in `transcoder.service.ts` — the flag appeared inside the renditions.forEach loop without a stream specifier, so it was emitted 1–4 times as a global option. Moved to a single `args.push("-pix_fmt", "yuv420p")` after the loop.

**Why:** In FFmpeg 7.x, repeated global options can confuse option parsing order for some codec profiles.

### 5. No disk space pre-flight check
Added `statfs(scratchDir)` check before FFmpeg invocation. Requires 3× source file size free. Throws ENOSPC so the dispatcher correctly retries (not permanently fails) after disk is freed. Non-fatal if statfs() is unavailable.

### 6. No single-rendition fallback
Added automatic 360p-only retry when multi-rendition FFmpeg fails with exit 234 / AVERROR_INVALIDDATA or stream-mapping error patterns. Wipes only rendition output subdirs (v0..vN-1), preserving activeSourcePath inside scratchDir. Regenerates thumbnail after fallback succeeds.

### 7. Scratch dir GC only fires on startup
Added per-tick counter in `runOnce()`; calls `purgeOrphanedScratchDirs()` every 180 ticks (~30 min at 10s/tick). Prevents accumulation in long-running production deployments.

### 8. db_fallback path missing nudge() — fixed May 2026
`chunked-upload.routes.ts` Path A (line ~1222) called `transcoderDispatcher.nudge()` after `enqueueTranscode`; Path B (db_fallback) did not. Jobs queued via this path waited up to 10 s for the next poll tick.

**Fix:** Added `transcoderDispatcher.nudge()` immediately after `enqueueTranscode` in the db_fallback success branch.

### 9. faststart source download lacked size verification — fixed May 2026
`faststart.service.ts` used raw `pipeline(body, createWriteStream(inputPath))` without checking the written file size. The chunked streaming path for blobs > 64 MiB (storage.ts `streamChunked`) exits early on a short SUBSTRING result, producing a silently truncated local file. Truncated input → `probeContainerIsValid` returns false on a valid file → `remuxForFaststart` also fails → `CORRUPT_UPLOAD` thrown → video permanently marked failed even though the storage blob is intact.

**Fix:** Destructure `contentLength` from `getObject()` response. After `pipeline()`, check `stat(inputPath).size === contentLength` and throw `{ code: "DOWNLOAD_TRUNCATED" }` on mismatch. This code is treated as non-fatal by the finalize handler — the video continues to the HLS transcoder, which does its own verified download via `downloadSourceToTempFile`.

**Why this matters:** Only triggers for videos > 64 MiB. `DOWNLOAD_TRUNCATED` vs `CORRUPT_UPLOAD` is the critical distinction — the latter permanently fails the video with no recovery path.

### 10. retryJob / manual requeue missing nudge() — fixed May 2026
`admin-ops.routes.ts` called `retryJob(id)` and `enqueueTranscode(...)` (the `/transcoding/:id/retry` and `/transcoding/requeue/:videoId` routes) without calling `transcoderDispatcher.nudge()`. Manual retries from the admin UI waited up to 10 s before the dispatcher picked up the job.

**Fix:** Imported `transcoderDispatcher` into `admin-ops.routes.ts` and added `nudge()` after each successful queue operation.

## Architecture note
- `activeSourcePath` lives INSIDE `scratchDir` (either `source.ext` or `source.remuxed.mp4`). Any fallback that wipes scratchDir must preserve this path — wipe only `v0/`, `v1/` etc.
- `generateThumbnail()` writes to `scratchDir/thumbnail.jpg` and is uploaded by `uploadDirRecursive()`.
- `maxAttempts` DB column default controls per-job retry budget. The `resetStuckJobs()` watchdog now increments this budget; `resetOrphanedJobs()` (startup-only) does NOT increment (server crash is not the job's fault).
- Broadcast auto-enqueue requires: `hlsMasterUrl` OR (`localVideoUrl` AND `faststartApplied=true`).
- `TRANSCODER_DISABLE=1` disables the dispatcher entirely — check when jobs queue but never start.
