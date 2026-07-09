---
name: Chunked permanent object storage (removed 1 GiB ceiling)
description: How large uploads are stored/read now that storage_blobs no longer holds one giant BYTEA value; what to check when touching storage.ts or blob integrity/cleanup code.
---

`completeMultipartUpload` no longer uses `bytea_agg()` to concatenate all parts into one
`storage_blobs.data` value (PostgreSQL hard-caps a single value at ~1 GiB — genuinely
unrecoverable at that size, not a transient failure). It now promotes `storage_upload_parts`
rows into a permanent `storage_blob_chunks` table (`blob_key, chunk_index, data, size_bytes`)
via a row-wise `INSERT...SELECT` — no aggregation, so no single value ever exceeds one part's
size. `storage_blobs` gained `chunked` (boolean) + `chunk_count` (int); a chunked row's `data`
column is legitimately `NULL` — that is its normal, healthy shape, not corruption.

**Why:** removes the structural ~1 GiB upload ceiling while keeping the existing
advisory-lock + `SET LOCAL statement_timeout=0` transaction pattern, and keeps small blobs
(HLS segments, thumbnails) on the simple single-`data`-column path unchanged.

**How to apply:**
- Any query that flags "corrupt blob" on `data IS NULL` must also check `chunked IS NOT TRUE`
  — otherwise every healthy large upload gets flagged and deleted by the integrity monitor.
- Any `DELETE FROM storage_blobs WHERE ...` must be paired with a matching
  `DELETE FROM storage_blob_chunks WHERE blob_key IN (...)` first, or you orphan chunk rows.
- Reads (`getObject`/`getObjectRange`) stream one chunk row at a time in `chunk_index` order —
  bounded Node.js memory regardless of total object size; range reads fetch chunk
  metadata (index+size only) first to compute offsets before fetching only the overlapping rows.
- SHA-256 verification for chunked blobs is computed incrementally inside the same transaction
  (stream chunks in order, update a running hash) — still O(chunk size) memory, not O(file size).
- `MAX_UPLOAD_BYTES` (chunked-upload.routes.ts) and the mirrored admin client check are now a
  5 TB operational sanity ceiling, not a storage-format limit; `totalChunks` Zod max raised to
  5,000,000 to match.
