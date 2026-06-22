---
name: Faststart-recovery probe deadman hang
description: Root cause and fix for "faststart-recovery worker hung and killed after 120000ms"
---

## Rule
The `backfillPlaceholderDurations()` slow-path stage inside `sweep()` must be bounded by both a per-item timeout **and** an outer stage budget, and the row limit must be sized so `(limit × per-item timeout) < outer budget`.

## Why
`workerSupervisor` defaults deadman to `2 × intervalMs`. For `faststart-recovery` that is `2 × 60 s = 120 s`. The slow-path stage probed up to 10 items sequentially, each with a 60 s `withTimeout`, giving a 600 s worst-case — well over the 120 s deadman. On PostgreSQL BYTEA storage every `probeUploadedDuration()` call downloads the entire video blob before ffprobe, making the per-item ceiling realistic rather than theoretical. Even 2 slow probes × 60 s = 120 s would trip the deadman.

## How to apply
Current tuning (post-fix):
- `PROBE_ITEM_TIMEOUT_MS = 15_000` (was 60 s)
- `.limit(3)` in the slow-path probe query (was 10)
- `SLOW_PATH_BUDGET_MS = 50_000` — outer `withTimeout` wrapping `backfillPlaceholderDurations()` in `sweep()`
- Worker spawn `timeoutMs: 90_000` (explicit, was default 120 s)

This gives: Stage 2 max = min(3 × 15 s, 50 s) = 45 s. Total sweep ≈ 8 + 45 + 8 ≈ 61 s, safely within the 90 s deadman.

General principle: for any worker with a sequential probe loop, ensure `(row_limit × per_item_timeout_ms) < outer_stage_budget_ms < worker_deadman_ms`. Add the outer stage budget as belt-and-suspenders since `withTimeout()` rejects the caller but does not abort underlying BYTEA downloads.
