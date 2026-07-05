---
name: Faststart schema removal — Drizzle query gaps
description: Pattern for fixing "undefined column" Drizzle errors when faststart_applied was removed from the schema but not all query sites were cleaned up.
---

# Faststart schema removal — Drizzle query gaps

## The rule
When `faststart_applied` was removed from the Drizzle `managed_videos` schema, any query that references `videosTable.faststartApplied` or `videos.faststartApplied` in a `.select()`, `.set()`, or SQL template literal will produce invalid SQL at runtime (Drizzle renders `undefined` columns as empty strings → `COALESCE(, false)`), or will throw `TypeError: Cannot convert undefined or null to object` inside Drizzle's `orderSelectedFields`.

## How to apply
- In `.select()` fields: replace `videosTable.faststartApplied` with `sql<boolean | null>\`NULL::boolean\`` (informational; isPlayableForBroadcast treats null as "unknown/legacy")
- In SQL template projections used as expression args (e.g. `buildQuery(faststartExpr)`): replace with `sql<boolean>\`false\``
- In `.set()` writes: remove the field entirely — the column may not exist in the live DB
- In `memory-watchdog.ts` dynamic imports of the deleted `faststart.service.js`: remove the import block entirely

**Why:** `faststart_applied` column is intentionally absent from the Drizzle schema (FastStart pipeline retired). The DB column itself may or may not exist on a given deployment; using raw SQL literals avoids both the Drizzle schema gap and the 42703 undefined-column DB error.

## Files fixed (initial pass — more may remain)
- `artifacts/api-server/src/modules/broadcast-v2/repository/queue.repo.ts` (loadActive buildQuery)
- `artifacts/api-server/src/modules/broadcast/auto-enqueue.service.ts` (enqueueIfMissing + scanLibraryAndEnqueue selects)
- `artifacts/api-server/src/modules/transcoder/video-validation.service.ts` (runVideoValidation select + .set() write + uploadFromTemp helper)
- `artifacts/api-server/src/infrastructure/memory-watchdog.ts` (3 dynamic imports of deleted faststart.service.js)

## Files with remaining references (follow-up task #2 covers these)
- `artifacts/api-server/src/modules/admin-videos/admin-videos.routes.ts`
- `artifacts/api-server/src/modules/broadcast-v2/io/rest.routes.ts`
- `artifacts/api-server/src/modules/broadcast-v2/engine/broadcast-orchestrator.ts`
- `artifacts/api-server/src/infrastructure/db-schema-guard.ts`
