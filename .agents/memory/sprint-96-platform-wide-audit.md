---
name: Platform-wide audit sprint 96
description: 6-subagent deep audit across upload, TV, broadcast-v2, admin SPA, API infra, and transcoding. 2 genuine bugs fixed; 20+ confirmed false positives documented.
---

## Genuine Bugs Fixed

### 1. upload_chunks: plain index → uniqueIndex on (sessionId, chunkIndex) (Critical)
- **Root cause**: `lib/db/src/schema/upload-sessions.ts` had `index("idx_upload_chunks_session_chunk").on(t.sessionId, t.chunkIndex)` — a plain non-unique index. Two concurrent chunk requests for the same `(sessionId, chunkIndex)` could both pass the application-level TOCTOU idempotency check (`if existingChunk → 409`) and both succeed with `db.insert()`, creating duplicate rows.
- **Impact**: Corrupt assembly — `finalizeFromDbFallback` expects exactly one BYTEA row per chunkIndex; `completeMultipartUpload` produces a double-sized blob. Files would be corrupted silently.
- **Fix**: Changed to `uniqueIndex("idx_upload_chunks_session_chunk")`. Schema pushed to DB via `drizzle-kit push`. Future duplicate inserts raise a `23505 unique_violation` which the application's existing idempotency guard at line 668 already handles correctly (returns 409).
- **Why**: The DB unique constraint is the only truly atomic enforcement layer for concurrent inserts. Application-level checks have an inherent TOCTOU window regardless of semaphores.

### 2. stopBroadcastV2: missing closeAllBroadcastV2WsSessions() (Medium)
- **Root cause**: `artifacts/api-server/src/modules/broadcast-v2/index.ts` `stopBroadcastV2()` called `closeAllSseSessions()` (line 363) but NOT `closeAllBroadcastV2WsSessions()`. The function existed in `ws.gateway.ts` (line 52) and maintains `_activeSockets` Set, but was never imported or called in shutdown.
- **Impact**: During SHUTDOWN_PRECLOSE_DELAY_MS (10s in production), WS clients kept receiving broadcast frames from the still-running orchestrator heartbeat. Fastify's `app.close()` eventually closes the underlying sockets, but without a clean WebSocket Close frame — clients get an abrupt disconnect instead of a graceful close, causing unnecessary reconnect storms on rolling restarts.
- **Fix**: Added `closeAllBroadcastV2WsSessions` to the import from `ws.gateway.js` and called it immediately after `closeAllSseSessions()` in `stopBroadcastV2`.

## Confirmed False Positives (20+ items across 6 subagents)

### Upload pipeline false positives
- **Session expiry vs. in-flight assembly**: Safe — status is atomically flipped to `assembling`; TTL sweep only targets `uploading`. Assembly watchdog handles true hangs.
- **Finalize concurrent call**: Safe — advisory lock in `completeMultipartUpload` prevents double-assembly even if application status lock is reset for stale entries.
- **abortMultipartUpload on init failure**: Already handled — explicit try/catch after db.insert fails calls `storage().abortMultipartUpload`.
- **Assembly watchdog clearTimeout on success**: Already called at line 1614 (in the success path try block) and line 1616 (catch). Both db and db_fallback paths clear their respective watchdogs. Subagent report was incorrect.

### TV surface false positives
- HLS.js config (abrEwmaDefaultEstimate, liveSyncDurationCount, backBufferLength): All correct, matching production tuning documented in replit.md.
- FATAL/OFFLINE_HOLD handling: Correct — `useEffect` monitors snapshot.state and propagates `onFatal` to App.tsx ErrorBoundary.
- CEC/wake recovery: `lifecycle.ts` maps `onResumed` → reconnect callback; V2 hook watchdog handles the rest.
- Catalog cache (`ttv:catalog:v2:${__BUILD_ID__}`): Versioned + SWR + libraryRevision invalidation — correct.
- ErrorBoundary coverage: Very thorough — every major screen and lazy component wrapped, plus root fallback.

### Broadcast-v2 server false positives
- badUrlCache size: Capped at 500 entries with lazy GC — correct.
- reEnableAllSuspended order: Called before `broadcastOrchestrator.start()` — correct.
- Dead-air escalation timer in stop(): Cleared in `stop()` along with 6 other timers — correct.
- listQueue N+1: Single `SELECT *` with ORDER BY and LIMIT 1000 — correct.
- 429 schemas: All routes confirmed to use `_429err` alias — correct.
- Body limits: All mutation routes have explicit `bodyLimit: 1048576` — correct.
- frameQueue cap: Enforced at 500 frames in WS resume handler — correct.
- SSE heartbeat unref: Called — correct.

### Admin SPA false positives
- pagination.tsx `<a>` tags: PaginationLink is unused in all admin pages (grep returned empty) — not a bug.
- global-api-error-toasts TRANSIENT_SHOW_THRESHOLD=2: Intentional design (code comment explains: single rolling-restart blip should not alarm operators) — not a bug.
- normalisePath dedup collision: Short numeric IDs (1 digit) are NOT replaced by `:id` regex (requires 4+ digits); different action paths (`/role` vs `/ban`) remain distinct — not a bug.

### Transcoding + storage false positives
- Job claim race: Atomic `UPDATE...WHERE status='queued' RETURNING *` — safe across replicas.
- COMPLETED→PENDING transition: No automated path exists — manual only via fresh enqueue.
- Faststart S3 multipart cleanup: Already in catch block with `abortMultipartUpload` — correct.
- Orphan detection joins: Correct LEFT JOIN with `isNull(v.id)` — correct.

### API infrastructure false positives
- env.ts validation: All vars validated with Zod, missing required vars crash cleanly at startup — correct.
- Plugin registration order: Correct (sensible→cookie→helmet→cors→rateLimit→compress→auth→csrf) — correct.
- JWT validation: `jose` enforces HS256 only; refresh token rotation is atomic with revokedAt guard — correct.
- CSRF protection: Admin routes require X-Admin-CSRF:1; Bearer exempt — correct.
- Notification delivery: Atomic UPDATE...RETURNING prevents double-firing; exponential backoff + max 5 attempts — correct.
