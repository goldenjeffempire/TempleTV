---
name: s3MirroredAt repair pipeline — scanLibraryAndEnqueue eligibility gate
description: Why local videos with confirmed storage blobs can be permanently excluded from the broadcast queue, and the self-healing pattern that fixes it.
---

## The rule

`scanLibraryAndEnqueue` pre-filters local videos on `s3_mirrored_at IS NOT NULL`. Any video where that column is NULL is invisible to all library scans — startup, orchestrator self-heal, queue-health-guard, and manual — forever.

## Why

Both upload finalize paths ("db" Path A and "db_fallback" Path B) set `s3MirroredAt` inside a `Promise.all` alongside another DB update. The original code used `.catch(() => {})` — silent discard — on the `s3MirroredAt` UPDATE. Any transient DB failure (pool exhaustion, statement timeout) left the field NULL permanently. The blob was committed and the video playable, but the eligibility filter was stuck.

## The fix

`repairMissingS3MirroredAt()` in `auto-enqueue.service.ts`:
1. SELECT local videos with `s3MirroredAt IS NULL`, `localVideoUrl IS NOT NULL`, no terminal error code.
2. Derive storage keys from `localVideoUrl` (relative `/api/v1/uploads/…` → `uploads/…`).
3. Batch-check `storage_blobs` for those keys.
4. Batch-UPDATE `s3MirroredAt = NOW()` for every confirmed hit.

Called as the **first step** inside `scanLibraryAndEnqueue` (so every scan path gets the repair automatically) AND called separately from `main.ts` startup block so the repair gets its own log line.

## How to apply

- If you ever add a new path that sets `s3MirroredAt`, make the `.catch()` log a WARN (not discard silently).
- `deriveStorageKeyFromUrl()` in auto-enqueue.service.ts is the canonical key derivation for this module; keep it in sync with `deriveStorageKey()` in queue.repo.ts.
- The storage_blobs check is what proves a blob was committed — `s3MirroredAt IS NOT NULL` is a derived marker, not ground truth. When in doubt, trust storage_blobs.
- `repairMissingS3MirroredAt` is safe to call on every scan cycle; it early-returns when no candidates exist (cheap SELECT on an indexed nullable column).
