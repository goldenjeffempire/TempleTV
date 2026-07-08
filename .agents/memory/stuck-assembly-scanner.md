---
name: Stuck-assembly scanner and session-completed retry
description: Three gaps that cause videos to get stuck in "Assembling…" and how they're fixed in chunked-upload.routes.ts.
---

## The gaps

1. **Session `status="completed"` update has no retry.**  
   Both the finalize background task (`~line 2590`) and `spawnAssemblyRetry` (`~line 449`) do:
   ```js
   db.update(sessions).set({ status: "completed" }).catch((err) => warn(err))
   ```
   A transient DB failure leaves the session at `"assembling"` forever. The blob is committed, `s3MirroredAt` is stamped, but `finalize-status` polls return `"assembling"` indefinitely.

2. **`finalize-status` endpoint didn't use the video row as source of truth.**  
   It only read `sessions.status`. If the blob was committed but the status update failed, the endpoint returned `"assembling"` forever.

3. **No periodic in-process scanner for sessions stuck in "assembling".**  
   The `onReady` startup hook covers restarts. But on a long-running server, a session stuck between 30 min and 4 hours (the watchdog boundary) had no in-process recovery.

## Fixes applied

### Fix 1 & 2: 30-second retry for `status="completed"` update
Both finalize BG task and `spawnAssemblyRetry` now schedule a `setTimeout(30s)` retry on failure, with a warning log if that also fails. The periodic scanner and finalize-status endpoint act as additional backstops.

### Fix 3: finalize-status self-heals from video.s3MirroredAt
In the `"assembling"` branch of `GET /finalize-status`, when `completedVideoId` is set:
- Query `videos.s3MirroredAt` for that video.
- If it's non-null → assembly committed but session update failed → force-complete session and return `"completed"`.

### Fix 4: Periodic stuck-assembly scanner (every 5 min, 10-min initial delay)
Finds sessions in `"assembling"` state for > 30 minutes. Two cases:
- **Case A** (blob committed, `s3MirroredAt IS NOT NULL`): force-complete session + fire `enqueueIfMissing`.
- **Case B** (blob NOT committed): increment `assemblyAttempts` + reset to `"uploading"` so reconciliation timer retries. If `assemblyAttempts + 1 >= MAX_AUTO_ASSEMBLY_ATTEMPTS`, mark video `ASSEMBLY_FAILED` and clear `completedVideoId` so neither scanner nor reconciliation loops forever.
- **Case B (no completedVideoId)**: same ceiling logic, no video row to mark.

## Key invariants to maintain
- `enqueueIfMissing` reason union in `auto-enqueue.service.ts` must include `"stuck-assembly-scanner"`.
- Scanner uses `MAX_AUTO_ASSEMBLY_ATTEMPTS` (currently 8) as the ceiling — must stay in sync with `spawnAssemblyRetry`.
- `STALE_ASSEMBLY_THRESHOLD_MS` = 30 min (hardcoded in scanner) — below the 4-hour watchdog, above typical large-file assembly times.

**Why:** The `status="completed"` update is the last step of assembly and historically had no retry, making it the most likely single point of failure for the "Assembling…" stuck state.
