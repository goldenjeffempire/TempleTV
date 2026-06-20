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

## Admin preview player — MP4 native path

`BroadcastPreviewV2.tsx` `attachHls()` is called by the player-core for ALL non-YouTube sources (both HLS and MP4). It must detect source type by URL:
- `url.includes(".m3u8") || url.includes("/hls/master")` → HLS.js path
- Anything else → native `video.src = url` (MP4 / faststart MP4)

HLS.js fatally fails when loaded with an MP4 URL — it immediately pushes the FSM into RECOVERING/FATAL. The native path handles MP4 uploads without issue (faststart-applied files play inline; moov-at-EOF files fail with MEDIA_ERR_SRC_NOT_SUPPORTED, which is a real viewer issue too).

`classifySourceFailure` for `kind==="mp4" && isApiUpload`: now `scope:"likely-all-surfaces"` (was "preview-only"). With MP4-first broadcasting, all surfaces receive the same raw MP4 when HLS isn't ready — a failure here IS a viewer issue.

## What NOT to revert

Do not re-add `isNotNull(videosTable.hlsMasterUrl)` as the sole admission gate to `scanLibraryAndEnqueue()` or `isPlayableForBroadcast()`. The queue's `loadActive()` function already handled MP4-only items — only the enrollment functions had the HLS gate.

Do not remove the MP4 early-exit from `attachHls()` in `BroadcastPreviewV2.tsx`. The comment block above the function must stay updated to explain the dual-mode behavior.
