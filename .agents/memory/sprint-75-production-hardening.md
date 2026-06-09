---
name: Production audit sprint 75
description: 5 fixes — SSE heartbeat unref, schedule/playlist remediation-report invalidation, channels response schemas, admin-ops 429 schemas
---

## Fixes

### 1. youtube-live.routes.ts — SSE heartbeat setInterval missing `.unref()`
- Line ~160: `const heartbeat = setInterval(…, 25_000)` had no `.unref()`
- Fix: added `heartbeat.unref()` immediately after setInterval
- **Why:** un-unref'd setInterval keeps Node event loop alive after SIGTERM, blocking graceful shutdown drain

### 2. schedule.tsx — 3 mutations missing `broadcast-v2-remediation-report` invalidation
- createMutation / updateMutation / deleteMutation each updated schedule entries that affect what airs
- Fix: added `void qc.invalidateQueries({ queryKey: ["broadcast-v2-remediation-report"] })` to all 3 `onSuccess` handlers

### 3. playlists.tsx — remediation-report + admin-stats gaps
- createMutation / deleteMutation missing `broadcast-v2-remediation-report`
- updateMutation missing both `admin-stats` AND `broadcast-v2-remediation-report`
- Fix: added both invalidations to all 3 mutations

### 4. channels.routes.ts — 6 rate-limited admin routes had NO response schemas
- POST /admin/channels, PATCH /admin/channels/:id, DELETE /admin/channels/:id,
  POST /admin/channels/:id/queue, DELETE /admin/channels/:channelId/queue/:itemId,
  PATCH /admin/channels/:channelId/queue/:itemId/active
- Added `ChannelSchema`, `ChannelQueueItemSchema`, `ErrSchema` Zod schemas near top of file
- Added full `response:` blocks to all 6 routes (201/409/429, 200/404/429, 204/400/404/429, etc.)
- **Why:** Fastify v5 + ZodTypeProvider requires response schemas for correct TS types and OpenAPI generation

### 5. admin-ops.routes.ts — 23 rate-limited routes missing `429: z.object({ error: z.string() })`
Routes fixed:
- GET /process-info, GET /transcoder-status, GET /transcoder/health
- GET /diagnostics/memory/history, POST /diagnostics/gc
- DELETE /videos/upload/:sessionId
- POST /transcoding/retry-failed, POST /transcoding/cancel/:id, DELETE /transcoding/:id
- POST /transcoding/requeue/:videoId, DELETE /transcoding/clear
- PATCH /playback/config
- POST /alerts/test, POST /alerts/:id/resolve
- POST /live/override/start, POST /live/override/stop, POST /live/override/extend
- POST /live/override/preview-youtube
- POST /live/override/schedule, DELETE /live/override/schedule/:id
- POST /session, POST /session/refresh, POST /purge

**Intentionally skipped** (no Zod schema block — use `app.post/delete` shorthand, not `r.post/delete`):
- POST /session/auto (bare app.post with inline rate-limit config only)
- DELETE /session (bare app.delete)
- POST /sse-token (bare app.post)
- POST /diagnostics/heap-snapshot (binary stream — no Zod response schema by design)

## Build verification
- esbuild syntax check: all 3 modified route files passed cleanly
- Full `pnpm run build` on api-server: succeeded (dist/index.mjs 6.8mb)
- API restarted: no errors in logs
