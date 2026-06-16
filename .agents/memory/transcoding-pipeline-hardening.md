---
name: Transcoding pipeline hardening sprint
description: 7 targeted production fixes applied to the already-sophisticated pipeline (leasing/DLQ/circuit-breakers all existed). Covers stage-field consistency, periodic zombie scan, stale-queue alerting, on-air deletion safety, and HLS integrity probing.
---

## Context
The transcoding pipeline already had: distributed leasing, worker heartbeats, exponential backoff, DLQ, orphan detection, circuit breakers, Prometheus metrics, audit log, resumable checkpoints. These 7 fixes address gaps found only by careful code review — none were visible from feature descriptions.

## Fix 1 — stage field NOT reset on requeue (4 paths)
**Rule:** Every path that sets `status: "queued"` on a `transcoding_jobs` row MUST also set `stage: "pending"`.

**Why:** The `stage` column (pending/validating/processing/finalizing/completed) persisted at its last active value when a job was re-queued. A "queued" job showed stage="processing" or "finalizing" in the admin UI — confusing and misleading. `stage: "pending"` is semantically correct for any reset (re-queue OR permanent failure — signals "start from scratch").

**Paths fixed:** `resetOrphanedJobs()`, `resetStuckJobs()`, `sweepRecoverableFailed()`, `runOnce()` failure transaction.

## Fix 2 — periodic FFmpeg zombie scan
**Rule:** `scanAndKillOrphanedFfmpegProcesses()` must run periodically, not only at startup.

**Why:** A long-lived server (24/7 broadcast) can accumulate zombie ffmpeg processes from SIGKILL-escaped jobs long after startup. New counter fields: `zombieScanCounter` + `zombieScanTicks` (computed from `TRANSCODER_ZOMBIE_SCAN_INTERVAL_MS`, default 30 min). Disabled when `TRANSCODER_ZOMBIE_SCAN_INTERVAL_MS=0`.

## Fix 3 — stale-queued watchdog / ops-alert
**Rule:** Any job sitting in `status='queued'` (with `next_retry_at IS NULL OR < now()`) for longer than `TRANSCODER_QUEUE_STALE_ALERT_MS` (default 2 h) must emit an ops-alert.

**Why:** Silent systemic failures (ffmpeg missing, `TRANSCODER_DISABLE=1` left set, all workers dead) leave jobs stuck in queued with no visible signal. The alert includes likely cause diagnosis (`ffmpegAvailable`, `stopped`, `TRANSCODER_DISABLE`). Implemented as `sweepStaleQueuedJobs()` running every ~15 min.

**New env vars:** `TRANSCODER_QUEUE_STALE_ALERT_MS` (default 7_200_000), `TRANSCODER_ZOMBIE_SCAN_INTERVAL_MS` (default 1_800_000).

## Fix 4 — cleanup.service.ts on-air MP4 deletion guard
**Rule:** Before deleting the source MP4 blob, check `broadcast_queue WHERE video_id=$id AND is_active=true AND (hls_master_url IS NULL OR hls_master_url='')`. Defer 1 h if true.

**Why:** Narrow race — transcoder sets `managed_videos.hls_master_url` then fires `broadcast-queue-updated`, but the orchestrator hasn't reloaded yet. If cleanup deletes the source blob at this moment, the queue row still serves `localVideoUrl` → 404 to every viewer. The 24-hour safety floor protects production; this guard closes the zero-retention dev edge case too.

## Fix 5 — media integrity scanner: last HLS segment probe
**Rule:** `probeHlsVariant()` must probe BOTH the first AND last segment URI extracted from the playlist. Skip if `lastSegUrl === firstSegUrl` (single-segment playlists).

**Why:** Partial transcodes write the full playlist with all `#EXTINF` entries but fail after uploading only early segments. The first segment exists; the last is 404. HEAD on the master/variant returns 200; this is the most common undetected failure mode. New helper: `extractLastSegmentUrl()` (scans the playlist in forward order, keeps the last non-comment line).

## Fix 6 — media integrity scanner: own-origin 5xx treated as failure
**Rule:** In `probeFirstSegment()`, add `isOwnOrigin = url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")`. If `isOwnOrigin && res.status >= 500`, return `ok: false`.

**Why:** External CDN 5xx is a transient blip — treating as ok avoids false-positive deactivations. But our own Node.js process returning 5xx on an HLS segment means a real storage/DB failure that needs to be surfaced immediately.

## Fix 7 — startup HLS integrity scan
**New file:** `artifacts/api-server/src/modules/broadcast-v2/engine/hls-startup-integrity.ts`
**Wired in:** `main.ts` after `seedPrimaryChannelIfAbsent()`, fire-and-forget.

**Rule:** On boot, for every active `broadcast_queue` row with `hls_master_url IS NOT NULL` pointing to own-origin, batch-check `storage_blobs` for `transcoded/{videoId}/master.m3u8`. Log WARN + emit ops-alert for any missing. Deactivate (`is_active=false`) items with ZERO HLS blobs. Items with partial blobs are left active for the media integrity scanner to handle.

**Why:** The media integrity scanner starts 90 s after boot. Without a startup scan, broken HLS items can reach air on the first broadcast cycle after a restart. Storage migration, TTL expiry, or a partial-success transcode from a previous run can leave items pointing at nonexistent blobs.

## How to apply
When reviewing transcoding code in the future:
- Any `.set({ status: "queued" })` on `transcoding_jobs` must also set `stage: "pending"`.
- Any new watchdog/timer added to the dispatcher must use the getter-computed ticks pattern (`Math.max(1, Math.round(TARGET_MS / env.TRANSCODER_POLL_MS))`).
- Any segment probe from own-origin (localhost) must treat 5xx as failure.
