---
name: Clock calibration on every snapshot ingress path
description: V2Transport must calibrate clockOffset from REST /state snapshots, not just WS/SSE frames — otherwise REST-seeded FSM computes positions on a stale offset.
---

# Clock calibration must fire on EVERY snapshot ingress, not just WS/SSE frames

`V2Transport` calibrates the server-client clock offset (`serverTimeMs − Date.now()`,
EMA-smoothed via `updateClockOffset()` → `onClockCalibration` → `machine.setClockOffsetMs`).
`handleFrame()` does this for the WS/SSE `hello`, `heartbeat`, and `snapshot` frames.

**The gap that was fixed:** `doRequestSnapshot()` (the REST `GET /state` path) dispatched
`{ type: "snapshot" }` to the FSM but did **not** calibrate the clock from the response's
`serverTimeMs`. Any FSM seeded/refreshed via REST *before* a clock-bearing frame arrives —
first load, transport reconnect, or degraded-WS phases where the heartbeat watchdog drives
`requestSnapshot()` — ran `resolvePositionSecs()` on a stale/zero offset, producing temporary
cross-surface / cross-device playback position skew until the next frame re-calibrated.

**Rule:** every code path that dispatches a `snapshot` event from a *live* server response
must calibrate the clock from that response's `serverTimeMs` first. Helper:
`calibrateFromSnapshot(state)` in transport.ts, called before dispatch in both REST happy-path
and 5xx/429-retry-body branches.

**Why:** "perfectly synchronized playback" across Hero/Player/PiP/devices depends on a
calibrated offset being present whenever `resolvePositionSecs` runs — the very first snapshot
counts, and on a cold/reconnect path that first snapshot often comes from REST, not WS.

**Critical exception:** do NOT calibrate from the local snapshot-cache fallback
(`loadSnapshotCache()` in the `catch` branch). Its `serverTimeMs` is from when the cache was
*saved*, not now — calibrating from it injects a large bogus offset. Cache is replayed only to
preserve playback continuity during an outage; clock stays on its last live value.

**How to apply:** when adding any new transport/state ingress that feeds the FSM a snapshot,
mirror the WS frame behaviour — calibrate-then-dispatch for live responses, dispatch-only for
stale cache. Regression tests live in `lib/player-core/tests/transport.test.ts` under
"V2Transport — REST /state clock calibration".
