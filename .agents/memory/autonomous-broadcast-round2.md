---
name: Autonomous broadcast platform — round 2
description: 6 additional autonomy gaps closed in the broadcast platform for 24/7 zero-admin operation.
---

## Changes

### HLS variant deep-probe (media-integrity-scanner.ts)
`probeHlsManifest()` now extracts the first variant URL from `#EXT-X-STREAM-INF` lines (resolves relative URIs against master URL's directory) and probes it for `#EXTINF`. Catches "master OK, variant 404" — the most common silent dead-air failure mode with HLS. Only runs when master is a multi-variant playlist (has `#EXT-X-STREAM-INF` but no `#EXTINF`).

### Three maintenance indexes (db.ts → ensureRuntimeIndexes)
- `idx_broadcast_queue_inactive_deactivated` — partial on `is_active=false AND validator_deactivated_reason IS NOT NULL`; covers `reEnableAllSuspended()` which previously did a full-table scan on every boot.
- `idx_managed_videos_processing_status` — partial on `transcoding_status='processing'`; covers `resetStuckProcessingVideos()` — existing composite index had `video_source` as leading column so status-only filter couldn't use it.
- `idx_broadcast_queue_all_sort` — non-partial `(sort_order ASC, added_at ASC)`; covers admin `listQueue()` which shows all rows (active + inactive) — the existing partial index only covered active rows.

### FFmpeg zombie scan (transcoder.dispatcher.ts)
`scanAndKillOrphanedFfmpegProcesses()` called in `start()`. Scans `/proc/*/cmdline` for ffmpeg processes whose cmdline references `TRANSCODER_SCRATCH_DIR`. Linux-only (no-op on macOS). Safe: only kills processes working in our own scratch directory.

### Storage health monitor (infrastructure/storage-health-monitor.ts)
New module. Writes probe blob `__health_probe__`, `headObject`s it, deletes it every `STORAGE_HEALTH_INTERVAL_MS` (default 60 s). Circuit breaker: 3 consecutive failures → `healthy=false` + `ops-alert` SSE. 2 consecutive successes → recovered + `ops-alert` info. Exposes `getStorageHealthStatus()`. Wired into `main.ts` `startWorkers()`/`stopWorkers()` (dynamic import). Disabled if `STORAGE_HEALTH_INTERVAL_MS=0`.

### Queue health guard (engine/queue-health-guard.ts)
New supervised worker. Every 5 min (2 min initial delay), counts active broadcast queue items. If below `QUEUE_MIN_ITEMS` (default 5), calls `scanLibraryAndEnqueue({ reason: "manual", maxToAdd: max(50, deficit*3) })`. Emits `ops-alert warn` if library too small to fill threshold. Disabled if `QUEUE_MIN_ITEMS=0`. Registered in `index.ts` `startSupervisedWorkers()`.

### Wiring (env.ts, main.ts, index.ts, rest.routes.ts)
- Env vars: `QUEUE_MIN_ITEMS` (default 5), `STORAGE_HEALTH_INTERVAL_MS` (default 60000).
- `rest.routes.ts` /health endpoint: `storageHealth` + `queueHealthGuard` fields added alongside `healthMonitor`/`contentRotation`/`dbPool`.
- `stopWorkers()` became `async` — call site updated to `void stopWorkers()`.
- Pre-existing TS error fixed: `admin-ops.routes.ts` purge `deleted > 0` (Record<string,number>) → `Object.values(deleted).some(n => n > 0)`.

**Why:** storage failures are invisible until uploads silently fail or HLS 404s; queue dropping below N items before dead air is undetected without a proactive guard; HLS master-only probing misses the most common variant 404 failure mode.
