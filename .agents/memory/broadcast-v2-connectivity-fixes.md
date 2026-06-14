---
name: Broadcast V2 connectivity fixes — timing constants
description: Key timing changes made to eliminate reconnect loops, premature skips, black screens, and stale admin panel data in the broadcast-v2 stack.
---

## What changed and why

### machine.ts — naturalItemEnd retry 30 s → 5 s
The machine retries a dropped `POST /natural-end` after N ms of the server still showing the same (ended) item. The 30 s interval caused a visible off-air gap between every item transition when the first POST was dropped (WS reconnect window, brief server restart). Reduced to 5 s (3 retries = 15 s total maximum). Added a 3-s re-poll of `onNeedSnapshotCb` in the else-branch so the machine actively polls for the advanced state instead of waiting for the next keepalive.

**Why:** Every video-to-video transition briefly shows a SYNCING gap that can be 30+ s if the naturalEnd POST is dropped.

### machine.ts — FATAL_AUTO_RECOVERY_MS 30 s → 10 s
Admin preview and all player surfaces recover from FATAL (HLS 404, MP4 stall) in 10 s instead of 30 s on the first attempt. Exponential backoff still applies (10→20→40→80→160→240 s cap).

**How to apply:** This constant is in lib/player-core/src/machine.ts. Both admin preview and TV/mobile use it.

### queue.repo.ts — first-failure bad-URL TTL 90 s → 20 s
`badUrlTtlForCount(1)` previously returned 90 s, meaning a single stall report blocked an item for 90 s. Now returns 20 s — a brief recovery window for transient CDN blips. If the URL fails again (count=2), TTL escalates to 3 min (unchanged). This pairs with the 15-s forward-scan anchor fix delay: together they create a 20-s window where a transiently-stalled item can self-recover without being permanently skipped.

### broadcast-orchestrator.ts — deferred forward-scan anchor fix (15 s)
Previously, when the orchestrator forward-scanned past a bad-URL-blocked item, it immediately advanced `cycleStartedAtMs` (the anchor fix) on the FIRST tick it noticed the forward-scan result. This caused premature skips from single stall reports.

Now: the anchor fix is DEFERRED. `pendingAnchorFixItemId` + `pendingAnchorFixFirstSeenMs` track first occurrence. A check at the top of `tickInner()` runs every tick and applies the fix only after `FORWARD_SCAN_ANCHOR_FIX_DELAY_MS = 15_000` ms. If the bad URL expires (20-s TTL) before the 15-s delay elapses, the pending fix is cancelled and the item re-enters rotation naturally.

**Net effect:** First stall → URL blocked 20 s → orchestrator holds pending fix for 15 s → if URL recovers at 20 s, fix cancelled (item plays again); if still blocked, fix fires at 15 s and advances cycle.

### BroadcastPreviewV2.tsx — auto-forceRebind after 8 s in FATAL
The admin preview calls `forceRebind()` automatically 8 s after entering FATAL state (was indefinite until user clicked "Try Again"). Clears the recovery timer, resets `primaryRetries`, re-requests fresh state. Works as a fast self-heal for transient HLS 404s.

### broadcast-v2.tsx — staleTime 50 s → 8 s + source-health SSE invalidation
`broadcast-v2-live-state` query staleTime reduced from 50 s to 8 s so the Master Control panel shows fresh state within seconds of any server-side change. Added `broadcast-v2-source-health` to the `broadcast-queue-updated` SSE handler invalidation set.
