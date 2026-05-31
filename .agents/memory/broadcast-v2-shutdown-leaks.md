---
name: Broadcast-v2 shutdown memory leaks
description: 5 root causes of RSS exceeding 430 MB + SIGKILL restart loops; all fixed.
---

## The 5 root causes

### 1. orchestrator.stop() never called (CRITICAL)
`stopBroadcastV2()` in `broadcast-v2/index.ts` called only `flushCheckpointForShutdown()` and `broadcastFanout.close()`. It never called `broadcastOrchestrator.stop()`. All 7 orchestrator timers kept running after every SIGTERM: `tickTimer` (2 s), `checkpointTimer` (5 s), `trimTimer` (60 s), `keepAliveTimer` (15 s), `selfHealEmptyTimer` (10 s), `selfHealStaleTimer` (30 s), `currentItemProbeTimer` (30 s).

**Fix:** `stopBroadcastV2()` now calls `broadcastOrchestrator.stop()` (step 4).

### 2. workerSupervisor.stopAll() never called (CRITICAL)
5 supervised workers (media-integrity-scanner every 2 min, orphan-cleanup every 4 h, queue-integrity-validator every 10 min, faststart-recovery every 60 s, viewer-count-metrics-updater every 5 s) kept running after shutdown. Each holds open DB pool connections and setTimeout/setInterval timers.

**Fix:** `stopBroadcastV2()` now calls `workerSupervisor.stopAll()` and resets `supervisedWorkersStarted = false` (step 3).

### 3. bootRetryTimer + fanoutRetryTimer never cleared (HIGH)
If the orchestrator failed its first start() or Redis was unavailable at boot, the retry timers were scheduled but never cleared in `stopBroadcastV2()`, so they fired post-shutdown and attempted re-init inside a dying process.

**Fix:** `stopBroadcastV2()` now clears both timers first (step 1).

### 4. v2 SSE connections invisible to shutdown drain loop (HIGH)
`sse.gateway.ts` incremented `activeSseConnections` (Prometheus) but never called `sseCounter.inc()`/`dec()`. The drain loop in `main.ts` polls `sseCounter.get()` — it always read 0 for v2 SSE, so the drain exited immediately while connections were still open. `app.close()` then truncated live SSE streams.

Additionally, the 10-second heartbeat `setInterval` inside each SSE handler was never cleared on shutdown, keeping those connections warm.

**Fix:**
- `sse.gateway.ts` now calls `sseCounter.inc()` on connect.
- A single idempotent `cleanup()` closure (guarded by `let closed = false`) handles all teardown: `clearInterval(heartbeat)`, `orchestrator.off("frame")`, `releaseCounter()`, `sseCounter.dec()`, `activeSseConnections.dec()`, `reply.raw.end()`.
- Each connection registers its `cleanup` in a module-level `openSseCleanups: Set<() => void>`.
- `closeAllSseSessions()` (exported) iterates the set and invokes all cleanups — called by `stopBroadcastV2()` (step 2) so the drain loop completes in ms rather than timing out.

### 5. stopViewerSlopeMonitor() never called (MEDIUM)
`startViewerSlopeMonitor()` (admin-ops.routes.ts) starts a 1-min `setInterval`. `stopViewerSlopeMonitor()` exists in viewer-slope-monitor.ts but was never called during shutdown — kept the event loop alive after everything else stopped.

**Fix:** `main.ts` shutdown handler now dynamically imports and calls `stopViewerSlopeMonitor()` before `stopBroadcastV2()`.

## Files changed
- `artifacts/api-server/src/modules/broadcast-v2/index.ts` — `stopBroadcastV2()` rewritten with 6-step ordered shutdown
- `artifacts/api-server/src/modules/broadcast-v2/io/sse.gateway.ts` — `sseCounter` integration + `openSseCleanups` registry + `closeAllSseSessions()` export
- `artifacts/api-server/src/main.ts` — added `stopViewerSlopeMonitor()` call in shutdown handler

**Why:** The combination of these leaks caused RSS to climb on every watchdog-restart cycle (workers didn't stop, timers kept firing, SSE heartbeats kept connections alive) until the hard SIGKILL threshold was hit.
