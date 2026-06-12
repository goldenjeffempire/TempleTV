---
name: Replit DATABASE_URL vs PG* env vars — two different DBs
description: DATABASE_URL points to Neon; PG* vars (PGHOST/PGDATABASE/etc.) point to Replit's heliumdb. The API pool uses PG* vars. psql $DATABASE_URL hits Neon and will miss anything written via the API pool.
---

In this project there are **two separate PostgreSQL clusters**:

| Variable | Host | Database | Used by |
|---|---|---|---|
| `DATABASE_URL` | `ep-wint…` (Neon) | neondb | `drizzle-kit push`, `psql $DATABASE_URL` |
| `PGHOST=helium` / `PGDATABASE=heliumdb` | helium | heliumdb | API pool (`db.ts`), the running API server |

**Why:** Replit auto-manages `PG*` vars that point to its built-in heliumdb instance. `DATABASE_URL` is a separately configured Neon connection string that was set at some point during early development. `replit.md` documents "Built-in `PG*` env vars override `DATABASE_URL` at boot" — meaning the API always uses heliumdb at runtime.

**How to apply:**
- Always validate DB state using `psql "postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}"` (not `psql $DATABASE_URL`) when checking results of server-side operations (indexes, schema columns, runtime data).
- `drizzle-kit push` uses `DATABASE_URL` → applies schema to Neon, which may diverge from heliumdb for columns added ONLY via `ensureUserSchemaColumns`.
- `ensureRuntimeIndexes` and `ensureUserSchemaColumns` in `db.ts` run against heliumdb (the live API DB). Checking `psql $DATABASE_URL` will always show 0 rows for indexes created by the API server.
- The real production guard is the API startup logs: `db: index ensured — <name>` (no ERROR level) means the index exists in heliumdb.
