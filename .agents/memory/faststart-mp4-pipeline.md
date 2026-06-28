---
name: Faststart MP4 pipeline — moov gating
description: Architecture and invariants for the faststart (moov relocation) pipeline in the MP4-only broadcast stack.
---

## The rule

A local MP4 video MUST have `faststartApplied = true` before it can be admitted to the broadcast queue or displayed to viewers. A raw MP4 with moov-at-EOF forces every player surface (browser/TV/mobile) to download the entire file before playback starts → blank screen.

**Why:** The platform stores video as PostgreSQL BYTEA (no S3/MinIO). Every download is served via HTTP Range requests. Without a front-positioned moov atom the player cannot parse the container without the full byte stream.

## Pipeline flow

1. `POST /admin/videos/upload/:sessionId/finalize` → assembles blob, probes metadata, then calls `runFaststart(videoId, objectKey)` as a background task.
2. `runFaststart()` (faststart.service.ts):
   - Reads first 64 KiB from storage to detect moov atom position.
   - If moov is already at front → stamps `faststartApplied=true, transcodingStatus=ready` and returns `ok:true` without remuxing.
   - If moov at EOF → runs 5-strategy remux cascade (ffmpeg -c copy -movflags +faststart).
   - Validates output via HTTP Range probe (loopback bypass).
   - Atomically replaces blob via multipart re-upload.
   - Stamps `faststartApplied=true, transcodingStatus=ready` on success.
3. On `fsResult.ok`:  `enqueueIfMissing()` is called; video enters broadcast queue.
4. On `fsResult.ok === false`: video stays off-air; ops alert emitted; `faststartRecoveryWorker` retries up to 3 times.

## Enforcement points

- `isPlayableForBroadcast()` (auto-enqueue.service.ts): `row.faststartApplied === true` required for local videos.
- `scanLibraryAndEnqueue()` WHERE clause: `and(isNotNull(localVideoUrl), eq(faststartApplied, true))`.
- Broadcast admission never bypassed — both guards are belt-and-suspenders.

## Recovery worker

`faststartRecoveryWorker` (broadcast-v2/engine/faststart-recovery.ts) is registered as a supervised worker in `startSupervisedWorkers()` with:
- `intervalMs: 5 × 60_000`, `initialDelayMs: 3 × 60_000`
- Finds: `transcodingStatus='processing'` stale >15 min, or `status='ready' && faststartApplied=false`
- After `MAX_ATTEMPTS=3` marks video permanently failed and alerts.

## How to apply

- Any new video admission path (bulk import, YouTube local cache, etc.) must check `faststartApplied === true` before enqueuing.
- Any DB migration that bulk-inserts local videos should run `runFaststart` per video or import only pre-processed files.
- Do NOT add a fast-path that bypasses faststart "for speed" — blank screens in prod are worse than upload latency.
