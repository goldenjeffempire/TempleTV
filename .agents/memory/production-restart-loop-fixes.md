---
name: Production restart-loop root causes + fixes
description: Memory restart cascade on 2 GiB host — root causes, correct thresholds, self-healing relief pass, and process isolation pattern.
---

## Root causes

| Setting | Was | Safe | Impact |
|---|---|---|---|
| `HLS_MAX_CONCURRENT` | 20 | ≤10 | 480 MiB external pressure from pg BYTEA hex strings |
| `MEMORY_RESTART_RSS_MB` | 2500 MiB | 1800 MiB | Higher than OS OOM killer threshold on 2 GiB host |
| `MEMORY_ABSOLUTE_MAX_RSS_MB` | 0 (disabled) | 2000 MiB | No hard ceiling → OS kills before watchdog fires |
| `--max-old-space-size` | 2048 | 1536 | V8 heap cap above safe RSS budget |
| `STORAGE_READ_CHUNK_BYTES` | 8 MiB | 4 MiB | Each HLS stream: 24 MiB RSS (8 MiB Buffer + 16 MiB hex) |

## Correct production thresholds (≥2 GiB host)

```
MEMORY_WARN_RSS_MB=1400
MEMORY_RESTART_RSS_MB=1800
MEMORY_ABSOLUTE_MAX_RSS_MB=2000
HLS_MAX_CONCURRENT=10
--max-old-space-size=1536
```

With `HLS_MAX_CONCURRENT=10` + 4 MiB chunks: ≤120 MiB HLS external pressure vs 480 MiB previously.

## Self-healing relief pass (watchdog sustained-pressure path)

Before committing to SIGTERM on sustained `MEMORY_RESTART_RSS_MB` breach:
1. Call `cancelAllFaststartJobs()` (each in-flight FFmpeg job holds 80–150 MiB)
2. Trim HLS segment cache to 0 + call `purgeExpiredCacheEntries()` + `gcFn()`
3. Wait 15 s for allocations to drain
4. Re-measure RSS — if below threshold, reset counter and SKIP restart
5. Only if still critical: send SIGTERM

**Why:** A single large upload + concurrent HLS pushes RSS briefly over threshold but self-corrects in <15 s. Without relief, the 8-sample countdown is exhausted regardless.

**Hard-ceiling path:** No 15 s wait — cancel faststart fire-and-forget, then SIGTERM immediately (OOM imminent).

## Process isolation (dev workflows)

- `RUN_MODE=api` — HTTP server + broadcast engine + memory watchdog. Start API workflow uses this.
- `RUN_MODE=worker` — background workers (YouTube sync, transcoder, cleanup, etc.). Start Workers workflow uses this.
- `RUN_MODE=all` (default) — both, used in Replit Deployments (`deployConfig` run command).

**Why split matters:** Worker restart cascade was the second OOM: workers restarting with the API created a thundering-herd DB connection storm that pushed RSS immediately past threshold again.

## cancelAllFaststartJobs

`faststart.service.ts` exports this function. It kills all entries in the `_activeProcs: Set<ChildProcess>` module-level registry (populated on `spawnFfmpegFaststart` spawn, cleared on close/error/timeout). The watchdog uses a dynamic `import()` to avoid a circular import.

## How to apply

On any future Replit Deployment (VM target), ensure the run command matches the thresholds above. In Render, set these as environment variables in the service dashboard. Always check that `MEMORY_ABSOLUTE_MAX_RSS_MB` < host RAM by ≥200 MiB.
