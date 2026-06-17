---
name: Broadcast-first upload pipeline
description: Policy decisions and code sites for admit-everything, never-block upload → broadcast flow.
---

## Rule
Every uploaded file must reach the broadcast queue and stay there as long as ANY playable URL exists. Only deactivate when there is truly nothing to play.

**Why:** HLS transcoding failure ≠ unplayable. Raw MP4 fallback always works for progressive playback. Old policy deactivated items on CORRUPT_SOURCE even when localVideoUrl was set — dead air for content that could play.

**How to apply:** Anywhere a queue item deactivation is triggered by a transcoding failure, check `localVideoUrl IS NOT NULL` first. If it's set, downgrade to a warn and leave the item active.

## Key code sites

### queue-integrity-validator.ts
- `UNPLAYABLE_CORRUPT_UPLOAD` detection: fires only when `SOURCE_MISSING` OR `(CORRUPT_SOURCE && !localVideoUrl && !qLocalUrl)`
- New `HLS_TRANSCODE_FAILED_MP4_FALLBACK` warn issue: fires when `CORRUPT_SOURCE + localVideoUrl present`
- Auto-fix deactivation filter: `baseFilter(r) && r.vErrCode === "CORRUPT_SOURCE" && !r.vLocalUrl && !r.qLocalUrl`
- Reverse pass (re-activation): excludes only `SOURCE_MISSING`; CORRUPT_SOURCE items with a URL are now re-activated

### transcoder.dispatcher.ts
- Removed `corruptSourcePattern` regex (`/moov atom not found|.../`). Only `errCode === "CORRUPT_SOURCE"` (explicitly thrown by our own code) triggers immediate terminal fail. FFmpeg stderr patterns route to dead_letter instead — broadcast item stays active, plays as MP4.

### chunked-upload.routes.ts — remaining CORRUPT_SOURCE writes (all safe)
- Lines 2336/2868: blob size mismatch → localVideoUrl NULL → correctly deactivated (nothing to play)
- Line 2660: `assemblyCommitted ? "CORRUPT_SOURCE" : "ASSEMBLY_FAILED"` — if blob committed, localVideoUrl likely set → stays active under new policy

## Upload pipeline finalization (4 paths)
All 4 paths call `enqueueIfMissing()` unconditionally before faststart/HLS. Faststart failures are warn-only (never throw). HLS transcoding failures fall back to raw MP4 at the orchestrator level via `resolveSource()` priority: HLS > MP4 > YouTube.

## What is still truly deactivated
- `SOURCE_MISSING`: storage blob deleted; URL column value is stale; 404 guaranteed → deactivate
- `CORRUPT_SOURCE + no localVideoUrl`: blob never committed or was purged → nothing to play → deactivate
- `MISSING_VIDEO_JOIN`: video row hard-deleted → deactivate
