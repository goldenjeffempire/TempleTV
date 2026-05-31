---
name: Transcoder videoPath normalization
description: localVideoUrl (/api/v1/uploads/…) vs objectPath (uploads/…) — two different fields, only the bare key works with storage().getObject()
---

# Transcoder videoPath: localVideoUrl vs objectPath

## The Rule
Always pass `objectPath` (the raw storage key) to `enqueueTranscode`, never `localVideoUrl` (the API-serving path). The transcoder's `downloadSourceToTempFile` calls `storage().getObject(key)` which looks up the `storage_blobs` table by key. The table key is the bare path (`uploads/2026/…/uuid.mp4`), not the API route (`/api/v1/uploads/…`).

**Why:** `managed_videos.localVideoUrl` stores the HTTP path through which the file is served (`/api/v1/uploads/…`). `managed_videos.objectPath` stores the raw storage blob key (`uploads/…`). Passing `localVideoUrl` to `enqueueTranscode` causes an "Object not found in storage" error at transcoding time because the `/api/v1/` prefix is a route mount point, not a storage key prefix.

**How to apply:** When calling `enqueueTranscode`, always use `row.objectPath`. If `objectPath` might be null (legacy uploads), apply the normalizer — strip `/api/v1/` prefix — rather than passing the raw `localVideoUrl`. The normalizer `normaliseVideoPath()` now lives in `transcoder.queue.ts` and runs at the point of DB write, so any caller passing `localVideoUrl` is silently corrected. `downloadSourceToTempFile` in `transcoder.service.ts` also has a defensive strip for jobs already in the DB with bad paths.

## Affected callers (were broken, now fixed via normaliseVideoPath in enqueueTranscode)
- `broadcast-v2/io/rest.routes.ts` — `autoEnqueueMissingHls` used `row.localVideoUrl`
- `admin-broadcast/admin-broadcast.routes.ts` — both the slim-path and explicit-path branches used `video.localVideoUrl`
- `admin-ops/admin-ops.routes.ts` — used `video.objectPath ?? video.localVideoUrl`; the fallback was broken

## Correct callers (unaffected)
- `chunked-upload.routes.ts` — uses `objectKey` (raw key from upload session)
- `media-uploads.routes.ts` — uses `body.objectKey`
- `admin-videos.routes.ts` — explicitly guards `!row.objectPath` and rejects if missing
