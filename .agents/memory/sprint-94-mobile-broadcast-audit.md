---
name: Mobile broadcast audit sprint 94
description: 8 fixes across player-core machine.ts, react-native.ts, admin notifications.tsx, and cross-session cache invalidations.
---

## Fixes

### 1. machine.ts — FATAL state deaf to server anchor refresh (Critical)
- **Bug**: `onSnapshot()`'s same-item branch had no FATAL handler. Machine in FATAL ignored ALL snapshots for 30–240 s even when admin fixed the stream and orchestrator issued a new `startsAtMs`.
- **Fix**: Added `else if (state === "FATAL")` branch — if `server.current.startsAtMs` changed (slot restarted), immediately clear `fatalRecoveryTimer`, reset retries, rebind active, transition to `PREPARING_ACTIVE`. Unchanged `startsAtMs` → stay in FATAL (respect backoff).
- **Why**: Different-item snapshots already exit FATAL via the "new item" branch at top of onSnapshot. Only same-item-new-anchor was the gap.

### 2. react-native.ts — escapeValveTimer leaks on session eviction (High)
- **Bug**: `escapeValveTimer` lives in `getOrCreateSession` closure — not reachable by `machine.destroy()` or `transport.stop()`. Janitor eviction left the 8 s timer alive, calling `transport.forceReconnect()` on a dead transport.
- **Fix**: Added `cleanup: () => void` to `NativeSession` interface. Initialized as `() => {}` in the session literal, overwritten with the actual closer-scoped cleanup after the escapeValveTimer closure is set up. Janitor calls `entry.session.cleanup()` FIRST in teardown order (before `machine.destroy()` and `transport.stop()`).

### 3. react-native.ts — stallLastReportedId thundering herd on failure (Medium)
- **Bug**: `stallLastReportedId = null` in `.catch()` reset immediately on every POST failure. On poor-signal devices, rapid SKIP_PENDING cycles fired N POST /report-stall requests per stalled item per burst (server rate limit exhaustion + battery drain).
- **Fix**: Replace immediate reset with `setTimeout(() => { stallLastReportedId = null; }, 5_000)` — at most one retry per 5 s per stalled item.

### 4. notifications.tsx — scheduleMutation/cancelMutation missing admin-stats (Low)
- **Bug**: Scheduling or cancelling a notification didn't refresh the Dashboard "Scheduled Notifications" counter (sourced from admin-stats).
- **Fix**: Added `void qc.invalidateQueries({ queryKey: ["admin-stats"] })` to both `scheduleMutation` and `cancelMutation` onSuccess handlers.

### 5–8. Cross-session cache invalidations (previous session, same commit)
- `bulkTranscodeMutation` (videos.tsx): added `broadcast-queue` + `transcoding-jobs`
- `series.tsx` create/update/delete/togglePublish: added `youtube-library-videos`; delete added `admin-videos`
- `promoteMutation` (live-ingest.tsx): added `broadcast-v2-engine-health` + `broadcast-v2-diagnostics`
- `broadcast-orchestrator.ts` checkpoint setInterval: wrapped `persistCheckpoint()` with `void ... .catch()` (unhandled rejection on any sync throw)

## Confirmed False Positives (do not re-audit)
- V2PlayerContainer buffering watchdog: already has `state.active && state.playing && loadedRevision === bindRevision` guard — correctly arms only on genuine mid-stream stalls.
- V2PlayerContainer onFatal double-fire: already has `fatalFiredRef` + `prevSnapshotStateRef` + `!suppressEvents && !minimal` guards — no double router.back().
- All `clearTimeout` / `clearInterval` cleanup in V2PlayerContainer: all 3 timer refs cleared on unmount and on bindRevision change.
- batchRetryMutation (videos.tsx): already has all required invalidations.
- reorderMutation (broadcast-v2.tsx): already complete.
- playlists.tsx mutations: already complete.
