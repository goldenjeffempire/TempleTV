---
name: Admin panel comprehensive audit sprint 43
description: 10 bugs fixed across DB schema, backend API, and admin frontend covering analytics orphan sessions, assembly failure cache, broadcast invalidations, and DB constraints.
---

## Bug 1 (HIGH) — analytics.routes.ts: orphaned heartbeat/completed when no deviceId
- When `deviceId` absent and event ≠ "started", server generated `nanoid()` → fresh ID → 0-row UPDATE → session never closed, watchTime never recorded
- Fix: early return 204 for non-"started" events with no deviceId — no session to correlate, wasted DB query avoided
- File: `artifacts/api-server/src/modules/analytics/analytics.routes.ts`

**Why:** Only "started" events create a session row; all subsequent events need the same stable deviceId to find that row. A new random ID can never match.

## Bug 2 (MEDIUM) — chunked-upload.routes.ts: assembly failure missing catalog cache invalidation
- Both Path A and Path B assembly failure handlers marked video "failed" and fired `videos-library-updated` bus event but never called `invalidateVideosCatalogCache()`
- Public catalog cache (Redis/in-memory TTL) kept showing the video as "queued" until it expired (~30s–5min)
- Fix: added `void invalidateVideosCatalogCache()` before `adminEventBus.push` in both Path A (line ~1465) and Path B (line ~1826) failure handlers
- File: `artifacts/api-server/src/modules/media-uploads/chunked-upload.routes.ts`

## Bug 3 (MEDIUM) — analytics.tsx: useLiveViewerCount swallowed all errors silently
- `catch {}` was empty — polling failures left the "Live Now" card showing stale "—" with no visual indication the endpoint was unreachable
- Fix: added `error` state, set `true` on catch; UI shows red dot + "Viewer count unavailable" subtext instead of green animate-pulse when errored
- File: `artifacts/admin/src/pages/analytics.tsx`

## Bug 4 (LOW) — broadcast-v2.tsx: reactivateMutation missing engine-health invalidation
- Reactivating a queue item changes what the "next" item is; `broadcast-v2-engine-health` wasn't refreshed, so the Now/Next header was stale until the next poll cycle
- Fix: added `void qc.invalidateQueries({ queryKey: ["broadcast-v2-engine-health"] })`
- File: `artifacts/admin/src/pages/broadcast-v2.tsx`

## Bug 5 (LOW) — broadcast-v2.tsx: saveScheduleMutation missing diagnostics+engine-health invalidation
- Saving a batch schedule (startsAt assignments) only invalidated `broadcast-queue`, not `broadcast-v2-diagnostics` or `broadcast-v2-engine-health`
- Fix: added both missing invalidations
- File: `artifacts/admin/src/pages/broadcast-v2.tsx`

## Bug 6 (LOW) — settings.tsx: invalidateQueries called without void/await
- `qc.invalidateQueries(...)` returned a Promise that was neither awaited nor voided — floating promise. ESLint/strict TS may flag this in future.
- Fix: added `void` prefix to both `upsertMutation.onSuccess` and `deleteMutation.onSuccess` calls
- File: `artifacts/admin/src/pages/settings.tsx`

## DB Fix 1 (MEDIUM) — lib/db/src/schema/users.ts: missing CHECK constraint on role
- `role` column was plain text with no DB-level constraint; invalid roles could enter via raw SQL or future code paths
- Fix: added `check("users_role_check", sql\`role IN ('system','admin','editor','moderator','user')\`)`
- File: `lib/db/src/schema/users.ts`

## DB Fix 2 (LOW) — lib/db/src/schema/rate-limit.ts: missing index on reset_at
- Cleanup query `DELETE WHERE reset_at < NOW()` did a full table scan without an index
- Fix: added `index("idx_rate_limit_buckets_reset_at").on(table.resetAt)`
- File: `lib/db/src/schema/rate-limit.ts`

## DB Fix 3 (LOW) — lib/db/src/schema/chat.ts: missing partial index on deleted_at IS NULL
- Chat history query `WHERE channel_id = ? AND deleted_at IS NULL ORDER BY created_at DESC` — existing full composite index scanned all rows including deleted ones
- Fix: added partial index `WHERE deleted_at IS NULL` on `(channel_id, created_at.desc())`
- File: `lib/db/src/schema/chat.ts`

## Confirmed-OK (false positives from audit)
- `series.tsx addEpisodeMutation`: picker updates correctly because `series-episodes` IS invalidated — `episodeVideoIds` re-derives from re-fetched data. NOT a bug.
- `broadcast-scheduler.ts`: already has guards against v1/v2 split-brain — v1 scheduler comments explicitly note v2 is primary; watchdog uses v2 engine health, not v1 reload.
- `broadcast.service.ts addToQueue()`: transaction wraps both the `max(sortOrder)` read and INSERT; comments mention row-level lock intent. Already safe.
- `bulkTranscodeMutation`: already shows per-item failure count in warning toast ("X videos could not be queued"). Not a bug.
- Rate limit broadcast-v2 allowList skip: intentionally documented — SSE/WS connections need no rate limit; per-route `config.rateLimit` on health endpoint applies independently.
- `useLiveViewerCount` setInterval: properly cleaned up via `clearInterval` in useEffect cleanup. NOT a leak.
- `auth.ts getCachedSessionsValidAfter` fail-open: documented design choice — availability over security during DB outages. Intentional.
