---
name: forceRebind vs forceReconnect — player overlay buttons
description: Overlay retry buttons must call forceRebind (FSM reset + transport reconnect), not forceReconnect alone; both web and RN hooks must expose it.
---

## The rule

Any "Try Again" / "Tap to reconnect" button in a player overlay (FATAL, RECOVERING_PRIMARY, RECOVERING_FAILOVER, SKIP_PENDING) must call **`forceRebind()`**, not `forceReconnect()`.

- `forceReconnect()` — drops and re-establishes the WebSocket transport only. The FSM stays in its current state (FATAL / RECOVERING) until the server sends a new snapshot that advances the queue. If the queue hasn't advanced, pressing the button is a no-op from the viewer's perspective.
- `forceRebind()` — calls `machine.requestManualRebind()` (resets `primaryRetries`, `skipPendingCycles`, transitions back to PREPARING_ACTIVE, re-issues bind + play with a fresh `bindRevision`) **and** `transport.forceReconnect()`. This gives an immediate video element reload regardless of server state.

**Exception**: LIVE_OVERRIDE_ACTIVE retains `forceReconnect()` — calling `forceRebind()` would dismiss a live admin override by issuing a new bind intent.

## Both hooks must expose forceRebind

- `lib/player-core/src/react-native.ts` → `UseV2BroadcastNativeResult.forceRebind`
- `lib/player-core/src/react.ts` → `UseV2BroadcastResult.forceRebind`

The machine method is `machine.requestManualRebind()` — it exists on `PlayerMachine` as a public method.

**Why:** When the machine is stuck in FATAL or RECOVERING, a WS reconnect alone produces no bind/play emit to the video element. Without a fresh `bindRevision`, `BroadcastBuffer` (mobile) and the web adapter's `attachHls` (TV/web) never reload the media source — the player stays frozen with a healthy socket but a dead video element.

## TV escape hatch timing

TV overlay shows `showRefresh: true` after `recoveringSecs >= 10` — a `useState(0)` + `setInterval` counter that resets whenever `snapshot.state` leaves RECOVERING. This gives the FSM ~3 auto-retry cycles before the button appears, matching mobile's `loadingPhase >= 1` (5 s) threshold but adjusted for TV's remote-control UX (10 s is enough time for auto-recovery without spamming the screen).
