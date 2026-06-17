---
name: HLS never-started sweep
description: Gap in the queue-integrity-validator — transcodingStatus='none' with no hlsMasterUrl on active broadcast queue items was never caught by existing sweeps.
---

# HLS never-started sweep (STUCK_HLS_NEVER_STARTED)

## The rule
The validator has three HLS recovery sweeps. Cover all four stuck states:
- `STUCK_HLS_FAILED` (Gap 2a) — `transcodingStatus='failed'` with recoverable error, every 15 cycles
- `STUCK_ENCODING_NO_JOB` (Gap 2b) — `transcodingStatus='encoding'` with no active job, every 3 cycles
- `STUCK_HLS_NEVER_STARTED` (Gap 2c) — `transcodingStatus='none'` AND `hlsMasterUrl IS NULL` AND `objectPath IS NOT NULL`, every 20 cycles ← **the new one**

**Why:** Videos admitted to the broadcast queue as raw MP4 (admission requires only `localVideoUrl` OR `hlsMasterUrl`) may have never had `enqueueTranscode` called if the upload-finalize background task threw after `enqueueIfMissing` but before the `enqueueTranscode` call, and the error was caught non-fatally. These videos broadcast forever as un-optimised MP4 or trigger auto-skip loops.

**How to apply:**
- Query: `transcodingStatus='none' AND hls_master_url IS NULL AND object_path IS NOT NULL` + `EXISTS(broadcast_queue is_active=true)` + `NOT EXISTS(transcoding_jobs queued/processing)`
- Use `priority: 2` (lower than STUCK_HLS_FAILED's priority 3) so genuine stuck-failed retries stay ahead.
- Rate-limit to every 20th cycle (~40 min) — these are not urgent since the video is still airing as MP4.
- Also exclude: `source_cleanup_status='deleted'` and terminal error codes.
