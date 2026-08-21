---
name: toLocalhostProbeUrl daemon probe bug
description: On Render's split-container daemon, API_ORIGIN is included in ownHostnames so upload URLs get rewritten to 127.0.0.1:PORT (the daemon's port), which returns 404 — marking all videos bad and keeping broadcast OFF_AIR permanently.
---

## The Bug

`toLocalhostProbeUrl()` builds an `ownHostnames` list that includes `API_ORIGIN` (e.g. `api.templetv.org.ng`) when `REPLIT_DEV_DOMAIN` is absent. On Render's broadcast daemon pserv:

- `API_ORIGIN` = `https://api.templetv.org.ng` → included in `ownHostnames`
- Video URL `https://api.templetv.org.ng/api/v1/uploads/xxx` → matched as "own origin"
- Rewritten to `http://127.0.0.1:9000/api/v1/uploads/xxx` (daemon's PORT)
- Daemon doesn't serve `/api/v1/uploads/` → HTTP 404
- URL cached as bad → all queue items blocked → orchestrator stays OFF_AIR

This affects three independent copies of the function:
- `artifacts/api-server/src/modules/broadcast-v2/engine/broadcast-orchestrator.ts` (`private toLocalhostProbeUrl`)
- `artifacts/api-server/src/modules/broadcast-v2/engine/media-integrity-scanner.ts` (module-level)
- `artifacts/api-server/src/modules/broadcast-v2/engine/queue-self-healing-worker.ts` (module-level)

The `queue-integrity-validator.ts` `isOwnOriginUrl()` does DB checks (not HTTP probes) so it's unaffected.

## Why it doesn't break dev

On Replit dev, `REPLIT_DEV_DOMAIN` is set → `API_ORIGIN` is excluded from `ownHostnames` by an existing guard. So dev was already protected; only the Render production daemon was broken.

## Fix Applied

Added early return at the top of all three `toLocalhostProbeUrl()` functions:

```typescript
if (env.RUN_MODE === "broadcast") return url;
```

**Why:** The broadcast daemon is a separate service that NEVER serves `/api/v1/uploads/` or `/api/hls/` routes. On Render it's in a different container; on single-VM it's on a different port (9000 vs 8080). Loopback rewriting is always wrong for `RUN_MODE=broadcast`. Probes go to the canonical API URL instead, with `x-internal-token` header for auth bypass.

## How to apply

Any time `toLocalhostProbeUrl()` is modified or a new copy is added, include the `RUN_MODE === "broadcast"` early return before all hostname logic.
