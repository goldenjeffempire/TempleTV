---
name: Broadcast daemon — Render pserv architecture
description: Documents the daemon/API split, fromService wiring pattern, and env.ts composition logic for the BROADCAST_DAEMON_URL. Prevents future agents from reverting the split.
---

## The split

The broadcast engine (`BroadcastOrchestrator`) runs as a separate Render **pserv** (`temple-tv-broadcast-daemon`, Starter plan $7/mo) so API rolling deploys never restart the broadcast engine.

Before this split: `RUN_MODE=all` in the API process meant every `git push → API deploy` killed the orchestrator and restarted the current video from position 0 (~15–30 s dead air per deploy).

After the split:
- Daemon: `RUN_MODE=broadcast`, `PORT=9000`. Owns the queue, all workers, SSE/WS frames.
- API: `RUN_MODE=all` + `BROADCAST_DAEMON_URL` set → `ensureBroadcastV2Started()` is skipped (`main.ts:798`). All `/broadcast-v2` traffic proxied via `daemon-proxy.ts`.

**Why:** API deployments restart the `web` service. A `pserv` is independent — it only redeploys when `buildFilter.paths` includes a changed file (broadcast engine code, not admin/TV/mobile changes).

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

## buildFilter.paths for the daemon

The daemon's `buildFilter.paths` includes `artifacts/api-server/**` and shared libs but NOT `artifacts/admin/**`, `artifacts/tv/**`, or `artifacts/mobile/**`. Changes to SPAs do NOT redeploy the daemon.

**Why:** SPA deploys must never restart the broadcast engine. Only broadcast-engine source changes warrant a daemon redeploy.

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
