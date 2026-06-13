---
name: Memory leak comprehensive audit
description: Full audit of all in-memory collections across the API server for unbounded growth. All known leaks fixed; confirmed-clean list maintained.
---

# Memory Leak Audit — API Server

## Fixed Leaks (June 2026 comprehensive audit)

### 1. `stream-health.ts` — `activeSessions` Map (CONFIRMED LEAK)
- `record()` called `activeSessions.set(sessionId, Date.now())` on every telemetry POST but NEVER pruned.
- `getStats()` / `getDetailedStats()` pruned with a 2-min window, but only when the admin panel was open.
- Under production load with thousands of viewers posting telemetry, every unique UUID accumulated forever.
- **Fix:** Extracted `SESSION_ACTIVE_WINDOW_MS = 2 * 60 * 1000` to module level; added `_sessionGcTimer = setInterval(prune, 60_000).unref?.()` at module scope; simplified inline prunes to use the constant.

### 2. `video-serve.routes.ts` — HLS chunk double-buffer (MEMORY PRESSURE)
- Cache-miss path: `chunks: Buffer[]` array collected all stream chunks, then `Buffer.concat(chunks)` = `segBuf`.
- V8 kept both `chunks` (array of individual Buffers) AND `segBuf` alive until the handler returned.
- Under 20 concurrent HLS requests with 2 MB segments: `chunks` arrays + `segBuf` = ~120 MB extra heap in flight.
- **Fix:** Added `chunks.length = 0` immediately after `Buffer.concat(chunks)` — releases chunk references so the constituent Buffers are GC-eligible during the LRU write and `reply.send()` calls.

### 3. `youtube-sync.service.ts` — IngestionQueue 955-item hold (MEMORY PRESSURE)
- `syncYouTubeChannel()` calls `queue.flush()` at line 1113, which already calls `getSummary()` internally and returns the summary.
- After flush, the `queue` instance still held all 955 `{ row, warnings, status, attempts }` items in `this.items`.
- The function awaits multiple more DB operations (cleanup-pass, persistSyncLog) before returning, keeping 955 objects live for seconds.
- **Fix:** Added `queue.clear()` immediately after `await queue.flush()` so the 955 NormalizedVideo objects are released during subsequent DB awaits rather than at function return.

### 4. `memory-watchdog.ts` — gc() only on RSS alert, not heap growth (MISSING COVERAGE)
- `global.gc()` was only invoked when `rssAlertActive` was true (RSS ≥ MEMORY_WARN_RSS_MB).
- A sustained heapUsed growth alert (`heapUsedAlertActive`) did NOT trigger `gc()`, so the GC was never nudged when JS objects were accumulating but RSS hadn't crossed the threshold yet.
- **Fix:** Changed trigger to `(rssAlertActive || heapUsedAlertActive) && gcFn` — GC is now nudged proactively as soon as heapUsed growth is sustained above 30 MB/min, before RSS pressure becomes critical.

---

## Earlier Fixed Leak (from previous audit)

**`infrastructure/slow-request-capture.ts` — `routeAggregates` Map**
- Keyed by normalized `"METHOD /path"` strings.
- Entries were filtered on READ but NEVER deleted from the Map.
- Fix: added `setInterval(() => { /* delete entries where lastAt < cutoff */ }, BUFFER_MAX_AGE_MS).unref?.()`

---

## Confirmed Clean (do not re-audit these unless code changes significantly)

| Collection | Location | Bound mechanism |
|---|---|---|
| `seenIdempotencyKeys` | broadcast-v2/io/rest.routes.ts | 1-min GC timer, `.unref()` |
| `stallVotes` + `stallActionCooldown` | broadcast-v2/io/rest.routes.ts | 60-s GC timer, `.unref()` |
| `sseTokenStore` | admin-ops/admin-ops.routes.ts | 60-s GC interval, `.unref()` |
| `reactionBuckets` | broadcast/broadcast.routes.ts | 5-min GC interval, `.unref()` |
| `sseConnections` | broadcast/broadcast.routes.ts | `sseDecrement()` deletes at 0 on every SSE disconnect |
| `probeAttemptedForId` | broadcast-v2/engine/broadcast-orchestrator.ts | Hard cap 200; LRU-evict oldest; also `.clear()` on reload |
| `airingHistory` | broadcast-v2/engine/broadcast-orchestrator.ts | `AIRING_HISTORY_MAX`-capped ring buffer (50 entries) |
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
| `_svaCache` (auth) | middleware/auth.ts | 5-min GC timer, `.unref?.()`  |
| `memWindow` | infrastructure/memory-watchdog.ts | Hard-capped at 60 entries with `shift()` |
| DriftAggregator | lib/broadcast-sync | Ring buffer, 1024 entries |
| `viewer-slope-monitor.ts samples` | admin-ops/viewer-slope-monitor.ts | Max 10 entries with `shift()` |
| `stream-health.ts buckets` | broadcast/stream-health.ts | `purgeOldBuckets()` called on every `record()`, `getStats()`, `getDetailedStats()` |
| Admin SSE heartbeat/zombieCheck | admin-ops/admin-ops.routes.ts:3704 | Both `.unref?.()`; `cleanup()` clears both on "close"/"error" |
| DB cleanup timer | infrastructure/db.ts:1638 | Both `setTimeout` and inner `setInterval` are `.unref?.()`-ed |
| `quotaTracker` Map | youtube-sync/youtube-sync.service.ts | Keyed by operation name (bounded finite set); `quotaTracker.clear()` on daily reset |
| Storage health monitor | infrastructure/storage-health-monitor.ts | `initialTimer.unref?.()` + `this.timer.unref?.()` |
| DB pool health monitor | infrastructure/db-pool-health.ts | `monitorInterval.unref?.()` |
| Event-loop lag monitor | infrastructure/event-loop-lag.ts | `lagInterval.unref()` |
| Viewer slope monitor | admin-ops/viewer-slope-monitor.ts | `monitorTimer.unref?.()` |
| HLS segment LRU | video-serve/video-serve.routes.ts | Capped at `HLS_SEGMENT_CACHE_MB` bytes; per-entry size limit at `maxBytes / 4` |
| `_shuffledPlaylist` | broadcast-v2/engine/youtube-shuffle-fallback.ts | Cleared on deactivation; only held during dead-air periods |
| `IngestionQueue` | youtube-sync/youtube-sync.service.ts | Local var in `syncYouTubeChannel`; now explicitly `queue.clear()` called post-flush |

**Why:** These were verified in focused read/grep audits. Do not re-audit unless the module changes significantly.

---

## Remaining production memory pressure (not JS leaks, architectural)

- **pg BYTEA hex strings for HLS segments**: `node-postgres` temporarily allocates a hex-encoded V8 string (~2× segment size) before decoding into a Buffer. Under high concurrent HLS load (20 concurrent × 2 MB segment = ~80 MB V8 heap spikes). Not a leak — GC reclaims — but GC pressure under sustained load. Mitigation: `chunks.length = 0` fix above, + `HLS_MAX_CONCURRENT` cap (default 20). Full fix would require a storage backend that streams raw bytes rather than BYTEA.
- **RSS vs heap**: RSS can be 2–3× heapUsed due to V8 heap fragmentation and Node.js internal buffers. A clean server often shows RSS > heapUsed by 200–300 MB. This is normal; the MEMORY_WARN_RSS_MB threshold should be set conservatively above typical RSS to avoid false positives.
