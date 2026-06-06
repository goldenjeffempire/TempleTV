---
name: Zero-downtime shutdown via shutdown-flag singleton
description: How /healthz returns 503 on SIGTERM so LBs drain traffic before connections close; SHUTDOWN_PRECLOSE_DELAY_MS pattern.
---

## The Rule
Zero-downtime rolling restarts require two things:
1. `/healthz` (and `/health`) must return 503 the instant SIGTERM is received
2. A pre-drain delay must give the LB time to observe the 503 before connections are closed

## Implementation
- `artifacts/api-server/src/infrastructure/shutdown-flag.ts` — singleton with `isShuttingDown()` / `markShuttingDown()`
- `health.routes.ts` — liveness handler imports `isShuttingDown()`; returns `{ status: "shutting_down" }` with 503 when true
- `main.ts` — imports `markShuttingDown`; calls it as the FIRST line of the shutdown handler, before any service is stopped or delayed; then waits `SHUTDOWN_PRECLOSE_DELAY_MS` before proceeding
- `env.ts` — `SHUTDOWN_PRECLOSE_DELAY_MS` (default 0; production operators set 5000–10000)
- Production pre-flight warns when `SHUTDOWN_PRECLOSE_DELAY_MS === 0`

**Why a separate module:** health.routes → app → … → main would be a circular import cycle.

## How to Apply
- Production: set `SHUTDOWN_PRECLOSE_DELAY_MS=5000` (match 2× LB health-check interval)
- For Render.com: health check interval is typically 10s → set delay to 10000–15000
- Existing `SHUTDOWN_DRAIN_MS` (SSE/storage drain) is separate and applies AFTER the preclose delay
