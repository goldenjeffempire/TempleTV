---
name: Upload pipeline 500s under concurrent load
description: All DB queries in chunk/finalize handlers must be try/caught; classifyRawError must cover pg pool patterns
---

## Rule
Every bare `await db.*` in the chunk handler and finalize handler must be wrapped in try/catch returning 503 (not let unhandled → 500). The video INSERT failure must use statusCode 503, not 500. The error handler's classifyRawError must recognize all pg pool/connection error messages as 503.

## Why
3 concurrent large file uploads (895 MB + 893 MB + 363 MB) exhaust the pg connection pool while bytea_agg assembly holds connections for minutes. RSS climbs to 466 MB+. All bare `await db.select/update` calls in the request path then throw raw pg errors with no statusCode. The error handler defaulted these to status=500 → "Internal server error" on the client.

The admin upload queue retries on 503 automatically, so changing 500→503 makes uploads self-healing without operator intervention.

## How to apply
**Chunk handler** (highest frequency — 12 concurrent ops at peak 3-file upload):
- Session SELECT (`await db.select().from(sessions)...`) → try/catch → reply.code(503)
- Idempotency SELECT (`await db.select().from(chunks)...`) → try/catch → reply.code(503)

**Finalize handler** (4 critical DB ops, each must be guarded):
- Session SELECT at entry → try/catch → throw 503
- CAS lock UPDATE (status→assembling) → try/catch → throw 503
- allChunks SELECT → try/catch → resetLock() + throw 503
- Video INSERT failure → statusCode: 503 (not 500 — it's a retry-able transient failure)

**Init handler**:
- `throw insertErr` after session INSERT failure → wrap in Object.assign(new Error("..."), { statusCode: 503 })

**Error handler classifyRawError** (error-handler.ts):
- "Connection terminated" → ServiceUnavailableError (503)
- "timeout exceeded" / "acquire Client timeout" / "PoolError" → 503
- "sorry, too many clients" → 503
- "not queryable" / "Client was closed" → 503
- ECONNRESET → 503 (unchanged)
- Must import ServiceUnavailableError (was only importing InternalError)

## Key insight
The explicit `{ statusCode: 500 }` on the video INSERT failure was the most confusing bug — it was deliberately set to 500 with a message "The upload is safe — retry finalization." A 500 tells the client "you broke something"; 503 tells it "infrastructure is busy, retry." The upload queue only auto-retries on 503.
