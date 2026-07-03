---
name: Blob-not-found root cause and permanent fix
description: Why "Blob not found in storage" errors occurred and the 6-layer fix applied
---

## Root Cause

The primary cause was a race in `cleanup.worker.ts` `sweepOrphanedSessions`:

```sql
WHERE s.status NOT IN ('completed', 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM managed_videos v WHERE v.id = s.completed_video_id)
```

When `completed_video_id IS NULL` (because the update at finalize line ~2305 failed non-fatally after the video INSERT succeeded), `NOT EXISTS` returns TRUE — so the session was treated as orphaned and its blob deleted. The video row still existed with `object_path` pointing to the now-deleted blob. This produced "Blob not found in storage" failures.

## Secondary Causes

- `ASSEMBLY_FAILED` / `SOURCE_MISSING` error codes incorrectly used for server-side data loss — told operators "delete and re-upload" when the blob was lost by the server, not the operator.
- Deep recovery Phase 8 always wrote `SOURCE_MISSING` even for videos where `s3_mirrored_at` was set (blob was confirmed, then lost).

## Fix (6 layers)

**1. `cleanup.worker.ts` — sweepOrphanedSessions SQL cross-check**
Added `AND (s.object_key IS NULL OR NOT EXISTS (SELECT 1 FROM managed_videos v2 WHERE v2.object_path = s.object_key))` to the query.
Added pre-deletion runtime check: if any video references `object_key`, mark session cancelled and skip blob deletion.

**2. `cleanup.worker.ts` — sweepCorruptBlobs**
Replaced `ASSEMBLY_FAILED` with `STORAGE_LOST` in the sweep list. STORAGE_LOST is now cleaned up after retention period; ASSEMBLY_FAILED is not (it may be recoverable via reassembly).

**3. `upload-integrity-monitor.ts` — STORAGE_LOST error code**
Missing blob with no parts → `STORAGE_LOST` (not `ASSEMBLY_FAILED`). Message says server-side loss, not "re-upload required".

**4. `video-recovery.service.ts` — Phase 8 error code split**
`wasConfirmed = (row.s3_mirrored_at != null)`. If confirmed: `STORAGE_LOST`. If not confirmed: `SOURCE_MISSING`. Increments the correct counter (`storageLostConfirmed` vs `sourceMissingConfirmed`).

**5. `chunked-upload.routes.ts` — completedVideoId retry**
Up to 3 attempts (500ms/1000ms backoff) before falling back to non-fatal. Sets as ERROR not WARN on final failure so it's visible in logs.

**6. Admin UI — STORAGE_LOST distinction**
`videos.tsx`: orange badge "Storage lost", never prompts re-upload.
`broadcast-v2.tsx`: "Storage lost" label with correct hover text.
Both banner counts exclude STORAGE_LOST from the "re-upload required" total.

## Key Invariant

**Why:** Blob deletion must NEVER occur if any managed_videos row references the same `object_path`/`object_key`. The `completedVideoId` link is the primary guard; the `object_path` cross-check is belt-and-suspenders for transient DB failure scenarios.

**How to apply:** Any new cleanup path that deletes storage blobs must include both guards: (a) SQL cross-check on object_path before selecting candidates, (b) runtime re-verify before actual delete().
