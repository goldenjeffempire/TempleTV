---
name: YouTube sync hardening
description: Three production bugs in the YouTube sync pipeline and the infrastructure patterns used to fix them.
---

## 1. drizzle-kit push silently skips columns

`drizzle-kit push` reports "Changes applied" even when it makes 0 changes on some Replit DB connections. Confirmed: `transcoding_error_code` was in the Drizzle schema for weeks but never appeared in the live DB. The only reliable fix is to add every new column to `ensureUserSchemaColumns()` in `db.ts` using `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.

**Why:** The push command resolves against the connected DB but doesn't error out when it can't apply. The startup migration in `ensureUserSchemaColumns()` is the source of truth for production column presence.

**How to apply:** Any time a column is added to an existing Drizzle table, add the matching `ADD COLUMN IF NOT EXISTS` to `ensureUserSchemaColumns()` in the same PR. Never rely solely on `drizzle-kit push`.

---

## 2. Orphaned "running" sync log entries → recoverStaleSyncLogs()

When the API process is killed mid-sync (SIGKILL, OOM, container restart), the `finally { _syncInProgress = false }` block cannot run. The `youtube_sync_log` row stays at `status='running'` forever — admin UI shows perpetual "sync in progress".

**Fix:** `recoverStaleSyncLogs()` in `db.ts`, called fire-and-forget at startup after `resetStuckProcessingVideos()`. Updates rows matching `status='running' AND started_at < NOW() - INTERVAL '5 minutes'` to `status='interrupted'`. Table is plain-text `status` column so any value is valid.

**Why 5 min threshold:** Production syncs complete in <1 min. Any "running" row older than 5 min at startup is definitively dead.

---

## 3. isTransientDbError string-matching was unreliable

The old function matched `msg.includes("connection")` which would false-positive on column names or FK messages containing those words. Replaced by `isTransientPgError()` in `db-schema-guard.ts` which walks the Drizzle → pg error chain and matches SQLSTATE codes:

- `08xxx` — connection exceptions
- `40001` — serialization failure
- `40P01` — deadlock detected
- `57014` — query canceled (lock/statement timeout)
- `53xxx` — insufficient resources (including `53300` too_many_connections)

Falls back to ECONNRESET/ECONNREFUSED message matching only when no SQLSTATE is present (pre-connection Node.js errors).

---

## 4. Full pg error extraction

`extractPgError(err)` in `db-schema-guard.ts` walks the `err.cause` chain (Drizzle wraps pg errors in `_DrizzleQueryError`) and returns `{ sqlstate, constraint, column, table, detail, hint, message }`. Log all batch/row failures with `pgErr: extractPgError(err), err` — the `pgErr` field gives fast-lookup structured fields; `err` gives the full stack trace via pino serialization. Never truncate errors in log calls.
