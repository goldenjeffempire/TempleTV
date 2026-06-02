---
name: Storage stream shutdown drain
description: Pattern for preventing "Cannot use a pool after calling end on the pool" crash when DB pool closes while active streamChunked generators are still in flight.
---

## The bug
`streamChunked` is an async generator that issues successive `SUBSTRING(data FROM x FOR n)` DB queries.  When the process receives SIGTERM:
1. Fastify `app.close()` resolves
2. `closeDb()` calls `pool.end()` — pool immediately rejects new queries
3. In-flight generators are still awaiting their next `db.execute()` — crash: `"Cannot use a pool after calling end on the pool"`

Confirmed in Render production log line 50 (2026-06-02T13:05:11): `_DrizzleQueryError` from `storage.ts:278:24` inside `generate()` during the very SIGTERM that triggered the restart cycle.

## The fix (implemented)
**storage.ts** — two module-level additions:
```ts
let _activeStreamCount = 0;
let _shuttingDown = false;
export function getActiveStorageStreamCount(): number { return _activeStreamCount; }
export function signalStorageShutdown(): void { _shuttingDown = true; }
```
- `streamChunked` checks `if (_shuttingDown) break;` at the top of every while iteration.
- `getObjectRange` large-range generator has the same `_shuttingDown` guard.
- `getObject` (both fast and chunked paths) and `getObjectRange` (large path) increment `_activeStreamCount` on Readable creation and decrement in a `body.once("close", ...)` listener.

**main.ts** — before `closeDb()`:
```ts
const { signalStorageShutdown, getActiveStorageStreamCount } = await import("./infrastructure/storage.js");
signalStorageShutdown();
const streamDrainMs = Math.max(env.SHUTDOWN_DRAIN_MS, 5_000);   // min 5 s floor
const deadline = Date.now() + streamDrainMs;
while (getActiveStorageStreamCount() > 0 && Date.now() < deadline) {
  await new Promise<void>((r) => setTimeout(r, 100));
}
```

Uses `env.SHUTDOWN_DRAIN_MS` (same var as SSE drain) with a 5 s floor. Deployment sets `SHUTDOWN_DRAIN_MS=10000`, giving a 10 s window. Logs `{ active, streamDrainMs }` at signal time only when there are active streams.

## HLS_MAX_CONCURRENT
Lowered default 200 → 50 in `env.ts`.  
**Why:** each in-flight HLS segment request holds an 8 MiB Buffer; 200 concurrent = up to 1.6 GiB peak RSS, which reliably trips the memory watchdog on Replit's 2 GiB container.  50 concurrent is still ample for normal viewer loads.

**How to apply:** Any new streaming path that issues DB queries in a loop (i.e. any generator that calls `db.execute` repeatedly) must check `_shuttingDown` at the start of each iteration and register its Readable with the `_activeStreamCount` counter.
