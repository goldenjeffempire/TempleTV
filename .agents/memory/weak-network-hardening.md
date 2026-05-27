---
name: Weak-network & dead-socket hardening batch
description: 5 production fixes for mobile weak-network instability, frozen upload progress bars, silent dead WebSocket sockets, and transcoder storage outage retry exhaustion.
---

## 1. fetchWithRetry base delay 350 ms → 1 000 ms
**File:** `artifacts/mobile/lib/fetchWithRetry.ts`  
**Why:** 350 ms fired the first retry mid-radio-handoff (LTE tower switch, airplane-mode recovery). The radio needs ~500–900 ms to complete its state transition; retrying before it does burns a retry slot on a guaranteed failure.  
**Rule:** 1 s base gives the mobile radio time to settle. Exponential backoff caps at 10 s — this only affects the first retry.

## 2. LocalVideoPlayer STALL_FAIL_MS 10 s → 15 s
**File:** `artifacts/mobile/components/LocalVideoPlayer.tsx`  
**Why:** On 3G / congested LTE a single 2 MB HLS segment can take 12–14 s to start delivering bytes. The old 10 s threshold caused premature "broken item" skips for perfectly healthy streams, leaving viewers on a black screen and the item auto-skipped as if broken.  
**Rule:** 15 s before declaring a stall fatal. STALL_NUDGE_MS stays at 8 s — the nudge fires first at 8 s, then at 16 s only if STALL_FAIL_MS > 15 s. Revisit if false stalls recur on very weak connections.

## 3. ChatClient pong watchdog — dead-socket detection
**File:** `artifacts/mobile/lib/chat/ChatClient.ts`  
**Why:** Android's OS power-manager and NAT gateways can silently drop the TCP connection while the WebSocket JS API still reports `readyState === OPEN`. The existing ping sent frames but never checked for responses, so a dead socket would stay "connected" indefinitely.  
**How:**  
- New private field `lastServerActivityAt = 0`  
- Set to `Date.now()` in `ws.onopen` (baseline) and on every `ws.onmessage` (any frame, including pong/state/message counts as server-alive)  
- Ping interval checks: if `Date.now() - lastServerActivityAt > PING_INTERVAL_MS * 2` (50 s), call `ws.close(1001, "pong-timeout")`, which triggers the normal `onclose → scheduleReconnect` path  
**Rule:** Never set `lastServerActivityAt` anywhere except `onopen` and `onmessage`. The watchdog only fires on OPEN sockets — guard `ws.readyState !== WebSocket.OPEN` returns early.

## 4. scheduleUpdate allows `finalizing` state
**File:** `artifacts/admin/src/lib/upload-queue.ts`  
**Why:** The RAF callback's early-exit guard was `status !== "uploading"`, which caused the progress bar to freeze at ~90% for the entire duration of the DB-fallback assembly phase (which sets `status = "finalizing"`). Large files could assemble for 5–15 min with the UI showing 90% with no movement.  
**Fix:** Guard changed to `status !== "uploading" && status !== "finalizing"` — RAF continues ticking during both phases.

## 5. Transcoder storage circuit breaker
**File:** `artifacts/api-server/src/modules/transcoder/transcoder.dispatcher.ts`  
**Why:** If Postgres or the object store suffers a transient outage (ECONNREFUSED, ECONNRESET, ETIMEDOUT, broken pipe), every queued transcoding job would fail on that tick, incrementing `attempts`. Three outage ticks (30 s) could permanently fail jobs that have `maxAttempts=3`.  
**How:**  
- `storageErrorStreak` counts consecutive storage-flavoured failures  
- `storageCircuitOpenUntil` holds the wall-clock time when dispatch may resume  
- Threshold: 3 consecutive storage errors → open circuit for 60 s  
- Success path resets streak to 0; non-storage errors also reset streak (they're per-job issues, not outages)  
- Circuit check is in `runOnce()` just after the ffmpeg circuit check  
**Rule:** Storage error detection is keyword-based (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, "Connection terminated", "pool", "connection refused"). If Postgres adds new error codes, extend `isStorageError` logic here.
