---
name: Broadcast v2 enterprise hardening sprint
description: 4 targeted improvements to the broadcast system — current-item dead-stream probing, SSE→WS return speed, continuous on-air uptime tracking, and emergency filler config warning.
---

## Changes made

### 1. Current-item dead-stream probing (orchestrator)
New `currentItemProbeTimer` (30 s interval) calls `probeCurrentItem()` while the broadcast runs.
- Probes the CURRENTLY-PLAYING item's URL (next-item probing already existed at preload time).
- Resets per-item failure counter (`currentItemProbeFailures`) when item changes between probes.
- Auto-skips after **3 consecutive definitive 4xx failures** (false=broken, null/true = no action).
- Guards: skips when < 15 s remain on the item (let it finish naturally); skips YouTube sources.
- Calls `markBadUrl()` + `incrementBadUrlSkipCount()` + `autoSuspendQueueItem()` on threshold, same as the next-item probe path.
- Timer is started in `start()` alongside other timers, cleared in `stop()`.

### 2. SSE → WebSocket return speed (transport.ts)
`WS_PROBE_INTERVAL_SSE_ROUNDS`: **20 → 5**
- Previously: clients on SSE fallback waited 4–8 minutes before re-probing WS.
- Now: re-probes after ~3 reconnect cycles (~60–90 s), returning to WS much faster.
- The 22 s DEAD_SOCKET_THRESHOLD_MS was intentionally NOT reduced (correct for mobile 3G).

### 3. Continuous on-air uptime tracking (orchestrator + health endpoint)
New `onAirSinceMs: number | null` private field in orchestrator:
- Set to `Date.now()` in `tickInner()` the first tick a current item is on air (after boot or dead-air recovery). Guard: `if (this.onAirSinceMs === null)`.
- Reset to `null` in the dead-air branch of `tickInner()` (when `!snap.current`).
- Exposed via `getContinuousOnAirMs(): number | null`.
- Added to `/api/broadcast-v2/health` response as `continuousOnAirMs`.
- Admin UI: green "On air" chip with formatted duration (Xh Ym or Xm Ys or Xs) in the Operator Controls card. Only shown when `continuousOnAirMs !== null`.

### 4. Emergency filler not-configured warning (health endpoint + admin)
- Added `emergencyFillerConfigured: !!env.EMERGENCY_FILLER_URL` to `/health` response.
- Admin: new `fillerNotConfiguredDismissed` state; yellow dismissible banner shown when `engineHealth.emergencyFillerConfigured === false` (only after health data loads to avoid false-flash).
- Existing `EMERGENCY_FILLER_URL` boot WARN log in `start()` was already present — this adds the admin-visible UI companion.

## Key design decisions

**Why 3 consecutive failures before auto-skip (not 1)?**
A single CDN 4xx can be a momentary origin error, rate-limit response, or signed-URL expiry mid-stream. Three consecutive definitive failures (over 90 s) is a strong signal the URL is dead. Same logic as the existing stall-report threshold (`BAD_URL_SKIP_THRESHOLD`).

**Why keep DEAD_SOCKET_THRESHOLD_MS at 22 s?**
Set deliberately for mobile 3G where 12–15 s delivery gaps are normal (2.2× the 10 s heartbeat). Reducing it would cause spurious reconnects on weak connections.

**Why format onAirSinceMs as ms (not seconds)?**
The admin UI formats it locally with `formatOnAirDuration(ms)` — keeps the wire format precise for external monitoring dashboards that might want sub-minute granularity.
