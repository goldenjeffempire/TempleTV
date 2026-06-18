---
name: FastStart non-blocking architecture
description: faststart is a best-effort MP4 optimization only — never a prerequisite for queue admission, broadcast, scheduling, or midnight-prayers rotation
---

## The rule
FastStart (moov-atom relocation) is an async optimization.  It must never gate:
- broadcast queue admission
- midnight-prayers rotation
- upload completion
- HLS transcoding scheduling
- any other pipeline step

## Why
Previous implementation had three blocking gates:
1. `midnight-prayers.service.ts` — `faststartApplied=true` gate excluded raw MP4 from rotation.
2. `faststart-recovery.ts` `dispatchOne` — `isActive: false` written on CORRUPT_UPLOAD/SOURCE_MISSING, removing the item from the broadcast queue entirely.
3. Both callers missed FASTSTART_SKIPPED marker and unclear log levels.

When faststart failed, videos silently vanished from midnight-prayers and the broadcast queue, causing avoidable dead-air.

## How to apply

### `faststart.service.ts` — ffmpeg early-return path
When `spawnFfmpegFaststart` throws (line ~424), before `return`:
- Write `transcodingErrorCode = 'FASTSTART_SKIPPED'` to DB (skip if hls_ready/encoding).
- Call `void enqueueIfMissing({ videoId, reason: "faststart-skipped" }).catch(()=>{})`.
- Fire `videos-library-updated` + `broadcast-queue-updated` on adminEventBus.
- Log at `warn` level with `[FASTSTART OPTIMIZATION SKIPPED]` prefix.

### `faststart.service.ts` — outer catch block
- Log at `warn` level with `[FASTSTART OPTIMIZATION SKIPPED]` prefix.
- Set `transcodingErrorCode = 'FASTSTART_SKIPPED'` for non-terminal errors (not CORRUPT_UPLOAD / SOURCE_MISSING).
- Call `void enqueueIfMissing(...)` belt-and-suspenders.
- Keep the `throw err` so callers can distinguish failure — callers already catch this.

### `faststart-recovery.ts` — isUnrecoverable block
- **DO NOT** write `isActive: false` to the broadcast queue.
- Keep: writing `transcodingStatus: 'failed'`, `transcodingErrorCode: 'CORRUPT_SOURCE'`, ops-alert, admin email.
- Update alert messages to say "queue item remains active and will be auto-skipped at runtime".
- Header comment must say "NEVER performed by this worker — deactivation is an operator action".

### `midnight-prayers.service.ts`
- The `OR` condition for locally-uploaded videos must be just `isNotNull(localVideoUrl)`.
- Remove `eq(faststartApplied, true)` — raw MP4 (moov at EOF) plays fine in modern browsers.

### `chunked-upload.routes.ts` — recovery path comment
- Remove "not midnight-prayers eligible" from the faststart failure log message.
- Comment faststart step as "BEST-EFFORT OPTIMIZATION ONLY".

## FASTSTART_SKIPPED marker
Used in `transcodingErrorCode` field to distinguish:
- `null` → never attempted
- `FASTSTART_SKIPPED` → attempted, ffmpeg or post-ffmpeg pipeline failed
- Not written when `transcodingStatus` is `hls_ready` or `encoding` (transcoder owns those).

## Upload completion ordering (already correct)
`completeMultipartUpload` → size integrity check → SHA-256 check → session `status='completed'` + `s3MirroredAt` → THEN `enqueueIfMissing` → THEN `runFaststart` → THEN `enqueueTranscode`.
No changes needed there.
