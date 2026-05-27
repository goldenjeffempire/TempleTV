---
name: V2Transport SSE/WS dual-connection bug
description: Two SSE cleanup bugs in lib/player-core/src/transport.ts — EventSource not closed on WS reconnect, and listener GC cycle.
---

## Bug 1: SSE not closed when WS reconnects (HIGH — duplicate events)
**File:** `lib/player-core/src/transport.ts` — `ws.onopen` handler

**Root cause:** When the WS reconnects after an SSE fallback session, `ws.onopen` cleared the `wsPreferSseUntilWsOpens` flag but never closed the active `this.es` EventSource. Both connections stayed live simultaneously.

**Symptom:** Every server frame was delivered twice to the FSM — once via WS and once via SSE. This could cause:
- Double state transitions in the PlayerMachine (rapid flicker between states)
- `lastSequence` advanced further than expected, making the `resume {lastSequence}` on future reconnects miss frames
- Server-side SSE subscription leaked for the rest of the player session (wasted server memory/bandwidth)

**Fix:** In `ws.onopen`, after clearing flags, close and null `this.es` if set:
```typescript
if (this.es) {
  this.es.close();
  this.es = null;
}
```

**Pattern:** `stop()` and `forceReconnect()` already do this correctly — the gap was only in the WS-wins path.

## Bug 2: SSE EventSource listener GC cycle (MEDIUM — memory)
**File:** `lib/player-core/src/transport.ts` — `connectSse()` method

**Root cause:** Listeners registered with `es.addEventListener(t, handler)` were never removed. The handlers captured `wrap` which captured `this` (the transport instance). This created a cycle: transport → (if es still reachable) → listeners → transport.

**Fix:** Store handlers in a local `sseHandlers` array, call `removeEventListener` for each in a `teardownSse()` function wired to `es.onerror`:
```typescript
const sseHandlers: Array<[string, (e: Event) => void]> = [];
// ... push handlers into array and addEventListener ...
const teardownSse = () => {
  for (const [t, h] of sseHandlers) es.removeEventListener(t, h);
  sseHandlers.length = 0;
  es.close();
};
es.onerror = () => {
  teardownSse();
  if (this.es === es) this.es = null;
  // ... scheduleReconnect
};
```

**Why `stop()`/`forceReconnect()` are OK without calling `teardownSse`:** After `this.es.close(); this.es = null;`, the EventSource has no external references. The GC can collect it (and its listeners) because `teardownSse` itself is only reachable via `es.onerror`, which won't fire on a closed socket — forming a closed reference cycle that the GC resolves.

## Confirmed-OK patterns found in same audit
- `forceReconnect()` timer accumulation: properly clears existing timer at line 325-328 before scheduling new one
- `lastSequence` replay race: `Math.max` ensures monotonic, `recover` frame + `requestSnapshot` minor inconsistency is harmless
- Worker supervisor: exponential backoff [1s, 5s, 15s, 60s] + circuit breaker + 10-min auto-reset — fully production-grade
- Orchestrator reload/tick race: single-threaded Node.js + reload coalescing + atomic `this.items` update prevents any real data race
- Orchestrator timer accumulation: `start()` has `if (this.started) return` guard + reload is coalesced
