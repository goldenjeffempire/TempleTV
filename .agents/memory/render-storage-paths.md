---
name: Render Disk / persistent storage paths
description: How scratch/backup dirs are routed, what uses /tmp vs STORAGE_PATH, and what the disk watchdog covers.
---

## Rule

All filesystem-resident temp work (FFmpeg scratch, faststart, all probe functions) now resolves under `storagePaths.scratch` (default `/tmp/transcoder`; override via `STORAGE_PATH=/var/data` or `TRANSCODER_SCRATCH_DIR`). Media (uploads, HLS, thumbnails) is 100% in PostgreSQL BYTEA — it never touches the filesystem as primary storage.

## What sits in scratch

| Dir pattern | Created by | Size pressure |
|---|---|---|
| `faststart-<uuid>/` | `faststart.service.ts` | 2× source (input.mp4 + output.mp4) |
| `probe-<uuid>/` | `probeUploadedDuration` | 1× source |
| `meta-probe-<uuid>/` | `probeVideoMetadata` | 1× source |
| `container-probe-<uuid>/` | `probeUploadedContainerValidity` | 1× source |
| `thumb-norm-<uuid>/` | `normalizeThumbnailBuffer` | tiny (thumbnail only) |
| `<jobId>/` | transcoder (HLS encode) | 4-5× source |

All cleaned up in try/finally. `sweepStaleTempDirs()` runs on boot and on emergency.

## Disk watchdog

`infrastructure/disk-watchdog.ts` — `startDiskWatchdog()` started in main.ts alongside memory + event-loop watchdogs.

- Samples `statfs(storagePaths.scratch)` every `DISK_WATCHDOG_INTERVAL_MS` (default 60 s)
- Warns at `SCRATCH_WARN_PERCENT` (default 70 %)
- At `SCRATCH_ALERT_PERCENT` (default 85 %): fires ops-alert SSE, sweeps dirs older than 30 min, sets `isDiskConstrained()=true`
- `isDiskConstrained()` imported by transcoder dispatcher and faststart — both abort pre-flight when true

## Startup sweep

`sweepStaleTempDirs({ maxAgeMs: 2h })` called in main() after `ensureStorageDirectories()` to reclaim dirs orphaned by a previous SIGKILL before their finally-blocks ran.

## Render Disk quick-start

Set `STORAGE_PATH=/var/data` — all sub-paths derive automatically:
- scratch → `/var/data/scratch`
- stateBackup → `/var/data`
- queueBackup → `/var/data`

**Why:** Render container `/tmp` is ~500 MB; a 1080p source can require 4-5 GB for the HLS scratch. Without persistent storage, large encodes reliably ENOSPC mid-job.
