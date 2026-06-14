---
name: Broadcast eligibility overhaul — HLS/transcoding decoupled from admission
description: Architectural changes to remove HLS/transcoding dependency from broadcast eligibility and enable continuous queue reconciliation.
---

## Core principle
Any uploaded, validated, active video with `localVideoUrl` or `hlsMasterUrl` is broadcast-eligible immediately. Background HLS transcoding/FastStart never blocks playback.

## Change 1: projectItem() failoverSource promotion (broadcast-orchestrator.ts)
When the primary URL (HLS) is bad-URL-blocked, `projectItem()` now promotes `failoverSource` (MP4) to primary instead of returning null. This prevents black screens when HLS is unavailable — the item plays via MP4 immediately.

Before: primary bad → return null → forward-scan to next item → dead air while transcoding
After: primary bad + failover available → serve failover as primary → no dead air

**How to apply:** Only applies when item has BOTH source (HLS) and failoverSource (MP4). Items with only localVideoUrl (no hlsMasterUrl) still play as MP4 primary with no failover.

## Change 2: Removed markBadUrlWithTtl suppression from autoEnqueueMissingHls (rest.routes.ts)
`_doAutoEnqueueMissingHls()` previously called `markBadUrlWithTtl(localVideoUrl, 5min)` when HLS was missing, causing guaranteed 5-minute dead air for every item being transcoded.

Removed entirely. The bad-URL exponential backoff (20s → 3min → 5min) handles repeated MP4 failures gracefully. Items that play via MP4 successfully are never suppressed.

## Change 3: Queue health guard → full continuous reconciliation (queue-health-guard.ts)
Worker now runs full library reconciliation on EVERY scan (not just when below threshold):
1. `reactivateSystemDeactivated()` — re-enables validator/auto-suspend deactivated rows
2. `scanLibraryAndEnqueue({maxToAdd: 2000})` — adds ALL missing eligible videos
3. `repairZeroDurations()` — fixes durationSecs=0 items via SQL UPDATE JOIN
4. Threshold alerting — ops-alert only when count < QUEUE_MIN_ITEMS after reconciliation

Worker interval: 3 min (was 5 min), initial delay: 90s (was 2 min).

## Eligibility criteria (isPlayableForBroadcast) — unchanged, correctly scoped
- HLS exists → eligible ✓
- CORRUPT_SOURCE / SOURCE_MISSING / ASSEMBLY_FAILED → NOT eligible (genuinely unplayable)
- localVideoUrl with (transcodingStatus=failed AND faststartApplied=false AND no HLS) → NOT eligible (moov at EOF, confirmed unplayable)
- localVideoUrl with faststartApplied=null → eligible (benefit of the doubt)
- localVideoUrl otherwise → eligible ✓

## HLS_STORAGE_MISSING validator interaction
When validator deactivates an HLS_STORAGE_MISSING item:
1. Validator deactivates item, clears hlsMasterUrl, re-enqueues transcoding
2. Reconciliation worker (3 min max gap) creates new active row with localVideoUrl as primary
3. Video plays via MP4 while HLS rebuilds in background
4. Validator's reverse pass re-activates the original row once HLS master.m3u8 appears again

**Why:** The reconciliation runs unconditionally every 3 min, so any eligible video temporarily deactivated by the validator re-enters rotation quickly via a new active row.
