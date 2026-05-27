---
name: Enterprise hardening batch — source resolver, transcoder recovery, upload race
description: 6 confirmed production bugs fixed across universal-source-resolver, transcoder dispatcher/service, SSE/WS gateways, chunked-upload finalize, and broadcast orchestrator.
---

## Bug 1: Source resolver HLS misclassification of MP4 paths
**File:** `modules/broadcast-v2/resolver/universal-source-resolver.ts`

**Rule:** The keyword heuristic for detecting HLS without a `.m3u8` extension must NOT include "index" or "stream" as standalone terms. MP4 paths like `/sermon-index` or `/video-stream-123` would be misclassified as HLS, sending them to hls.js which cannot parse MP4 bytestreams → silent player stall.

**Fix:** Removed "stream" entirely; kept only "playlist|manifest|master" for the broad check. Added a separate stricter regex for "index" that requires a streaming context prefix (`/live/`, `/hls/`, `/channel/`, `/broadcast/`).

**Why:** The old regex `/\/(playlist|manifest|master|index|stream)(?:$|\/|\?)/i` was too broad — "index" and "stream" appear in non-HLS paths constantly.

## Bug 2: Zombie "encoding" videos after server crash
**File:** `modules/transcoder/transcoder.dispatcher.ts` → `resetOrphanedJobs()`

**Rule:** On startup recovery, always check for videos stuck at `transcodingStatus="encoding"` where the corresponding `transcoding_jobs` row is already `status="done"`. This is the crash window between the two-write commit pattern: job update succeeds, server dies before video update. Reconstruct `masterUrl` as `/api/hls/${videoId}/master.m3u8`, verify `storage_blobs` has the key, then update the video row to `hls_ready`.

**Why:** The dispatcher only requeues "processing" jobs; "done" jobs are never rechecked. Videos were permanently stuck at "encoding" with no operator-facing fix.

## Bug 3: 360p fallback shows stale progress percentage
**File:** `modules/transcoder/transcoder.service.ts`

**Rule:** When the multi-rendition FFmpeg run fails with a mapping error and falls back to 360p-only, call `req.onProgress(0)` before spawning the fallback FFmpeg process. Without this, the Admin UI shows a stale 47% (from the failed run) that then jumps to 100% at the end.

**Fix:** `await Promise.resolve(req.onProgress(0)).catch(() => {})` — wrapped in `Promise.resolve()` because `onProgress` returns `void | Promise<void>`.

## Bug 4: Finalize concurrent-lock kills active assembly
**File:** `modules/media-uploads/chunked-upload.routes.ts`

**Rule:** The stale-lock recovery block (status="assembling" + completedVideoId=null) must check `updatedAt` before resetting. A concurrent request that won the lock milliseconds earlier will also be in this state (lock acquired, pre-commit INSERT not yet complete). Threshold is 2 minutes — generous since the pre-commit path is a single async DB call taking well under a second.

**Why:** Two `/finalize` calls arriving simultaneously: second request reads `status="assembling" + completedVideoId=null` and resets the session, killing the first request's active assembly → duplicate video rows on retry.

## Bug 5: SSE/WS IP maps can hold stale entries on edge-case disconnects
**Files:** `io/sse.gateway.ts`, `io/ws.gateway.ts`

**Rule:** Add a 10-minute `setInterval` sweep that deletes any map entries with `count <= 0`. The primary `releaseCounter` / `close` event path handles the vast majority of disconnects; the sweep is a belt-and-suspenders safety net for OS-level TCP RSTs that bypass the WS close handshake.

**Note:** Call `.unref()` on the timer to prevent it from blocking graceful shutdown.

## Bug 6: probeAttemptedForId not cleared on single-item queue cycle wrap
**File:** `modules/broadcast-v2/engine/broadcast-orchestrator.ts`

**Rule:** In the single-item loop detection block (same item ID, `startsAtMs > lastCurrentItemStartsAtMs + 500`), call `this.probeAttemptedForId.clear()` alongside `this.preloadFiredForId = null`. Without it, the proactive HEAD probe is skipped for every subsequent loop of the same item (until the next self-heal reload, up to 60s later), meaning a CDN URL that became stale mid-playback is not detected for a full loop pass.

**Why:** The set only clears on `reload()`. For a single-item broadcast queue that loops continuously, a URL probe failure is invisible for up to `RELOAD_INTERVAL_MS` (60s).
