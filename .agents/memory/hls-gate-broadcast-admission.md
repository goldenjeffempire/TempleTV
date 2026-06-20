---
name: MP4-first broadcast admission (HLS-gate removed)
description: Upload → broadcast queue enrollment is now MP4-first; HLS is an async upgrade, not a gate.
---

## The rule

Any local video with a `localVideoUrl` (raw MP4) is admitted to the broadcast queue immediately after upload assembly completes. HLS is preferred when available but is **not required** for admission.

**Why:** The old HLS-gate held every upload out of broadcast rotation until `hlsMasterUrl` was set by the transcoder, causing multi-minute (or permanent) dead-air for freshly-uploaded content. MP4-first means 24/7 continuous playback is never blocked by transcoding delays.

## How it works

**Enrollment sequence (current):**
1. Upload finalize pre-commit → video row inserted with `localVideoUrl`
2. Background assembly → `completeMultipartUpload` commits blob → immediately calls `enqueueIfMissing(reason:"upload-finalize")` → item airs as raw MP4 → fire `broadcast-queue-updated`
3. Faststart runs → no re-enqueue (orchestrator picks up `faststartApplied` flag on next reload)
4. HLS transcoder completes → `UPDATE broadcast_queue SET hls_master_url = ...` + fire `broadcast-source-upgraded` + fire `broadcast-queue-updated` → orchestrator upgrades source in-place

**Assembly-retry path:** `enqueueIfMissing(reason:"assembly-retry")` called after ffprobe, before faststart.

**Transcoder dispatcher fallback:** `enqueueIfMissing` still called after HLS completes — now a no-op for items already queued; acts as safety net for pre-policy uploads or re-transcodes.

## Where the gates live

- `auto-enqueue.service.ts` → `isPlayableForBroadcast()`: accepts `localVideoUrl` OR `hlsMasterUrl` (YouTube always excluded)
- `auto-enqueue.service.ts` → `scanLibraryAndEnqueue()`: `or(isNotNull(hlsMasterUrl), isNotNull(localVideoUrl))`
- `chunked-upload.routes.ts` finalize background task: `enqueueIfMissing` called after blob integrity check + probes, before faststart
- `chunked-upload.routes.ts` spawnAssemblyRetry: `enqueueIfMissing` called after ffprobe
- `queue.repo.ts` → `loadActive()`: already admitted MP4-only items (no change needed)

## What NOT to revert

Do not re-add `isNotNull(videosTable.hlsMasterUrl)` as the sole admission gate to `scanLibraryAndEnqueue()` or `isPlayableForBroadcast()`. The queue's `loadActive()` function already handled MP4-only items — only the enrollment functions had the HLS gate.
