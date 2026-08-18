---
name: Proxy-mode system-health pattern
description: Admin system-health endpoint must fetch from daemon when BROADCAST_DAEMON_URL is set — local orchestrator is never started in proxy mode.
---

# Proxy-mode system-health pattern

## The rule
`/admin/broadcast/system-health` (in `admin-ops.routes.ts`) must detect `env.BROADCAST_DAEMON_URL` and `fetch` the daemon's public `/api/broadcast-v2/health` endpoint (loopback, no auth) to get real broadcast state. Only fall back to local orchestrator/workerSupervisor when BROADCAST_DAEMON_URL is not set (standalone mode).

**Why:** In proxy mode the API server's local `broadcastOrchestrator` is never started — all V2 workers, the orchestrator, and the content-rotation state live in the broadcast daemon (port 9000). The local `isStarted()` always returns false → the endpoint permanently reported "Broadcast orchestrator is not started" even with broadcast running perfectly.

**How to apply:**
- Check `if (env.BROADCAST_DAEMON_URL)` at the top of the system-health handler.
- Fetch `${env.BROADCAST_DAEMON_URL}/api/broadcast-v2/health` with a 4s timeout.
- On success, use daemon's `boot.started`, `sequence`, `itemCount`, `contentRotation`, and `workerAggregate.workers`.
- On fetch failure (mid-restart), fall through to local state — endpoint must never hard-fail.
- The public health payload in `rest.routes.ts` MUST include `contentRotation` and `workerAggregate` (added alongside this fix) so no auth header is needed from the API server.
