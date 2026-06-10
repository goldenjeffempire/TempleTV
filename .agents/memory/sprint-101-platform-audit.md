---
name: Platform audit sprint 101
description: Comprehensive 6-subagent sprint — 4 real fixes, 40+ confirmed false positives. Schema was 100% clean.
---

## Fixes

### 1. `admin-ops.routes.ts` — `POST /transcoding/retry-failed` missing `broadcast-queue-updated`
- **File**: `artifacts/api-server/src/modules/admin-ops/admin-ops.routes.ts` ~line 1862
- **Bug**: Fires `transcoding-update` + `videos-library-updated` but NOT `broadcast-queue-updated`.
  When all failed jobs are re-queued, the broadcast engine won't reload to pick up newly playable
  items until the next scheduled validator cycle (up to 10 min).
- **Fix**: Added `adminEventBus.push("broadcast-queue-updated", { reason: "bulk-retry-failed" })`.

### 2. `admin-ops.routes.ts` — `DELETE /transcoding/clear` missing two bus events
- **File**: `artifacts/api-server/src/modules/admin-ops/admin-ops.routes.ts` ~line 2012
- **Bug**: Fires only `transcoding-update`. Missing `videos-library-updated` AND `broadcast-queue-updated`.
  Library status badges stay stale; broadcast engine doesn't reload.
- **Fix**: Added both bus events when `cleared > 0`.

### 3. `transcoder.dispatcher.ts` — Non-atomic job+video status update on error path
- **File**: `artifacts/api-server/src/modules/transcoder/transcoder.dispatcher.ts` lines 1181–1209
- **Bug**: Two sequential `db.update()` calls — jobs table first, then videos table — with no
  wrapping transaction. A process crash between the two leaves inconsistent state: job says
  "failed" while video stays "encoding" (or vice versa). This blocks auto-enqueue and shows
  contradictory UI state.
- **Fix**: Wrapped both updates in `db.transaction(async (tx) => { ... })`.

### 4. `transcoder.service.ts` — `void req.onProgress(pct)` missing `.catch()` (×2 locations)
- **File**: `artifacts/api-server/src/modules/transcoder/transcoder.service.ts` lines 1847, 2011
- **Bug**: `void req.onProgress(pct)` — if the progress callback is async (type is `void | Promise<void>`)
  and it throws/rejects (e.g. DB write fails during progress update), the rejection escapes as an
  unhandled rejection that can crash Node ≥15.
- **Fix**: Changed to `void Promise.resolve(req.onProgress(pct)).catch(() => { /* non-fatal */ })`.
  Using `Promise.resolve()` is required because the return type is `void | Promise<void>` — direct
  `.catch?.()` fails the type check.
- **Note**: The recovery path at line 1951 was already correctly handled with `.catch(()=>{})`.

## Confirmed False Positives (40+ items, do not re-audit)

### Schema (lib/db/src/schema/)
All 16 tables: indexes OK, constraints OK, exports OK, defaultNow/onUpdate OK. Nothing to fix.

### Admin Panel (artifacts/admin/src/pages/)
All already correct from prior sprints:
- `featureMutation`, `lockMutation`, `publishMutation` (videos.tsx): have broadcast-queue + remediation-report ✓
- `addEpisodeMutation`, `removeEpisodeMutation` (series.tsx): have full 9-key invalidation set ✓
- `reorderMutation` (broadcast.tsx): has `onError` with toast + queue refetch ✓
- `addMutation` (broadcast.tsx): has `onError: toast.error` ✓
- `bulkDeleteMutation` (videos.tsx): calls `setSelectedIds(new Set())` + setBulkDeleteOpen(false) ✓
- `bulkTranscodeMutation` (videos.tsx): calls `setSelectedIds(new Set())` ✓
- `bulkTranscodeMutation`, `retryAllMutation` (transcoding.tsx): no selectedIds concept, N/A ✓

### Backend Routes
- `ffmpegRecheckTimer` in dispatcher: `.unref?.()` already on line 113 immediately after `setTimeout` ✓
- All SSE/WS heartbeat cleanup: correct close-handler teardown ✓
- `/views` + `/reactions` unauthenticated: intentionally public ✓

### Broadcast-V2
- `loadActive` LIMIT: already has `BROADCAST_QUEUE_MAX_ITEMS` env-var cap + operator warn log ✓
- WS/SSE IP maps: 10-min sweep + per-IP limit already in place ✓
- Frame queue overflow: `FRAME_QUEUE_MAX = 500` + shift() in both WS and SSE gateways ✓
- Bad-URL cache GC: lazy-GC at size > 500 in both markBadUrl and markBadUrlWithTtl ✓
- Dead-air escalation correctness: verified correct (stopOverride resets fallbackOverrideActive) ✓

### Infrastructure/Memory
- `storage.ts` stream counter: uses `body.once("close/error")`; not a real leak, very rare edge case ✓
- `chunked-upload.routes.ts` missing abortMultipartUpload: DB-backed storage, no orphan issue ✓
- Dev TCP forwarder not closed in shutdown: dev-only block, process exits cleanly anyway ✓
- `metrics.ts` channel cardinality: `channel` is hardcoded `"main"` everywhere, not dynamic ✓

## Lesson
After 101 sprints, subagent false-positive rate is ~10:1. Schema is fully hardened.
Key pattern: subagents report "missing" items that were added in prior sprints. Always grep the
actual code before marking a finding as real.
