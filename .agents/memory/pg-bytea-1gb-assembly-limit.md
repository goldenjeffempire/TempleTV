---
name: PostgreSQL BYTEA 1GiB single-value assembly ceiling
description: Hard architectural limit for the pg-bytea-storage upload backend — files near/above 1GB can never assemble, regardless of retries.
---

completeMultipartUpload's `bytea_agg()` step aggregates every uploaded chunk into ONE bytea column value in a single INSERT. PostgreSQL hard-caps any single field value (bytea/text) at 1 GiB - 1 byte (1,073,741,823 bytes) — the varlena/TOAST limit. Any upload at or above that size throws `invalid memory alloc request size ...` (pg error code XX000) and can **never** succeed no matter how many times the assembly retry/backoff ladder runs.

**Why this matters:** the original `MAX_UPLOAD_BYTES` was set to 100 GiB (arbitrary "sanity" ceiling) with no awareness of the storage backend's real 1 GiB ceiling. A ~1.45 GB video upload burned through hours of auto-retry backoff before this was caught — the retry system correctly classified everything as "transient" because the failure didn't match any of the existing `TERMINAL_ASSEMBLY_ERROR_CODES` codes (which were all data-structural: corrupt/no-parts/empty-parts, not size-related).

**How to apply:** `MAX_UPLOAD_BYTES` in `chunked-upload.routes.ts` must stay at or below ~1,000,000,000 bytes while the storage backend assembles into a single bytea column. If the storage backend is ever redesigned to chunk large files across multiple bytea rows (segmented blob storage), this ceiling can be relaxed — but until then, do not raise it. Terminal-error detection (`isUnrecoverableAssemblyError`) also matches on Postgres OOM/allocator message patterns (not just error codes) since this class of failure is message-only, no distinct SQLSTATE.
