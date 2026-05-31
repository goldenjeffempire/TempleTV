---
name: Upload → Library → Queue real-time sync hardening
description: 8 bugs in the upload-finalize → video library → broadcast queue real-time sync pipeline and how they were fixed.
---

## Bugs fixed

### 1. `onComplete` missing `broadcast-queue` invalidation
**File:** `artifacts/admin/src/pages/videos.tsx`  
`uploadQueue.onComplete()` only invalidated `["admin-videos"]` and `["admin-stats"]`. If the SSE `broadcast-queue-updated` event was missed (connection drop between finalize and event delivery), the broadcast queue UI never refreshed after an upload.  
**Fix:** Add `qc.invalidateQueries({ queryKey: ["broadcast-queue"] })` to the callback.

### 2. `broadcast-queue-updated` only fired when `enqueued: true` (Path A + B)
**File:** `artifacts/api-server/src/modules/media-uploads/chunked-upload.routes.ts`  
If a video was already in the queue (e.g., prod-sync pre-populated it), `enqueueIfMissing` returned `enqueued: false` and the event was never emitted. Also: if `enqueueIfMissing` threw, no event was emitted at all.  
**Fix:** Emit `broadcast-queue-updated` unconditionally after `enqueueIfMissing` succeeds **and** emit it (with a `*-enqueue-failed` reason) even when it throws. Applied to both Path A (db mode) and Path B (db_fallback mode).

### 3. Missing unique partial index on `object_path`
**Files:** `lib/db/src/schema/videos.ts` + `artifacts/api-server/src/infrastructure/db.ts`  
No uniqueness constraint on `object_path` — uploading the same file twice created two separate `managed_videos` rows.  
**Fix:** Added `uniqueIndex("uq_managed_videos_object_path").on(table.objectPath).where(sql\`"object_path" IS NOT NULL\`)` to the Drizzle schema, AND a startup guard `CREATE UNIQUE INDEX IF NOT EXISTS uq_managed_videos_object_path ... WHERE object_path IS NOT NULL` in `db.ts` so existing prod databases get the constraint on next boot without a manual migration.

### 4. `transcoding-update` handler missing `broadcast-queue` invalidation
**File:** `artifacts/admin/src/pages/videos.tsx`  
When HLS transcoding completed, the `transcoding-update` SSE handler only invalidated `["admin-videos"]`. But the broadcast_queue row gains a `hlsMasterUrl` on transcode completion — the queue panel needs to refresh too.  
**Fix:** Add `broadcast-queue` invalidation to the `transcoding-update` handler.

### 5. `api-client-react` mutations used wrong cache key prefix
**File:** `lib/api-client-react/src/index.ts`  
`useImportVideo`, `useUpdateAdminVideo`, `useDeleteAdminVideo` all invalidated `["admin","videos"]` but the admin SPA uses `["admin-videos",...]`. Any future consumer using the shared hooks alongside the SPA's own queries would see stale data.  
**Fix:** Mutations now invalidate both `["admin","videos"]` AND `["admin-videos"]` via `Promise.all`.

### 6. `adminEventBus` max listener ceiling too low
**File:** `artifacts/api-server/src/modules/admin-ops/admin-event-bus.ts`  
Ceiling was 200 — could be hit in large orgs with many simultaneous admin browser tabs, causing new tabs to stop receiving real-time events silently.  
**Fix:** Raised to 500.

## Why the "always emit" pattern matters
The admin UI has two paths to learn about queue changes:
1. SSE `broadcast-queue-updated` event (real-time, requires live SSE connection)
2. `uploadQueue.onComplete()` callback + `broadcast-queue` cache invalidation (belt-and-suspenders, always fires)

Both must work independently so a dropped SSE connection never leaves the UI stale.

## Key pattern for future indexes
When adding a Drizzle schema index that Drizzle Kit might not support (partial, expression, or CONCURRENT), **always add a corresponding `CREATE INDEX IF NOT EXISTS` in `db.ts`**. The startup guard is idempotent and ensures the index exists on all environments (dev, prod, newly provisioned) without manual migrations.
