---
name: Video validation service — e2e pipeline
description: Architecture and key constraints for the video-validation.service.ts implemented in the MP4-only upload pipeline.
---

## What it does
`artifacts/api-server/src/modules/transcoder/video-validation.service.ts` runs 9 checks on every uploaded MP4:

1. FILE_INTEGRITY — ffprobe reads container/codec info; **fails** if container is unparseable
2. MOOV_PLACEMENT — returns "warn" for faststartApplied=false; HTTP byte-range works regardless
3. CODEC_COMPAT — "fail" ONLY when no video stream is found at all; codec issues (HEVC, VP9, etc.) are "warn"
4. KEYFRAME_INTERVAL — warn if > 10s, warn (not fail) if > 20s
5. AV_SYNC — warn if > 500ms, warn (not fail) if > 2000ms
6. FIRST_FRAME — warn (not fail) if first 2s decode fails
7. LAST_FRAME — warn (not fail) if tail decode fails
8. DURATION_ACCURACY — warn if > 10% deviation
9. RANGE_SUPPORT — warn if server doesn't return 206

**Status values:** `null` → `pending` → `running` → `passed` / `warn` / `failed`

## Broadcast gate (ADVISORY ONLY — NOT a hard gate)
Validation is fully advisory. `isPlayableForBroadcast()` does NOT check `validationStatus`.
All statuses (null/pending/running/passed/warn/**failed**) are broadcast-eligible.

The two checks that still produce "fail" (FILE_INTEGRITY and CODEC_COMPAT no-video-stream)
surface in the admin UI for operator awareness but do NOT deactivate queue items.

**Why:** A video with a confirm blob (`s3MirroredAt IS NOT NULL`) broadcasts immediately.
Quality issues are reported; only genuinely missing blobs or terminal error codes block.

## Places that previously gated on validationStatus (all removed):
- `isPlayableForBroadcast()` — never checked it (confirmed by code read)
- `scanLibraryAndEnqueue()` — does not filter on validationStatus
- `sync-library Phase 3` — was a hard deactivation; converted to advisory count + warn log
- Library stats query in `/sync-library` — removed `validation_status <> 'failed'` filter
- Queue integrity validator VALIDATION_FAILED — already advisory warn only (no deactivation)

## Queue integrity validator reverse pass
The validator re-activates items with `validator_deactivated_reason = 'validation_failed'`
on every 2-minute cycle, restoring previously gated items to broadcast rotation.

## REMEDIABLE_CHECKS
After FIRST_FRAME/LAST_FRAME were downgraded to warn, only `["FILE_INTEGRITY", "CODEC_COMPAT"]`
remain. Note: `attemptRemediation` appears to be dead code in `runVideoValidation` (never called
from that function); it may be called from a recovery worker or is legacy.

## Integration points
- Primary finalize path: `chunked-upload.routes.ts` after assembly commits blob
- `scheduleVideoValidation()` is fire-and-forget; runs after enqueueIfMissing

## Admin endpoints
- `GET /api/v1/admin/videos/:id/validation` — returns stored report
- `POST /api/v1/admin/videos/:id/validation/run` — triggers new validation
