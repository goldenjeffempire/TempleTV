---
name: broadcastEngine.reload() safety in routes
description: Wrapping reload() + broadcast route error handling to prevent 500s from v1 engine reload failures
---

## Rule
`broadcastEngine.reload()` (v1 in-memory engine) can throw after a successful DB write. Never let it propagate as HTTP 500 to the caller.

## Fix applied
`broadcast.service.ts`: extracted `reloadV1Engine(context)` — wraps reload in try/catch, logs as warn. All 4 mutation methods use it.

`broadcast.routes.ts` missing catches that caused 500:
- `POST /queue`: `BadRequestError` (no source URL) was unhandled → now → 422; DB 23505 → 409
- `DELETE /queue/:id`: `NotFoundError` now caught → 404 (added to response schema)
- `POST /skip`: second bare `broadcastEngine.reload()` call now wrapped

## Why
The v2 orchestrator reload fires via `adminEventBus.push("broadcast-queue-updated")` through the bus bridge, independently of the v1 engine. So a v1 reload failure is truly non-fatal — the orchestrator still gets its reload signal. Propagating it as 500 was pure noise.

## How to apply
Any new route that calls `broadcastService.*` or `broadcastEngine.reload()` directly must either use the service's internal `reloadV1Engine()` or wrap the call in its own try/catch. Never let a reload error escape to the HTTP layer.
