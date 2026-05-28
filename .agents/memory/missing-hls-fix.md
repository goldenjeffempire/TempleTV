---
name: Missing HLS false-negative fix
description: Why boostTranscodePriority alone silently fails to fix missing-HLS queue items, and the full fix pattern applied.
---

## The rule
Never use `boostTranscodePriority` alone after adding an item to the broadcast queue. Always call `enqueueTranscode` (idempotent) when a queue item has `localVideoUrl` but no `hlsMasterUrl`.

**Why:** `boostTranscodePriority` only UPDATEs rows with `status = 'queued'` in `transcoding_jobs`. If no job row exists (video added before transcoder ran, job cancelled, job cleared), it silently does nothing — the item stays as raw MP4 forever and shows "N missing HLS" in the admin status bar.

`enqueueTranscode` handles all cases:
- No job → INSERT new queued job at given priority
- Failed job → re-arm (reset attempts, status=queued)
- Queued/processing → leave it, return existing id (truly idempotent)

## Fix locations applied
1. `admin-broadcast.routes.ts` — slim path (POST /admin/broadcast with just videoId): call `enqueueTranscode` when `video.localVideoUrl && !hlsById?.hlsMasterUrl`
2. `admin-broadcast.routes.ts` — explicit path: same check using `explicit.localVideoUrl && !hlsExplicit?.hlsMasterUrl`
3. `rest.routes.ts` — extracted `autoEnqueueMissingHls()` shared function; refactored `/prepare-hls` endpoint to use it; added 15 s boot-time auto-scan so existing missing-HLS items are fixed automatically on API restart

## GET handler COALESCE fix
The `GET /admin/broadcast` response spread `{ ...row, ...hlsMap.get(row.videoId) }` could overwrite a valid `broadcastQueueTable.hlsMasterUrl` with a null `videosTable.hlsMasterUrl`. Fixed by explicitly COALESCing:
```typescript
hlsMasterUrl: videoMeta.hlsMasterUrl ?? row.hlsMasterUrl ?? null
```

## Boot scan behavior
- Fires 15 s after route registration (timer `.unref()`d so it doesn't block clean exit)
- Logged as `[broadcast-v2] auto-enqueue-missing-hls: scan complete { triggered: N }`
- `triggered: 0` on dev is expected (dev has no locally-uploaded videos missing HLS)
- On production: any items with `localVideoUrl` but no `hlsMasterUrl` are auto-enqueued at priority 10 and the transcoder dispatcher is nudged immediately
