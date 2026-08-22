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

## Admin client contract

Treat both daemon health and aggregated platform health as progressive payloads. Core public playback fields are guaranteed, but operator-only or nested diagnostic groups can be absent during proxying, auth refresh, or a rolling deployment.

**Why:** The private daemon uses a minimal runtime and may not establish `req.principal` for a proxied public health request. It then correctly returns the public payload, while an admin page that assumes `prodSync`, `drift`, or `skipInfo` exists can crash despite a healthy ON AIR broadcast.

**How to apply:** Normalize each health response once at the client query boundary, preserve all reported values, and clearly label missing diagnostic groups as unavailable. A partial platform-health response must render as degraded, not healthy. Never let optional diagnostics gate or crash core Master Control playback controls.
