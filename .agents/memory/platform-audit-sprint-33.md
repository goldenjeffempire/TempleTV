---
name: Platform audit sprint 33 — TOCTOU + schema + admin hardening
description: Key patterns and decisions from the comprehensive audit that fixed the watch-history TOCTOU race, added $onUpdate to 8 schema tables, and hardened the admin frontend.
---

## Per-user rate limiting + row-count caps on write endpoints

`POST /user/history` and `POST /user/favorites` were rate-limited per-IP only. A compromised account could flood the table at 120/min (history) from its own IP without affecting other accounts' buckets — and could also pollute IP buckets shared by many users behind NAT.

**Fix:**
- Added `jwtUserKey(req)` helper that decodes the JWT payload (no signature verification — safe for bucketing only) to extract the `sub` claim and returns `user:<sub>`. Falls back to `req.ip` for unauthenticated requests.
- Applied `keyGenerator: jwtUserKey` to both POST write endpoints so each user has their own rate-limit bucket.
- Lowered `POST /history` from 120/min → 30/min per user (normal usage is ~2/min per device; 30/min covers 4 simultaneous devices).
- Added per-user **row-count caps** enforced at the API layer:
  - `MAX_FAVORITES_PER_USER = 2_000` — `COUNT(*)` before upsert; 429 if at ceiling
  - `MAX_HISTORY_PER_USER = 10_000` — same pattern
- Added `count` to the drizzle-orm import in user.routes.ts.

**Why:** Rate limiting per-IP is correct for anonymous traffic but wrong for authenticated writes — it conflates all users behind a NAT into one bucket and lets a single account hammer the DB from one IP without disturbing other accounts' buckets. For write endpoints scoped to a user's own data, always key by user-ID.

## Watch-history TOCTOU fix

The `POST /user/history` route had a classic SELECT-then-INSERT/UPDATE race. Two concurrent watch-progress syncs (mobile + TV watching the same user) could both pass the "does it exist?" check and both attempt an INSERT, causing a unique-constraint violation in one.

**Fix:** Changed `user_watch_history_user_video_idx` from `index()` to `uniqueIndex()` on `(userId, videoId)`, then replaced the SELECT + INSERT/UPDATE two-step with a single `onConflictDoUpdate` targeting that unique index. Pushed schema change with `pnpm --filter @workspace/db run push`.

**Why:** Same pattern already used for favorites (see user.routes.ts). Always prefer a single UPSERT statement over a two-step read-then-write for any table that could see concurrent writes from multiple client surfaces.

## $onUpdate on updatedAt columns

8 tables were missing `.$onUpdate(() => new Date())` on their `updatedAt` column — meaning Drizzle ORM update() calls would silently leave `updated_at` at its INSERT-time value.

Fixed tables: `users`, `channels`, `series`, `storage_blobs`, `app_config`, `live_ingest_endpoints`, `midnight_prayers_config`, `cache_entries`.

Already had it: `playlists`, `upload_sessions` ($onUpdateFn), `broadcast_runtime_state` ($onUpdateFn), `player_position_checkpoint` ($onUpdateFn).

**Why:** `$onUpdate` is a Drizzle ORM-only hook (no DB trigger), so the DB schema doesn't change — no push required for this part. It only fires on Drizzle `.update()` calls, not raw SQL.

## Admin frontend hardening

- `SortableQueueItem` in broadcast-v2.tsx wrapped in `React.memo` — without this the entire queue list re-rendered every second on the 1-second health tick, regardless of whether queue items actually changed. Added `memo` to the react import.
- `safeRandomUUID()` helper added to broadcast-v2.tsx — falls back to Math.random hex UUID when `crypto.randomUUID` is unavailable (non-HTTPS context). All `idempotencyKey: crypto.randomUUID()` calls in that file replaced with `safeRandomUUID()`.
- `handleLogout` in header.tsx wrapped in try/catch — previously `void handleLogout()` could surface an unhandled rejection if the logout API call failed; the local cache is already cleared before the await so the user is signed out even on network error.
- Password-toggle button in login.tsx had `tabIndex={-1}` making it unreachable by keyboard — removed the attribute (defaults to 0, naturally focusable).
