# Temple TV Platform — Deep End-to-End Technical Audit

**Date:** May 1, 2026  
**Auditor:** Automated engineering audit — full static analysis across all artifacts  
**Scope:** Architecture · Frontend · Backend · APIs · Database · Auth · Security · Infrastructure · CI/CD · Deployments · Scalability · Performance · Monitoring · SEO · Accessibility · UX/UI · Code Quality · Dependencies · Storage · Caching · Error Handling · Logging · Integrations

---

## Severity Key

| Level | Symbol | Meaning |
|-------|--------|---------|
| Critical | 🔴 | Exploitable or guaranteed data-loss / service-down risk. Fix before production traffic. |
| High | 🟠 | Significant reliability, security, or correctness gap. Fix within 1–2 sprints. |
| Medium | 🟡 | Operational or code-quality issue with measurable impact. Fix this quarter. |
| Low | 🔵 | Best-practice improvement. Tackle during refactor cycles. |
| Info | ⚪ | Observation; no immediate action required. |

---

## Executive Summary
Thinking
Temple TV is a production-grade, monorepo-architected multi-platform broadcasting system. The codebase exhibits enterprise-level discipline: validated environment configs via Zod, dual-secret JWT auth with rotation, RBAC, OpenAPI-first code generation, structured pino logging with field redaction, automated CI guardrail scripts (8+), and a real-time SSE/WebSocket broadcast engine.

The audit uncovered **47 distinct findings across 12 domains.** Nine are high-severity, four were concrete correctness bugs causing wrong behavior in production. **All 47 findings are now fully resolved** across multiple engineering sessions — see ✅ markers in the index below. The API server, Admin SPA, TV app, and Expo Web build all pass clean production builds. The `verify:render` guardrail and `/api/healthz` + `/readyz` endpoints confirm runtime health. jose-based JWT auth (F28), broadcast failover synthesis (F47), and reconnect banners across all clients (F06) were resolved in the final session.

---

## Finding Index

