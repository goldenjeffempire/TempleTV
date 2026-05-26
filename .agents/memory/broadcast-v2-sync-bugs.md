---
name: Broadcast v2 player sync bugs
description: Three root-cause bugs in player-core causing timeline drift, loop stalls, and wrong seek positions on remount.
---

## Bug 1 — onClockCalibration not wired in web react.ts (persistent timeline drift)

`V2Transport` fires `onClockCalibration(offset)` on every hello/heartbeat/snapshot frame.
`react-native.ts` wires it → `machine.setClockOffsetMs(offset)`. **`react.ts` did not.**
The machine's `clockOffsetMs` stayed 0 forever on web surfaces — every `resolvePositionSecs` call
used the wrong local clock. On devices where OS clock ≠ server clock (no NTP) the seek was off
by the full delta.

**Fix:** added `onClockCalibration: (offset) => machine.setClockOffsetMs(offset)` to the `V2Transport`
config inside `createSession` in `lib/player-core/src/react.ts`.

## Bug 2 — bindInactive early-exit ignored startsAtMs (loop stall)

`bindInactive` bailed when `current.id === item.id` — fine for multi-item queues, but on a
single-item queue after HANDOFF:
- inactive buffer still holds item X (played to end, video is at EOF)
- server fires item.advanced + new preload for item X with a fresh `startsAtMs`
- early-exit fired (same id) → inactive never rebound
- when active buffer ended → HANDOFF swapped to an already-ended buffer → black screen / SYNCING stall on every loop

**Fix:** early-exit now requires BOTH `id` AND `startsAtMs` to match. `"startsAtMs" in item`
guard naturally passes through `V2Override` (it has `startedAtMs`, not `startsAtMs`).
File: `lib/player-core/src/machine.ts`, `bindInactive()`.

## Bug 3 — replayStateToAdapter ignored clockOffsetMs (wrong seek on remount)

On SPA navigation back or sleep-wake, `attachElements` calls `replayStateToAdapter` to rejoin the
broadcast at wall-clock position. The seek was computed as `(Date.now() - startsAtMs) / 1000`
without applying `clockOffsetMs` — wrong by the clock delta on every remount.

**Fix:** `replayStateToAdapter` now accepts a `clockOffsetMs` parameter (default 0).
`attachElements` passes `session.transport.getClockOffsetMs()`.
Seek computation: `nowMs = Date.now() + clockOffsetMs`.
File: `lib/player-core/src/react.ts`.

**Why these matter:** These three bugs compound. Clock drift causes seek errors. Loop stalls
cause black-screen gaps every cycle. Remount errors cause viewers who navigate away and back
to rejoin at wrong positions. Together they produce the "looping scenes / frozen playback /
timeline drift" symptoms.
