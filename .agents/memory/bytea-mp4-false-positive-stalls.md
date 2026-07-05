---
name: BYTEA MP4 false-positive stall fixes
description: Root causes and fixes for false-positive RECOVERING_PRIMARY events on large non-faststart MP4 files stored as PostgreSQL BYTEA blobs.
---

## Root Causes of False-Positive "Retrying Source" Events

### RC-1: MAX_NOTIFY_ACTIVE_STREAK too low (was 40 → fixed to 120)
Non-faststart MP4 files place the moov atom at the END of the file. The browser must
download the entire file before it can decode any frame and fire `timeupdate`. During
download, `progress` fires continuously (data flowing) → `notifyActive()` is called.
After 40 consecutive `notifyActive()` without `feed()`, the watchdog stops resetting
its clock → WATCHDOG_INITIAL_LOAD_MS (45s) fires → `buffer-stalled` → RECOVERING_PRIMARY.

**Fix:** `MAX_NOTIFY_ACTIVE_STREAK = 120` in watchdog.ts (both lib/ and mobile vendor).
At ~1 progress event/sec this gives ~120s of tolerance — covers ~750 MB at 50 Mbps.
The slow-death guard still fires for truly frozen sources because those stop triggering
`progress` entirely and never reach the cap.

### RC-2: BIND_LOAD_TIMEOUT_MS too tight for BYTEA first-byte latency (was 20s → fixed to 40s)
PostgreSQL BYTEA query latency under load can exceed 20s before the first byte arrives.
The 20s load timer fires BEFORE `progress` fires (which would extend to 90s).

**Fix:** `BIND_LOAD_TIMEOUT_MS = 40_000` in adapters/web.ts (both lib/ and mobile vendor).
Inactive (preload) buffer gets 3× = 120s — aligned with the 120s preload window.

### RC-3: markBadUrl escalating TTL for internal BYTEA uploads
When report-stall fires for `/api/v1/uploads/` URLs, `markBadUrl()` uses escalating TTL
(60s → 3m → 5m → 10m → 20m) and increments per-URL failure count. Repeated false-positive
stalls escalate the block, eventually removing healthy content for 20 minutes.

**Fix:** In `/report-stall` handler, detect internal upload URLs by parsing their pathname
and checking for `/api/v1/uploads/` or `/api/uploads/` prefix (NOT a raw `includes()` check
— that risks misclassifying external URLs with these strings in query params). Use
`markBadUrlWithTtl(url, 15_000)` instead of `markBadUrl(url)` for these URLs. This:
- Does NOT increment the failure count (no escalation)
- Uses 15s flat TTL (one queue cycle skip only)
- Allows healthy BYTEA videos back into rotation within 15s

## Files Changed
- `lib/player-core/src/watchdog.ts` — MAX_NOTIFY_ACTIVE_STREAK: 40 → 120
- `lib/player-core/src/adapters/web.ts` — BIND_LOAD_TIMEOUT_MS: 20_000 → 40_000
- `artifacts/mobile/vendor/player-core/src/watchdog.ts` — same as above
- `artifacts/mobile/vendor/player-core/src/adapters/web.ts` — same BIND + aligned WATCHDOG_INITIAL_LOAD_MS: 20_000 → 45_000, WATCHDOG_REBUFFER_MS: 20_000 → 25_000
- `artifacts/api-server/src/modules/broadcast-v2/io/rest.routes.ts` — markBadUrlWithTtl for internal upload URLs in /report-stall handler
- `lib/player-core/tests/watchdog.test.ts` — updated streak test: 41 → 121 iterations
- `artifacts/mobile/vendor/player-core/tests/watchdog.test.ts` — same

**Why:** These were the three root causes of false-positive "Retrying Source" events for large BYTEA MP4 videos in a YouTube-only catalog deployment. The platform removed faststart processing (raw MP4 enqueued immediately) but the watchdog/bind timeouts were not adjusted for non-faststart behavior.

**How to apply:** If stall events return for BYTEA content: check if MAX_NOTIFY_ACTIVE_STREAK needs further tuning. If files > 750MB at typical connection speed, consider raising to 180. The 15s INTERNAL_UPLOAD_BAD_URL_TTL_MS can be raised if the orchestrator snapshot cadence changes significantly.
