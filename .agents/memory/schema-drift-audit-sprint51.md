---
name: Schema drift audit sprint 51
description: 16 schema drift items fixed — missing columns, table, indexes, constraints; dual-DB discovery.
---

## The dual-database problem
`artifacts/api-server/src/config/env.ts` rewrites `process.env.DATABASE_URL` at module load using Replit's managed `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` vars. So the API always connects to `heliumdb` (Replit built-in PostgreSQL), NOT the `neondb` pointed at by the `DATABASE_URL` secret. Bare `node -e` scripts that read `process.env.DATABASE_URL` hit the Neon DB instead.

**Why:** operator may have stored a Neon/Supabase URL in the DATABASE_URL secret; env.ts prefers the Replit-managed vars so the built-in DB is always used in dev.

**How to apply:** when running schema queries for verification always use the PGHOST-constructed URL, not DATABASE_URL raw. Both DBs were patched in this sprint (API's self-heal fixed heliumdb; direct DDL fixed neondb).

## Missing schema items fixed (all IF NOT EXISTS / idempotent)

### Missing columns (crash-level — 42703 at runtime)
1. `transcoding_jobs.last_progress_at` TIMESTAMPTZ — stall watchdog `isNull()` / `lt()` calls crashed the dispatcher loop.
2. `broadcast_runtime_state.bad_url_cache` JSONB — `runtime.repo.ts` saveBadUrlCache / loadBadUrlCache both threw 42703, resetting skip-budget on every restart.
3. `managed_videos.updated_at` TIMESTAMPTZ NOT NULL DEFAULT NOW() — Drizzle `$onUpdate` fires JS-side; column must exist or every ORM `UPDATE` fails.

### Default mismatch (data integrity)
4. `transcoding_jobs.max_attempts` — DB DEFAULT was 3, Drizzle schema says 5. Fixed with `ALTER COLUMN max_attempts SET DEFAULT 5`. Existing rows unchanged (intentional).

### Missing table
5. `memory_hourly_snapshots` — memory watchdog `persistHourlySnapshot()` silently failed every hour. Created via new `ensureMemoryHourlySnapshotsTable()` in db.ts.

### Missing indexes on managed_videos (7)
6. `idx_managed_videos_hls_master_url`
7. `idx_managed_videos_local_video_url`
8. `idx_managed_videos_published_at`
9. `idx_managed_videos_source_transcoding` (composite: video_source, transcoding_status)
10. `idx_managed_videos_faststart_applied`
11. `idx_managed_videos_broadcast_admission` (composite: video_source, transcoding_status, faststart_applied)
12. `idx_managed_videos_uploaded_by`

### Missing partial unique index (data integrity)
13. `uq_broadcast_queue_video_id_active` on `broadcast_queue(video_id) WHERE is_active=true AND video_id IS NOT NULL` — without it the same video can be active in the queue multiple times.

### Missing check constraints (data integrity)
14. `no_youtube_urls_in_queue` on broadcast_queue
15. `chk_broadcast_queue_sort_order_nonneg` on broadcast_queue
16. `managed_videos_transcoding_status_check` on managed_videos

## Where the self-heal code lives
- `artifacts/api-server/src/infrastructure/db.ts`
  - `ensureUserSchemaColumns()` — columns 1-4 above; called with `await` in main.ts before buildApp()
  - `ensureRuntimeIndexes()` — indexes 6-13, constraints 14-16; called fire-and-forget after pool warmup
  - `ensureBroadcastV2Tables()` — column 2 (bad_url_cache via ALTER); called with await
  - `ensureMemoryHourlySnapshotsTable()` — table 5; NEW function, called fire-and-forget in main.ts

## Why drizzle-kit push silently skipped these
Drizzle-kit push has known issues with: nullable column additions on existing large tables, partial/expression indexes, and check constraints on existing tables. The `ensureXxx` belt-and-suspenders pattern in db.ts is the authoritative fix path.
