---
name: Comprehensive platform audit sprint 59
description: 12 bugs fixed across API, admin panel, and mobile — SQL array casts, TypeScript errors, query invalidations, security guards, and UI consistency.
---

## Rule
Drizzle's `sql` tag expands JS arrays as `($1, $2)` (a PostgreSQL record), not `ARRAY[$1,$2]`. Any `WHERE col = ANY(${array}::text[])` pattern WILL throw `cannot cast type record to text[]` when the array has >1 element. Use `inArray(table.col, array)` instead everywhere.

**Why:** Production logs showed `cannot cast type record to text[]` crashing the storage_blobs integrity check on every queue-validator cycle, silently breaking HLS storage validation for all queue items.

**How to apply:** Search for `ANY(${` in any raw SQL and replace with Drizzle `inArray()`. The table/column must be in the Drizzle schema. When not in schema, use `sql.join(ids.map(id => sql\`${id}\`), sql\`, \`)` inside an `IN (...)` clause.

## Fixed sites (sprint 59)
- `queue-integrity-validator.ts` — forward-pass HLS blob check (2 sites)
- `rest.routes.ts` — repair-hls-storage-missing + boot remediation report (2 sites)
- `cleanup.service.ts` — upload_chunks + upload_sessions delete after transcode (2 sites)

## Admin query invalidation gaps pattern
After any mutation that affects a video's transcoding or source status, invalidate ALL panels that display that status:
- `transcodeMutation`/`faststartMutation` in **videos.tsx** → must also invalidate `broadcast-queue`
- `clearFinishedMutation` in **transcoding.tsx** → must also invalidate `admin-videos`
- `reprobeMutation` in **broadcast-v2.tsx** → must also invalidate `broadcast-v2-remediation-report`
(remediation-report is cached — if a successful reprobe doesn't bust it, "Duration Mismatch" persists as stale alert)

## Self-delete guard
`deleteUserMutation` in **users.tsx** had no guard. An admin deleting themselves gets immediately logged out with 401 on next poll. Fix: check `id === currentUserId` and reject with an error message (same pattern as `updateRoleMutation`'s self-demotion guard).

## Filter → selection consistency
Any click that changes the visible set of rows (status filter, category, search, page change) MUST call `setSelectedIds(new Set())`. The "Show failed" banner button on line 859 was missing this, meaning selections from a different filter context persisted invisibly (cross-context bulk delete hazard). Pattern: every `setStatusFilter`/`setCategoryFilter`/`setSearch` call must be paired with `setSelectedIds(new Set())`.

## Mobile version parity
`artifacts/mobile/package.json` `version` field must stay in sync with `artifacts/mobile/app.json` `version`. After bumping `app.json` (e.g., 1.0.14→1.0.15), also bump `package.json`. Both were at 1.0.15 after this sprint.

## TypeScript: SAFE_CATALOG_COLS map(toDto) cast
`CatalogRows = Array<{ [K in keyof typeof VIDEO_COLS]: unknown }>` uses `unknown` for all values (intentional for the try/catch fallback path). `toDto(v: VideoDtoRow)` can't accept `unknown` values. Fix: `rows.map(v => toDto(v as unknown as VideoDtoRow))` — same pattern already used in the `/:id` route at line 488.
