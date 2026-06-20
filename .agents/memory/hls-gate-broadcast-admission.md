---
name: HLS-gate broadcast admission policy
description: Broadcast queue ONLY admits videos with hlsMasterUrl — raw MP4 uploads are held until HLS transcoding completes.
---

## Rule
`isPlayableForBroadcast()` returns true ONLY when `hlsMasterUrl` is non-empty. Raw MP4 `localVideoUrl` alone is never sufficient for broadcast admission.

**Why:** Raw MP4 uploads with moov-at-EOF cause moov atom not found stalls, SKIP_PENDING cycles, and dead-air. HLS guarantees adaptive bitrate delivery with no player-side failures.

**How to apply:**
- Single enqueue trigger: `transcoder.dispatcher.ts` calls `enqueueIfMissing()` after writing `hls_ready` + `hlsMasterUrl` — this is the ONLY place local uploads enter `broadcast_queue`.
- `chunked-upload.routes.ts` finalize, assembly-retry, and upload-recovery paths do NOT call `enqueueIfMissing()` anymore.
- `faststart.service.ts` does NOT call `enqueueIfMissing()` — faststart is optimization-only, not a broadcast gate.
- `auto-queue-refill.ts` SQL requires `transcoding_status = 'hls_ready' AND hls_master_url IS NOT NULL`.
- `scanLibraryAndEnqueue` WHERE clause uses `isNotNull(videosTable.hlsMasterUrl)` only (no OR localVideoUrl fallback).
- Admin UI video cards show "HLS Queued"/"Converting"/"Awaiting HLS"/"HLS Ready" status labels + "Pending broadcast" sub-label for videos without hlsMasterUrl.
