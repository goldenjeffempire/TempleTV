---
name: HLS concurrency memory budget
description: HLS_MAX_CONCURRENT must not be overridden to 20 in Replit workflows — each concurrent request adds ~24 MiB (16 MiB V8 hex + 8 MiB Buffer) so 20 concurrent = 480 MiB from HLS alone.
---

## Rule
Never set `HLS_MAX_CONCURRENT` above 10 in the Replit/constrained environment. The workflow command must not override the userenv value of 10.

**Why:** Each concurrent HLS request creates a 16 MiB hex string in V8 heap (PostgreSQL BYTEA wire encoding) + an 8 MiB external Buffer held until the client ACKs. At HLS_MAX_CONCURRENT=20 that's 320 MB V8 + 160 MB external = 480 MB from HLS alone on top of the 300 MB baseline RSS → 780 MB peak, which was driving the "44 MB/min heap growth" alarm.

**How to apply:** `HLS_MAX_CONCURRENT=10` in the `Start API` workflow (and deployment run). The userenv.shared already has it at 10 but the workflow command was overriding it to 20. Do not add `HLS_MAX_CONCURRENT=20` to any workflow command.

## Related settings
- `HLS_SEGMENT_CACHE_MB`: lowered default from 64 → 32 to halve the permanent Buffer allocation for the segment LRU cache.
- `MEMORY_WARN_RSS_MB=1500` / `MEMORY_RESTART_RSS_MB=2500` — correct for Replit; do not lower these or the watchdog will restart needlessly.

## MemoryCache changes
- `MAX_SIZE` reduced from 10,000 → 1,000 (sufficient for all catalog/broadcast use cases).
- Added 60-second background TTL sweep so expired entries are freed without waiting for an access hit.
- Added `purgeExpiredCacheEntries()` export so the memory watchdog can flush stale entries before calling `gc()` during pressure events.
