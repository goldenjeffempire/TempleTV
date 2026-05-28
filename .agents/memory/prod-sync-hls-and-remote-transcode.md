---
name: Prod-sync hlsMasterUrl gap & remote-transcode feature
description: Two related fixes — prod-sync omitted hlsMasterUrl from its DB upsert; transcoder was extended to support HTTP URL sources for queue items without local blobs.
---

## Fix 1 — prod-sync must write hlsMasterUrl

**Rule:** `prod-queue-sync.ts` `upsertItems()` must include `hlsMasterUrl: newState.hlsUrl` in both the INSERT `.values({})` and `onConflictDoUpdate` `.set({})` blocks.

**Why:** The `ItemPollState.hlsUrl` was computed correctly from the upstream guide but was never persisted. Queue items from production that had HLS showed `has_hls = false` in dev because the column was always NULL. The admin UI's `hasHls` flag is computed as `!!(row.hlsMasterUrl)` — no hlsMasterUrl → no HLS badge → confusing operator state.

**How to apply:** Any future prod-sync field additions that have a corresponding broadcast_queue column must be written to BOTH the VALUES and SET clauses.

## Fix 2 — transcoder supports HTTP(S) URL objectPath

**Rule:** `downloadSourceToTempFile()` in `transcoder.service.ts` detects `objectKey` values starting with `https?://` and downloads from the remote URL via `fetch()` instead of reading from local object storage.

**Why:** Prod-sync queue items can be transcoded locally without first mirroring the source file to local storage. The `POST /broadcast-v2/queue/:id/transcode-remote` endpoint stores the production HTTP URL directly as `managed_videos.objectPath` and enqueues normally.

**How to apply:** The 20-minute AbortController timeout is intentional — large sermon videos can take 10–15 minutes to download over slow links. Do not reduce it below 15 minutes.

## Fix 3 — POST /broadcast-v2/queue/:id/transcode-remote endpoint

Added in `rest.routes.ts` (before closing `}`). Requires admin auth. Flow:
1. Finds queue item, rejects if already has `videoId` (409) or no http(s) `localVideoUrl` (400).
2. Creates `managed_videos` row with `objectPath = sourceUrl`, `transcodingStatus = "queued"`.
3. Updates `broadcast_queue.video_id` to link the new entry.
4. Calls `enqueueTranscode({ videoId, videoPath: sourceUrl, priority: 5 })` + `transcoderDispatcher.nudge()`.
5. Reloads orchestrator, returns 202.

## Fix 4 — Admin UI "Transcode" button for prod-sync items

`SortableQueueItem` in `broadcast-v2.tsx` now shows a "No HLS / Transcode" badge+button when `!item.videoId && !item.hasHls && item.localVideoUrl`. Props: `onTranscodeLocally(itemId)` + `isTranscodingLocally`. Mutation calls the new endpoint above.
