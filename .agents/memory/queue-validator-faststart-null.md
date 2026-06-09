---
name: Queue validator false-positive UNPLAYABLE_CORRUPT_UPLOAD
description: !row.vFaststart treats NULL (never attempted) same as false (explicitly failed) — causes false critical error toast and wrongly deactivates broadcast items.
---

## The Rule

In `queue-integrity-validator.ts`, always use `row.vFaststart === false` (strict equality), never `!row.vFaststart`, when checking whether faststart explicitly failed.

**Why:** `faststartApplied` is a nullable boolean in PostgreSQL:
- `NULL` = faststart was never attempted (video may still be playable as raw MP4)
- `false` = faststart was explicitly run and failed (moov at EOF — truly unplayable)
- `true` = faststart succeeded (moov at byte 0)

`!null === true` in JavaScript, so `!row.vFaststart` incorrectly flags every never-processed video as unplayable, fires a critical SSE toast to the admin panel, and auto-deactivates valid broadcast items.

**How to apply:** Any boolean guard in the validator (or anywhere in the codebase) that tests whether faststart failed must use `=== false`, not `!`. Also applies to the auto-fix filter array and the reverse-pass SQL recovery query.

## Three Sites Fixed

1. **Detection** (`~line 222`): `const noFaststart = !row.vFaststart;` → `row.vFaststart === false`
2. **Auto-fix filter** (`~line 636`): `!r.vFaststart` → `r.vFaststart === false`  
3. **Reverse-pass SQL** (`~line 707`): Added `OR (mv.faststart_applied IS NULL AND mv.local_video_url IS NOT NULL)` — recovers items in production that were falsely deactivated by the old bug (they had `validator_deactivated_reason = 'corrupt_upload'` but `faststart_applied` was NULL, not false).

## Production Impact

Items in the production broadcast queue that had:
- `transcoding_status = 'failed'`
- `faststart_applied = NULL` (never processed by faststart worker)
- No HLS URL
- But a valid `local_video_url`

…were incorrectly deactivated. The reverse-pass fix will re-activate them on the next validator cycle (~5 min after deploy).
