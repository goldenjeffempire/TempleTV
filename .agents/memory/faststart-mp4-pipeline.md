---
name: Faststart MP4 pipeline — moov gating REMOVED
description: Faststart is now a background optimization only — NOT a broadcast admission gate. Raw MP4 is admitted directly.
---

## Current state (gate removed — June 2026)

Faststart is NO LONGER a broadcast admission requirement. Raw MP4 (moov-at-EOF)
plays directly. The faststart worker still runs as a background optimization
(better seek performance) but videos air immediately after upload.

**Why removed:** 24/7 autonomous broadcast — blocking admission on faststart
completion caused upload-to-air delays and killed self-healing for videos that
failed faststart. Players handle progressive-download MP4 without blank screens
in practice.

## What changed

- `isPlayableForBroadcast()` (auto-enqueue.service.ts): Now returns true for any
  video with `localVideoUrl` (non-empty). `faststartApplied` check removed.
- `scanLibraryAndEnqueue()` WHERE clause: `isNotNull(localVideoUrl)` only — no
  `eq(faststartApplied, true)` gate.
- `queue-integrity-validator.ts` ORPHANED_VIDEO_REF reverse fix: SQL
  `AND mv.faststart_applied = true` removed — items re-admitted when
  `local_video_url IS NOT NULL`.
- `probeCurrentItem()` (broadcast-orchestrator.ts): No longer calls `this.skip()`
  after probe failures. Both 4xx (≥5) and ambiguous (≥8) failure paths reset
  counters and log warnings only — retry indefinitely (24/7 broadcast mode).

## Upload/Recovery enqueue order (IMPORTANT)

Both upload finalize and faststart-recovery now enqueue BEFORE running faststart:

1. blob assembled → `enqueueIfMissing` (raw MP4 — video airs immediately)
2. `runFaststart` runs in background (moov relocation, no re-encode)
3. On success → `broadcast-source-upgraded` event upgrades sourceQuality in-place
4. On failure → video continues airing as raw MP4; recovery worker retries
5. Assembly-retry path follows same order

**Why:** Ensures 24/7 continuity — new uploads are in rotation within seconds of
assembly, not after ffmpeg remux completes (which can take minutes for large files).

## What still runs (optimization only)

- `faststartRecoveryWorker` still runs sweeps and applies faststart when possible
  (improves seek performance) but its outcome does NOT gate broadcast admission.
- `faststartApplied` column still selected in queries and in type signatures —
  informational only, displayed in admin UI.

## Signal checklist — still applies for UI feedback

After `runFaststart()` returns `{ ok: true }`, emit all three:
1. `void invalidateVideosCatalogCache()`
2. `adminEventBus.push("videos-library-updated", { videoId, reason: "..." })`
3. `adminEventBus.push("broadcast-source-upgraded", { videoId, quality: "mp4_faststart" })`

The bus bridge in broadcast-v2/index.ts consumes `broadcast-source-upgraded`
with `{ videoId, quality }` (NOT `sourceQuality`).

## How to apply

- New video admission paths: only require `localVideoUrl IS NOT NULL`.
- Do NOT add `faststartApplied === true` gates — this was intentionally removed.
