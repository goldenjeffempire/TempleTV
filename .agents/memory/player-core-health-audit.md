---
name: Player-core + health endpoint audit bugs
description: 3 real bugs fixed from comprehensive platform audit sprint; 8 false positives documented with reasoning.
---

## Bugs Fixed

### Bug 1 — naturalEnd retry setTimeout leaks on session destroy (react.ts)

**Rule:** `doPost` retry chain must check `transport.isStopped` before each attempt and inside the `.catch()` retry branch.

**Why:** When the janitor evicts a session (`machine.destroy()` + `transport.stop()`), in-flight retry timers had no cancellation mechanism. They kept calling `POST /natural-end` and `transport.requestSnapshot()` indefinitely — one stale chain per natural video end that fired while the session was alive.

**Fix:** `V2Transport` now exposes `get isStopped(): boolean` (public getter on `private stopped`). `doPost` in `react.ts` bails with `if (transport.isStopped) return` at the top of each attempt and at the top of each `.catch()` retry branch.

**Tests:** `lib/player-core/tests/regression.test.ts` — "naturalEnd retry — cancelled on transport stop (Bug 8)" (3 tests).

---

### Bug 2 — Clock EMA no large-jump reset (transport.ts)

**Rule:** `updateClockOffset()` must re-seed the EMA directly when `Math.abs(rawOffset - this.clockOffsetMs) > 5_000` instead of applying the α=0.15 formula.

**Why:** NTP step-sync (OS clock adjustment) can shift the clock by tens of seconds. The EMA takes ~130 heartbeats (130 s) to converge from the stale value. During that window, `resolvePositionSecs()` computes wrong seek positions for every HLS item, causing persistent timeline drift on long-running 24/7 sessions.

**Fix:** Added `else if (Math.abs(rawOffset - this.clockOffsetMs) > 5_000)` branch in `updateClockOffset()` that re-seeds directly (same as the bootstrap path for the first frame).

**Tests:** `lib/player-core/tests/transport.test.ts` — "clock EMA large-jump re-seed" (4 tests). The pre-existing "EMA smooths out jitter" test was updated to use a 2 000 ms spike (below threshold) — a 10 000 ms spike now correctly tests the re-seed path.

---

### Bug 3 — Health /health stuck detection only covers sequence===0 (rest.routes.ts + orchestrator)

**Rule:** Health endpoint must detect *both* boot-stuck (sequence never advanced) *and* post-start hangs (sequence advanced at least once then stalled).

**Why:** The existing `stuck` flag only fires when `sequence === 0`. If the orchestrator's tick loop died after advancing once, external monitors (UptimeRobot, Datadog) would see `ok=true`, `stuck=false` — completely missing a live broadcast outage.

**Fix:**
- `broadcast-orchestrator.ts`: Added `private lastSequenceAdvanceMs: number = Date.now()` field, updated in `bump()` on every `this.sequence += 1`, exposed via `getLastSequenceAdvanceMs()`.
- `rest.routes.ts`: Added `sequenceStale` (bool) and `sequenceStaleSec` (int) to `/health` response. `sequenceStale=true` when `sequence > 0 && itemCount > 0 && now - lastAdvanceMs > 5 min`. `ok` is now `!stuck && !sequenceStale`.

**Tests:** `artifacts/api-server/tests/integration/broadcast-v2-health.test.ts` — new file (15 tests covering schema validation, stale logic unit tests, rate-limit headers, Cache-Control).

---

## False Positives Documented (no fix needed)

| Area | Finding | Why it's false |
|------|---------|----------------|
| `forceReconnect` replacing race | `this.replacing=false` before setTimeout | Already safe: `dead.onclose=null` + `this.ws=null` before close; stale close can't sneak through |
| SSE per-IP rate limit | No `fastify-rate-limit` config on `/events` | Custom `getSseLimit()` + `sseConnectionsPerIp` Map already enforces 8-conn/IP cap |
| TV `stallRecoveryTimer` let not ref | `let` variable leaks after unmount | Already safe: `hls.destroy` is patched (lines 320-324) to clear the timer before original destroy |
| `V2PlayerContainer` cold-mount watchdog | 12s timer fires into PLAYING FSM | Already fixed: `fsmIsWaitingRef` gates both watchdogs (lines 389-390) |
| Mobile Hero ErrorBoundary | No boundary around `V2PlayerContainer` | Expo Router file-level `ErrorBoundary` export (lines 19-21) already wraps the entire tab |
| YouTube Live excluded from hero | `kind !== "youtube"` guard | Intentional design policy — YouTube items render via iframe, hero cannot proxy them |
| `connectSse` dual-connection | SSE connects while WS still open | Not possible per control flow: WS already null/failing by the time `connectSse()` is called |
| `main.ts` shutdown ordering | `stopBroadcastV2()` not properly awaited | Already `await`ed at line 469, before `app.close()` and before DB pool close |

## Test Count After Audit Sprint
- player-core: **369 tests, 12 files, all green**
- api-server: **190 tests, 17 files, all green** (includes new broadcast-v2-health.test.ts)
