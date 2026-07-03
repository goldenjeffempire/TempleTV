---
name: Inline blob-confirmation self-heal for broadcast admission
description: enqueueIfMissing self-heals a missing s3MirroredAt stamp synchronously in the same call, eliminating the "not yet broadcast-ready" wait state
---

`isPlayableForBroadcast()` requires `s3MirroredAt` to be non-null for local MP4s. When the post-assembly UPDATE that stamps it silently fails (partial write, race, restart mid-assembly), a video could sit "not broadcast-ready" until the 60s reconciler tick or a manual force-enqueue/"Sync to Queue" click repaired it.

Fix: `enqueueIfMissing()` in `auto-enqueue.service.ts` now checks `isBlockedOnlyByMissingBlobConfirmation(row)` when admission fails — true only when the *sole* blocking reason is the missing stamp (excludes YouTube-only rows, midnight-prayers category, terminal transcode error codes, and failed validationStatus, which are genuine non-transient exclusions and must never be auto-repaired). If true, it runs `repairMissingS3MirroredAt(videoId)` inline (scoped, synchronous blob-existence check), re-reads the row, and retries admission in the same call.

**Why:** every caller of `enqueueIfMissing` (upload finalize, reconciler, startup library scan, manual force-enqueue) gets the self-heal for free with one change, rather than requiring every call site to special-case the repair.

**How to apply:** when adding any new blocking condition to `isPlayableForBroadcast()`, decide explicitly whether it belongs in `isBlockedOnlyByMissingBlobConfirmation`'s exclusion list — a new *transient* condition should be added to the self-heal path; a new *terminal* condition must be excluded so it's never silently retried into an incorrect state. FastStart/moov relocation is confirmed dead code (never invoked in the automated upload flow) and is not, and should not become, an admission gate.
