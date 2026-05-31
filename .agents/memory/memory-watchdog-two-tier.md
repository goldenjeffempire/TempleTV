---
name: Memory watchdog two-tier threshold
description: MEMORY_WARN_RSS_MB and MEMORY_RESTART_RSS_MB are now independent — warn fires at the low threshold, forced restart only at the higher threshold.
---

## Problem
`MEMORY_WARN_RSS_MB=380` was configured in production with `--max-old-space-size=460`.
A warm Node.js process with a 460 MB heap cap naturally uses 380–460 MB RSS through JIT compilation, DB pool buffers, and in-process caches. The watchdog was killing a healthy server every ~5 minutes (10 × 30 s samples = 5 min).

The `MEMORY_RESTART_RSS_MB` secret was already set in production but the code never read it — it was wired in as a no-op.

## Fix
Two independent thresholds now exist:
- `MEMORY_WARN_RSS_MB` → ops-alert SSE emitted after 3 consecutive samples over threshold (early warning, does NOT kill).
- `MEMORY_RESTART_RSS_MB` → SIGTERM sent after 10 consecutive samples over THIS threshold only.
- `restartThresholdMb = Math.max(MEMORY_RESTART_RSS_MB, MEMORY_WARN_RSS_MB)` — clamped so restart threshold is always ≥ warn.
- A separate `consecutiveRssOverRestart` counter tracks breaches of the restart threshold independently from `consecutiveRssOver`.

## Defaults
- `MEMORY_WARN_RSS_MB`: 1500 MB (dev environments)
- `MEMORY_RESTART_RSS_MB`: 600 MB

## Production config for a 512 MB host with --max-old-space-size=460
```
MEMORY_WARN_RSS_MB=380      # warn early
MEMORY_RESTART_RSS_MB=490   # only kill if truly close to OOM
```

**Why:** With the old code, MEMORY_WARN_RSS_MB served as both the warn and kill threshold. Setting it to 380 on a server with a 460 MB heap limit meant the process was killed whenever the heap warmed up — i.e., constantly during normal operation.