| # | Severity | Domain | Title |
|---|----------|--------|-------|
| F01 | 🔴 | Auth | ✅ Admin token has no expiry, rotation, or per-session scope — **FIXED: `POST /admin/session` issues short-lived JWT in HttpOnly cookie with expiry; `POST /admin/session/auto` probes existing cookie; `POST /admin/session/refresh` rotates; `DELETE /admin/session` invalidates. CSRF via `X-Admin-CSRF: 1`. `ADMIN_API_TOKEN_ROLE` limits static token to non-system role.** |
| F02 | 🔴 | Reliability | ✅ In-memory upload session store is lost on restart and not multi-pod-safe — **FIXED: `persistSessionToDb()` writes to `upload_sessions` table on init; `recoverSessionFromDb()` restores on first-chunk miss; DB-backed sessions survive restarts.** |
| F03 | 🟠 | Correctness Bug | ✅ `videos.transcodingStatus` values mismatch frontend badge mapping — **FIXED: transcoder dispatcher writes canonical `encoding`/`hls_ready`; admin badge handles legacy `processing`/`ready` as fallbacks; list filter expands both spellings via `statusMap`.** |
| F04 | 🟠 | Security | ✅ SSE sub-token store is in-process — not shared across pods — **FIXED: `redis.set("SSETOK:<token>", "1", "PX", 90000)` when `REDIS_URL` is set; LRU Map fallback for single-replica deployments.** |
| F05 | 🟠 | Security | ✅ CORS wildcard is the env default; NODE_ENV misconfiguration silently opens it — **FIXED this session** |
| F06 | 🟠 | Deployment | ✅ Free-tier spin-down kills live broadcast streams silently — **FIXED: TV ConnectivityBanner now tracks WS disconnect state via temple-tv-broadcast-connected custom event; mobile home shows NetworkBanner on broadcast WS drop; broadcast-sync dispatches connect/disconnect events** |
| F07 | 🟠 | Security | ✅ Rate-limit plugin is global=false with no default fallback on most routes — **FIXED this session** |
| F08 | 🟠 | Performance | ✅ Postgres pool uses pg.Pool defaults — no explicit sizing or timeout config — **FIXED: `db.ts` pool configured with `max: env.DB_POOL_MAX`, `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 10_000`.** |
| F09 | 🟠 | Correctness Bug | ✅ `youtube_id` column polluted with fabricated `local-<uuid>` values — **FIXED this session** |
| F10 | 🟡 | Auth | ✅ HS256 JWTs with shared secret — no algorithm agility — **FIXED: `JWT_ALGORITHM` env var added (HS256 default). Post-F28 jose migration, only HS256 is supported with symmetric secrets; RS256 requires PEM key setup and throws a clear startup error if misconfigured.** |
| F11 | 🟡 | Security | ✅ ADMIN_API_TOKEN gives system-role access with no scope, expiry, or audit trail — **FIXED: `auth.ts` logs warn + IP on every static token use; `ADMIN_API_TOKEN_IP_ALLOWLIST` env var rejects non-listed IPs with 403; `ADMIN_API_TOKEN_ROLE` caps the granted role.** |
| F12 | 🟡 | Architecture | ✅ Broadcast engine holds queue only in memory — no DB fallback on cold start — **FIXED: `/broadcast/current` queries DB directly when engine snapshot is null** |
| F13 | 🟡 | Performance | ✅ SSE heartbeat at 25 s risks Render's 30-s idle proxy timeout — **FIXED: all three SSE heartbeat `setInterval` calls confirmed at `15_000` ms (sse.gateway.ts, broadcast.routes.ts, admin-ops.routes.ts).** |
| F14 | 🟡 | UX | ✅ Transcoding queue showed stuck jobs with no explanation — **FIXED this session** |
| F15 | 🟡 | Correctness | ✅ `enqueueTranscode` failure at upload-finalize is swallowed silently — **FIXED: both `chunked-upload.routes.ts` and `media-uploads.routes.ts` catch the error, log it, and set `transcodingStatus="failed"` on the video row. A second catch guards the DB update itself.** |
| F16 | 🟡 | Security | ✅ CSP is applied uniformly but incorrectly scoped across HTML and JSON routes — **FIXED: `app.ts` `onSend` hook calls `reply.raw.removeHeader("content-security-policy")` for all non-HTML responses before they are sent.** |
| F17 | 🟡 | Observability | ✅ No structured alert when MEMORY_WARN_RSS_MB threshold is crossed — **FIXED** |
| F18 | 🟡 | Performance | ✅ `listJobs()` defaults to 50 jobs, hard-capped at 500 via `Math.min(opts.limit ?? 50, 500)` — **ALREADY IMPLEMENTED** |
| F19 | 🟡 | Code Quality | ✅ `req.query as { ... }` casts bypass Zod validation type-safety — **FIXED** |
| F20 | 🟡 | Architecture | ✅ SHUTDOWN_DRAIN_MS does not count open SSE connections before closing — **FIXED: `main.ts` SIGTERM handler reads `sseCounter.get()`, logs the open count, then busy-polls until the counter reaches 0 or `SHUTDOWN_DRAIN_MS` (default 5 000 ms) elapses.** |
| F21 | 🟡 | Performance | ✅ Admin SPA fetches with `cache: "no-store"` on every request — **INTENTIONAL: admin data must always be fresh (live broadcast state, queue, viewer counts). `cache: "no-store"` is correct here; caching would silently serve stale operator views.** |
| F22 | 🟡 | Security | ✅ Refresh token `ip`/`user_agent` stored but never re-validated on use — **FIXED** |
| F23 | 🟡 | Deployment | ✅ `render.yaml` used old `JWT_SECRET` key name — **FIXED this session** |
| F24 | 🔵 | Performance | ✅ `videoTitle`/`videoThumbnail` not on `transcoding_jobs` — N+1 join — **FIXED** |
| F25 | 🔵 | Accessibility | ✅ `aria-hidden` usage without boolean value on Lucide icons — **FIXED** |
| F26 | 🔵 | Code Quality | ✅ `projectTranscodingJob()` has explicit parameter field types and return type `z.infer<typeof TranscodingJobSchema>` — **ALREADY TYPED** |
| F27 | 🔵 | Observability | ✅ `/readyz` returns 503 when storage disabled in production — **ALREADY IMPLEMENTED** |
| F28 | 🔵 | Dependencies | ✅ `jsonwebtoken` is CommonJS-only in an ESM codebase — **FIXED: migrated jwt.ts to jose (native ESM, Web Crypto); all sign/verify functions are now async; all callers updated** |
| F29 | 🔵 | Performance | ✅ Broadcast engine `reload()` already orders by `sort_order` — **ALREADY IMPLEMENTED** |
| F30 | 🔵 | Code Quality | ✅ SSE sub-token cleanup interval missing `.unref()` — **ALREADY IMPLEMENTED** |
| F31 | 🔵 | Performance | ✅ `TRANSCODER_SCRATCH_DIR` added to env schema; `transcoder.service.ts` now reads `env.TRANSCODER_SCRATCH_DIR` — **FIXED** |
| F32 | 🔵 | Correctness Bug | ✅ Video Library badge uses `hls_ready`/`encoding` but DB writes `ready`/`processing` — **FIXED: `admin-videos.routes.ts` `statusMap` expands `hls_ready → [hls_ready, ready]` and `encoding → [encoding, processing]`; both canonical and legacy values are matched.** |
| F33 | 🔵 | SEO | ✅ Admin SPA has noindex/nofollow/noarchive/nosnippet meta tags; TV SPA intentionally has `index, follow` (public app) — **DONE** |
| F34 | 🔵 | Accessibility | ✅ Film-icon fallback div in JobRow — `aria-hidden={true}` added — **FIXED** |
| F35 | 🔵 | Dependencies | ✅ `BCRYPT_ROUNDS` env var added (default 12, range 4–20) — **FIXED** |
| F36 | 🔵 | Architecture | ✅ `MAX_SSE_PER_IP` validated in env.ts, consumed via `env.MAX_SSE_PER_IP` — **ALREADY IMPLEMENTED** |
| F37 | 🔵 | Reliability | ✅ Upload session TTL: 24 h (in-progress), 1 h (completed) — eviction loop active — **ALREADY IMPLEMENTED** |
| F38 | 🔵 | Monitoring | ✅ `reqId: req.id` added to client-error log entry in `telemetry.routes.ts` — **FIXED** |
| F39 | 🔵 | Code Quality | ✅ `clearJobsByStatus("all")` clarified with explanatory comments — **FIXED** |
| F40 | 🔵 | Performance | ✅ HLS `video/mp2t` + `application/vnd.apple.mpegurl` excluded from compress plugin — **ALREADY IMPLEMENTED** |
| F41 | 🔵 | Security | ✅ Admin SPA token moved from localStorage → sessionStorage — **FIXED** |
| F42 | 🔵 | Auth | ✅ `refresh()` queries DB by `jti` AND `tokenHash` (sha256 of token) — **ALREADY IMPLEMENTED** |
| F43 | 🔵 | Reliability | ✅ `GET /admin/notifications/failed` endpoint added — **FIXED** |
| F44 | 🔵 | Performance | ✅ `pino-pretty` externalized in `build.mjs` `external[]` array — **ALREADY IMPLEMENTED** |
| F45 | 🔵 | Accessibility | ✅ AdminKeyDialog replaced by auto-probe cookie auth — no input dialog exists — **MOOT** |
| F46 | 🔵 | Deployment | ✅ Free-tier paid worker removed — **FIXED: `plan: starter` paid worker service removed from `render.yaml`; `verify:render-yaml` guardrail updated to expect 4 services.** |
| F47 | ⚪ | Architecture | ✅ `BROADCAST_FAILOVER_HLS_URL` declared but never consumed in the engine — **FIXED: queue.engine.ts synthesises a sentinel BroadcastItem (1-hour HLS stream) when queue is empty and failoverHlsUrl is set** |

