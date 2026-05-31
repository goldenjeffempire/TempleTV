---
name: Memory monitoring infrastructure — full inventory
description: All memory monitoring pieces added for 24/7 broadcast stability — where each lives and key design decisions.
---

## Named-store registry (`infrastructure/cache.ts`)
- `registerNamedStore(name, getSize)` — idempotent, preserves peak across re-registration
- `sampleNamedStorePeaks()` — called by watchdog every 30s; updates lifetime `peak` on each entry regardless of whether the diagnostics endpoint is polled
- `getRegisteredCacheStats()` — returns `{ name, size, peak }[]`; also updates peaks on read
- 8 registered stores: `main` (LRU cache), `sse-sub-tokens`, `broadcast-v2-idempotency-keys`, `slow-request-route-aggregates`, `broadcast-v2-stall-votes`, `broadcast-v2-stall-cooldown`, `broadcast-reaction-buckets`, `broadcast-sse-connections`, `youtube-quota-tracker`

**Why:** Peak tracking catches stores that grew large and GC'd back down — invisible in snapshots.

## Memory watchdog (`infrastructure/memory-watchdog.ts`)
- 30s sample interval; RSS absolute threshold + external/heapUsed slope tracking
- `getMemoryHistory()` — returns memWindow as `{ ts, heapUsedMb, externalMb }[]` (last 3 min)
- `logMemorySummary()` called on 1-hour interval — structured INFO log with all metrics + named store sizes/peaks; persists in production log files even without active operator monitoring
- Hourly interval is `.unref()`'d to avoid keeping process alive on shutdown
- `stopMemoryWatchdog()` clears both the 30s and hourly intervals

## API endpoint (`GET /admin/diagnostics/memory`)
Response now includes:
- `caches[]` — `{ name, size, peak }`
- `memorySamples[]` — rolling window MB values for sparkline
- `heapSpaces[]` — `v8.getHeapSpaceStatistics()` mapped to `{ spaceName, spaceUsedSizeMb, spaceSizeMb }` (13 V8 spaces)
- `watchdog` — slopes, thresholds, alert flags

## Admin UI (`admin/src/pages/diagnostics.tsx`)
Memory Watchdog · In-Memory Stores section contains:
1. Watchdog State card — RSS alert, native slope, JS heap slope, V8 heap spaces mini progress bars (color-coded at 60%/85%)
2. Memory History sparkline — AreaChart (heapUsed + external), full-width, only renders when ≥ 2 samples exist
3. In-Memory Stores card — name, current size (badge), lifetime peak (↑N, highlighted red if at peak and elevated)

**Why:** Sparkline appears after first two 30s ticks (~1 min after boot). On a fresh restart it shows nothing, which is correct.
