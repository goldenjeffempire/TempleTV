---
name: Production restart-loop root causes + fixes
description: Memory restart cascade on 2 GiB host — root causes, correct thresholds, log-only watchdog, faststart concurrency semaphore, process isolation.
---

## Root causes (original)

| Setting | Was | Safe | Impact |
|---|---|---|---|
| `HLS_MAX_CONCURRENT` | 20 | ≤10 | 480 MiB external pressure from pg BYTEA hex strings |
| `MEMORY_RESTART_RSS_MB` | 2500 MiB | 1800 MiB | Higher than OS OOM killer threshold on 2 GiB host |
| `MEMORY_ABSOLUTE_MAX_RSS_MB` | 0 (disabled) | 2000 MiB | No hard ceiling → OS kills before watchdog fires |
| `--max-old-space-size` | 2048 | 1536 | V8 heap cap above safe RSS budget |
| `STORAGE_READ_CHUNK_BYTES` | 8 MiB | 4 MiB | Each HLS stream: 24 MiB RSS (8 MiB Buffer + 16 MiB hex) |
| `FASTSTART_MAX_CONCURRENT` | unbounded | 2 (default) | Each FFmpeg job: 80–150 MiB; 5 concurrent = 750 MiB spike |

## Correct production thresholds (≥2 GiB host)

```
MEMORY_WARN_RSS_MB=1400
MEMORY_RESTART_RSS_MB=1800
MEMORY_ABSOLUTE_MAX_RSS_MB=2000
HLS_MAX_CONCURRENT=10
--max-old-space-size=1536
FASTSTART_MAX_CONCURRENT=2
```

With `HLS_MAX_CONCURRENT=10` + 4 MiB chunks: ≤120 MiB HLS external pressure vs 480 MiB previously.
With `FASTSTART_MAX_CONCURRENT=2`: max 300 MiB additional faststart spike, queued not dropped.

## Watchdog is log-only (no auto-restart)

All `process.kill(process.pid, "SIGTERM")` and `process.exit(1)` removed from:
1. V8 heap critical path — replaced with emergency relief + RELIEF_COOLDOWN_MS reset
2. Hard ceiling (MEMORY_ABSOLUTE_MAX_RSS_MB) — replaced with emergency relief + reset
3. Sustained RSS path — replaced with looping relief (re-fires every ~90s if still critical)

The watchdog still:
- Logs structured JSON at `error` / `warn` level
- Sends Sentry captures
- Fires `ops-alert` SSE events (visible in Admin → Ops section)
- Sends email alerts via `sendAdminAlert()`
- Runs the relief pass (cancel faststart + trim HLS cache + GC + 15s wait)

**Why log-only:** restart itself was causing the loop (workers reconnecting, DB connection storm, broadcast checkpoint replay all spiked RSS again immediately). Fixing root causes (thresholds, HLS concurrency, faststart semaphore) eliminates the need to restart.

**Risk:** if there IS a real leak and relief never recovers it, the OS OOM killer fires (SIGKILL, no graceful shutdown). Monitor `/api/admin/diagnostics/memory` and the ops-alert SSE events for sustained pressure warnings.

## Self-healing relief pass

Before or after CRITICAL_SAMPLES_FOR_EXIT is reached:
1. Call `cancelAllFaststartJobs()` — SIGKILL all in-flight FFmpeg, drain semaphore waiters
2. Trim HLS segment cache to 0 + `purgeExpiredCacheEntries()` + GC nudge
3. Wait 15 s for allocations to drain
4. Re-measure — log recovery if below threshold
5. Reset `criticalExitInFlight` after RELIEF_COOLDOWN_MS (90s) so next pass can run

## Faststart concurrency semaphore

`faststart.service.ts` — module-level semaphore pattern:
- `_faststartRunning: number` + `_faststartWaiters: Array<() => void>`
- `acquireFaststartSlot()` — returns `Promise<void>`, waits if at max concurrent
- `releaseFaststartSlot()` — passes slot to next waiter or decrements counter
- Slot acquired AFTER pre-flight checks (memory gate, disk gate), BEFORE `mkdir(scratchDir)`
- Slot released in `finally` block (always, even on error/kill)
- `cancelAllFaststartJobs()` also drains `_faststartWaiters` (drained callers hit memory gate and skip)
- Configured via `FASTSTART_MAX_CONCURRENT` env var (default 2, max 16)

## Process isolation (dev workflows)

- `RUN_MODE=api` — HTTP server + broadcast engine + memory watchdog. Start API workflow uses this.
- `RUN_MODE=worker` — background workers (YouTube sync, transcoder, cleanup, etc.). Start Workers workflow uses this.
- `RUN_MODE=all` (default) — both, used in Replit Deployments (`deployConfig` run command).

**Why split matters:** Worker restart cascade was the second OOM: workers restarting with the API created a thundering-herd DB connection storm that pushed RSS immediately past threshold again.

## How to apply on Render

Set these as environment variables in the Render service dashboard:
```
MEMORY_WARN_RSS_MB=1400
MEMORY_RESTART_RSS_MB=1800
MEMORY_ABSOLUTE_MAX_RSS_MB=2000
HLS_MAX_CONCURRENT=10
FASTSTART_MAX_CONCURRENT=2
NODE_OPTIONS=--max-old-space-size=1536
MALLOC_ARENA_MAX=2
```

Always verify `MEMORY_ABSOLUTE_MAX_RSS_MB` < host RAM by ≥200 MiB.
