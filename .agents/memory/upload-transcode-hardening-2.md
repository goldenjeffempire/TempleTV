---
name: Upload/transcode pipeline hardening batch 2
description: Double-assembly pre-CAS reset bug, ENOSPC immediate-fail, admin-ops cancel route DB upgrade, stale-lock threshold, HLS Range support, upload cancel cleanup
---

## Double-assembly pre-CAS reset bug (chunked-upload.routes.ts)

**Rule:** Never reset `status="assembling"` before the atomic CAS lock attempt. The old code had an unconditional reset at lines 773–790 (before the CAS) that fired even for *live* assemblies — Request 2 would reset Request 1's lock, then win the CAS and spawn a second parallel assembler.

**Fix:** Removed the pre-CAS reset entirely. The post-CAS stale-lock check (only reached when the CAS fails, meaning another holder exists) is the sole recovery path. It uses an age gate so crash-recovery still works after the process dies.

**Why:** The reset must only fire when the lock holder is *dead* (process crashed). A concurrent live request can't be distinguished from a post-crash state before the CAS — only lock age can tell them apart.

**How to apply:** Keep all stale-lock recovery in the post-CAS failure branch. Never reset assembling status before the atomic UPDATE...WHERE status='uploading'.

## Stale-lock threshold: 2 min → 30 min

**Rule:** `STALE_LOCK_THRESHOLD_MS` must be longer than the longest realistic assembly time. A 2 GiB file assembled via `db_fallback` bytea-concat can take 40+ min on Replit's shared Neon DB.

**Fix:** Raised from 2 minutes to 30 minutes. This is safely below `ASSEMBLY_WATCHDOG_MS` (90 min default) but long enough to never interrupt a genuine large-file assembly.

## ENOSPC immediate-fail in transcoder dispatcher

**Rule:** `ENOSPC`/`EDQUOT` errors from FFmpeg are non-retryable. Treating them as normal errors burns all 5 retry slots over ~2 hours.

**Fix:** In `transcoder.dispatcher.ts` catch block, detect `errCode === "ENOSPC" || errCode === "EDQUOT"`. If disk-full: set `exceeded=true`, don't increment `attempts`, mark job `failed` immediately, log at ERROR with instruction to free storage before re-queueing.

## Admin-ops cancel route upgraded to DB-based cleanup

**Rule:** `DELETE /admin/videos/upload/:sessionId` (in admin-ops.routes.ts) used the old in-memory S3 multipart registry (`uploadSessions.remove()`). Since chunked uploads are DB-based, the registry is never populated — the cancel was a no-op.

**Fix:** Replaced with DB-based cleanup: deletes `upload_chunks` rows (FK first), then orphaned `_parts/{uploadId}/` rows in `storage_blobs`, then the session row. Returns 409 for `status="assembling"` and `status="completed"`. Idempotent for missing sessions.

**Also:** Removed a duplicate cancel route I added to `chunked-upload.routes.ts` — both would have landed at `DELETE /admin/videos/upload/:sessionId`, causing a Fastify duplicate-route error at startup.

## HLS Range request support (206 Partial Content)

Added byte-range support to `video-serve.routes.ts` for HLS `.ts` segments. Uses `s.headObject()` for total size, then `s.getObjectRange(key, start, end)` for the partial slice. Returns 416 with `Content-Range: bytes */N` when `rawStart >= total`. Manifests always served whole (no Range needed, URL-rewriting requires buffer).

**Why:** Safari/AVFoundation and Smart TV players (Tizen, webOS) require 206 support to seek within `.ts` segments; without it they may stall or fail to play HLS VOD content.

## Queue-validator startup WARN

The persistent 1-warning (PLACEHOLDER_DURATION) on startup is expected: prod-sync'd videos from `api.templetv.org.ng` have `durationSecs=1800` placeholder because the local ffprobe hasn't run on them. This is benign in dev — the validator's fingerprint dedup prevents repeated WARN spam.
