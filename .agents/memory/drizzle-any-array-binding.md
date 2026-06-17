---
name: Drizzle sql-template array binding bug — ANY() fix
description: Drizzle ORM expands JS arrays in sql`...` templates to tuple notation ($1,$2,...) not PostgreSQL array literals; ANY(${arr}::text[]) causes ERROR 42846.
---

## The bug

Drizzle ORM's `PgDialect.sqlToQuery()` expands a plain JS array interpolated inside
`sql\`...\`` into a **tuple literal** `($1, $2, $3)`. Casting a row-constructor to a typed
array — `($1, $2)::text[]` — is rejected by PostgreSQL:

```
ERROR 42846: cannot cast type record to text[]
```

This pattern is **silently valid in development** if queries run with small arrays that
avoid the error, but **fails in production** with multi-item arrays at runtime.

## Affected files (all fixed June 2026)

| File | Line | Pattern |
|------|------|---------|
| `broadcast-v2/engine/hls-startup-integrity.ts` | 172 | `LIKE ANY(${likePatterns}::text[])` |
| `broadcast-v2/engine/hls-startup-integrity.ts` | 192 | `= ANY(${masterKeys}::text[])` |
| `broadcast-v2/engine/hls-startup-integrity.ts` | 279 | `= ANY(${totallyMissing}::text[])` |
| `transcoder/cleanup.service.ts` | 139 | `= ANY(${renditionKeys}::text[])` |
| `transcoder/transcoder.dispatcher.ts` | 548 | `= ANY(${masterKeysToProbe}::text[])` |
| `transcoder/transcoder.dispatcher.ts` | 644 | `= ANY(${healedVideoIds}::text[])` |
| `transcoder/transcoder.dispatcher.ts` | 1291 | `= ANY(${stuckIds}::text[])` |

## Fix patterns

**Pattern 1 — `sql.param()` for raw sql UPDATE/SELECT:**
```typescript
// BROKEN: Drizzle emits ($1,$2)::text[] → ERROR 42846
WHERE id = ANY(${ids}::text[])

// FIXED: sql.param() emits single $N binding; pg driver serialises to {v1,v2,...}
WHERE id = ANY(${sql.param(ids)}::text[])
```

**Pattern 2 — use `presentStorageKeys()` for `= ANY` on storage_blobs.key:**
```typescript
// BROKEN
const result = await db.execute(sql`SELECT key FROM storage_blobs WHERE key = ANY(${keys}::text[])`);

// FIXED (uses Drizzle inArray which generates valid IN ($1,$2,...))
const present = await presentStorageKeys(keys);
```

**Pattern 3 — use `blobCountByVideoIdPrefix()` for `LIKE ANY` prefix counts:**
```typescript
// BROKEN
WHERE key LIKE ANY(${likePatterns}::text[])

// FIXED (uses UNNEST + LEFT JOIN — no ANY() at all)
const counts = await blobCountByVideoIdPrefix(videoIds);
```

## Utility file

`artifacts/api-server/src/infrastructure/sql-array-utils.ts` exports:
- `safeInArray(col, values)` — Drizzle `inArray` with empty-array short-circuit
- `blobCountByVideoIdPrefix(videoIds)` — UNNEST-based blob count per videoId prefix
- `presentStorageKeys(keys, {requireNonZero?})` — batch existence check using `inArray`
- `likeAnyOr(col, patterns)` — OR-chain of `LIKE` expressions (safe LIKE ANY alternative)
- `anyTextParam(values)` — `= ANY(${sql.param(values)}::text[])` fragment for raw sql

## Why `inArray()` is safe but raw `ANY()` is not

Drizzle's `inArray(col, values)` generates standard `IN ($1, $2, ...)` syntax which is
always valid. The bug only affects `ANY()` used inside `sql\`...\`` templates where Drizzle
tries to serialize the array as a parameter value and emits the tuple form.

## All `inArray()` calls in the codebase are properly guarded

Every `inArray(col, dynamicArray)` call was audited. All are inside `if (arr.length > 0)`
guards, so Drizzle's `WHERE false` fallback for empty arrays is never reached in practice.

**How to apply:** Any time you write `ANY(${someArray}::type[])` inside a `sql\`...\``
template, replace with `ANY(${sql.param(someArray)}::type[])` or use the appropriate
helper from `sql-array-utils.ts`.
