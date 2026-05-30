---
name: Comprehensive platform audit — sprint 18
description: 6 fixes + 5 documented false positives from parallel 5-way audit; key broadcast/player/queue reliability improvements.
---

## Fixes implemented

1. **Queue validator — ORPHANED_VIDEO_REF auto-fix**: deactivates broadcast_queue items where `video.transcodingStatus='failed'` and no URLs exist. Safety rule: ONLY fix when `vStatus='failed'`; never touch `queued/encoding/processing` (actively transcoding). File: `queue-integrity-validator.ts`.

2. **Transcoder CODECS injection: `warn` → `error`**: missing CODECS attr causes black screens on Samsung Tizen/LG webOS; now visible in monitoring dashboards. File: `transcoder.service.ts` ~line 1307.

3. **Admin broadcast DnD constraint**: `isDragDisabled` now includes `removeMutation.isPending` to prevent drag-while-remove-in-flight race. File: `broadcast.tsx`.

4. **Prod-sync log dedup**: consecutive failure counter → WARN only on 1st failure and every 10th (~5 min at 30s poll). Stats expose `consecutiveFailures` for monitoring dashboards. Stops log spam when upstream is extended-down (e.g. maintenance). File: `prod-queue-sync.ts`.

5. **Mobile SKIP_PENDING escape valve: 20 s → 8 s**: matches web hook (`react.ts`) which was already 8 s. Reduces max dead-air per stalled item from 20 s to 8 s. File: `lib/player-core/src/react-native.ts`.

6. **V2PlayerContainer LOAD_TIMEOUT comment fix**: corrected misleading "chosen above BUFFERING_STALL_THRESHOLD_MS" (12 < 15 is intentional — different failure modes). File: `V2PlayerContainer.tsx`.

## Confirmed false positives (do NOT re-investigate)

- **Finalization race**: `enqueueTranscode` at `chunked-upload.routes.ts:1320` is inside a void IIFE that runs AFTER assembly completes AND faststart finishes. The pre-commit `transcodingStatus: "queued"` at line 1036 is purely UI-status; the dispatcher uses `transcoding_jobs` table only (never polls `managed_videos.transcodingStatus`). Future auditors will flag this — it is NOT a race.
- **`resetOrphanedJobs` preserves `attempts`**: the `.set()` call updates only `{status, progress, startedAt, errorMessage}` — NOT `attempts`. The maxAttempts guard still works correctly after a restart.
- **DnD rollback**: already present at `broadcast.tsx:1589` (`if (queue?.items) setItems(queue.items)`) — reverts to server state on reorder error.
- **Orchestrator/filler SSE alerts**: operators DO receive real-time SSE events for `dead_air.detected`, `all_sources_blocked`, and `emergency-filler-activated` via `adminEventBus.push()`. No gap.
- **Notification/scheduling system**: solid. Atomic claim, crash recovery, idempotency index, 3-tier retry on push delivery, SSE heartbeat cleanup. No bugs found.

## Design decisions confirmed correct

- **LOAD_TIMEOUT_MS (12 s) intentionally < BUFFERING_STALL_THRESHOLD_MS (15 s)**: targets different failure modes. LOAD_TIMEOUT: ExoPlayer never emits `isBuffering=true` (manifest/codec silent failure). STALL_THRESHOLD: `isBuffering=true` but no frames. They don't race — LOAD_TIMEOUT fires first and clears stall watchdog via error path.
- **Mobile/web escape valves must match**: keep `react-native.ts` and `react.ts` SKIP_PENDING escape valve in sync (both now 8 s).
