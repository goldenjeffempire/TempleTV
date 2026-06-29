---
name: Blob-not-found permanent fix
description: Root cause and 3-layer fix for "Blob not found in storage" errors across the upload assembly + queue validation pipeline.
---

## Root cause

Assembly via `completeMultipartUpload` succeeds and deletes all staging parts from `storage_upload_parts`. A downstream post-processing step (video row update, s3MirroredAt stamp) throws. Session is reset to "uploading". The reconciliation timer fires `spawnAssemblyRetry` → `completeMultipartUpload` throws `ASSEMBLY_NO_PARTS` (parts already deleted) → video marked permanently failed. The intact blob in `storage_blobs` is orphaned and the video never plays.

## Fix 1 — spawnAssemblyRetry blob-exists shortcut (chunked-upload.routes.ts)

Before calling `completeMultipartUpload`, do a `headObject(storageKey)`. If the blob already exists, skip re-assembly and run only post-processing (video row stamp + s3MirroredAt). Falls back to full assembly on headObject failure. This breaks the ASSEMBLY_NO_PARTS cascade entirely.

**Why:** completeMultipartUpload deletes parts atomically inside its transaction, so a second call has no parts to work with; blob-exists check is the only safe re-entry point.

**How to apply:** Any future retry path for chunked upload assembly must check blob existence before attempting to re-assemble.

## Fix 2 — storageBackend column value (chunked-upload.routes.ts)

The finalize path was writing `storageBackend: "minio"` when the schema default and the actual backend is `"db"` (PostgreSQL BYTEA). Fixed to `"db"`.

## Fix 3 — MISSING_BLOB detection in queue integrity validator (queue-integrity-validator.ts)

Added `deriveStorageKey()` helper + batch `storage_blobs` check. Queue items whose storage key is absent from `storage_blobs` are auto-deactivated (`validatorDeactivatedReason = 'missing_blob'`). Reverse pass re-activates when blob is restored. Both passes are non-fatal.

## Fix 4 — Startup blob audit (auto-enqueue.service.ts + main.ts)

`auditMissingBlobs()` scans all local `managed_videos` rows with `localVideoUrl` set, derives storage keys (prefers `objectPath` over URL derivation), batch-checks `storage_blobs`, and logs an `error`-level message listing missing videos. Read-only diagnostic — queue validator handles deactivation. Called at startup after 5 s delay alongside `repairMissingS3MirroredAt`.

## Key patterns

- `deriveStorageKey()` handles: `/api/v1/uploads/...`, `/api/uploads/...`, absolute `https://...api.../uploads/...`, and bare `uploads/...` keys. Returns null for YouTube/CDN URLs (skipped).
- Blob audit on a YouTube-only library exits immediately (checked: 0) — no noise.
