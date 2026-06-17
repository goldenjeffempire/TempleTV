---
name: Faststart-recovery worker hang fix
description: 8 root causes of the faststart-recovery worker hanging indefinitely; fixes applied to make every sweep non-blocking.
---

## The rule
Every operation inside `faststartRecoveryWorker.sweep()` must be non-blocking end-to-end. No await chain may block indefinitely on storage I/O, a DB lock, or a subprocess.

**Why:** The worker is called both by the 60-second supervisor interval AND by the orchestrator dead-air path (`broadcast-orchestrator.ts:2440`). When it hangs, it blocks the orchestrator recovery path, keeps the DB connection pool saturated, and prevents subsequent supervisor ticks from running (supervisor waits for the previous sweep to resolve before scheduling the next one).

## Root causes and fixes

### 1. `dispatchOne()` awaited `runFaststart()` inline — BIGGEST STALL
- **Problem:** `runFaststart()` = download entire blob from PG BYTEA + ffmpeg + re-upload. Each call blocked sweep() for up to 15 min. With N candidates, sweep took N × 15 min.
- **Fix:** `dispatchOne()` is now fire-and-forget. `runFaststart()` runs in a `void (async () => { ... })()` detached block. `dispatchOne()` returns one of 5 string literals immediately. Sweep returns in O(candidates) time.

### 2. No sweep concurrency guard
- **Problem:** Orchestrator dead-air path called `sweep()` directly while supervisor was also in mid-sweep → overlapping parallel sweeps competed for inFlight slots and DB connections.
- **Fix:** `_sweepRunning` boolean flag; second invocation returns immediately with a debug log.

### 3. `probeUploadedDuration()` downloads the ENTIRE blob
- **Problem:** Called sequentially per row in `backfillPlaceholderDurations()`. Each call reads the full video (potentially GBs) from PG BYTEA via repeated SUBSTRING queries, then runs ffprobe. 10 rows × 30 s each = 5+ min just for the backfill stage.
- **Fix:** (a) Per-item `withTimeout(PROBE_ITEM_TIMEOUT_MS=60s)` wrapper abandons stalled downloads. (b) Status filter: skip `none`/`queued`/`encoding` — those items will have their duration updated by faststart/transcoder running on them anyway. Only probe `ready`/`hls_ready`/`failed`.

### 4. No storage-probe circuit breaker
- **Problem:** Degraded storage (PG I/O pressure) caused every probe to fail slowly, saturating the connection pool on every 60-s sweep.
- **Fix:** `probeCircuit` object: opens after 3 consecutive probe failures, stays open for 5 min cooldown. While open, `backfillPlaceholderDurations()` skips all blob probes entirely.

### 5. No per-stage timeouts on DB queries
- **Problem:** `findCandidates()` JOIN and `backfillDurationsFromVideoTable()` UPDATE had zero timeouts — would wait indefinitely under PG lock pressure.
- **Fix:** All DB calls wrapped in `withTimeout(ms, label)` utility (Promise.race + clearTimeout cleanup). `CANDIDATE_QUERY_TIMEOUT_MS=8s`, `DURATION_UPDATE_TIMEOUT_MS=8s`, `HEAD_OBJECT_TIMEOUT_MS=6s`.

### 6. No LIMIT on `findCandidates()` JOIN
- **Problem:** Could return hundreds of rows on a large queue, allocating unbounded result sets and holding shared locks across the full table scan.
- **Fix:** Added `.limit(CANDIDATE_QUERY_LIMIT=20)` to the Drizzle query.

### 7. `backfillDurationsFromVideoTable()` UPDATE with no LIMIT
- **Problem:** Could acquire row-level locks on all matching rows in one shot. RETURNING clause allocated a large result.
- **Fix:** Added an inner subquery `WHERE q.id IN (SELECT ... LIMIT 50)` to batch the update. Max 50 rows per sweep; remaining rows processed by subsequent sweeps.

### 8. No `headObject` gate before expensive blob download
- **Problem:** Missing blobs triggered a full download attempt (all SUBSTRING reads) that predictably failed after burning the connection.
- **Fix:** Lightweight `headObject()` check (timeout 6s) before every `probeUploadedDuration()` call. Absent blobs added to `probeSkipObjectPaths` so they are never re-attempted.

## Concurrency model
- `MAX_CONCURRENT_FASTSTART = 2` — checked via `inFlight.size` before dispatching.
- `inFlight` Set + `inFlightSince` Map + `INFLIGHT_TTL_MS = 30 min` eviction guard for zombie ffmpeg jobs.
- `dispatchOne()` returns: `"dispatched" | "skipped_inflight" | "skipped_giveup" | "skipped_cap" | "skipped_stop"`.

## Per-stage observability
`stats.lastSweepStageMs` object is logged at sweep completion with: `fastDurationBackfillMs`, `probeDurationBackfillMs`, `candidateQueryMs`, `dispatchMs`. Use these to identify which stage was slow in production logs.

## New public API
- `getInFlightCount()` — number of active ffmpeg jobs
- `getProbeCircuitState()` — `{ isOpen, openUntilMs, consecutiveFailures }`
- `stats.inFlightCount` + `stats.probeCircuitOpenUntilMs` surfaced in diagnostics
