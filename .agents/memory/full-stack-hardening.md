---
name: Full-stack production hardening audit batch
description: 8 production-risk fixes identified by 5-way parallel audit across mobile, admin, player-core, transport, and API pipeline. All hot-reloaded into the running dev server.
---

## Fix 1: WS/SSE cycling on WS-blocked networks (transport.ts)

**Symptom:** On networks where WebSocket is permanently blocked (corp firewall, strict proxy, iOS VPN, some Android configs), the transport cycled WS→WS→SSE→WS→WS→SSE with a black-screen window every third reconnect cycle.

**Root cause:** `connectSse()` reset `wsFailStreak = 0` on SSE connect. When SSE subsequently failed, `connectWs()` saw streak=0, burned two WS attempts, then fell back to SSE — wasting 2 slots every cycle.

**Fix:** Added `wsPreferSseUntilWsOpens` (bool) and `sseReconnectCount` (int) to `V2Transport`. Once `wsFailStreak >= WS_FAIL_STREAK_SSE_FALLBACK`:
- Set `wsPreferSseUntilWsOpens = true`, go directly to SSE on every reconnect.
- Every `WS_PROBE_INTERVAL_SSE_ROUNDS = 20` SSE reconnects, probe WS once.
- `wsPreferSseUntilWsOpens` is cleared only in `ws.onopen` (WS demonstrably succeeded).
- Removed the `wsFailStreak = 0` reset from `connectSse()`.

**Why:** `wsFailStreak` must only be cleared when WS actually opens — not when SSE connects.

## Fix 2: Natural-end replay loop (machine.ts)

**Symptom:** After a video ended naturally and the HANDOFF completed, if the POST /natural-end failed (network error), the server kept showing the ended item as `current`. After the 30s guard expired, the machine called `bindActive()` on the old item — looping it for the rest of the server-scheduled slot (potentially 30+ minutes).

**Root cause:** The 30s TTL guard cleared `lastEndedItemId` and fell through to `bindActive()` as a "last resort". But the local HANDOFF had already occurred — rebinding the ended item caused a replay loop.

**Fix:** Added `private naturalEndRetries = 0` to `PlayerMachine`. On TTL expiry:
- Extend the guard by 30s and retry `onNaturalEndCb(itemId)` (re-sends POST /natural-end).
- After 3 retries (90s total), clear guard and fall through as last resort.
- Reset `naturalEndRetries` when a different server item appears.

**Why:** Extending + retrying is safer than immediately rebinding. After 90s the server's own slot TTL will almost certainly have advanced anyway.

## Fix 3: Watchdog stable phase never reached (watchdog.ts)

**Symptom:** Streams playing for hours without interruption got the 15s (rebuffer) stall threshold instead of the intended 25s (stable) threshold.

**Root cause:** `feed()` reset `stableEnteredMs = now` on EVERY position advance, so `Date.now() - stableEnteredMs` was always ≈ 0. Stable phase required 30s of uninterrupted accumulation but was reset every second.

**Fix:** Removed the `else { this.stableEnteredMs = now; }` branch from `feed()`. `stableEnteredMs` is now set only on the FIRST position advance and reset only by `notifyActive()` (rebuffer) or `disarm()`. After 30s of continuous play without a rebuffer, the stable threshold (25s) kicks in.

## Fix 4: prepareHls missing dual cache invalidation (broadcast-v2.tsx)

**Problem:** `prepareHls()` only invalidated `broadcast-queue`, not `admin-videos`. The video library's HLS-status badges (showing "HLS ready" vs "transcoding queued") stayed stale until the next SSE event.

**Fix:** Added `await qc.invalidateQueries({ queryKey: ["admin-videos"] })` immediately after the broadcast-queue invalidation in `prepareHls()`.

## Fix 5: DnD-kit crash on duplicate queue IDs (broadcast-v2.tsx)

**Problem:** `queueData` from DB-sync or prod-sync races could contain duplicate IDs. Passing those to `DndContext` with `useSortable` crashes with "Found duplicate draggable id" invariant violation.

**Fix:** Deduplication in two places:
- `useEffect` that sets `localOrder` from `queueData` — filters duplicate IDs via a `seen` Set.
- `orderedQueueItems` useMemo — also filters duplicates before passing to the sortable list.

## Fix 6: Delete mutation missing broadcast-queue invalidation (videos.tsx)

**Problem:** Deleting a video from the library didn't refresh the broadcast queue panel. If the deleted video was in the queue, the queue UI showed stale orphan references until the next SSE-triggered invalidation.

**Fix:** Added `void qc.invalidateQueries({ queryKey: ["broadcast-queue"] })` in `deleteMutation.onSuccess`.

## Fix 7: ChatClient binary WebSocket frame crash (ChatClient.ts)

**Problem:** `ev.data` type is `any` in React Native's WebSocket implementation. Binary frames (ArrayBuffer/Blob) passed to `JSON.parse(typeof ev.data === "string" ? ev.data : "")` threw SyntaxError — caught silently, but the intent was obscure.

**Fix:** Added explicit `if (typeof ev.data !== "string") return;` guard before `JSON.parse`. Binary frames are now explicitly skipped (chat protocol is JSON-only).

## Fix 8: SSE context malformed-JSON crash (sse-context.tsx)

**Problem:** `let parsed: unknown = e.data; try { parsed = JSON.parse(...) } catch { /* keep raw */ }` — on parse failure, `parsed` was the raw string. `setLastStatusPayload(parsed as AdminLiveStatus)` was called with a string, crashing any consumer that destructured `isLive`, `ytLive`, etc. without nullish checks.

**Fix:** Added `typeof parsed === "object" && parsed !== null` guard before calling `setLastStatusPayload` and before emitting to structured listeners. Raw-string payloads for `snapshot`/`status` events are logged to activity but not dispatched to subscribers.

## Things audited but intentionally NOT changed

- Queue validator auto-heal — design is explicitly non-mutating; auto-heal requires a separate module.
- Dead-air escalation cooldown — 5min matches SUSPENSION_TTL_MS; reducing risks re-enabling still-suspended items.
- Media proxy body stall — complex to guard without breaking long video streams.
- FFmpeg SIGKILL process leaks — fundamental OS limitation; existing orphan-cleanup covers DB state.
- FATAL machine state — by design; machine always retries for 24/7 operation.
- Watchdog initial-load vs. bytes-flowing race — `notifyActive()` handles this (extends stall clock on progress/waiting).
