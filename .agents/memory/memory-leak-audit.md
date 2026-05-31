---
name: Memory leak comprehensive audit
description: Full audit of all in-memory collections across the API server for unbounded growth. One real leak found and fixed; everything else confirmed clean.
---

# Memory Leak Audit — API Server

## The One Real Leak (Fixed)

**`infrastructure/slow-request-capture.ts` — `routeAggregates` Map**

- Keyed by `"METHOD /normalised/path"` (UUIDs/numbers normalised to `:id`)
- Entries were filtered on READ (`lastAt >= cutoff`) but NEVER deleted from the Map
- Fix: added `setInterval(() => { /* delete entries where lastAt < cutoff */ }, BUFFER_MAX_AGE_MS).unref?.()`
- This runs every 5 min (same as the cutoff window) and prunes stale route entries

## Confirmed Clean (do not re-audit these)

| Collection | Location | Bound mechanism |
|---|---|---|
| `seenIdempotencyKeys` | broadcast-v2/io/rest.routes.ts | 1-min GC timer, `_idempotencyGcTimer.unref()` |
| `stallVotes` + `stallActionCooldown` | broadcast-v2/io/rest.routes.ts | 60-s GC timer, `_stallVotesGcTimer.unref()` |
| `sseTokenStore` | admin-ops/admin-ops.routes.ts | 60-s GC interval, `.unref()` |
| `reactionBuckets` | broadcast/broadcast.routes.ts | 5-min GC interval, `.unref()` |
| `sseConnections` | broadcast/broadcast.routes.ts | `sseDecrement()` deletes at 0 on every SSE disconnect |
| `probeAttemptedForId` | broadcast-v2/engine/broadcast-orchestrator.ts | Hard cap 200; LRU-evict oldest at line 2220–2222; also `.clear()` on reload |
| `airingHistory` | broadcast-v2/engine/broadcast-orchestrator.ts | `AIRING_HISTORY_MAX`-capped ring buffer |
| LRU cache | infrastructure/cache.ts | 10k entry cap |
| Playback analytics | broadcast-v2/engine/playback-analytics.ts | 8k ring buffer |
| Event log | broadcast-v2/repository/event-log.repo.ts | Trimmed to 1000 entries per channel in DB |
| Brute-force guard | auth/brute-force-guard.ts | GC sweep timer |
| Upload sessions | media-uploads/upload-sessions.ts | TTL-based sweep |
| All SSE gateways | broadcast-v2/io/sse.gateway.ts, realtime/sse.gateway.ts | `req.socket.on("close")` cleanup |
| All WS gateways | broadcast-v2/io/ws.gateway.ts, realtime/ws.gateway.ts | WS `close` event cleanup |
| Chat hub | realtime/chat.hub.ts | Room deleted when empty on every `leave()` |
| Broadcast fanout | broadcast-v2/io/broadcast-fanout.ts | Redis subscriber properly closed |
| FFmpeg processes | transcoder/transcoder.service.ts | All spawns use `settled` guard + `proc.kill("SIGKILL")` + `clearTimeout` on close |

**Why:** These were all verified in a focused read/grep audit. Do not re-audit unless code in those modules changes significantly.
