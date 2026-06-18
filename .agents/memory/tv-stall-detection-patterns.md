---
name: TV stall detection and network probe patterns
description: Patterns for detecting buffer stall and network unreachability in LiveBroadcastV2.tsx
---

## Buffer stall spinner (LiveBroadcastV2.tsx)

Uses `@keyframes broadcast-spin` — defined in the component's inline `<style>` block at the bottom of the JSX. Do NOT use `spin` (not globally defined in the TV app; only available as inline `<style>` in other page components).

Pattern: `timeupdate` stops firing for >4 s while video is not paused/ended → `bufferStalled=true` → spinner overlay. After 12 s of continuous stall, `forceRebind()`. Guard: `bufferStalled && !overlay` — never show spinner when main overlay is showing (it takes precedence, zIndex 20 vs 22).

**Why:** HLS.js stall watchdog handles internal recovery (nudge, ABR drop) but exposes no visual state. Frozen-last-frame is invisible to the user without this layer.

## Network reachability probe

Periodic HEAD to `${resolveApiOrigin()}/api/healthz` every 15 s with `AbortSignal.timeout(5_000)`. Use a ref (`networkReachableRef`) alongside state so the recovery callback (`false→true`) can call `forceRebind()` without being stale in the closure.

**Why:** Smart TVs (Tizen 4-6, webOS 5-6, FireTV) keep WS "connected" (no close frame) even when upstream gateway is unreachable. `navigator.onLine` is unreliable on these platforms. Ground-truth probe skips the 22 s dead-socket watchdog.

Connection-loss strip distinguishes network vs socket: blue background for `!networkReachable` ("NO NETWORK SIGNAL…"), amber for `!connected` ("RECONNECTING TO BROADCAST").

## Admin broadcast status strip

`BroadcastStatusStrip` in `sidebar.tsx` polls `/api/broadcast-v2/health` every 10 s. Key fields:
- `hasCurrent` — queue item on air
- `hasOverride` — live override active
- `currentTitle` — null during override (override title not in public payload)
- `offAirReason` — why broadcast is off air
- `mode`, `sequence`, `uptimeMs`

Rate limit on `/health`: 30 req/min — 10 s polling interval = 6 req/min per tab, safe.
