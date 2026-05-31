---
name: Midnight Prayers table missing at runtime
description: midnight_prayers_config defined in Drizzle schema but never in startup self-heal — causes 42P01 on any production DB provisioned before the feature was merged.
---

## The Bug

`midnight_prayers_config` is declared in `lib/db/src/schema/midnight-prayers.ts` and exported through `lib/db/src/schema/index.ts`.  `drizzle-kit push` creates it on a fresh deploy, but production databases provisioned before the midnight-prayers feature was merged won't have the table if `drizzle-kit push` is not re-run as part of every upgrade deployment.

At startup, `midnightPrayersService.init()` fires inside `buildApp()` (in `app.ts`, near the end) and immediately calls `loadConfig()` which does `db.select().from(schema.midnightPrayersConfig)`. Without the table this throws SQLSTATE **42P01** ("relation does not exist"). The original code caught the error with a plain `logger.warn` and returned, leaving the service with in-memory defaults — but `saveConfig()` and subsequent `loadConfig()` retries still failed because the table never got created.

## The Fix (applied May 2026)

Three layers of protection, all idempotent:

### Layer 1 — `ensureMidnightPrayersTable()` in `db.ts`
New exported function (`artifacts/api-server/src/infrastructure/db.ts`) that runs:
1. `CREATE TABLE IF NOT EXISTS midnight_prayers_config (...)` — exact DDL matching the Drizzle schema
2. `DO $$ … ADD CONSTRAINT midnight_prayers_config_singleton CHECK (id = 1) …` — singleton guard via pg catalog check
3. `INSERT INTO midnight_prayers_config … ON CONFLICT (id) DO NOTHING` — seeds the default row

### Layer 2 — Startup call in `main.ts`
`await ensureMidnightPrayersTable().catch(err => logger.error(...))` is called **after** `ensureUserSchemaColumns()` and **before** `buildApp()`.  This guarantees the table and singleton row exist before `midnightPrayersService.init()` ever runs. Non-fatal: catches any error and logs it without aborting the rest of the server.

### Layer 3 — Defense-in-depth in `midnight-prayers.service.ts`
`loadConfig()` now wraps the query in a `tryLoad()` helper. If the query throws 42P01, it calls `ensureMidnightPrayersTable()` and retries once. This handles races where the startup call wasn't awaited or a missed deployment step left the table absent.

## Why

**Why:** `drizzle-kit push` is a manual/CI step that can be skipped on upgrades. The broadcast v2 tables set the precedent: they have their own `ensureBroadcastV2Tables()` function precisely because that table wasn't guaranteed to exist. Midnight Prayers needs the same pattern.

**How to apply:** Every new Drizzle table that has runtime service code querying it MUST get a corresponding `ensureXxxTable()` function added to `db.ts` and called (awaited) in `main.ts` before `buildApp()`. Don't rely on `drizzle-kit push` alone.

## Verification

Boot log shows the correct sequence:
```
db: midnight_prayers_config table ensured (table + singleton row)
[midnight-prayers] service initialised — 0 videos loaded
```
