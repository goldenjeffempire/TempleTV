---
name: Production audit sprint 72
description: 13 files edited — broadcast invalidation gaps in transcoding.tsx, 429 schema completeness sweep across 11 backend route files, prod-sync ffprobe child.unref()
---

## Fixes

### 1. transcoding.tsx — 5 mutations missing broadcast invalidations (HIGH IMPACT)
All 5 mutations (retryMutation, cancelMutation, bulkTranscodeMutation, retryAllMutation, clearFinishedMutation) were missing `broadcast-queue`, `broadcast-v2-engine-health`, `broadcast-v2-diagnostics`, `broadcast-v2-remediation-report` invalidations.

**Why:** broadcast-v2.tsx handles transcoding-update SSE → invalidates these keys, but ONLY when that page is mounted. When operator is on the Transcoding page, the SSE handler doesn't run → broadcast panel stays stale until navigation.

**How to apply:** Any mutation that changes HLS-readiness (retry/cancel/bulk-transcode) must directly invalidate all broadcast-v2 keys, not rely on SSE-driven invalidation from another page.

### 2. videos.tsx — 5 mutations missing broadcast-v2-diagnostics + broadcast-v2-engine-health
transcodeMutation, faststartMutation, batchRetryMutation, bulkTranscodeMutation, bulkDeleteMutation were missing these two keys (already had broadcast-queue and remediation-report).

### 3. prod-sync/prod-queue-sync.ts — ffprobe spawn missing child.unref()
45s kill timer wrapped the child but never called child.unref() → held event loop open during SIGTERM drain window.

### 4. 429 schema completeness sweep — 36 schemas added across 11 files
Routes with `config: { rateLimit: ... }` but no `429: z.object({ error: z.string() })` in their response schema:
- admin-videos.routes.ts: 6 routes (PATCH/:id, DELETE/:id, POST/:id/transcode, faststart, reset-for-reupload, bulk-transcode)
- playlists.routes.ts: 6 routes (POST /, PATCH/:id, DELETE/:id, POST/:id/videos, DELETE/:id/videos/:videoId, POST/:id/reorder)
- notifications.routes.ts: 4 routes (GET /history, GET /, GET /stats, POST /send)
- push.routes.ts: 2 routes (POST /push-tokens, POST /push/web-subscriptions)
- youtube-sync.routes.ts: 3 routes (POST /sync, GET /sync/category-stats, POST /recategorize)
- scheduled-notifications.routes.ts: 2 routes (POST /schedule, DELETE /scheduled/:id)
- live-ingest.routes.ts: 9 routes (POST endpoints, PATCH endpoints, DELETE endpoints, rotate-key, promote, probe, POST stop, POST sweep, POST validate-key)
- live-overrides.routes.ts: 6 routes (POST /start, POST /stop, POST /extend, POST /schedule, DELETE /scheduled/:id, POST /report-failure)
- broadcast.routes.ts: 5 routes (POST /skip, POST /playback-telemetry, POST /prayer, PATCH /playback/state; reaction already had 429)
- auth.routes.ts: 5 entries (POST /extend, GET /session/ping, PATCH /password, POST /device-link/create; login already had 429)

**Pattern:** Routes using `app.get<{...}>()` raw (not ZodTypeProvider) cannot carry 429 schemas — SSE endpoint and sse.gateway.ts are intentional exceptions.

## False positives confirmed clean
- transcoder.dispatcher.ts ffmpegRecheckTimer: already has .unref() at line 113
- sse.gateway.ts manual 429 send: uses raw app.get() — no Zod schema possible, correct as-is
- user.routes.ts manual 429 sends at lines 217/400: both routes have 429 schemas at lines 196/376
- broadcast-v2.tsx transcoding-update SSE handler: already invalidates broadcast-queue + engine-health + transcoding-panel + remediation-report
