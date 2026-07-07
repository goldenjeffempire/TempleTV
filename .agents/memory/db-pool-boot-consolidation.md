---
name: DB pool saturation boot sequence fix
description: How the 9-connection startup fan-out was fixed; boot consolidation pattern and pool utilization impact.
---

## The fix

At startup, 9 separate `pool.connect()` calls (each released but some running concurrently as fire-and-forget):
- `ensureRuntimeIndexes` / `ensureUserSchemaColumns` / `ensureMemoryHourlySnapshotsTable` / `ensureMidnightPrayersTable` (phase-1 group)
- `ensureBroadcastV2Tables` / `resetStuckProcessingVideos` / `resetStuckEncodingVideos` / `recoverStaleSyncLogs` / `scheduleStaleDataCleanup` (phase-2 group)

Collapsed to `runPreBuildBootSequence()` (1 connection, sequential) + `runPostBuildBootSequence()` (1 connection, sequential). Pool utilization at 30s dropped from 40/40 → 4/40 (10%).

## Other fixes in the same pass

- `launch-readiness.routes.ts`: 13 parallel `Promise.all` queries → single SQL CTE (`db.execute(sql\`...\`)`) = 1 pool slot instead of 13. Fixed row extraction to use `firstRow<T>` pattern from storage.ts.
- `scheduleStaleDataCleanup`: removed redundant 2nd `pool.connect()` for TRUNCATE (moved into same connection as REFRESH MATERIALIZED VIEW).
- Added indexes: `idx_managed_videos_s3_mirrored_at`, `idx_managed_videos_validation_status`.
- `db-pool-health.ts`: exported `getPoolBackpressureLevel()` (0/1/2) and `isPoolSaturated()` for workers to self-throttle.

**Why:** pg pool at 40/40 with 0 waiting = hard stall; any new request hangs until a connection frees. The boot fan-out was the root cause of the saturation spike that cascaded to the watchdog restarting the process.

**How to apply:** Any new startup-time DB check must join one of the two boot sequences, not run standalone. Workers doing heavy batch DB ops should call `isPoolSaturated()` before starting a batch to shed load gracefully.
