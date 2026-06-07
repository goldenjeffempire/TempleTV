---
name: Comprehensive platform audit sprint 58
description: 7 bugs fixed across DB indexes, video delete orphan cleanup, admin UI invalidation, YouTube sync performance, SSE events, WorkerSupervisor, and mobile version bump.
---

## Fixes applied

### 1. Missing DB indexes (Critical — full-table scan every 2 min)
- `idx_managed_videos_youtube_live_status` — live-status.service.ts sweeps `WHERE youtube_live_status = 'live'` every 2 min; without index = full table scan at scale.
- `idx_managed_videos_metadata_locked` — YouTube sync `WHERE metadata_locked IS NULL OR metadata_locked = false`; same full-scan risk.
- Added to `lib/db/src/schema/videos.ts`, applied via `pnpm --filter @workspace/db run push`.

**Why:** Both columns were read in tight background loops but had no index; this is an O(N) → O(log N) fix for growing libraries.

### 2. playlist_videos orphan rows on video delete
- `DELETE /admin/videos/:id` cleaned up: broadcast_queue, transcoding_jobs, series_episodes — but NOT `playlist_videos`.
- Fixed in `admin-videos.routes.ts` step 7: delete playlist_videos rows where videoId = deleted id, inside the fire-and-forget cleanup IIFE.
- **Why:** playlist_videos.videoId has no FK cascade; ghost rows surface as 404s in the playlist player.

### 3. reorderMutation missing V2 state invalidation
- `broadcast.tsx` `reorderMutation` onSuccess only invalidated `["broadcast-queue"]`; added `["broadcast-v2-state"]` and `["broadcast-v2-source-health"]` to both onSuccess and onError handlers.
- **Why:** After reorder, the v2 health panel and source panel showed stale data until a manual refresh.

### 4. recategorizeAllVideos N+1 → batch UPDATE
- `youtube-sync.service.ts` was doing one `db.update()` per changed video in a loop (up to 100 per batch).
- Fixed with a single `UPDATE managed_videos AS mv SET category = v.category FROM (VALUES ...) AS v(id, category) WHERE mv.id = v.id` using `sql.join()`.
- **Why:** O(N) DB round-trips replaced with 1 per page; safe because the DB check constraint handles bad values.

### 5. WorkerSupervisor.remove() method added
- `worker-supervisor.ts` had spawn/stopAll but no per-worker remove — Map would grow if workers were dynamically named.
- Added `remove(name): boolean` that stops and deletes the named worker.

### 6. stream-health-degraded/recovered missing from SSE KNOWN_EVENTS
- `viewer-slope-monitor.ts` emits these events; both were missing from the `KNOWN_EVENTS` array in `sse-context.tsx` (silently dropped — never fired to subscribers).
- Added both to KNOWN_EVENTS and added summarize() cases for human-readable activity log entries.

### 7. Mobile version bump
- `artifacts/mobile/app.json`: version 1.0.14 → 1.0.15, android.versionCode 51 → 52, ios.buildNumber 202606070001 → 202606070002.

## Key pattern: bare node DB check hits wrong DB
`node -e "require('pg')"` uses raw `DATABASE_URL` env var. The API rewrites it from PGHOST at startup (env.ts). Always use `psql -h $PGHOST -U $PGUSER -d $PGDATABASE` to verify indexes/schema on the live API database.
