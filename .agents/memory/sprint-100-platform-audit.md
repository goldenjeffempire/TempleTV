---
name: Platform audit sprint 100
description: Comprehensive sprint-100 audit after 90+ prior hardening sprints — 6 real fixes, 30+ confirmed false positives.
---

## Fixes

1. **midnight-prayers.tsx `refreshQueueMutation`** — `onSuccess` was invalidating `midnight-prayers/queue` + `midnight-prayers/state` but NOT `broadcast-v2-diagnostics` or `broadcast-v2-remediation-report`. Engine sees new items after refresh but diagnostics/remediation panels stay stale.

2. **broadcast-v2.tsx remediation report query** — `refetchInterval: 5 * 60_000` (5 min) far too slow for Master Control. All other health queries use 30–60 s. Changed to 60_000; staleTime 60_000→30_000 to match.

3. **BroadcastPreviewV2.tsx native HLS error handler** — only retried on `MEDIA_ERR_NETWORK` (code 2), not `MEDIA_ERR_DECODE` (code 3). WebKit fires code 3 transiently on segment boundaries; one silent reload clears it. Was already fixed in TV's LiveBroadcastV2.tsx — now parity in the admin preview (Safari editors).

4. **broadcast-v2/index.ts `fanoutRetryTimer`** — 60-second Redis fan-out retry timer was missing `.unref?.()`. Without it the timer could hold the event loop open past SIGTERM if the server shuts down while Redis is still unreachable and a retry is pending.

5. **media-proxy/media-proxy.routes.ts** — `z` (from `zod`) was imported but never used anywhere in the file. Removed to clear the TS6133 pre-existing error.

6. **youtube-live/youtube-live.poller.ts** — `logger.warn(...)` called at line ~246 but `logger` was never imported. Pre-existing TS2304 error. Added `import { logger } from "../../infrastructure/logger.js"`.

## Confirmed false positives (do not re-audit)

All of the following were re-checked and are genuinely correct:
- `batchRetryMutation` (videos.tsx) — already has all 7 invalidation keys
- `featureMutation`, `lockMutation` (library.tsx) — call `invalidateLibrary()` which contains all 12 keys
- `bulkTranscodeMutation` (videos.tsx) — already has all 7 keys including broadcast-v2-remediation-report
- `resetForReuploadMutation` (broadcast-v2.tsx) — already has all 7 keys including transcoding-panel
- Upload `onReady` hook multi-table cleanup — uses `Promise.allSettled` (belt-and-suspenders recovery path, intentional)
- Orchestrator: all timers use `.unref?.()` (tickTimer, checkpointTimer, trimTimer, keepAliveTimer, selfHealEmptyTimer, selfHealStaleTimer, currentItemProbeTimer, badUrlCacheTimer, _cbResetTimer)
- broadcast-v2/index.ts: pending, validatorPending, bootRetryTimer all `.unref?.()` ✓
- media-integrity-scanner: scanInterval, bootTimer `.unref?.()` ✓
- orphan-cleanup: timer, boot `.unref?.()` ✓
- worker-supervisor: timer, circuitResetTimer `.unref?.()` ✓
- viewer-slope-monitor: monitorTimer `.unref?.()` ✓
- brute-force-guard: _gcTimer `.unref?.()` ✓

**Why:** After sprint 96 + 97, the codebase is very well-hardened. The ratio of false positives to real bugs is ~5:1 on a full deep audit. Trust the code, verify before reporting.
