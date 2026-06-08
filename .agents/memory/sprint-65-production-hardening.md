---
name: Sprint 65 production hardening
description: 8 fixes across API schema safety, DB integrity, memory bounding, input validation, and admin UI correctness.
---

## Fixes applied

### 1. Missing 429 response schemas
- `media.routes.ts` — added `429: z.object({ error: z.string() })` to all 5 rate-limited routes (POST /:id/views, POST /, PATCH /:id, DELETE /:id, POST /uploads/signed-url). Also added proper `200` response to DELETE /:id (was missing entirely).
- `admin.routes.ts` — added `429` to GET /stats, GET /analytics/concurrent, GET /analytics/platform-trends, DELETE /users/:id, POST /users/:id/ban, PATCH /users/:id/role. Also added `bodyLimit: 1 * 1024 * 1024` to all three mutation routes (DELETE, POST, PATCH).
- `broadcast-v2/io/rest.routes.ts` — added `bodyLimit: 1048576` to all 12 POST routes (skip, override/start, override/stop, force-failover, clear-failover, reload, report-stall, checkpoint, play-now, clear-bad-urls, natural-end, prepare-hls, repair-hls-storage-missing, sync-library).

### 2. /rehydrate unsafe query cast fixed
- Replaced `req.query as { fromSequence?: string }` with `z.object({ fromSequence: z.coerce.number().int().nonnegative().default(0) }).safeParse(req.query)`. Added `import { z } from "zod/v4"` to rest.routes.ts. Schema const `_rehydrateQS` defined at module scope (once, not per-request).

### 3. FK: broadcast_queue.video_id → managed_videos(id) ON DELETE SET NULL
- Cannot use Drizzle schema DSL cross-file references (drizzle-kit CJS bundler fails MODULE_NOT_FOUND for `.js → .ts` remapping).
- Applied via `ensureRuntimeIndexes()` in `db.ts` using the existing DO-block idempotency pattern. Constraint name: `fk_broadcast_queue_video_id`.
- **Why:** When a video is hard-deleted, queue rows are automatically set to `video_id = NULL`. The queue-integrity validator deactivates null-video_id rows on the next cycle. Without this, orphaned queue entries could keep trying to play a deleted video forever.

### 4. badUrlSkipCounts Map cap
- `queue.repo.ts` `incrementBadUrlSkipCount()`: when map > 500, prune entries whose `itemId` is no longer in the bad-URL cache (expired TTL). Mirrors the lazy-GC pattern already in `markBadUrl()`.

### 5. prod-queue-sync Maps cap
- Added `MAX_TRACKED_ITEMS = 2_000` constant.
- After updating `lastSeenAtMs` per cycle, if map > MAX_TRACKED_ITEMS, sort by oldest seenAt and evict the tail. Both `lastSeenAtMs` and `prevItemPollState` are pruned together (same keys).

### 6. Admin self-ban guard
- `users.tsx` `banChatMutation.mutationFn`: added `if (id === currentUserId) Promise.reject(...)` guard. Mirrors the existing `deleteUserMutation` self-delete guard. Note: `currentUserId` is declared after the `useMutation` call in the component body — this works correctly because `mutationFn` is only invoked on user action (after full render), not during render.

### 7. Bonus: broadcast-orchestrator silent anchor persist missing fields
- `broadcast-orchestrator.ts` line ~1163: `runtimeRepo.save()` was missing `failoverActive` and `failoverReason` (added in sprint 63 schema). Added both fields from `this.failover.active` / `this.failover.reason`. This was a pre-existing TS2345 error surfaced by the typecheck run.

## Key patterns established
- Drizzle schema DSL FK cross-file references fail with drizzle-kit v0.31.9 CJS bundler — always use `ensureRuntimeIndexes()` DO-block pattern for cross-table constraints.
- `z.literal(true)` in Zod response schemas fails TS when service returns typed as `boolean` — use `z.boolean()` instead.
- Module-scope Zod schema constants (outside the route registration function) are fine and slightly more efficient than inline objects.
