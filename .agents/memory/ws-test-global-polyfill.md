---
name: api-server WS integration tests need a global WebSocket
description: broadcast-v2 WS integration tests use browser-style `new WebSocket(url)` and require a global WebSocket; provide it via vitest setupFiles or they fail / pass vacuously on Node < 22.
---

# api-server broadcast-v2 WS integration tests require a global `WebSocket`

The broadcast-v2 WS integration tests (`broadcast-v2-ws*.test.ts`, `broadcast-v2-phantom.test.ts`)
open real client connections with the browser-style `new WebSocket(url)` API. That global only
exists on Node 22+. The project's target/CI runtime is Node ≥24 (so CI is green), but the Replit
dev shell can run an older Node (seen: 20.20) where `globalThis.WebSocket` is `undefined`.

**Symptoms when the global is missing:**
- `openWs` helper (no try/catch) → `ReferenceError: WebSocket is not defined`.
- `openAndClose` helper → catches it and records `refused: true` → `expect(refused).toBe(false)` fails.
- `collectWsFrames` helper → catches it and resolves `{ frames: [] }` → the test **passes vacuously**
  (the gateway is never actually exercised). This is the dangerous one: a green that proves nothing.

**Fix:** `artifacts/api-server/tests/setup.ts` polyfills `globalThis.WebSocket` from the `ws`
package only when absent (no-op on Node 22+), wired via `setupFiles` in `vitest.config.ts`.
`ws` is added as an explicit devDep of `@workspace/api-server` (it was already in the tree via
`@fastify/websocket`, but don't rely on hoisting). `ws`'s browser-compat surface
(onopen/onmessage/onclose/onerror/send/close/readyState/OPEN, message event `.data`) is sufficient
for these tests. `tests/**` is excluded from `tsconfig.json`, so no `@types/ws` is needed.

**Why:** keeps the WS suite meaningful and green across Node 20 / 22 / 24 instead of failing or
silently no-opping on the dev shell.

**How to apply:** any new test that creates a client `WebSocket` works automatically. When adding
WS helpers, prefer asserting a concrete frame is received (the gateway sends `hello` + `snapshot`
on connect) rather than `frames.length >= 0` — a `>= 0` check is a vacuous-green trap.
