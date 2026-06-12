---
name: DO-EXECUTE nested dollar-quoting fails silently in pg client
description: DO $$ BEGIN ... EXECUTE $idx$ CREATE INDEX ... $idx$; END $$ runs but the inner CREATE INDEX is silently skipped by the node-postgres (pg) library when dollar-quote tags differ. Use run() with bare CREATE INDEX IF NOT EXISTS instead.
---

**The bug:**
```sql
-- This looks valid PostgreSQL but the pg library silently skips the inner CREATE INDEX:
DO $$ BEGIN
  IF EXISTS (...) THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS my_idx ON ...
    $idx$;
  END IF;
END $$
```

The `pg` library parses the query but treats nested `$idx$...$idx$` dollar-quote blocks inconsistently when wrapped inside `DO $$...$$`. The outer `$$` and inner `$idx$` tags confuse the client-side query parser, resulting in the `DO` block running (no error returned) but the `EXECUTE` statement inside never firing. The `run()` wrapper logs `db: index ensured — <name>` because `client.query()` returns success for the DO block itself.

**The fix:**
```javascript
// Use run() directly with a bare CREATE INDEX IF NOT EXISTS:
await run("my_idx", `
  CREATE INDEX IF NOT EXISTS my_idx
    ON table_name (col)
    WHERE condition
`);
```

If the column referenced in the WHERE clause might not exist on old prod DBs, `run()` already catches the `42703` error and logs it at ERROR level (non-fatal). The next restart (after `ensureUserSchemaColumns` has added the column) will create the index.

**Why:** This pattern is consistent with all other indexes in `ensureRuntimeIndexes`. The `DO $$ IF EXISTS` guard is only needed for ALTER TABLE or FK constraints that would error if a column/constraint already existed — `CREATE INDEX IF NOT EXISTS` is inherently idempotent and doesn't need the IF EXISTS guard.
