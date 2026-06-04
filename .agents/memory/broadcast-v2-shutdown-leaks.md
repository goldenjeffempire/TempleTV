---
name: Broadcast-v2 shutdown memory leaks — all 9 root causes fixed
description: All SSE/timer/worker shutdown leaks causing 514 MB RSS + watchdog restarts, fixed across two sessions.
---

## Session 1 fixes (previous session)

### 1. orchestrator.stop() never called (CRITICAL)
`stopBroadcastV2()` never called `broadcastOrchestrator.stop()`. All 7 orchestrator timers kept running after every SIGTERM.
**Fix:** `stopBroadcastV2()` now calls `broadcastOrchestrator.stop()` (step 4).

### 2. workerSupervisor.stopAll() never called (CRITICAL)
5 supervised workers (media-integrity-scanner, orphan-cleanup, queue-integrity-validator, faststart-recovery, viewer-count-metrics-updater) kept running after shutdown, holding open DB pool connections.
**Fix:** `stopBroadcastV2()` now calls `workerSupervisor.stopAll()` (step 3).

### 3. bootRetryTimer + fanoutRetryTimer never cleared (HIGH)
Retry timers fired post-shutdown, attempting re-init inside a dying process.
**Fix:** `stopBroadcastV2()` now clears both timers first (step 1).

### 4. v2 SSE invisible to shutdown drain loop + heartbeat not cleared (HIGH)
`sse.gateway.ts` (broadcast-v2) never called `sseCounter.inc/dec`. The 10s heartbeat kept connections alive.
**Fix:** v2 SSE now uses `sseCounter`, idempotent cleanup, `openSseCleanups` registry, `closeAllSseSessions()` called from `stopBroadcastV2()`.

### 5. stopViewerSlopeMonitor() never called (MEDIUM)
1-min setInterval kept event loop alive post-shutdown.
**Fix:** `main.ts` shutdown now calls `stopViewerSlopeMonitor()` before `stopBroadcastV2()`.

---

## Session 2 fixes (this session)

### 6. v1 broadcast SSE, realtime SSE, admin-ops SSE — no force-close on shutdown (HIGH)
All three v1 SSE handlers (`broadcast.routes.ts`, `realtime/sse.gateway.ts`, `admin-ops.routes.ts`) used `sseCounter.inc/dec` but had NO force-close mechanism. The drain loop timed out waiting for clients to disconnect voluntarily, emitting "SSE drain timeout reached" warnings on every restart. Heartbeat timers (15 s, 10 s, 5 s) were also NOT `.unref()`'d, holding the event loop open during drain.

**Fix:**
- Each handler has a module-level `openXxxSseCleanups: Set<() => void>` registry + exported `closeAllXxxSseSessions()`.
- Cleanup closures are idempotent (`let xxxSseClosed = false` guard), self-remove from registry on first call.
- Heartbeat timers now have `.unref?.()` on all three handlers.
- `main.ts` shutdown calls all three `closeAll*()` functions before the drain loop, so the drain always completes in `O(ms)`.

**Files changed:** `broadcast.routes.ts`, `realtime/sse.gateway.ts`, `admin-ops.routes.ts`, `main.ts`.

### 7. prodQueueSync.stop() never called during shutdown (MEDIUM)
`prodQueueSync.start()` is called in `main.ts` but `stop()` was never called in the shutdown handler. The 30s poll interval + any in-flight ffprobe child processes kept running post-SIGTERM.
**Fix:** `main.ts` shutdown now dynamically imports and calls `prodQueueSync.stop()`.

### 8. _svaCache (auth.ts) grows unboundedly with authenticated users (LOW)
`_svaCache` (keyed by userId) expires entries on read (30s TTL check) but never GC's stale entries from the Map. On a 24/7 server, this grows to O(distinct authenticated users).
**Fix:** 5-min `.unref()`'d `setInterval` sweeps entries older than `_SVA_TTL_MS`.

---

### 9. broadcast-v2 WS gateway — no force-close on shutdown (HIGH)
`broadcast-v2/io/ws.gateway.ts` had no active-socket registry and no `closeAll`. The v1 realtime WS gateway and all SSE gateways drain on shutdown, but established v2 **player** WS sockets kept their orchestrator `frame` listener registrations alive and blocked `app.close()` until `SHUTDOWN_DRAIN_MS`, escalating to SIGKILL — a restart-loop signature.
**Fix:** module-level `_activeSockets: Set<{terminate?()}>` + exported `closeAllBroadcastV2WsSessions()` (mirrors `closeAllRealtimeWsSessions`); `add` on connect, `delete` in close handler; wired into `main.ts` shutdown next to the v1 WS drain. `terminate()` fires the existing close handler so all per-socket cleanup still runs; `Set.delete`/`clear` + idempotent `releaseCounter` make terminate/close ordering safe.

## WS drain parity rule
Every WS gateway needs the same drain treatment as SSE: a module-level active-socket registry + exported `closeAll*()` wired into `main.ts` shutdown. Fastify `app.close()` does NOT auto-close established WS connections — un-drained sockets hang shutdown until the drain timeout and force SIGKILL restarts.

## Key pattern
Any SSE handler that calls `sseCounter.inc()` MUST also:
1. Have a module-level force-close registry (`Set<() => void>`) + exported `closeAll*()`.
2. Have an idempotent cleanup closure (closed-flag guard, self-removes from registry).
3. Use `.unref?.()` on all internal `setInterval` timers (heartbeats).
4. Wire the `closeAll*()` call into `main.ts` shutdown BEFORE the drain loop.

**Why:** Without force-close, the drain loop always hits its timeout on any restart with active SSE clients. With it, the loop completes in < 100ms.
