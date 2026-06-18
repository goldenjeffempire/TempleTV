---
name: Broadcast autonomy worker patterns
description: Queue exhaustion monitor, auto-refill, disk backup, storage capacity stats — patterns and gotchas from the broadcast autonomy sprint.
---

## managed_videos column: imported_at not created_at
The `managed_videos` table uses `imported_at` (not `created_at`) as its creation timestamp. Raw SQL queries ordering by recency must use `ORDER BY mv.imported_at DESC`.

## Queue exhaustion monitor
- Sums `duration_secs` of active broadcast_queue rows to compute timeToEmpty
- Level thresholds: WARN = QUEUE_WARN_MS (default 2h), CRIT = QUEUE_CRIT_MS (default 15min)
- 10-min cooldown per level to prevent alert spam
- `getExhaustionStatus()` is sync (reads in-process state)

## Auto-refill candidate query
Selects videos not already in the active queue that have a URL and are in a playable transcoding state:
```sql
SELECT mv.id, mv.title FROM managed_videos mv
WHERE mv.transcoding_status IN ('done','faststart_applied','none')
  AND (mv.hls_master_url IS NOT NULL OR mv.local_video_url IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM broadcast_queue bq WHERE bq.video_id = mv.id AND bq.is_active = true)
ORDER BY mv.imported_at DESC LIMIT $batch
```
Must `enqueueIfMissing` (not raw INSERT) to re-use broadcast queue admission logic.

## Disk state backup
- Path: BROADCAST_STATE_BACKUP_PATH env (default /tmp) + `/broadcast-v2-state-main.json`
- Written fire-and-forget after every DB checkpoint, never blocks
- Loaded only when BOTH DB reads in hydrate() return nothing
- 30-min freshness gate prevents serving stale backup

## Storage capacity stats
- `refreshStorageStats()` runs `SELECT SUM(size_bytes), COUNT(*) FROM storage_blobs WHERE deleted_at IS NULL`
- Supervised worker `storage-capacity-stats` refreshes every 5 min (30s initial delay)
- `getStorageStats()` returns `{totalBytes, totalBlobCount, lastRefreshedAtMs}`
- In-process singleton in storage.ts — no DB round-trip on read

## Worker health
- `getWorkerStatuses()` on WorkerSupervisor returns `{name, state, consecutiveFailures, lastRunAtMs, lastErrorMs}[]`
- `state` is one of: `running`, `circuit_open`, `stopped`
- `/worker-health` endpoint at `/api/broadcast-v2/worker-health` (requireAuth("editor"))

**Why:** Exhaustion + refill are the last missing pieces for a fully autonomous 24/7 broadcast; without them an empty queue goes off-air with no recovery path.
