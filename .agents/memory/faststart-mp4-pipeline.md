---
name: Faststart MP4 pipeline — faststartApplied IS a broadcast gate
description: FastStart moov relocation is REQUIRED before broadcast admission. Raw MP4 is never admitted. Gate re-added July 2026.
---

## Current state (gate RE-ADDED — July 2026)

FastStart IS a broadcast admission requirement. Raw MP4 (moov-at-EOF) must never
enter the broadcast queue — blank screens on TV/mobile surfaces (progressive
download requires moov at byte 0).

**Why re-added:** Original removal caused "blank screen" reports on TV/mobile. The
previous rationale ("players handle it in practice") was wrong for the real surfaces.
The 24/7 continuity concern is handled by faststartRecoveryWorker retrying and
calling enqueueIfMissing on success — no operator action needed.

## What changed (July 2026)

- `isPlayableForBroadcast()` (auto-enqueue.service.ts): Returns false when
  `row.faststartApplied !== undefined && row.faststartApplied !== true`.
  undefined = caller didn't select the field (diagnostic-only callers like
  listMissingFromQueue) — gate skipped for backward compat.
- `scanLibraryAndEnqueue()` WHERE clause: Added `eq(videosTable.faststartApplied, true)`.
- Upload finalize path: Enqueue block is now `if (fsResult.ok) { enqueueIfMissing... }`
  — no enqueue on faststart failure.
- Assembly-retry path: Pre-faststart enqueue removed. Enqueue fires only inside
  the `else` branch after `fsResult.ok`.

## Upload/Recovery enqueue order (CORRECT)

1. blob assembled → `runFaststart` runs (moov relocation required)
2. On success: `enqueueIfMissing` fires → video enters broadcast queue
3. On failure: NOT enqueued; `faststartRecoveryWorker` retries every 5 min
   and calls `enqueueIfMissing` on recovery success

## faststartRecoveryWorker

Still critical — it is the ONLY path that recovers videos when faststart fails
during finalize or assembly-retry. Must call `enqueueIfMissing` on success.
Currently confirmed to do so (faststart-recovery.ts line ~203).

## Signal checklist — after runFaststart ok

1. `void invalidateVideosCatalogCache()`
2. `adminEventBus.push("videos-library-updated", { videoId, reason: "..." })`
3. `adminEventBus.push("broadcast-source-upgraded", { videoId, quality: "mp4_faststart" })`

## Admin UI state machine labels

- `transcodingStatus='none'`, `faststartApplied=null` → "Awaiting FastStart" (outline)
- `transcodingStatus='processing'` → "Applying FastStart" (secondary)
- `faststartApplied=false` → "FastStart Failed" (destructive)
- `faststartApplied=true` → "MP4 Ready" (default/green)
- "Sync to Queue" button: only shown when `faststartApplied === true`

## How to apply

- New video admission paths: require BOTH `localVideoUrl IS NOT NULL` AND `faststartApplied = true`.
- Do NOT remove the `faststartApplied` gate — raw MP4 causes blank screens.
- Do NOT enqueue before faststart completes in upload finalize or assembly-retry.
