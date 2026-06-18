---
name: PostgreSQL BYTEA storage — full S3/MinIO replacement
description: How S3/MinIO was replaced with PostgreSQL BYTEA as the sole storage backend; key schema changes, lockfile gotcha, and migration steps.
---

## The Rule
PostgreSQL BYTEA is now the sole object storage backend. No S3 SDK, no MinIO process. All blob reads/writes go through `PostgresObjectStorage` in `artifacts/api-server/src/infrastructure/storage.ts`.

**Why:** Replit environment — MinIO adds a separate process and AWS SDK adds ~45 packages. PostgreSQL is already the primary DB and handles large BYTEA efficiently with `SUBSTRING(data FROM n FOR len)` for range reads.

## Schema changes applied
- `storage_blobs.data` — added `bytea` nullable column (stores raw bytes for all blobs)
- `storage_upload_parts` — new table for in-progress multipart upload parts (`upload_id`, `part_number`, `data bytea`, composite PK)
- `upload_sessions/upload_chunks.storage_backend` default changed from `"minio"` → `"db"`

## Implementation
- `PostgresObjectStorage` implements all 13 `ObjectStorage` interface methods using SQL
- `getObjectRange` uses `SUBSTRING(data FROM $start FOR $len)` — efficient, no full-row load
- `completeMultipartUpload` loads all parts into Node memory via `Buffer.concat` — peak ~2× file size RSS; acceptable for sermon videos (50–500 MB)
- Range reads from pg: pg decodes BYTEA hex → ~16 MiB V8 heap per 8 MiB segment; keep `HLS_MAX_CONCURRENT ≤ 10`

## Packages removed
- `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` removed from `artifacts/api-server/package.json`

## Lockfile update gotcha
`pnpm install --no-frozen-lockfile` OOMs on Replit (Node heap exhaustion during resolution). **Fix: edit `pnpm-lock.yaml` directly** — find the `artifacts/api-server: dependencies:` section and delete the `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` specifier blocks (4 lines each). Then `pnpm install --frozen-lockfile` works fine.

## How to apply
When adding/removing packages from `artifacts/api-server` on Replit:
1. Edit `package.json`
2. Edit the corresponding specifier block in `pnpm-lock.yaml` under `artifacts/api-server: dependencies:`
3. Run `pnpm install --frozen-lockfile` to verify — should say "Lockfile is up to date"
4. Rebuild: `pnpm --filter @workspace/api-server run build`
