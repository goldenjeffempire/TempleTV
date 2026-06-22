---
name: Memory watchdog slope window — startup false positive
description: Heap-growth slope alert fires false positive on startup due to V8 JIT; fix is MIN_SLOPE_WINDOW_MS.
---

## The rule

All three slope-growth functions in `memory-watchdog.ts` (`calcHeapUsedGrowthMbPerMin`, `calcExternalGrowthMbPerMin`, `calcArrayBuffersGrowthMbPerMin`) must return `null` when the rolling sample window spans less than `MIN_SLOPE_WINDOW_MS = 120_000` (2 minutes).

## Why

V8 JIT-compiles 1400+ modules in the first ~30 s of startup. During that window, heapUsed can grow at 75+ MB/min over only 3 samples — well above the 30 MB/min alert threshold. This triggers a false-positive "possible JS object leak" alert in the admin dashboard and fires Sentry captures on every clean restart.

## The fix

Added to `memory-watchdog.ts`:

```typescript
const MIN_SLOPE_WINDOW_MS = 120_000;

// inside each calcXxxGrowthMbPerMin():
const windowMs = samples.at(-1)!.ts - samples[0]!.ts;
if (windowMs < MIN_SLOPE_WINDOW_MS) return null;
```

Returning `null` from slope functions suppresses the alert entirely for the first 2 minutes. By then JIT has settled and any remaining slope is genuinely anomalous.

**How to apply**: Any new slope-based alert in the watchdog should also gate on `windowMs < MIN_SLOPE_WINDOW_MS` before comparing against its threshold.
