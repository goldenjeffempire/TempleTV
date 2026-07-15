---
name: Broadcast Daemon Architecture
description: Two-process architecture for zero-downtime API deployments — daemon on port 9000 owns the broadcast engine, API proxies to it.
---

## Rule
The broadcast engine runs in a separate permanent process (RUN_MODE=broadcast, port 9000). The API server (port 8080) is a proxy-only client when BROADCAST_DAEMON_URL=http://127.0.0.1:9000 is set.

**Why:** API restarts previously caused 5–30s broadcast gaps. With the daemon-proxy split, API restarts reconnect within milliseconds since the daemon never stops.

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

## Production status (as of Jul 2026 — corrected)
This split now runs in the Replit VM deployment too, not just dev workflows — see `production-supervisor-vm-deploy.md`. Before this fix, `.replit [deployment]` and `render.yaml` both ran a single `RUN_MODE=all` monolith, so publishing the API always killed the live broadcast. Daemon binds `127.0.0.1` only now (was `0.0.0.0`) — it is an unauthenticated internal implementation detail, never meant to be reachable except via the API's proxy.