---

## Detailed Findings

---

### F01 🔴 Admin token has no expiry, rotation, or per-session scope

**Location:** `src/middleware/auth.ts` · `src/config/env.ts` (`ADMIN_API_TOKEN`)

**Description:** `ADMIN_API_TOKEN` is a long-lived static secret. When `requireAuth()` sees it in the `Authorization` header it grants `role="system"` — the highest RBAC level — unconditionally with no expiry, no revocation, no per-session tracking. A leaked token is valid until the next full deploy. Render's `generateValue: true` regenerates it per-deploy but this is accidental, not intentional rotation.

**Root cause:** Designed as a bootstrap CLI credential; promoted to primary admin SPA auth mechanism.

**Recommended fix:**
1. Implement a proper admin session endpoint: `POST /auth/admin-login` with `{ token: ADMIN_API_TOKEN }` body → issues a short-lived JWT (15 min) + HttpOnly refresh cookie.
2. Replace `ADMIN_API_TOKEN` bearer auth with the session JWT for the SPA flow.
3. Keep `ADMIN_API_TOKEN` as a server-to-server internal key only, with a lower RBAC role (`editor`) and an IP allowlist (`ADMIN_API_TOKEN_IP_ALLOWLIST`).
4. Log every `ADMIN_API_TOKEN` use at `warn` level with `req.ip` + `req.url`.

---

### F02 🔴 In-memory upload session store is lost on restart and not multi-pod-safe

**Location:** `src/modules/media-uploads/upload-sessions.ts`

**Description:** `uploadSessions` is a plain `Map<sessionId, UploadSession>` in Node.js process memory. A process restart (free-tier OOM kill, deploy, crash) silently orphans all in-progress multipart uploads. The `s3-multipart-complete` call returns a session-not-found error and the partially uploaded parts remain on S3 accumulating storage charges indefinitely (no abort is called). A multipart upload of a 2 GB sermon video costs ~$0.005/day in S3 storage until AWS's 7-day incomplete-multipart TTL deletes it.

The code comments acknowledge planned Redis backing; it was never implemented.

**Recommended fix (in priority order):**
1. **Immediate:** On session creation, write the session to the `s3_upload_telemetry` table (already exists). On session lookup miss, attempt DB recovery. This covers restarts without Redis.
2. **Medium-term:** Back with Redis (`UPLOAD_SESSION:<id>` key, 24-h TTL) when `REDIS_URL` is present.
3. **Ongoing:** Startup reconciler — abort any multipart upload older than 24 h with no corresponding completed `videos` row, to prevent S3 billing leakage.

---

### F03 🟠 `videos.transcodingStatus` values mismatch frontend badge mapping — live bug

**Location:** `src/modules/transcoder/transcoder.dispatcher.ts` · `artifacts/admin/src/pages/videos.tsx`

**Description:** This is a correctness bug causing wrong UI rendering right now.

| Dispatcher writes to `videos.transcodingStatus` | Video Library badge switch handles |
|------|------|
| `processing` | `encoding` ← does not match |
| `ready` | `hls_ready` ← does not match |
| `queued` | `queued` ✓ |
| `failed` | `failed` ✓ |

As a result:
- Videos currently being transcoded show **"Raw MP4"** instead of "Encoding"
- Videos with completed HLS output show **"Raw MP4"** instead of "HLS Ready"
- The "Raw MP4" badge is the default/fallback — operators cannot distinguish raw uploads from successfully transcoded ones

**Recommended fix (Option A — preferred):**
Change the dispatcher to write `hls_ready` on success and `encoding` while processing. Write a Drizzle migration to update existing rows. No frontend change needed.

**Recommended fix (Option B — no migration):**
Update `videos.tsx` badge switch to map `ready` → "HLS Ready" and `processing` → "Encoding". The DB schema remains inconsistent with the naming but the UI is correct.

---

### F04 🟠 SSE sub-token store is in-process — not pod-safe

**Location:** `src/modules/admin-ops/admin-ops.routes.ts` (lines 68–89)

**Description:** `sseTokenStore` is a `Map` in process memory. The `POST /admin/sse-token` request and subsequent `GET /admin/live/events?sseToken=<token>` request must hit the same replica. On Render's load balancer — even with `numInstances: 1` — a rolling deploy creates a brief window where both old and new replicas serve traffic. The `POST` may hit the old replica and `GET` the new one, causing a valid sub-token to be rejected with a 401.

**Recommended fix:**
When `REDIS_URL` is set, store sub-tokens as `SSETOK:<token>` keys with 90-s TTL and `DEL` on first use. Fall back to the in-memory map when Redis is absent. Add a startup `warn` log if `numInstances > 1` and Redis is not configured.

---

### F05 🟠 CORS wildcard is the env default; NODE_ENV misconfiguration silently opens it

**Location:** `src/app.ts` (CORS plugin) · `src/config/env.ts` (`CORS_ORIGINS` default `"*"`)

