---
name: Platform 500-error hardening sprint
description: Comprehensive audit and fix of all Server Error (500) sources — unhandled rejections, orchestrator bugs, mobile UI, memory watchdog.
---

## What was fixed

### Memory watchdog (infrastructure/memory-watchdog.ts)
Two-tier threshold: `MEMORY_WARN_RSS_MB` (default 450) only WARNs + logs (3 consecutive samples required). New `MEMORY_RESTART_RSS_MB` (default 600) controls forced restart with its own `consecutiveRssOverRestart` counter. Production: set `MEMORY_RESTART_RSS_MB=490`.

### Broadcast orchestrator bugs (broadcast-v2/engine/broadcast-orchestrator.ts)
6 bugs fixed:
- Emergency filler SSRF gate was rejecting the configured URL
- HLS detection false-negative on `index` path segments
- `clearBadUrl` not called on skip (stuck bad-URL loop)
- 300s→3600s max item duration cap
- YouTube 404/410 treated as hard-skip (not retry)
- Large-queue filler path read queue from wrong variable

### Unhandled rejection process-crash bugs
**Pattern:** `void somePromise()` without `.catch()` means a rejection becomes an unhandled rejection → crashes the Node process in production.

Fixed in:
- `broadcast-orchestrator.ts` — 2 locations (`busListener` callback, `scheduleAutoStart`)
- `rest.routes.ts:561` — reprobe route background reload
- `rest.routes.ts:132` — auto-enqueue-missing-hls background reload

### Mobile prayer request stuck loading (mobile/app/player.tsx)
`submitPrayerRequest().then(ok => { setSending(false); })` — missing `.catch()` meant API failure left button permanently disabled. Fixed: `.catch(() => { setSending(false); })` added.

## Key audit findings (confirmed-safe, not bugs)
- `boostTranscodePriority`, `pruneExpiredRefreshTokens`, `runSessionCleanup` all have internal error handling
- `row!.` after `.insert().returning()` is safe — insert failure throws before reaching the assertion
- TV hooks (`useSeries`, `usePlaylists`) already have `.catch()` returning safe defaults
- Admin dashboard secondary queries already use `.catch()` returning empty defaults
- `qc.invalidateQueries` in TanStack Query handles errors internally — `void` is safe
- `serverSync.ts` fire-and-forget fetches already have `.catch(() => {})`
- admin-ops, admin-broadcast, admin-videos, auth modules: zero uncaught `void` patterns

## Why
`void promise` without `.catch()` is the #1 source of process crashes in Node async code. Any rejection in a `void`-ed promise bypasses Fastify's error handler entirely and becomes a global unhandledRejection — which in Node ≥15 terminates the process by default.

## How to apply
When writing fire-and-forget async calls, always use:
```ts
void someAsyncFn().catch((err) => {
  logger.warn({ err }, "background task failed (non-fatal)");
});
```
Never just `void somePromise()` without a catch.
