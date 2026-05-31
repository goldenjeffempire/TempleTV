---
name: Comprehensive platform audit — sprint 25
description: 5 confirmed bugs fixed across API config, YouTube sync, DB schema, and mobile hooks. Extensive false-positive triaging documented.
---

## Bugs Fixed

### 1. Memory watchdog env defaults inverted (CRITICAL)
- `MEMORY_WARN_RSS_MB` defaulted to **1500**, `MEMORY_RESTART_RSS_MB` to **600**.
- Since RESTART < WARN, server restarted at 600 MB before the warning (at 1500 MB) ever fired, defeating the early-warning purpose.
- Fixed: defaults now WARN=380, RESTART=490 (matching the inline comments).
- File: `artifacts/api-server/src/config/env.ts` lines 149–150.

### 2. YouTube RSS fallback overwrites valid duration with "" (HIGH)
- Both `upsertBatch` paths (primary + metadata_locked fallback) used `duration: sql\`excluded.duration\`` unconditionally.
- RSS fallback always produces `durationSecs=0 → duration=""` because RSS has no duration data.
- An API failure followed by RSS sync would reset all video durations to empty string until the next full API sync.
- Fixed: both SET clauses now use `CASE WHEN excluded.duration = '' THEN managed_videos.duration ELSE excluded.duration END`.
- File: `artifacts/api-server/src/modules/youtube-sync/youtube-sync.service.ts` lines ~690–725.

### 3. Missing FK index on refresh_tokens.replaced_by_id (HIGH)
- Token rotation lineage queries (e.g., finding the replacement chain) would full-scan the table.
- Fixed: added `replacedByIdx: index("refresh_tokens_replaced_by_id_idx").on(t.replacedById)`.
- File: `lib/db/src/schema/refresh-tokens.ts`.
- DB pushed and applied.

### 4. YouTube quota only persisted at sync end (HIGH)
- `persistQuota()` was only called at lines 962 and 1083 (end of sync or on error).
- A crash mid-sync lost all quota consumption for that run, risking silent over-quota usage.
- Fixed: `void persistQuota()` now called after each successful 25-row chunk in `IngestionQueue.flush()`.
- File: `youtube-sync.service.ts` ~line 806.

### 5. usePlaylists uses raw fetch without retry (MEDIUM)
- Both `usePlaylists` and `usePlaylistDetail` used plain `fetch()` without retry.
- On weak mobile connections, a single timeout would put the UI in permanent error state.
- Fixed: replaced with `fetchWithRetry` (existing mobile utility), bumped timeout to 15s.
- File: `artifacts/mobile/hooks/usePlaylists.ts`.

## False Positives Confirmed (Documented to Prevent Re-audit)
- **Heap-snapshot/GC routes**: All have `preHandler: requireAuth("editor"|"admin")` — guarded.
- **Admin UI innerHTML**: Every field uses `esc()` helper before insertion — no XSS surface.
- **playlist_videos.video_id index**: Already present as `videoIdx` at line 33 — not missing.
- **db_fallback finalization race**: Protected by the same atomic CAS lock (UPDATE…RETURNING) as the main path.
- **StateSyncService `void this.fetchSnapshot()`**: `fetchSnapshot` has its own internal try/catch — safe pattern.
- **TV D-pad useTVNav stale closure**: Proper `useEffect` dependency array with cleanup — correct React pattern.
- **Cleanup service infinite retry**: Intentional 24h retry-after-reset for operator self-healing.
- **lower(email) unique index**: Already exists in `infrastructure/db.ts` via `CREATE INDEX IF NOT EXISTS idx_users_email_lower`.
- **CORS wildcard default**: Has production guard — throws if `*` + `NODE_ENV=production`.

**Why:** These findings came from explorers that can see patterns but not always the full surrounding context. Recording false positives avoids re-investigating them in future audits.
