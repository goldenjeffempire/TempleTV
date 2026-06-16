---
name: Transcoder tick constants must be adaptive to TRANSCODER_POLL_MS
description: Static tick counts calibrated for 10s/tick run 2× too often at the default 5s poll rate. Use getter computed from env.TRANSCODER_POLL_MS.
---

## Rule
Never hardcode tick-counter thresholds in the transcoder dispatcher as static readonly constants. Always compute them as `Math.max(1, Math.round(TARGET_MS / env.TRANSCODER_POLL_MS))` so they fire at the intended wall-clock cadence regardless of poll interval tuning.

## The bug
Static constants STUCK_JOBS_TICKS=12, PARTIAL_RECOVERY_TICKS=18, FASTSTART_ORPHAN_TICKS=270, SCRATCH_GC_TICKS=180 were calibrated for 10s/tick (TRANSCODER_POLL_MS=10_000). But the env default is 5s, so all four internal watchdogs ran 2× more frequently than their comments documented.

## Fix applied
Replaced all four static readonly constants with private getter properties:
```ts
private get stuckJobsTicks(): number {
  return Math.max(1, Math.round(2 * 60_000 / env.TRANSCODER_POLL_MS));
}
```
The `autoRetryCounter` was already correct — it used `Math.round(env.TRANSCODER_AUTO_RETRY_INTERVAL_MS / env.TRANSCODER_POLL_MS)` inline.

**Why:** TRANSCODER_POLL_MS is configurable via env. Hardcoded tick counts create a silent calibration gap whenever the poll interval is changed.