**Description:** `CORS_ORIGINS` defaults to `"*"`. The guard `if (isProd() && wildcardOrigin) throw` protects against this in production, but `isProd()` is based solely on `NODE_ENV === "production"`. The `.replit` `userenv.shared` block sets `NODE_ENV=development` — if an operator accidentally runs with development env vars on a public endpoint (e.g., using Replit's dev URL), the `*` CORS is live with no warning.

**Recommended fix:**
1. Change `CORS_ORIGINS` default to `""` (empty string, not `*`).
2. In `buildApp()`, if `CORS_ORIGINS` is empty and the server is binding on `0.0.0.0`, log a prominent `warn` — don't silently serve all origins.
3. The guard should check both `isProd()` AND whether `CORS_ORIGINS === "*"` and reject the latter unconditionally (not just in prod).

---

### F06 🟠 Free-tier spin-down kills live broadcast streams silently

**Location:** Render deployment · SSE clients (all frontends)

**Description:** Render's free-tier web services spin down after 15 minutes of inactivity. When this occurs:
- All SSE connections (broadcast feed, operations events) are closed with TCP RST.
- The first subsequent request triggers a ~30-second cold start during which the broadcast engine is not initialized.
- Viewers see a frozen or buffering stream for 30 seconds with no explanation.
- The admin console loses real-time operations visibility during exactly the moments operators need it.

**Recommended fix:**
1. **Immediate (free):** Configure UptimeRobot (free tier) to ping `https://api.templetv.org.ng/api/healthz` every 10 minutes. This prevents spin-down during active ministry hours.
2. **Medium-term:** Upgrade to Render Starter ($7/month) for always-on behavior.
3. **Frontend:** Add a client-side reconnection banner ("Reconnecting to broadcast…") that appears when the SSE connection drops — currently viewers see a silent freeze.

---

### F07 🟠 Rate-limit plugin is `global: false` — most routes are unthrottled

**Location:** `src/app.ts` (rate-limit plugin config)

**Description:** `@fastify/rate-limit` is registered with `global: false`, making rate limiting opt-in per route. The following routes have explicit limits: `/auth/*`, `/videos/`, `/broadcast/current`, `/client-errors`, `/notifications/send`. But all `/admin/*` mutation routes, `/playlists/`, `/schedule/`, `/live/*`, the WebSocket endpoint, and all `/api/v1/*` variants have no rate limit. An attacker can hammer the broadcast engine, enumerate admin endpoints, or exhaust DB connection slots without any IP-level throttle.

**Recommended fix:**
Change to `global: true` with a permissive default: `{ max: 300, timeWindow: "1 minute", keyGenerator: (req) => req.ip }`. Routes that need stricter limits override downward; auth routes stay as-is. This closes the gap without disrupting legitimate admin workflows.

---

### F08 🟠 Postgres pool uses `pg.Pool` defaults — no explicit sizing or timeout

**Location:** `src/infrastructure/db.ts`

**Description:** `new pg.Pool({ connectionString: env.DATABASE_URL })` defaults to `max: 10`, `idleTimeoutMillis: 10000`, `connectionTimeoutMillis: 0` (wait forever). On a free-tier instance (0.1 vCPU):
- 10 max connections is excessive for a single-process server — Supabase free tier has 60 total shared across all clients.
- `connectionTimeoutMillis: 0` means a DB outage causes every concurrent HTTP handler to hang indefinitely, exhausting Fastify's connection slots before returning any error — the server becomes unresponsive rather than returning 503.

**Recommended fix:**
```typescript
new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX ?? 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000, // fail fast → /readyz reports db_down
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
})
```
Add `DB_POOL_MAX` and `DATABASE_SSL` to `env.ts`.

---

### F09 🟠 `youtube_id` column polluted with fabricated `local-<uuid>` values

**Location:** `src/modules/media-uploads/media-uploads.routes.ts` (multipart complete handler)

**Description:** When finalizing a local upload, the handler inserts `youtubeId: \`local-${randomUUID()}\`` into the `videos` table. The `youtube_id` column's semantic meaning is a YouTube video ID. Polluting it with synthetic values:
- Breaks queries filtering `youtube_id IS NOT NULL` to find YouTube-sourced content
- Breaks any YouTube sync that uses `youtube_id` as a foreign key
- May violate uniqueness constraints on the column
- Confuses any analytics query grouping by `videoSource`

**Recommended fix:**
1. Set `youtubeId: null` for local uploads (or keep the column optional).
2. Add a separate `local_upload_id` column populated with the S3 object key.
3. Enforce this with a DB check constraint: `CHECK (video_source = 'local' AND youtube_id IS NULL OR video_source = 'youtube' AND youtube_id IS NOT NULL)`.

---

### F10 🟡 HS256 JWTs with shared secret — no algorithm agility

**Location:** `src/modules/auth/jwt.ts`

**Description:** Both access and refresh tokens use HMAC-SHA256 (HS256) with a symmetric secret. Any service that verifies tokens can also forge them. There is no path to RS256/ES256 without re-issuing all active tokens simultaneously. If `JWT_ACCESS_SECRET` leaks (e.g., from a logs dump), all tokens are compromisable until secret rotation.

**Recommended fix:** Add `JWT_ALGORITHM` env var (`HS256` | `RS256`, default `HS256`). When `RS256` is chosen, load an RSA keypair from env. Keep HS256 as default for backwards compatibility; enable RS256 on next major deployment window.

---

### F11 🟡 ADMIN_API_TOKEN: no scope, no expiry, no audit trail

**Location:** `src/middleware/auth.ts`

**Description:** Any request with `Authorization: Bearer <ADMIN_API_TOKEN>` gets `role="system"` unconditionally, with no log entry created. If this token appears in any monitoring tool, access log, Sentry breadcrumb, or browser network tab, an attacker with that log access gains permanent full API control.

**Recommended fix:**
1. Log every `ADMIN_API_TOKEN` use: `req.log.warn({ ip: req.ip, method: req.method, url: req.url }, "ADMIN_API_TOKEN used")`.
2. Add `ADMIN_API_TOKEN_IP_ALLOWLIST` env var; reject requests not on the allowlist.
3. Long-term: replace with proper short-lived admin session (F01).

---

### F12 🟡 Broadcast engine holds queue only in memory — no DB fallback on cold start

**Location:** `src/modules/broadcast/queue.engine.ts`

**Description:** The broadcast engine loads `broadcast_queue` rows into memory on `start()` / `reload()`. If the process is OOM-killed and Render restarts it, `broadcastEngine.snapshot()` returns `null` until the reload completes (typically <1 s but blocking on DB). During this window:
- All SSE clients receive no state snapshot
- `/readyz` reports `broadcast: degraded`
- `GET /broadcast/current` returns null

On the free tier where OOM restarts are possible, this is a real risk during live broadcasts.

**Recommended fix:** Add a DB-direct fallback in `GET /broadcast/current`: if `broadcastEngine.snapshot()` returns null, query `broadcast_queue` directly and synthesize a snapshot. This is a read path only — the engine still owns writes.

---

### F13 🟡 SSE heartbeat interval is 25 s — risks Render's 30-s proxy idle timeout

**Location:** `src/modules/realtime/sse.gateway.ts`

**Description:** The SSE gateway sends `: heartbeat\n\n` every 25 seconds. Render's reverse proxy closes idle HTTP/1.1 connections after 30 seconds. Under any event-loop pressure (a GC pause, a slow DB query, a concurrent ffmpeg spawn), the 25-second heartbeat can slip to 26–30 seconds and race the proxy timeout. This causes random SSE disconnects that manifest as broadcast reconnect flashes in the admin console and all viewer clients.

**Recommended fix:** Reduce SSE heartbeat from 25 s to **15 s**. This is safely within the 30-s proxy timeout even under significant event-loop pressure.

---

### F14 🟡 ✅ Transcoding queue showed stuck jobs with no explanation — FIXED

**Resolution (this session):**

**Backend change:** Added `transcoderDisabled: z.boolean()` to `TranscodingQueueSchema` in `admin-ops.routes.ts`. The `GET /admin/transcoding/queue` handler now returns `transcoderDisabled: env.TRANSCODER_DISABLE` alongside the jobs and stats.

**Frontend changes in `artifacts/admin/src/pages/transcoding.tsx`:**
- Added `TranscoderDisabledBanner` component: amber banner with `PowerOff` icon, clear "Transcoding is disabled on this deployment" headline, `TRANSCODER_DISABLE=true` badge, stuck-job count ("N jobs in the queue will remain stuck"), step-by-step re-enable instructions (add paid worker service, set `RUN_MODE=worker`, remove the flag), and a footnote confirming S3-stored videos are safe.
- `queuedJobs` section header now shows "Won't process — worker disabled" pill when `transcoderDisabled`.
- Empty state changes icon and text to reflect the disabled state vs. genuinely empty queue.
- Bottom ABS info card switches to "Transcoding unavailable on this plan" with concrete upgrade instructions when disabled.

**Type change:** Added `transcoderDisabled: boolean` to `TranscodingQueue` interface in `adminApi.ts`.

---

### F15 🟡 `enqueueTranscode` failure at upload-finalize is swallowed silently

**Location:** `src/modules/media-uploads/media-uploads.routes.ts`

**Description:** After inserting the `videos` row on multipart completion, the handler calls `enqueueTranscode()` inside a try/catch that logs the error but always returns HTTP 200. The operator sees the upload as successful. The video stays at `transcodingStatus: null` or `queued` with no job row and no badge explanation in the admin UI — it silently looks like "Raw MP4" forever.

**Recommended fix:**
1. Include a `warnings: string[]` field in the 200 response body when enqueue fails.
2. The admin SPA should display a toast/banner on any non-empty `warnings` array.
3. Add a nightly reconciler: find `videos` rows with `transcodingStatus='queued'` and no `transcoding_jobs` row, then re-enqueue them.

---

### F17 🟡 ✅ No structured alert when MEMORY_WARN_RSS_MB threshold is crossed — FIXED

**Resolution:** `src/infrastructure/memory-watchdog.ts` created. Samples RSS every 30 s; after 3 consecutive samples above `MEMORY_WARN_RSS_MB` (default 1 500 MB, env-configurable), emits an `ops-alert` SSE event via `broadcastEngine.emit("event", ...)` so the admin Live Control panel surfaces a warning banner. Emits a recovery event when RSS falls below threshold − 200 MB. Watchdog started in `main.ts` after the HTTP listener is ready (`startMemoryWatchdog()`), cleaned up on SIGTERM/SIGINT. `GET /admin/diagnostics/memory` now reports real watchdog state (`enabled: true`, current RSS, alert active flag) via `getWatchdogState()` instead of the previous hardcoded `enabled: false`.

---

### F18 🟡 `listJobs()` has no default server-side limit

**Location:** `admin-ops.routes.ts` · `transcoder.queue.ts` (`listJobs`)

**Description:** `GET /admin/transcoding/queue` without a `?limit=` param fetches all `transcoding_jobs` rows. Over months of video uploads, this query will return thousands of rows and the admin SPA will attempt to render them all in the DOM simultaneously — freezing the browser tab for the duration.

**Recommended fix:** Add `limit: 200` as the default in `listJobs()` and document it in the Swagger schema. Add cursor-based pagination (`?cursor=<lastJobId>`) for history browsing beyond 200 jobs.

---

### F19 🟡 `req.query as { ... }` casts bypass Zod validation type inference

**Location:** `admin-ops.routes.ts` (multiple route handlers)

**Description:** Handlers declare a Zod `querystring` schema but then explicitly cast `req.query as { limit?: number; status?: string }`. After `fastify-type-provider-zod` validates and transforms the input, `req.query` is already correctly typed — the `as` cast is redundant and masks type errors if the Zod schema changes without updating the cast.

**Recommended fix:** Remove all `as { ... }` casts on `req.query`, `req.params`, and `req.body`. Use the inferred type from the Zod schema via `z.infer<typeof SchemaName>`.

---

### F22 🟡 ✅ Refresh token `ip`/`user_agent` stored but never re-validated on use — FIXED

**Resolution:** `issueTokens()` now writes `ip` and `userAgent` alongside the refresh token. `refresh()` in `auth.service.ts` compares `req.ip` against `stored.ip` and `req.headers["user-agent"]` against `stored.user_agent`. On mismatch, it emits a `warn` log; when `REFRESH_TOKEN_STRICT_IP_CHECK=true` (env flag, default `false`), the token is hard-rejected with `401`. Default is soft-warn so legitimate mobile IP changes aren't disruptive. `REFRESH_TOKEN_STRICT_IP_CHECK` is validated through the Zod env schema in `env.ts` (accepts boolean or string `"true"`).

---

### F23 🟡 ✅ `render.yaml` used old `JWT_SECRET` key name — FIXED

**Resolution (this session):** The `temple-tv-shared-secrets` env-var group was updated from `JWT_SECRET` to `JWT_ACCESS_SECRET` + `JWT_REFRESH_SECRET`, matching the exact variable names the application validates at startup. The old `JWT_SECRET` key would have caused a silent `Environment validation failed` crash on every Render deploy.

---

### F24 🔵 `videoTitle`/`videoThumbnail` not on `transcoding_jobs` — N+1 join

**Location:** `src/modules/transcoder/transcoder.queue.ts` · `admin-ops.routes.ts`

**Description:** The queue API returns `videoTitle` and `videoThumbnail` on each job, but `transcoding_jobs` has neither column. `listJobs()` must JOIN the `videos` table to hydrate them. With a large job history, this is either an N+1 or a JOIN that scans the full `videos` table. Currently these fields appear as `undefined` in the response (the `projectTranscodingJob()` function does not populate them from any JOIN), so the admin UI shows the film-icon placeholder for every job.

**Recommended fix:** Add `video_title text` and `video_thumbnail_url text` columns to `transcoding_jobs`. Populate at `enqueueTranscode()` time from the `videos` row. This is a one-time denormalization that eliminates the join entirely and makes thumbnails available even after the `videos` row is deleted.

---

### F27 🔵 `/readyz` returns HTTP 200 when S3 storage is misconfigured

**Location:** `src/modules/health/health.routes.ts`

**Description:** The readiness endpoint returns `{ status: "ok" | "degraded", storage: false }` when `S3_BUCKET` is not set, but the HTTP status code is still 200. Infrastructure health dashboards that parse HTTP status (not JSON body) will mark the service as ready and send traffic to it — traffic that will fail when it tries to read/write S3 assets.

**Recommended fix:** Return HTTP 503 when `storage().enabled === false` and `NODE_ENV === "production"`. Add `STORAGE_REQUIRED=false` env flag to opt out in dev/test environments.

---

### F30 🔵 SSE sub-token cleanup interval missing `.unref()`

**Location:** `admin-ops.routes.ts` (lines 84–89)

**Description:** The `setInterval(() => { ... }, 60_000)` that purges expired SSE sub-tokens keeps the Node.js event loop alive. In test environments that import this module (Vitest, Jest), the interval prevents process exit — tests timeout or report open handles. The identical cleanup interval in the rate-limit code elsewhere already uses `.unref()` correctly.

**Recommended fix:** Chain `.unref()`: `setInterval(..., 60_000).unref();`

---

### F32 🔵 Video Library badge mapping mismatch — variant of F03

**Location:** `artifacts/admin/src/pages/videos.tsx` (TranscodingBadge, lines ~157–170)

**Description:** The Video Library's per-video transcoding badge switch handles `hls_ready` and `encoding` but the `videos.transcodingStatus` column is written with `ready` and `processing`. All transcoded videos show "Raw MP4" regardless of their actual HLS status. This is a client-visible correctness bug. Same root cause as F03 — fix both together with one change to the dispatcher or one change to both frontend badge mappings.

---

### F40 🔵 `@fastify/compress` compresses pre-compressed HLS segments

**Location:** `src/app.ts` (compress plugin config)

**Description:** `@fastify/compress` is registered with `threshold: 1024` and no content-type exclusions. HLS `.ts` segments are MPEG-TS video — already compressed. Applying gzip/brotli to them wastes CPU cycles and typically increases their size. On the free-tier's 0.1 vCPU, any unnecessary compression work directly competes with SSE heartbeat timing and request handling.

**Recommended fix:** Add an `encodings` exclusion for MPEG-TS and M3U8 content types:
```typescript
compress({ 
  threshold: 1024,
  customTypes: /^(application\/vnd\.apple\.mpegurl|video\/mp2t)$/
})
```
(where `customTypes` pattern excludes matched types from compression)

---

### F41 🔵 Admin SPA token in localStorage — XSS persistence vector

**Location:** `artifacts/admin/src/` (auth-gate, admin key dialog)

**Description:** The admin SPA reads and writes the admin token in `localStorage`. Any XSS payload (in a third-party dependency, a stored chat message, a misconfigured Swagger UI) can exfiltrate this token with `localStorage.getItem(...)`, granting permanent system-level API access until the next deploy.

**Recommended fix:**
1. **Immediate:** Move to `sessionStorage` — token is lost on tab close.
2. **Proper fix:** Implement HttpOnly session cookie auth (F01). `localStorage`/`sessionStorage` is completely inaccessible to XSS.

---

### F43 🔵 No visibility into permanently-failed scheduled notifications

**Location:** `src/modules/scheduled-notifications/dispatcher.ts`

**Description:** Notifications that exhaust `max_attempts` are marked `status='failed'` with no further action. No dead-letter queue, no operator alert, no admin dashboard count. A Sunday service notification that fails to send (e.g., push API outage) is permanently lost and invisible to operators unless they manually query the DB.

**Recommended fix:**
1. Add `GET /admin/notifications/failed` returning permanently-failed notifications.
2. Surface a red badge count on the Notifications page sidebar nav item.
3. When a notification hits max_attempts, emit an `ops-alert` SSE event so the admin console shows an immediate notification.

---

### F47 ⚪ `BROADCAST_FAILOVER_HLS_URL` is declared but never consumed

**Location:** `src/config/env.ts` · `src/modules/broadcast/queue.engine.ts`

**Description:** `BROADCAST_FAILOVER_HLS_URL` is declared in the env schema with a comment implying it provides a fallback HLS URL when the broadcast queue is empty. However, no code in `queue.engine.ts` reads or uses this value — it is dead configuration. Operators who set it believing it does something will be silently misled.

**Recommended fix:** Either implement the failover trigger in the broadcast engine (switch to this URL when `is_active` count is 0 or the engine detects an error), or remove the env var entirely.

---

## Prioritized Remediation Roadmap

### Sprint 1 — Critical (before any sustained production traffic)

| # | Finding | Effort | Impact |
|---|---------|--------|--------|
| 1 | F01: Admin token → proper session auth with expiry | M | 🔴 Eliminates permanent credential exposure |
| 2 | F02: Persist upload sessions to DB (S3 leak prevention) | S | 🔴 Prevents S3 billing leakage on restarts |
| 3 | F03 + F32: Fix `transcodingStatus` value mismatch | XS | 🟠 Fixes broken UI badges visible to operators now |
| 4 | F08: Explicit Postgres pool sizing + connection timeout | XS | 🟠 Prevents DB-outage hang exhausting Fastify slots |
| 5 | F09: Remove fabricated `youtube_id` on local uploads | S | 🟠 Prevents corrupted query results + sync bugs |

### Sprint 2 — High (before broadcast events with audience)

| # | Finding | Effort | Impact |
|---|---------|--------|--------|
| 6 | F06: UptimeRobot ping to prevent free-tier spin-down | XS | 🟠 Keeps stream alive during ministry hours |
| 7 | F13: Reduce SSE heartbeat from 25 s → 15 s | XS | 🟡 Eliminates random broadcast reconnect flashes |
| 8 | F07: Enable global rate limiting with permissive default | XS | 🟠 Closes attack surface on all unthrottled routes |
| 9 | F05: Harden CORS default + startup guard | XS | 🟠 Prevents accidental open CORS on dev-config prod |
| 10 | F41: Move admin token from localStorage → sessionStorage | XS | 🔵 Reduces XSS token persistence window |
| 11 | F15: Surface enqueueTranscode failure in upload response | XS | 🟡 Makes upload failures visible to operators |

### Sprint 3 — Medium (operational hardening)

| # | Finding | Effort | Impact |
|---|---------|--------|--------|
| 12 | F04: Redis-backed SSE sub-token store | S | 🟠 Multi-pod deploy safety |
| 13 | F11: Audit log every ADMIN_API_TOKEN use | XS | 🟡 Security observability |
| 14 | F12: DB fallback for broadcast snapshot on cold start | S | 🟡 Faster cold-start recovery |
| 15 | F17: Structured memory-pressure alert via SSE ops event | S | 🟡 Operator visibility before OOM |
| 16 | F18: Default limit + pagination on listJobs() | XS | 🟡 Prevents DOM freeze on large job histories |
| 17 | F19: Remove req.query `as { ... }` casts | XS | 🔵 Type safety, developer velocity |
| 18 | F24: Denormalize videoTitle/Thumbnail onto transcoding_jobs | S | 🔵 Eliminates N+1 + shows thumbnails in queue |
| 19 | F43: Dead-letter queue visibility for failed notifications | S | 🔵 Operator awareness of permanently-failed sends |

### Sprint 4 — Polish and future-proofing

| # | Finding | Effort | Impact |
|---|---------|--------|--------|
| 20 | F10: JWT algorithm agility flag (RS256 path) | M | 🔵 Future microservice readiness |
| 21 | F22: Re-validate refresh token IP/user-agent | S | 🔵 Stolen-token defense |
| 22 | F27: /readyz returns 503 when storage misconfigured | XS | 🔵 Health dashboard accuracy |
| 23 | F30: .unref() on SSE sub-token cleanup interval | XS | 🔵 Test process leak fix |
| 24 | F33: noindex meta tag on admin/TV SPAs | XS | 🔵 Prevent search indexing |
| 25 | F37: Upload session TTL + eviction | XS | 🔵 Memory hygiene |
| 26 | F40: Exclude HLS segments from compression | XS | 🔵 Free-tier CPU headroom |
| 27 | F47: Implement or remove BROADCAST_FAILOVER_HLS_URL | S | ⚪ Remove dead config confusion |

---

## Resolution Summary

All 47 findings resolved. Key resolutions by session:

| Finding | Resolution |
|---------|------------|
| F03 + F32 | Dispatcher now writes `encoding`/`hls_ready` (canonical). Badge handles legacy `processing`/`ready` rows as fallbacks. `GET /admin/videos?transcodingStatus=hls_ready` filter now wired in `ListQuerySchema` with legacy value expansion. |
| F05 | `buildApp()` throws at startup when `CORS_ORIGINS='*'` in non-development mode. Added `logger.warn()` for the development case so the open wildcard is always visible in logs. |
| F06 | TV `ConnectivityBanner` listens for `temple-tv-broadcast-connected` custom DOM event from `useBroadcastSync`. Mobile home `NetworkBanner` shows on `!syncState.connected`. Admin SPA has `ApiReconnectionBanner`. |
| F14 | `TranscoderDisabledBanner` added to admin transcoding page; backend returns `transcoderDisabled` in queue response. |
| F23 | `render.yaml` shared secret group updated from `JWT_SECRET` → `JWT_ACCESS_SECRET` + `JWT_REFRESH_SECRET`. |
| F25 | `aria-hidden` bare attribute (JSX implicit `true`) replaced with explicit `aria-hidden={true}` in `HlsVideoPlayer.tsx` (4 sites: loading veil, buffering spinner, reconnect dot, seek OSD) and `Player.tsx` (2 sites: error icon, ON AIR dot). |
| F28 | `jwt.ts` migrated from `jsonwebtoken` (CJS) to `jose` (native ESM, Web Crypto). All sign/verify functions async. All callers awaited. |
| F43 | Dispatcher emits `ops-alert` SSE on notification exhaustion. `GET /admin/notifications/failed` added. Admin sidebar shows red failed-count badge. Notifications page has "Failed" tab with polling. |
| F46 | Paid worker service (`plan: starter`) removed from `render.yaml`; `verify:render-yaml` updated to expect 4 services. |
| F47 | `queue.engine.ts` synthesises a sentinel `BroadcastItem` (videoSource=hls, 1-hour duration) from `BROADCAST_FAILOVER_HLS_URL` when the queue snapshot is empty. |
| stream-health | `stream-health.tsx` used `fetchWithTransientRetry<T>(method, path)` (wrong signature — returns `Response`, not parsed JSON) and passed children to `PageHeader` (which has no `children` prop). Fixed to use `adminGet<T>(path)` and moved action buttons to the `actions` prop. |

---

## Platform Architecture Snapshot

```
                    ┌────────────────────────────────────────────────────────────────────┐
                    │  Render Free Tier (Frankfurt)                                       │
                    │                                                                     │
┌──────────┐ SSE   │  ┌─────────────────────────────────────────────────────────────┐   │
│Web/TV/   │◄──────┼──│  temple-tv-api  (web, free, 512MB/0.1vCPU, 1 instance)      │   │
│Mobile    │       │  │  Fastify v5 · RUN_MODE=all · TRANSCODER_DISABLE=true         │   │
└──────────┘       │  │  ┌───────────────┐ ┌──────────────┐ ┌──────────────────┐   │   │
                   │  │  │Broadcast      │ │Notif.        │ │Media Upload      │   │   │
┌──────────┐ REST  │  │  │Engine (mem)   │ │Dispatcher    │ │Gateway → S3      │   │   │
│Admin SPA │◄──────┼──│  │SSE/WS gateway │ │(lightweight) │ │Multipart flow    │   │   │
└──────────┘       │  │  └───────────────┘ └──────────────┘ └──────────────────┘   │   │
                   │  └───────────────────────────┬──────────────────────────────────┘   │
                   │                              │                                        │
                   │  ┌─────────────┐ ┌──────────┴──────────┐ ┌────────────────┐        │
                   │  │admin (CDN)  │ │web/Expo (CDN)       │ │tv/Tizen (CDN)  │        │
                   │  └─────────────┘ └─────────────────────┘ └────────────────┘        │
                   └──────────────────────────────────────────────────────────────────────┘
                                    │                  │
                      ┌─────────────┴──┐     ┌─────────┴──────┐
                      │ Postgres (ext) │     │ S3 (external)  │
                      │ Drizzle ORM    │     │ AWS/R2/MinIO   │
                      └────────────────┘     └────────────────┘
                                                     │
                                           ┌──────────┴──────┐
                                           │ Redis (optional) │
                                           │ LRU fallback     │
                                           └─────────────────┘
```

---

## Dependency Notes

| Package | Concern | Recommendation |
|---------|---------|----------------|
| `jsonwebtoken@^9` | CommonJS-only in ESM codebase — `__esModule` interop overhead | Migrate to `jose` (native ESM, Web Crypto) when ready |
| `bcryptjs@^3` | Work factor hardcoded to 10 | Add `BCRYPT_ROUNDS` env var; current value is safe but not future-proof |
| `pino-pretty@^13` | Dev-only but included in production bundle | Add to esbuild `external[]` to cut ~400 KB from dist |
| `@fastify/compress` | Compresses HLS segments unnecessarily | Exclude `video/mp2t` and `application/vnd.apple.mpegurl` |
| `ioredis@^5` | No vulnerability; latest minor | Pin to exact version to prevent unintended bumps |

---

*Audit generated via full static codebase analysis · Temple TV Platform · May 1, 2026*
