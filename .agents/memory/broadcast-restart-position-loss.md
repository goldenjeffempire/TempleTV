---
name: Broadcast restart-from-0 root causes and permanent fixes
description: Why videos restart from the beginning after every daemon restart, and the 3 permanent fixes applied.
---

## Root Cause: Boot-time Queue Oscillation Consuming the Cycle Anchor

**Symptoms**: After every daemon restart, the broadcast starts from a random video at position 0 instead of resuming the correct video at the correct timestamp.

**Root Cause Sequence**:
1. `hydrate()` loads `restoredCycleAnchor = historical_epoch` from `broadcast_runtime_state.started_at_ms`
2. First `reloadInner()`: finds N items → applies `restoredCycleAnchor` (correct resume) → **consumes** anchor (sets to null)
3. `queue-integrity-validator` fires ~2-3 seconds later at boot → deactivates all items with MISSING_BLOB (no storage_blobs row for their localVideoUrl key)
4. Second `reloadInner()`: queue empty → no anchor to use → `ytShuffleFallback` activates
5. Validator reverse pass finds 1+ items with valid blobs → re-activates them
6. Third `reloadInner()`: `prevCurrentId = null` (was empty), `restoredAnchor = null` (consumed) → **FRESH START** → `cycleStartedAtMs = reloadNow` → broadcast from position 0!

**Why**: `restoredCycleAnchor` is a one-shot field consumed on first use. When the queue oscillates (empty → populated) during the boot sequence, subsequent reloads that find items have no anchor left to restore.

## Secondary Root Cause: `queue_order` Column Error

`runPreBuildBootSequence()` tried to create `idx_broadcast_queue_active_order ON broadcast_queue (queue_order ASC)` but the column is `sort_order`. This caused a non-fatal 42703 error on every boot. `idx_broadcast_queue_active_sort` already covers `(sort_order, added_at)`.

## Permanent Fixes Applied (July 2026)

### Fix 1: `_bootAnchorPreserved` field (broadcast-orchestrator.ts)
- Added `private _bootAnchorPreserved: number | null = null` to `BroadcastOrchestrator`
- Set it when `restoredCycleAnchor` is first applied (PRIMARY restore path)
- Set it when checkpoint fallback is applied (FALLBACK restore path)
- In the boot-case else branch: use `_bootAnchorPreserved` instead of `reloadNow`
- Result: queue oscillation during boot no longer causes restart-from-0

### Fix 2: Remove broken `queue_order` index creation (db.ts)
- Removed the 5-line block creating `idx_broadcast_queue_active_order ON broadcast_queue (queue_order ASC)`
- Column `queue_order` doesn't exist; `sort_order` is the correct column and already indexed

### Fix 3: Disk backup max-age 30min → 4h (disk-state-backup.ts)
- `maxAgeMs` default raised from `30 * 60 * 1000` to `4 * 60 * 60 * 1000`
- Covers long deployment queue waits (EAS build, cloud deployment) that take >30 min

## How to Verify Fix is Working
Look for this log line in Broadcast Daemon boot logs:
```
"[broadcast-v2] boot: preserved cycle anchor applied — broadcast continues from correct position after transient queue disruption"
```
And for YouTube shuffle: `resumeSeconds > 0` (not 0:00).

## Architecture Notes
- This deployment is YouTube-only (968 YouTube videos, 0 local blobs)
- ALL local queue items always fail MISSING_BLOB at boot → queue always empty → ytShuffleFallback is primary driver
- `ytShuffleFallback.tryResumeFromHydratedState()` handles the actual video resume position
- The cycle anchor is preserved through the transient oscillation by `_bootAnchorPreserved`

**Why**: `_bootAnchorPreserved` is never cleared — a stale-but-close epoch is always less harmful than restarting from 0 for 24/7 broadcast TV.
