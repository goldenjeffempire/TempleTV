---
name: Storage BYTEA streaming refactor
description: How getObject() and completeMultipartUpload() were fixed to prevent OOM on large video files, and the pg_proc pattern for creating the bytea_agg aggregate.
---

## Problem
`getObject()` did `SELECT data FROM storage_blobs WHERE key = $1` — the pg driver hex-decodes BYTEA, so a 1 GB blob produced ~2 GB of transient Node.js allocations → "invalid memory alloc request size" / OOM crash.

`completeMultipartUpload()` did `Buffer.concat(allParts)` — peak RSS ≈ 2× file size during assembly.

## Fix: getObject() — chunked SUBSTRING streaming

Replace single full-query with async generator + `Readable.from()`:

```typescript
const STORAGE_READ_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MiB

async function* readChunks() {
  let offset = 0;
  while (offset < totalSize) {
    const pgOffset = offset + 1; // PostgreSQL SUBSTRING is 1-indexed
    const length = Math.min(chunkSize, totalSize - offset);
    const result = await db.execute<{ chunk: Buffer }>(sql`
      SELECT SUBSTRING(data FROM ${pgOffset} FOR ${length}) AS chunk
      FROM storage_blobs WHERE key = ${capturedKey} LIMIT 1
    `);
    const buf = toBuffer(firstRow(result)?.chunk);
    if (!buf || buf.length === 0) break;
    offset += buf.length;
    yield buf;
  }
}
const body = Readable.from(readChunks(), { objectMode: false });
```

Peak Node.js RSS: one chunk (~24 MiB with pg hex decode). O(1) regardless of blob size.
headObject() is called first to get totalSize — one extra round-trip, acceptable.

## Fix: completeMultipartUpload() — PostgreSQL-side assembly via bytea_agg

```sql
INSERT INTO storage_blobs (key, content_type, size_bytes, data, updated_at)
SELECT $key, $contentType, SUM(octet_length(data)), bytea_agg(data ORDER BY part_number), NOW()
FROM storage_upload_parts WHERE upload_id = $uploadId
ON CONFLICT (key) DO UPDATE SET ...
```

Node.js sends one INSERT…SELECT query, PostgreSQL does the assembly. Peak Node.js RSS: ~0 bytes.
Fallback `_assemblePartsIterative()` exists for when bytea_agg is not yet installed.

## bytea_agg aggregate creation — CRITICAL PG VERSION GOTCHA

`CREATE AGGREGATE IF NOT EXISTS` requires **PostgreSQL 16+**, NOT 9.5 as the docs imply.
Replit runs PG 14/15 → syntax error at "NOT".

**Solution**: Two-step pg_proc existence check (same pattern as series_id index):

```typescript
const aggCheck = await client.query(`
  SELECT 1 FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'bytea_agg' AND n.nspname = 'public'
  LIMIT 1
`).catch(() => ({ rows: [] }));

if (!aggCheck.rows.length) {
  await run("bytea_agg", `
    CREATE AGGREGATE bytea_agg(bytea) (SFUNC = byteacat, STYPE = bytea, INITCOND = '')
  `);
}
```

`byteacat` is a built-in PostgreSQL function (underlying `bytea || bytea`). Works as SFUNC.

## How to apply
- Any future custom aggregate creation: use pg_proc existence check, not IF NOT EXISTS
- Any large BYTEA reads: use SUBSTRING chunked generator, not `SELECT data`
- Any multipart assembly: use bytea_agg INSERT…SELECT, not Buffer.concat
