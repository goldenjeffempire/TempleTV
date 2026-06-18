---
name: V8 heap guard — Exit Code 134 (SIGABRT) prevention
description: Memory watchdog must monitor V8 heap utilisation directly, not just RSS, to prevent Exit Code 134 crashes when the heap approaches --max-old-space-size before RSS crosses the restart threshold.
---

## The problem

Exit Code 134 = SIGABRT issued by V8 when `heapUsed` approaches the hard `--max-old-space-size` limit.

The old memory watchdog polled RSS every 30 s. With `CRITICAL_SAMPLES_FOR_EXIT=10`, the watchdog needed 5 minutes of sustained RSS pressure before triggering a graceful restart. During those 5 minutes V8 could exhaust its old-space limit and abort the process before the watchdog could act.

Two root causes:
1. Poll interval too slow (30 s → could miss the V8 OOM window entirely)
2. Only monitored RSS, not V8 heap utilisation (V8 abort can happen while RSS is still within bounds)

## The fix (implemented in memory-watchdog.ts)

### 1. Faster polling: 30 s → 10 s
```typescript
const SAMPLE_INTERVAL_MS = 10_000; // was 30_000
const SUSTAIN_SAMPLES = 6;         // was 3   → still 60 s before warn alert
const CRITICAL_SAMPLES_FOR_EXIT = 18; // was 10 → still ~3 min before restart
const SLOPE_WINDOW_SAMPLES = 180;  // was 60  → still 30 min of data
```

### 2. V8 heap guard — direct heap monitoring via `node:v8`
```typescript
import v8 from "node:v8";
const V8_HEAP_WARN_PCT = 0.88;
const V8_HEAP_CRITICAL_PCT = 0.93;
const V8_HEAP_CRITICAL_SAMPLES = 6; // 6 × 10 s = 60 s before graceful restart
```

Every tick:
- `v8.getHeapStatistics()` reads `used_heap_size` and `heap_size_limit`
- At ≥ 88%: proactive GC + cache purge + HLS segment cache trim
- At ≥ 93% for 6 consecutive ticks: SIGTERM (graceful restart) before V8 can SIGABRT

### 3. Pre-exit emergency drain
3 samples before `CRITICAL_SAMPLES_FOR_EXIT`, flushes all expired cache entries + trims HLS segment cache to 0.

**Why:**
- Production workflow uses `--max-old-space-size=2048` and `MEMORY_RESTART_RSS_MB=2500`
- V8 heap can hit 2048 MB while RSS is still 1800 MB (well below RSS restart threshold)
- At 30 s polling, 5-min window before restart is far too long to prevent V8 SIGABRT
- `node:v8` provides exact heap statistics with no overhead — safe to call every 10 s

**How to apply:**
- Never increase `MEMORY_RESTART_RSS_MB` above V8's `--max-old-space-size` significantly
- `--expose-gc` required in production start command for the GC nudge to work (already in workflow)
- `V8_HEAP_WARN_PCT=0.88` and `V8_HEAP_CRITICAL_PCT=0.93` are tuned to provide 60 s of warning before SIGTERM — adjust if process restarts unexpectedly during normal traffic spikes
