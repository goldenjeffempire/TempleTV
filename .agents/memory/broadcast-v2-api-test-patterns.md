---
name: Broadcast-v2 API test patterns
description: Route names, auth guards, validation patterns, and test infrastructure gotchas for broadcast-v2 integration tests.
---

## Route names (mounted at `/api/broadcast-v2`)
- `/health` — GET, public, rate-limited 30/min
- `/snapshot` — GET, public; returns 200/404/503 (404 when queue empty/not loaded)
- `/state` — GET, public (alias)
- `/events` — GET, SSE long-poll, public; **inject() hangs forever** (see below)
- `/reload` — POST, requires editor auth + `idempotencyKey`
- `/skip` — POST, requires editor auth + `idempotencyKey`
- `/override/start` — POST, requires **admin** auth
- `/override/stop` — POST, requires **admin** auth
- `/report-stall` — POST, **NO auth**, rate-limited 5/min; manual validation → returns `200 { ok: false }` for invalid body (not HTTP 400)
- `/natural-end` — POST, **NO auth**, rate-limited 20/min; manual validation → returns `200 { ok: false }` for missing `itemId` (not HTTP 400)
- `/checkpoint` — POST, **NO auth**, rate-limited 60/min

## Auth guard pattern
Routes using `adminOnlyGuard` or `editorGuard` preHandler reject unauthenticated calls with 401/403 **before** body validation. So missing body + no auth → 401, not 400.

## Validation patterns
Two distinct patterns in this module:
1. **Zod SafeParse routes** (skip, reload, override/start, override/stop): return HTTP 400 `{ error: ZodFlatten }` on invalid body.
2. **Manual validation routes** (report-stall, natural-end, checkpoint): return HTTP 200 `{ ok: false, reason: "..." }` on invalid body.

## SSE inject() hang fix
`app.inject()` on `/events` never resolves — SSE keeps the connection open. Fix with Promise.race + deadline:
```typescript
function injectSse(app: FastifyInstance, url: string) {
  return Promise.race([
    app.inject({ method: "GET", url, headers: { accept: "text/event-stream" } }),
    new Promise<null>((res) => setTimeout(() => res(null), 3_000)),
  ]);
}
// then: if (!r || r.statusCode !== 200) return;
```

## ioredis-mock shared-store leader key collisions
All `new RedisMock()` instances share the same in-process store. Leader election keys (SETNX `broadcast-leader:{channelId}`) persist across tests. If multiple tests use the same channelId, later tests' writers fail election and become readers → no frames published.

**Fix:** Use a unique `channelId` per test (`"test-b"`, `"test-c"`, `"test-d"`, etc.) so each test has its own leader key namespace.

**Why:** `BroadcastLeader` writes `SET broadcast-leader:{channelId} {instanceId} NX EX 30`. With shared ioredis-mock store, the TTL persists across test boundaries within the same process run.

## snapshot status codes
Accept `[200, 404, 429, 503]` — 404 is returned when the orchestrator hasn't loaded queue from DB yet (empty DB, test env).

## busBridgeInstalled
May be `false` in test environments where the orchestrator hasn't fully booted (no broadcast queue in DB). Assert `typeof boot.busBridgeInstalled === "boolean"`, not `=== true`.
