---
name: Broadcast Daemon Architecture
description: Separate broadcast-clock ownership from API/admin lifecycles; verify media delivery independently.
---

## Rule
The broadcast engine runs in a separate permanent process (RUN_MODE=broadcast, port 9000). The API server (port 8080) is a proxy-only client when BROADCAST_DAEMON_URL=http://127.0.0.1:9000 is set.

**Why:** API restarts previously reset or interrupted the broadcast runtime. A separate daemon preserves the authoritative clock, but that alone does not establish uninterrupted media delivery or an unconditional recovery time.

## Continuity acceptance

Treat daemon-clock continuity and successful audience media playback as separate
acceptance criteria. Administrative logout/tab close/network loss must not own
the station lifecycle. Never infer continuous delivery merely because the daemon
is healthy or its sequence advances.

**Why:** The user requires broadcasts to remain independent of administrative
sessions; uploaded-media requests may still share an API process that can fail.

**How to apply:** Test administrative disconnections and process failures with
an independent runtime observer, and separately verify actual player/media
behavior. Report hosting, leadership-loss, and real-device gates explicitly.

## How to apply
- Only restart "Start API" for deployments. The "Broadcast Daemon" must NOT be restarted during API deployments — that's the whole point.
- If the daemon itself needs a restart (e.g. after a build changing broadcast logic): stop it, then restart it BEFORE restarting the API (or the API will 502 on broadcast endpoints until daemon is back).

## Key files
- `artifacts/api-server/src/modules/broadcast-v2/io/daemon-proxy.ts` — SSE streaming proxy + REST catch-all proxy (Fastify plugin `broadcastDaemonProxyRoutes`)
- `config/env.ts` — `RUN_MODE` enum includes `"broadcast"`; `BROADCAST_DAEMON_URL: z.string().url().optional()`
- `app.ts` — when BROADCAST_DAEMON_URL set, mounts `broadcastDaemonProxyRoutes` instead of `broadcastV2Routes`; adds raw TCP WebSocket upgrade proxy via `net.createConnection` + `server.prependListener("upgrade", ...)`
- `main.ts` — `runBroadcastDaemon()` (minimal Fastify + broadcast-v2 routes + listen PORT); early-return when mode==="broadcast"; `ensureBroadcastV2Started()` skipped when BROADCAST_DAEMON_URL set
- `broadcast-orchestrator.ts` `bump()` — event-driven checkpoint on item.advanced/skipped/queue.changed/override.started/ended

## Critical proxy URL bug (fixed)
`httpDaemonProxy` must use `req.url` directly (already the full path, e.g. `/api/v1/broadcast-v2/state`). Prepending `/api/v1/broadcast-v2` again creates double prefix (`/api/v1/broadcast-v2/api/v1/broadcast-v2/state`) → 404.

## Workflows
- "Broadcast Daemon": `RUN_MODE=broadcast PORT=9000` — configured WITHOUT `waitForPort` (Replit's port health check has a timing issue when waitForPort is set; daemon opens port 9000 within 1s but Replit times out)
- "Start API": `RUN_MODE=all BROADCAST_DAEMON_URL=http://127.0.0.1:9000 PORT=8080`

## Startup sequence — order matters
1. Start Broadcast Daemon FIRST (opens port 9000 within ~1s)
2. Then start/restart API (it sees BROADCAST_DAEMON_URL → skips local engine → proxies immediately)

## Do NOT run both engines simultaneously
Starting the daemon while the API is still running its own broadcast engine (old RUN_MODE=all without BROADCAST_DAEMON_URL) causes both to write conflicting checkpoint/queue state to the DB. The daemon crashes after ~125s.

## Production status
Render production runs the daemon as a private service and the API as a separate web service. The daemon binds `0.0.0.0` in production so Render private networking can reach it; it remains unreachable from the public internet except through the API proxy.

Replit development uses the separate local daemon/API workflows. Replit VM deployment uses the supervised two-process pattern documented in `production-supervisor-vm-deploy.md`.
