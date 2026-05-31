---
name: Comprehensive platform audit — sprint 28
description: 6 bugs fixed across API security, database indexes, mobile networking resilience, analytics safety, and AsyncStorage bounds. Upload pipeline, TV app, and admin frontend confirmed production-grade.
---

## Bugs Fixed

### 1. 110 MiB body limit on credential JSON routes (HIGH)
- The global `bodyLimit: 110 * 1024 * 1024` (set for chunk uploads) applied to ALL routes
  including `POST /auth/login`, `/register`, `/forgot-password`, `/reset-password`.
  A client could POST a 100 MB JSON body to a login endpoint, causing memory exhaustion
  during body parsing before any validation ran.
- Fix: Added `bodyLimit: 1 * 1024 * 1024` (1 MiB) per-route to:
  - `POST /auth/register`
  - `POST /auth/login`
  - `POST /auth/forgot-password`
  - `POST /auth/reset-password`
- File: `artifacts/api-server/src/modules/auth/auth.routes.ts`

**Why:** Per Fastify docs, `bodyLimit` can be set at route level to override the instance
default. The comment in `app.ts` said "other routes stay protected at this global ceiling"
but 110 MiB IS the ceiling, which is too large for any JSON credential endpoint.

### 2. Missing scheduled_notifications dispatch index (MEDIUM)
- The notification dispatcher polls `WHERE status = 'pending' AND scheduled_at <= now()`
  on every tick. `ensureRuntimeIndexes` mentioned this index in a comment (line 113) but
  never actually created it. Full table scan grows worse as sent rows accumulate.
- Fix: Added `idx_scheduled_notifications_dispatch ON scheduled_notifications(scheduled_at)
  WHERE status = 'pending'` to `ensureRuntimeIndexes()`.
- File: `artifacts/api-server/src/infrastructure/db.ts`

### 3. Missing viewer_sessions(started_at) index (LOW→MEDIUM)
- The admin analytics concurrent-viewers query LEFT JOINs `viewer_sessions` on `started_at`
  across 7/30/90 day windows. Without an index this is a sequential scan over the entire
  sessions table for every analytics dashboard load.
- Fix: Added `idx_viewer_sessions_started_at ON viewer_sessions(started_at)` to
  `ensureRuntimeIndexes()`.
- File: `artifacts/api-server/src/infrastructure/db.ts`

### 4. Raw fetch in useEmergencyAlerts + series page (MEDIUM)
- `useEmergencyAlerts.ts` initial fetch and `series/[slug].tsx` load both used bare
  `fetch()` — no retry on transient network errors, no per-request timeout (zombie TCP
  hang risk), no Retry-After support.
- Fix: Both upgraded to `fetchWithRetry(..., {}, { maxRetries: 3 })`.
- Files: `artifacts/mobile/hooks/useEmergencyAlerts.ts`,
         `artifacts/mobile/app/series/[slug].tsx`

### 5. sql.raw analytics safety (LOW)
- `getConcurrentViewers` in `admin.service.ts` used `sql.raw(\`...\${rangeDays}...\${gran}...\`)`
  with values derived from a Zod enum — safe at the route boundary but vulnerable to
  SQL injection if called directly from other service code with different inputs.
- Fix: Added explicit allowlist assertions (`safeRangeDays` and `safeGran`) that
  fall back to "7 / 1 day" if the value is not in the known-safe set. Query updated
  to use `safeRangeDays`/`safeGran` instead of the unchecked originals.
- File: `artifacts/api-server/src/modules/admin/admin.service.ts`

### 6. AsyncStorage watch progress grows unbounded (LOW)
- `useWatchProgress.ts` stored a progress entry for every video watched with no cap.
  Android's default AsyncStorage limit is ~6 MB. With ~500 bytes per entry, 12 000+
  videos would hit the limit; in practice even 500 entries is excess.
- Fix: Added `MAX_PROGRESS_ENTRIES = 200`. In `saveProgress`, after building the new
  map: if entry count > 200, prune by dropping oldest completed entries (pct ≥ 0.97)
  first, then oldest in-progress entries. This preserves resume-ability for active videos.
- File: `artifacts/mobile/hooks/useWatchProgress.ts`

## Confirmed False Positives (Sprint 28)

### Rate Limiting
- Login/register/forgot/reset all rate-limited (20 or 5/min). Health endpoints excluded
  from rate limiting intentionally — needed for monitoring/uptime checks.
- X-Forwarded-For spoofing: `trustProxy: true` trusts the upstream proxy.
  On Replit, the proxy strips client-provided XFF headers — safe in production.
  Any custom deployment must ensure a trusted reverse proxy sits in front.
- CORS: Wildcard `*` refused at startup in production; dev-only.

### Upload Pipeline
- Sessions have 24h in-memory TTL + 48h DB cleanup — no orphan leaks.
- Chunk ordering enforced: server reorders by `chunkIndex` at finalization.
- Finalizer uses advisory lock + CAS UPDATE to prevent double-assembly.
- Cancel cleanup immediate (explicit) + 6h background sweep as backstop.

### TV App
- HLS manifest 10-retry + watchdog + stall recovery confirmed correct.
- Auth proactive refresh 2 min before expiry — non-disruptive to video playback.
- All pages wrapped in ErrorBoundary with `onReset → handleBack()`.
- Tizen polyfills (enableSoftwareAES) and webOS back key handling confirmed.

### Admin Frontend
- React Query cache invalidation comprehensive — manual invalidations + SSE events.
- Error boundaries: global (main.tsx), page-level (PanelErrorBoundary), chart-level (ChartErrorBoundary).
- Permission checks: admin-only pages guarded by `isAdmin` check; sidebar links hidden.
- WebSocket reconnect: exponential backoff 250ms→8s + fresh token on each attempt.
- Session expiry: `ttv:auth-expired` event → localStorage clear → login redirect.

### Database
- Connection pool: `try...finally { client.release() }` confirmed on all manual pool.connect() calls.
- N+1 patterns: broadcast guide uses single leftJoin; video listing has two-layer cache + ETag.
- Transaction isolation: notification dispatcher uses `UPDATE ... RETURNING` (row-level lock) — no phantom read risk.
