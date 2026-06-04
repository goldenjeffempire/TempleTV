---
name: Transcoder partial-success drift recovery must be periodic AND race-safe
description: Healing videos stuck at "encoding" (job done, hls_ready write lost) needs a periodic watchdog pass and an atomic NOT-EXISTS guard, not a boot-only reconciliation.
---

Job completion does two writes: `transcoding_jobs.status='done'` then
`managed_videos.transcoding_status='hls_ready'`. A crash/error between them leaves
the video stuck at `encoding` forever — its job is `done`, so it never re-enters
the dispatch loop and serves the raw MP4 fallback indefinitely.

**Rule 1 — recover periodically, not only at boot.** The reconciliation that
verifies `master.m3u8` exists in `storage_blobs` and flips the video to
`hls_ready` must run on a gated cadence in the dispatcher tick (the watchdog),
not only inside boot-time `resetOrphanedJobs`. A 24/7 process can run for days
without restarting, so a boot-only fix means the drift persists for days.

**Rule 2 — the heal MUST be a single atomic UPDATE, never read-then-write.** A
manual re-transcode legitimately puts a previously-finished video back into
`encoding` under a NEW job while the OLD `done` job and its stale `master.m3u8`
still exist. A naive heal would flip it to `hls_ready` mid-encode. Pre-filtering
out videos with an active job in a separate SELECT is NOT enough — a new job can
be queued between the SELECT and the UPDATE (TOCTOU, worse across replicas). Fold
every guard into the write:

```sql
UPDATE managed_videos
SET transcoding_status='hls_ready', hls_master_url=$url
WHERE id=$videoId
  AND transcoding_status='encoding'          -- multi-replica idempotency
  AND NOT EXISTS (SELECT 1 FROM transcoding_jobs j
                  WHERE j.video_id=managed_videos.id
                    AND j.status IN ('queued','processing'))  -- skip live re-transcode
RETURNING id
```

**Why:** `transcoding_jobs` has no uniqueness on `video_id` (re-transcode allowed),
so "a done job exists for this encoding video" is NOT sufficient evidence of drift.

**How to apply:** emit `transcoding-update` + `broadcast-queue-updated` events only
when `RETURNING` yields a row, so race-losing replicas don't spam false events.
The existing `idx_transcoding_jobs_video_id` keeps the NOT EXISTS cheap (few jobs
per video) — no composite index needed.
