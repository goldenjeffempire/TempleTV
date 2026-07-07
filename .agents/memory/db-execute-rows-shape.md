---
name: db.execute() node-postgres rows shape
description: db.execute() returns { rows: T[] } not T[] — always unwrap via firstRow/allRows helpers.
---

## The rule

`db.execute<T>(sql\`...\`)` on the node-postgres driver returns `{ rows: T[] }`, not a plain `T[]`. Accessing index 0 directly (`result[0]`) silently returns `undefined`, producing all-zero counts or missing fields.

**Always use the helpers in `artifacts/api-server/src/infrastructure/storage.ts`:**
```ts
function firstRow<T>(result: unknown): T | undefined
function allRows<T>(result: unknown): T[]
```
These handle both `{ rows: T[] }` (node-postgres) and plain `T[]` (fallback) transparently.

**Why:** Drizzle's `db.execute()` type signature says it returns something iterable, but the runtime value from node-postgres is `{ rows, rowCount, command, ... }` — not an array. This was the root cause of the launch-readiness CTE returning `totalVideos: 0` even though the DB had 962 rows.

**How to apply:** Any time you add a new `db.execute(sql\`...\`)` call and need the first or all rows, import and use `firstRow<T>` / `allRows<T>` from `../../infrastructure/storage.js`. Never use `result[0]` directly.
