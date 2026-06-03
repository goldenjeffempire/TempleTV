---
name: SIGTERM crash hardening — WS zombie / shutdown drain / HLS memory
description: 6 confirmed bugs fixed for 24/7 enterprise broadcast reliability — zombie WS accumulation, shutdown race, HLS memory pressure, event-loop leaks on shutdown.
---

## Bugs fixed

### 1. `realtime/ws.gateway.ts` — zombie WS accumulation (no heartbeat, no wsCounter)
- Added 30s server-initiated ping (`send({ type: "ping" })` + `socket.ping()`)
- Terminate after 60s silence (2+ missed cycles) — frees fd, releases broadcastEngine/overrideBus/signalBus listener slots
- Added `wsCounter.inc/dec` — diagnostics panel was showing wrong WS count
- Added `_activeSockets` Set + exported `closeAllRealtimeWsSessions()` for shutdown

### 2. `chat.hub.ts` — pingAll() sent pings but never terminated non-responsive sockets
- Added `lastPongMs: number` to `RoomMember` (initialized to join-time for grace period)
- Added `terminate?(): void` to `ChatSocket` interface
- `pingAll()` now sweeps zombies (silent >60s) BEFORE broadcasting ping: calls `terminate()` then `leave()` to remove from room Set and broadcast updated presence count
- Prevents half-open sockets from accumulating in room Sets indefinitely

### 3. `chat.routes.ts` — pong never updated lastPongMs; pingInterval never stopped on shutdown
- Updated pong handler: `if (frame.type === "pong") { member.lastPongMs = Date.now(); return; }`
- Exported `stopChatPingInterval()` — called by main.ts shutdown so the 25s setInterval doesn't delay process.exit(0)

### 4. `memory-watchdog.ts` — FORCE_EXIT_GRACE_MS=30s too short for full drain
- Changed from 30_000 to 60_000 ms
- Full shutdown path: SSE drain + app.close + storage stream drain (5s floor) + DB close = up to ~20s worst case
- 30s could fire process.exit(1) while storage streams were still draining → "Cannot use a pool after calling end on the pool"

### 5. `env.ts` — HLS_MAX_CONCURRENT=50 caused memory pressure on Render
- Lowered default from 50 to 30
- Budget: 30 × 8 MiB = 240 MB + 150 MB baseline = 390 MB — safe under 430 MB Render threshold
- Old 50 × 8 MiB = 400 MB + 150 MB = 550 MB — exceeded threshold → restart loop

### 6. `main.ts` — WS connections and chat ping-interval not cleaned up on shutdown
- Added `closeAllRealtimeWsSessions()` call after SSE force-close block
- Added `stopChatPingInterval()` call — without this, the interval kept event loop alive up to 25s extra

**Why:** Without heartbeats and zombie sweeps, 24/7 broadcast server accumulates half-open WS connections at a rate of ~1 per viewer reconnect, leaking memory, inflating viewer counts, and holding event-listener slots on the broadcast engine.

**How to apply:** Any new WS gateway must: (1) import wsCounter and inc/dec, (2) server-ping every ≤30s, (3) terminate() after ≥60s no response, (4) export a close-all function called in main.ts shutdown, (5) any module-level setInterval must have an exported stop function called in shutdown.
