---
name: Memory leak investigation and fixes
description: Confirmed sources of RSS/External/ArrayBuffers growth and the fixes applied
---

## Confirmed Leaks + Fixes (June 2026)

### 1. unacked-alerts.ts store Map — unbounded growth (FIXED)
`store` Map in `modules/admin-ops/unacked-alerts.ts` accumulated every ops-alert
ever fired and never purged entries.  `sweep()` only set `emailedAtMs` but never
called `store.delete()`.  Fix: added TTL purge at the top of `sweep()` —
entries older than `STORE_MAX_AGE_MS = 2h` are deleted regardless of ack status.

### 2. storage.ts dec() double-decrement (FIXED)
`getObject()` and `getObjectRange()` each registered `dec()` on both `'close'`
and `'error'` events of the Readable.  When Node.js destroys a stream with an
error both events fire, calling `dec()` twice and corrupting `_activeStreamCount`
(it saturated at 0 due to `Math.max`).  Fix: one-shot `_decCalled` / `_decRangeCalled`
boolean flag makes dec() idempotent.

### 3. storage.ts readChunks() missing _shuttingDown guard (FIXED)
`readChunks()` async generator in `getObject()` had no `_shuttingDown` check
inside the loop, unlike `readRangeChunks()` in `getObjectRange()`.  On SIGTERM,
in-flight full-object streams kept issuing SUBSTRING DB queries.
Fix: added `if (_shuttingDown) break;` at the top of each loop iteration.

### 4. memory-watchdog.ts ArrayBuffers alert missing GC trigger (FIXED)
When `arrayBuffersAlertActive` fired, only the HLS segment cache trim was
attempted (a no-op on the MP4-only pipeline).  No GC or cache purge ran, so
the alert never helped recover.  Fix: added `purgeExpiredCacheEntries()` +
`(global as {gc?:()=>void}).gc?.()` to both the initial alert trigger and the
periodic re-trim path (every 18 samples = 3 min).
NOTE: `gcFn` is declared later in sample(); must use `global.gc` directly here.

## What Was NOT a Leak
- broadcast-v2 SSE/WS gateways: properly clean up on disconnect (aborted flag,
  one-shot cleanup, activeFrameHandler pointer)
- sseTokenStore in admin-ops: has its own 90 s TTL sweep
- _downloadInProgress Map in transcoder: has finally block cleanup
- broadcast fanout: proper close() with leader + subscriber teardown
- unacked-alerts adminEventBus listener: single module-level listener, correct
- admin SSE adminEventBus listener: correctly removed in cleanup at line 4291
- realtime WS gateway: proper cleanup on both 'close' and 'error'
