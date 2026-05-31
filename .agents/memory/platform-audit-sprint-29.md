---
name: Comprehensive platform audit — sprint 29
description: 6 bugs fixed across API security (media-proxy PII), admin frontend performance (bulk transcode hammering, SortableRow memo, CopyButton timer), and DB indexes (refresh_tokens composite, managed_videos uploaded_by). Extensive false-positive documentation.
---

## Bugs Fixed

### 1. Media-proxy logs full URL with tokens on error (SECURITY — HIGH)
**File:** `artifacts/api-server/src/modules/media-proxy/media-proxy.routes.ts` lines 171, 182  
**Bug:** On upstream fetch failure and non-2xx response, the logger wrote `{ url: targetUrl }` — the full URL including any signed tokens or credentials in query-string parameters.  
**Fix:** Both log sites now emit only `{ targetHost }` (extracted earlier during SSRF allowlist check), matching the safe pattern already used by the redirect-rejection log.  
**Why:** Media proxy URLs can carry signed AWS S3 / CDN tokens in query params. These must never appear in structured logs.

### 2. Bulk transcode fires 100+ concurrent requests (PERFORMANCE — HIGH)
**File:** `artifacts/admin/src/pages/videos.tsx` `bulkTranscodeMutation`  
**Bug:** `Promise.all(ids.map(...))` fired one API request per selected video simultaneously. With 100+ selected videos this saturated the browser's 6-connection-per-origin limit, caused request queuing stalls, and could trigger rate-limiting on the server.  
**Fix:** Requests now processed in sequential batches of 5: `for (let i = 0; i < ids.length; i += BATCH_SIZE=5)` with `Promise.all` over the chunk only.  
**Why:** The browser HTTP/1.1 connection limit per origin is 6. 5 concurrent = headroom for SSE keepalive.

### 3. SortableRow missing React.memo (PERFORMANCE — MEDIUM)
**File:** `artifacts/admin/src/pages/broadcast.tsx` `SortableRow`  
**Bug:** `SortableRow` was a plain function component. Any parent state change (`isSyncing`, `playNowMutation.isPending`, query refetch) triggered re-renders of ALL queue rows simultaneously, even those whose props didn't change.  
**Fix:** Wrapped with `React.memo(function SortableRow(...) { ... })`.  
**Why:** With 100+ items in the queue during a live broadcast, every mutation state toggle caused 100+ React reconciliations. The memo wrapper cuts this to only the rows whose props actually changed.

### 4. CopyButton setTimeout fires on unmounted component (LOW)
**File:** `artifacts/admin/src/pages/live-ingest.tsx` `CopyButton`  
**Bug:** `setTimeout(() => setCopied(false), 1500)` had no cleanup — if the component unmounted before 1500ms, setState fired on a dead component.  
**Fix:** Added `timerRef` + `useEffect(() => () => clearTimeout(timerRef.current), [])`. Also cancels previous timer if button is clicked twice rapidly.  
**Why:** React 18 makes this a no-op (not a crash), but it's still a resource waste and dev-tools warning.

### 5. Missing composite index on refresh_tokens(user_id, revoked_at) (DB — MEDIUM)
**File:** `lib/db/src/schema/refresh-tokens.ts`  
**Bug:** The `changePassword` and `logout-everywhere` paths run `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = ? AND revoked_at IS NULL`. Without a composite index, Postgres full-scans all tokens for the user before filtering by `revoked_at IS NULL`.  
**Fix:** Added `index("refresh_tokens_user_id_revoked_at_idx").on(t.userId, t.revokedAt)`.  
**Why:** A user with many sessions (long-lived refresh tokens across multiple devices) would cause a slow UPDATE on password change. The existing `userIdx` on `user_id` alone doesn't cover the `revoked_at IS NULL` filter.

### 6. Missing index on managed_videos(uploaded_by) (DB — MEDIUM)
**File:** `lib/db/src/schema/videos.ts`  
**Bug:** The `uploaded_by` column (which tracks which admin user uploaded a file) had no index. Admin filtering/audit queries that join or filter on `uploaded_by` full-scan the table.  
**Fix:** Added `index("idx_managed_videos_uploaded_by").on(table.uploadedBy)`.

---

## Confirmed OK (False Positives)

- **`useSSEEvent` cleanup** — `useEffect(() => subscribe(...), [deps])` correctly returns the cleanup function from the arrow function's implicit return. Not a leak.
- **`/realtime/ws` unauthenticated** — intentional; serves public TV/mobile viewer clients who need broadcast state without admin auth. Data exposed is fully public broadcast info.
- **`/natural-end` unauthenticated** — intentional by design (documented in route comment). Item-ID check + idempotency prevents abuse; rate-limited 20/min.
- **media-proxy redirect log** — already safe, logs only `locHost` not full Location URL (line 162).
- **`sql.raw` in admin-ops `dbCounts()`** — table names and WHERE clauses are always hardcoded string literals, never user input.
- **`sql.raw` in admin.service `getConcurrentViewers()`** — interpolated values (`safeRangeDays`, `safeGran`) are derived from whitelist-validated enums. Line 305-306 has explicit whitelist assertion.
- **`broadcast-v2.tsx` timer cleanup** — `reorderDebounceRef` (line 1068) and `reloadTimer` (line 1148) both have `useEffect(() => () => clearTimeout(...), [])` cleanup. `OnAirStatusBar` interval (line 3589) returns `() => clearInterval(t)`.
- **analytics.tsx interval cleanup** — mounted flag + `clearInterval` at lines 168-171.
- **midnight-prayers.tsx interval** — `return () => clearInterval(t)` at line 129.
- **library.tsx search timer** — `searchTimerRef` cleared at line 159 before each new setTimeout.
- **Auth self-demotion guard** — `ForbiddenError` at API level in `admin.routes.ts` lines 137, 236. Client-side guard in `users.tsx` line 62 is a second layer.
- **Auth rate limits (120/min on /extend and /session/ping)** — intentional: these are called by keep-alive background refresh loops across multiple tabs simultaneously.
- **Channels routes** — all write operations properly guarded: `requireAuth("admin")` on create/update/delete; `requireAuth("editor")` on add-video.
- **Scheduled notifications dispatcher** — claim + dispatch + mark-done without a DB transaction, but startup recovery (`resetStuckSending`) on line 62 resets any stuck `sending` rows. This "soft transaction" pattern is the established design.
- **`dbCounts()` in admin-ops** — `n(table, where)` only receives hardcoded literal strings at all 5 callsites; no user input ever reaches the raw SQL.
