---
name: Broadcast-v2 hardening sprint
description: 8 production fixes applied to the broadcast-v2 engine, health monitor, worker supervisor, and transcoder.
---

## Fixes applied

### 1. Worker supervisor — onCircuitOpen callback (worker-supervisor.ts + index.ts)
Added `onCircuitOpen?: (name, consecutiveFailures) => void` to `WorkerConfig`.
Called (try/catch-wrapped) immediately after `this.circuitOpen = true` in `execute()`.
In `index.ts`, `makeCircuitOpenCallback(workerName)` wires all critical workers
(media-integrity-scanner, queue-integrity-validator, faststart-recovery,
broadcast-health-monitor, content-rotation, queue-health-guard) to push an
`ops-alert` SSE event AND fire `sendAdminAlert()` email.
Non-critical worker (viewer-count-metrics-updater) intentionally skipped.

**Why:** Circuit breaker previously opened silently — only a logger.error. Operators
with no dashboard open (overnight) had no out-of-band notification that a critical
background worker was suspended.

### 2. Health monitor — withinPlaybackWindow overrun detection (broadcast-health-monitor.ts)
Added `itemMassivelyOverdue` flag:
```ts
const itemMassivelyOverdue =
  snap.current != null &&
  currentItemElapsedMs > currentItemDurationMs + 3 * PLAYBACK_GRACE_MS;
const withinPlaybackWindow = snap.current != null && !itemMassivelyOverdue && ...
```
**Why:** A 30-min placeholder-duration item whose actual video is 20 min would suppress
the health monitor for up to 33 min (durationMs + GRACE) even if naturalItemEnd was
never called. With `itemMassivelyOverdue` at 3× GRACE the monitor fires after
durationMs + 3×3min = durationMs + 9min, limiting silent-complete dead air.

### 3. Health monitor defaults tightened (env.ts)
- `BROADCAST_HEALTH_MONITOR_STALE_MS`: 300 000 → 180 000 (5 min → 3 min)
- `BROADCAST_HEALTH_MONITOR_RECOVERY_MS`: 600 000 → 420 000 (10 min → 7 min)

### 4. naturalItemEnd — durationWriteInFlight dedup (broadcast-orchestrator.ts)
Added `private readonly durationWriteInFlight = new Set<string>()`.
The fire-and-forget `updateDurationSecs` write is now gated on
`!this.durationWriteInFlight.has(itemId)`. Entry removed in `.finally()`.
**Why:** Defense-in-depth against near-simultaneous naturalItemEnd calls from
multiple clients issuing redundant concurrent DB writes for the same item.

### 5. STUCK_ENCODING_NO_JOB check
Already fully implemented in queue-integrity-validator.ts (lines 1380-1400).
The `validatorCycleCount` at line 116 is already used for this purpose.

### 6. API_ORIGIN production startup warning (main.ts)
The `else` branch (API_ORIGIN unset) now distinguishes three cases:
- production + no fallback: `logger.error` (dead air risk)
- production + RENDER_EXTERNAL_URL fallback: `logger.warn` (fragile)
- development: `logger.info` (unchanged)

### 7. Transcoder audio probe timeout → ops-alert SSE (transcoder.service.ts)
On 15 s probe timeout in `probeHasAudio()`, now pushes a `warn` ops-alert SSE
via lazy `import("../admin-ops/admin-event-bus.js")` (no circular dep).
**Why:** Silent audio in a VOD HLS output is invisible until a viewer complains.
The ops-alert surfaces it immediately on the admin dashboard.

### 8. STUCK_ENCODING_NO_JOB + db-pool-health.ts
Both were already fully implemented. No changes needed.
