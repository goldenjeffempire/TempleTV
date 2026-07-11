---
name: Broadcast deployment resilience — three implementation gaps
description: Three gaps found and fixed when implementing "keep broadcast running across restarts/crashes/deployments": SSE proxy resilience, restart history log, daemon liveness monitor.
---

## Restart log — `broadcast_daemon_restarts` table

Every orchestrator boot writes a row (fire-and-forget, never blocks startup):
- `restartLogRepo.write()` called after `this.started = true` in `start()`
- `hydrateSource` field on orchestrator set during `hydrate()`: "checkpoint" (runtime or player checkpoint found), "disk_backup" (DB unavailable), "cold_start" (nothing)
- REST endpoint `GET /broadcast-v2/restart-history` (auth-guarded) returns last 20 records
- Admin panel `RestartHistoryCard` polls every 5 min, shows resume source badge + position

**Why:** Operators need to verify state is preserved after each crash/restart without checking raw DB.

**How to apply:** `restartLogRepo` lives in `broadcast-v2/repository/restart-log.repo.ts`; `hydrateSource` is a private field on the orchestrator; must stay in sync with every hydrate path.

---

## Daemon liveness monitor

`daemon-liveness-monitor.ts` polls `BROADCAST_DAEMON_URL/health` every 30 s; fires `ops-alert` (level "error", code "DAEMON_UNREACHABLE") after 3 consecutive failures (~90 s downtime). Uses `adminEventBus.push("ops-alert", {...})` — there is no standalone `sendOpsAlert` function.

Started from `broadcastDaemonProxyRoutes` via Fastify `onReady` hook. Uses `_started` boolean flag (not `pollTimer`) to prevent double-start — `pollTimer` is only assigned inside a 15 s `setTimeout`, so the guard `if (pollTimer !== null)` doesn't work when `startDaemonLivenessMonitor` is called twice quickly (e.g. both route-prefix registrations fire `onReady`).

**Why:** Without it, the API never knew the daemon was down — operators had to notice dead-air themselves.

---

## Resilient SSE proxy — 30 s retry window

`sseDaemonProxy` in `daemon-proxy.ts` now retries the daemon for up to 30 s before failing:
1. First connection failure → commit SSE headers immediately (keeps client alive)
2. Send `: daemon reconnecting\n\n` SSE comments every 2 s
3. Per-probe 5 s timeout, interruptible by client disconnect via `clientAbort` AbortController
4. If daemon recovers within 30 s → pipe the stream transparently (restart invisible to viewers)
5. If still down → send `{"type":"reconnect","retryAfterMs":5000}` frame and close

**Why:** The old proxy returned 502 immediately on any connection error — a daemon crash caused an immediate visible error on every connected client instead of a seamless reconnect.

**How to apply:** All timing constants are at the top of the function (`SSE_RETRY_MAX_MS`, `SSE_RETRY_INTERVAL_MS`, `SSE_PROBE_TIMEOUT_MS`).
