---
name: S3 storage migration pattern
description: How the storage backend was migrated from PostgreSQL BYTEA to AWS S3, and how the factory selects between them.
---

# S3 Storage Migration

## Rule
`artifacts/api-server/src/infrastructure/storage.ts` contains two implementations of `ObjectStorage`: `DatabaseObjectStorage` (BYTEA fallback) and `S3ObjectStorage` (primary). The factory `storage()` returns `S3ObjectStorage` when `env.S3_BUCKET` is set, otherwise falls back to `DatabaseObjectStorage`.

**Why:** Migrating 100% BYTEA storage to S3 removes the 16 MiB V8 hex-string penalty per concurrent HLS request and eliminates TOAST table fragmentation.

**How to apply:** Set `S3_BUCKET=<bucket>` and `S3_REGION=<region>` in Replit secrets. AWS credentials are read from `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (standard SDK env var names). `AWS_ENDPOINT_URL` overrides the endpoint (for LocalStack or custom S3-compatible stores).

## Key design decisions
- `publicUrl()` returns CDN URL if `CDN_BASE_URL` is set; otherwise returns the `/api/v1/uploads/<suffix>` proxy path so the server can gate HLS token auth.
- Multipart upload maps 1:1 to real S3 multipart API (no DB temp rows).
- `_activeStreamCount` tracked for graceful-shutdown parity with the DB backend.
- `deleteByPrefix` uses `ListObjectsV2` + `DeleteObjects` (batch 1000) in a loop.
- `bucket` property exposed on both implementations (null for DB backend); `video-serve.routes.ts` uses `storage().bucket !== null` to select the correct memory budget math.

## faststart_locked no-op
`faststart.service.ts` has a direct `UPDATE storage_blobs SET faststart_locked = true WHERE key = ...`. With S3 backend this no-ops (0 rows updated); it logs a warn and continues — intentionally non-fatal.

## Migration script
`scripts/src/migrate-blobs-to-s3.ts` — batch copies BYTEA rows to S3 with `--dry-run`, `--delete-after`, `--batch-size`, `--skip-existing`, `--key-filter` flags. Run after switching to S3 to backfill existing blobs.

## Credentials
The `InvalidAccessKeyId` error observed at first startup means the IAM key stored in Replit secrets (`AWS_ACCESS_KEY_ID`) has been rotated or deleted in AWS IAM. The fix is to update the secret in the Replit Secrets tab with a fresh key that has `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on the `temple-tv-media-storage` bucket.

## `storage_blobs` schema
Intentionally retained for the migration period. Do NOT drop it until all existing blobs are confirmed migrated to S3 and the fallback DB backend is no longer needed.
