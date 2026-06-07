---
name: ensureRuntimeIndexes single-try-catch silent skip
description: ensureRuntimeIndexes had one shared try/catch — a failure on the first index silently skipped all remaining indexes, and fire-and-forget hid the error.
---

## The rule

`ensureRuntimeIndexes()` in `infrastructure/db.ts` must wrap each `CREATE INDEX IF NOT EXISTS` in its own per-index try/catch (via the `run()` helper), and must be **awaited** in `main.ts` (not fire-and-forget).

**Why:** The original single try/catch caused 10 out of 10 indexes (GIN FTS, functional lower(), all partial indexes) to be absent from the production DB.  The fire-and-forget `.catch()` in main.ts also hid any errors from startup logs, so the failure was invisible.

**How to apply:** Any new `CREATE INDEX IF NOT EXISTS` added to `ensureRuntimeIndexes` must be wrapped in `await run("index_name", \`SQL\`)` — never added as a raw `await client.query(...)` inside the shared try block.  The `run()` helper logs per-index success/failure and never throws.

## Symptoms

- FTS search returns zero results (GIN index missing).
- Category/preacher filter queries do full table scans.
- Partial indexes (transcoder, cleanup, dispatcher) missing → degraded query plans.
- The log line `db: functional and partial indexes ensured` appears but indexes are absent (the old code logged this even after a catch-block skip).

## Resolution applied

1. Refactored `ensureRuntimeIndexes()` to use a `run(name, sql)` helper with per-index try/catch.
2. Changed `main.ts` call from fire-and-forget to `await ensureRuntimeIndexes()`.
3. Created the 10 missing indexes manually to restore the dev DB immediately.
4. Fixed stale comment "managed_videos has no updated_at column" — column WAS added June 2026.
5. Tightened stuck-processing cleanup to `updated_at < NOW() - INTERVAL '20 minutes'`.
