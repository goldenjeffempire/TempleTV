---
name: Broadcast daemon — Render pserv architecture
description: Documents the daemon/API split, fromService wiring pattern, and env.ts composition logic for the BROADCAST_DAEMON_URL. Prevents future agents from reverting the split.
---

## The split

The broadcast engine runs as a separate paid Render private service so an API-only restart does not restart the broadcast engine. Verify current plan names and prices from Render rather than treating historical nicknames or prices as current.

Before this split: `RUN_MODE=all` in the API process meant every `git push → API deploy` killed the orchestrator and restarted the current video from position 0 (~15–30 s dead air per deploy).

After the split:
- Daemon: `RUN_MODE=broadcast`, `PORT=9000`. Owns the queue, all workers, SSE/WS frames.
- API: `RUN_MODE=all` + `BROADCAST_DAEMON_URL` set → `ensureBroadcastV2Started()` is skipped (`main.ts:798`). All `/broadcast-v2` traffic proxied via `daemon-proxy.ts`.

**Why:** Process separation alone does not prevent a deployment trigger from restarting both services. Administrative connectivity, API restarts, and deployment-trigger policy are separate failure boundaries.

## fromService wiring in render.yaml

```yaml
# In temple-tv-api envVars:
- key: BROADCAST_DAEMON_HOST
  fromService:
    name: temple-tv-broadcast-daemon
    type: pserv
    property: host
- key: BROADCAST_DAEMON_PORT
  fromService:
    name: temple-tv-broadcast-daemon
    type: pserv
    property: port
```

Render injects the daemon's internal hostname + port at deploy time. The URL cannot be hardcoded because Render appends a random suffix (e.g. `temple-tv-broadcast-daemon-2j3e`).

## env.ts composition

`artifacts/api-server/src/config/env.ts` `loadEnv()` composes `BROADCAST_DAEMON_URL`:
```
if (!BROADCAST_DAEMON_URL && BROADCAST_DAEMON_HOST) {
  BROADCAST_DAEMON_URL = `http://${BROADCAST_DAEMON_HOST}:${BROADCAST_DAEMON_PORT ?? 9000}`
}
```
- `BROADCAST_DAEMON_HOST` — optional string (fromService)
- `BROADCAST_DAEMON_PORT` — optional coerced number (fromService)
- When neither is set (local dev without daemon): engine runs in-process (legacy behavior)

## npm script

`artifacts/api-server/package.json`: `"start:render-daemon"` uses `--max-old-space-size=300` (daemon has no HLS cache, no upload buffers, no FFmpeg — 300 MiB is sufficient on Starter's 512 MiB RAM).

## Daemon deployment trigger

Do not couple unrelated admin-only releases to broadcast-runtime deployments.
Deploy compatible API/daemon changes together through a planned rollout.

**Why:** A broad deployment trigger can restart the authoritative runtime even
though the admin application does not own that runtime. Conversely, an outdated
daemon can serve a contract incompatible with newer API proxy code.

**How to apply:** Check the current repository filters and the operator's actual
Blueprint synchronization state before promising deployment independence.
Changing a repository file does not prove Render has applied its trigger policy.

## Memory thresholds for daemon (Starter: 512 MiB)

- `NODE_OPTIONS=--max-old-space-size=300`
- `MEMORY_WARN_RSS_MB=380`
- `MEMORY_RESTART_RSS_MB=430`
- `MEMORY_ABSOLUTE_MAX_RSS_MB=450`

The memory watchdog triggers graceful SIGTERM (not OOM kill), so `flushCheckpointForShutdown()` still runs and broadcast position is saved on memory-triggered restarts.

## Do NOT revert

- Do not remove `BROADCAST_DAEMON_HOST` / `BROADCAST_DAEMON_PORT` from the API service envVars
- Do not set `RUN_MODE=broadcast` on the API service (it would start the engine there again)
- Do not remove the `if (!env.BROADCAST_DAEMON_URL)` guard in `main.ts:798`
- Do not rename the daemon service (the `fromService.name` must match exactly)

## Free API private-network diagnosis

Do not assume that the API's Free instance type prevents it from calling the paid private daemon.

**Why:** Render's official Free and private-network documentation allows Free web services to send private-network requests, although they cannot receive them. Services must be in the same workspace and region.

**How to apply:** Check the actual daemon service status, its own startup logs, internal host/port wiring, and workspace/region before suggesting a paid-plan change. An API-process `broadcast.started=false` is not proof that the separate daemon is stopped.

Sources: https://render.com/docs/free and https://render.com/docs/private-network.
