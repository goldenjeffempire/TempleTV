---
name: Render memory restart loop hardening
description: Root causes of the Render production restart-every-5-minutes loop from June 2026 and the 5-part fix applied.
---

## The problem

Production logs showed:
```json
{
  "rssMb": 590,
  "warnThresholdMb": 380,
  "restartThresholdMb": 430,
  "consecutiveRssOverRestart": 10,
  "msg": "[memory-watchdog] CRITICAL: … graceful exit"
}
```

RSS sustained at 590 MB > 430 MB restart threshold → server restarted every ~5 minutes under HLS load.

## Root causes

1. **`HLS_MAX_CONCURRENT=200`** (old default) — each in-flight HLS segment holds an 8 MiB Buffer. 200 × 8 MiB = 1.6 GiB theoretical peak; actual burst to 590 MB RSS under real traffic.

2. **`MEMORY_RESTART_RSS_MB=430`** set explicitly in Render environment — too low for an HLS-serving process. Code default is 600; the explicit Render env var overrode it.

3. **Storage stream / DB pool shutdown race** — in-flight HLS segment stream could query the DB after `pool.end()` was called, causing `Cannot use pool after calling end` crash.

4. **`void boostTranscodePriority(videoId, 10)`** (two call sites in `admin-broadcast.routes.ts`) had no `.catch()` — unhandled rejection could crash the process.

5. **CRITICAL log had no heap breakdown** — `rssMb: 590` alone doesn't distinguish Buffer pressure (External high) from a heap leak (heapUsed high).

## Fixes applied

| # | File | Change |
|---|------|--------|
| 1 | `env.ts` | `HLS_MAX_CONCURRENT` default 200 → **50** |
| 2 | `storage.ts` | `_shuttingDown` flag + `_activeStreamCount` counter; generators check flag at each chunk boundary |
| 3 | `main.ts` | 15-second active-stream drain loop before `closeDb()` on SIGTERM |
| 4 | `admin-broadcast.routes.ts` (×2) | Added `.catch(err => logger.warn(...))` to both bare `void boostTranscodePriority(...)` calls |
| 5 | `memory-watchdog.ts` | Startup WARN when `effectiveRestartMb < 500`; `heapUsedMb/heapTotalMb/externalMb/arrayBuffersMb` added to CRITICAL log; proactive `global.gc()` nudge in warn zone (no-op unless `--expose-gc` is set) |

## Operator action required in Render dashboard

**Raise `MEMORY_RESTART_RSS_MB` from 430 to ≥ 600** in the Render service environment variables.

With `HLS_MAX_CONCURRENT=50` the Buffer peak is ~400 MiB; combined with V8 heap + shared libs (~300 MB baseline), a comfortable ceiling is 600–700 MB.

## How to diagnose future incidents

After this fix the CRITICAL log will include:
```json
{
  "rssMb": ...,
  "heapUsedMb": ...,
  "externalMb": ...,
  "arrayBuffersMb": ...
}
```
- `externalMb` high → in-flight Buffer memory (HLS segments, uploads). Raise `HLS_MAX_CONCURRENT` cap or `MEMORY_RESTART_RSS_MB`.
- `heapUsedMb` high and growing → V8 heap leak. Check named-store registry in admin diagnostics UI.

**Why:**
The Render env had `MEMORY_RESTART_RSS_MB=430` while the code default (set in a previous sprint) was already 600. The mismatch meant the explicit Render value silently dominated and every HLS burst triggered a restart cycle.
