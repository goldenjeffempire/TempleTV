---
name: objectPath absolute-URL data quality bug
description: Some managed_videos rows stored an absolute URL as objectPath instead of the bare storage key, causing faststart CORRUPT_UPLOAD false-positives.
---

## The Rule
`managed_videos.object_path` must always be a bare storage key (`uploads/yyyy/mm/dd/uuid.ext`), never an absolute URL (`https://api.templetv.org.ng/api/v1/uploads/…`). `storage().headObject(fullUrl)` returns `{ exists: false }` causing faststart to throw CORRUPT_UPLOAD → video marked failed + broadcast queue entry deactivated.

**Why:** Some older upload paths stored `localVideoUrl` (relative or absolute URL) as `objectPath` by mistake. Discovered via faststart-recovery retry loop on video `7647cc3d` in dev DB (prod-sync mirrored it with the bad value).

**How to apply:**
1. `faststart.service.ts` `runFaststart()` normalises at the top of the function: if objectKey starts with `http://`/`https://`, extract bare key via `/api/v1/uploads/` marker, repair DB row, recurse with corrected key.
2. `main.ts` startup runs a one-time SQL `UPDATE managed_videos SET object_path = 'uploads/' || SUBSTRING(...)` for all rows matching `LIKE 'http%'` (idempotent, fast). Fixed 3 rows on first run.
3. `faststart-recovery.ts` `backfillPlaceholderDurations` filter now skips full-URL objectPaths with a WARN log instead of attempting a storage probe that would silently fail.
