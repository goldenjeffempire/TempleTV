---
name: Render memory restart loop hardening
description: Root causes of the Render production restart-every-5-minutes loop from June 2026 and the complete fix applied across two sessions.
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

Final log line (hidden until re-read): `"Cannot use a pool after calling end on the pool"` from `storage.ts:278` inside `generate()` — the storage stream race crash that accompanied the shutdown.

## Root causes

1. **`HLS_MAX_CONCURRENT=200`** (old default) — each in-flight HLS segment holds an 8 MiB Buffer. 200 × 8 MiB = 1.6 GiB theoretical peak; actual burst to 590 MB RSS under real traffic.

2. **`MEMORY_RESTART_RSS_MB=430`** set explicitly in Render environment — too low for an HLS-serving process. Code default is 600; the explicit Render env var overrode it.

3. **Storage stream / DB pool shutdown race** — in-flight HLS segment stream could query the DB after `pool.end()` was called, causing `Cannot use pool after calling end` crash.

4. **`void boostTranscodePriority(videoId, 10)`** (two call sites in `admin-broadcast.routes.ts`) had no `.catch()` — unhandled rejection could crash the process.

5. **Probe IIFEs in `broadcast-orchestrator.ts`** (YouTube probe + URL reachability probe) had no outer `.catch()` — unhandled rejection on probe failure.

6. **CRITICAL log had no heap breakdown** — `rssMb: 590` alone doesn't distinguish Buffer pressure (External high) from a heap leak (heapUsed high).

7. **`--expose-gc` missing** from dev workflow and deployment run — proactive `global.gc()` nudge in memory watchdog was a no-op without the flag.

8. **Storage drain used hardcoded `15_000` ms** instead of `env.SHUTDOWN_DRAIN_MS` — inconsistent with SSE drain above it; deployment gets `max(SHUTDOWN_DRAIN_MS, 5000) = 10 s`.

## Fixes applied

| # | File | Change |
|---|------|--------|
| 1 | `env.ts` | `HLS_MAX_CONCURRENT` default 200 → **50** |
| 2 | `storage.ts` | `_shuttingDown` flag + `_activeStreamCount` counter; generators check flag at each chunk boundary |
| 3 | `main.ts` | Storage stream drain uses `Math.max(env.SHUTDOWN_DRAIN_MS, 5_000)` instead of hardcoded `15_000`; logs `active` count at signal time |
| 4 | `admin-broadcast.routes.ts` (×2) | Added `.catch(err => logger.warn(...))` to both bare `void boostTranscodePriority(...)` calls |
| 5 | `broadcast-orchestrator.ts` (×2) | Added outer `.catch()` to YouTube probe IIFE and URL reachability probe IIFE |
| 6 | `memory-watchdog.ts` | Startup WARN when `effectiveRestartMb < 500`; heap breakdown in CRITICAL log; proactive `global.gc()` nudge in warn zone |
| 7 | `package.json` `start:prod` | Added `--expose-gc` flag |
| 8 | `.replit` "Start API" workflow | Added `--expose-gc` via `configureWorkflow` |
| 9 | `.replit` deployment run | Added `--expose-gc` to `run` command |

## Operator action required in Render dashboard

**Raise `MEMORY_RESTART_RSS_MB` from 430 to ≥ 600** in the Render service environment variables.
**Set `MALLOC_ARENA_MAX=2`** as a Render env var (glibc arena limiter; already present in Replit dev workflow but not in Render).

With `HLS_MAX_CONCURRENT=50` the Buffer peak is ~400 MiB; combined with V8 heap + shared libs (~300 MB baseline), a comfortable ceiling is 600–700 MB.

## Second restart loop — June 2026 (start:prod overriding NODE_OPTIONS)

**Symptom:** Same `consecutiveRssOverRestart: 10` restart pattern, RSS=548 MB, heapUsed=205 MB on the Render free tier (512 MiB container).

**Root cause:** `render.yaml` set `NODE_OPTIONS=--max-old-space-size=256` but `startCommand` was `pnpm ... run start:prod`. The `start:prod` npm script hardcodes `--max-old-space-size=460` as a CLI flag, which takes precedence over `NODE_OPTIONS`. V8 heap limit was silently 460 MB, not 256 MB. With 460 MB heap + glibc arenas + pg pool, RSS peaked at ~548 MB — well above the 430 MB restart threshold — causing a 5-minute restart loop.

**Fix applied (June 2026):**
1. `artifacts/api-server/package.json`: added `start:render-free` script with `--max-old-space-size=256` (does NOT override to 460)
2. `render.yaml` `startCommand`: changed from `start:prod` → `start:render-free`
3. `render.yaml` `MEMORY_RESTART_RSS_MB`: raised 430 → 480 (steady-state RSS with 256 MB heap is ~380–430 MB; 480 gives headroom without restarting normally, still catches leaks before Render's 512 MB OOM-killer)

**Key invariant:** On Render free tier, always use `start:render-free` (256 MB heap). CLI flags in the npm script silently override `NODE_OPTIONS` — `NODE_OPTIONS` alone is NOT sufficient to cap the heap.

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
The Render env had `MEMORY_RESTART_RSS_MB=430` while the code default (set in a previous sprint) was already 600. The mismatch meant the explicit Render value silently dominated and every HLS burst triggered a restart cycle. The `--expose-gc` flag was essential — without it the watchdog's `global.gc()` call in the warn zone is silently a no-op.
