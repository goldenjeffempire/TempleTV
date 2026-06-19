---
name: Auto thumbnail generation service
description: ffmpeg frame extraction at 30% of duration, stored in BYTEA storage as thumbnails/{videoId}.jpg
---

## Service location
`artifacts/api-server/src/modules/admin-videos/thumbnail-generator.service.ts`

## Key patterns
- `toInternalVideoUrl()` — absolutizes `/api/v1/uploads/...` to `http://127.0.0.1:PORT/...` for ffmpeg's `-i` input
- Frame extracted at `Math.floor(probedDuration * 0.3)`, fallback to t=1s if first attempt fails
- Storage key: `thumbnails/{videoId}.jpg` — served at `/api/v1/uploads/thumbnails/{videoId}.jpg`
- Skip conditions: `hasCustomThumbnail=true` (unless force=true), `videoSource='youtube'`, missing `localVideoUrl`

## Worker
`artifacts/api-server/src/modules/broadcast-v2/engine/thumbnail-sweep-worker.ts`
- Interval: `THUMBNAIL_SWEEP_INTERVAL_MS` (default 10 min)
- Boot delay: 2 minutes (avoids contending with HLS transcoding at startup)
- Batch size: 5 videos per sweep
- Started via dynamic import in `startWorkers()` in main.ts

## API endpoint
`POST /admin/videos/:id/generate-thumbnail` with `{ force: boolean }` body
- 422 on generation failure (not 500 — non-fatal)
- Invalidates catalog cache + emits `videos-library-updated` on success

**Why:** ffmpeg's `-i` accepts HTTP URLs directly, so no need to stream from BYTEA storage to a temp file — just use the internal API URL.
