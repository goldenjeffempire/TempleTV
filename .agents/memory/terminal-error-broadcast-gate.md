---
name: Terminal error code gate for broadcast admission
description: Both repairMissingS3MirroredAt and isPlayableForBroadcast must exclude permanently-broken uploads; SQL NULL trap in NOT IN on nullable column.
---

## Rule
`isPlayableForBroadcast()` and `repairMissingS3MirroredAt()` must both exclude videos with terminal error codes (`ASSEMBLY_FAILED`, `CORRUPT_SOURCE`, `SOURCE_MISSING`). Without this, a video whose assembly failed but whose blob somehow exists (orphaned byte assembly, watchdog timing edge) could get its `s3MirroredAt` stamped and be admitted to the broadcast queue, causing dead air at the source-resolver layer.

## Critical SQL NULL trap
`transcodingErrorCode` is a nullable column. The naive form:

```typescript
not(inArray(videosTable.transcodingErrorCode, [...TERMINAL_ERROR_CODES]))
```

generates SQL `transcoding_error_code NOT IN (...)` which evaluates to **NULL** (not TRUE) when the column is NULL. The `WHERE` clause drops all NULL rows — excluding every valid upload with no error code.

**Correct form** in `repairMissingS3MirroredAt`:
```typescript
or(
  isNull(videosTable.transcodingErrorCode),
  not(inArray(videosTable.transcodingErrorCode, [...TERMINAL_ERROR_CODES])),
),
```

**Correct form** in `isPlayableForBroadcast` (non-SQL, plain JS):
```typescript
if (
  row.transcodingErrorCode &&
  (TERMINAL_ERROR_CODES as ReadonlyArray<string>).includes(row.transcodingErrorCode)
) return false;
```

The `&&` short-circuit handles the NULL/undefined case safely here since JS `null && ...` is falsy.

## Where
- `artifacts/api-server/src/modules/broadcast/auto-enqueue.service.ts`
- `TERMINAL_ERROR_CODES` constant defined at top of file before first use
- Same file: `repairMissingS3MirroredAt()` candidates query + `isPlayableForBroadcast()` early return

**Why:** The docstring for `repairMissingS3MirroredAt` claimed terminal codes were excluded, but the WHERE clause didn't implement it. This was a latent bug: only triggered in the edge case where an assembly-failed video had an orphaned blob in `storage_blobs`.
