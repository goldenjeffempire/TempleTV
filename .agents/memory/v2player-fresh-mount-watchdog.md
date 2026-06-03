---
name: V2PlayerContainer fresh-mount watchdog hazard
description: Two watchdog timers in BroadcastBuffer disrupt a healthy PLAYING FSM when a secondary consumer mounts fresh (Hero→Player nav, fullscreen open).
---

# Problem

`BroadcastBuffer` has two watchdog timers that fire `buffer-error` into the shared singleton FSM:

1. **Load timeout** (12 s, `LOAD_TIMEOUT_MS`) — armed in the `bindRevision` reset effect when `!suppressEvents && state.playing && state.active`.
2. **Buffering stall** (15 s, `BUFFERING_STALL_THRESHOLD_MS`) — armed in `onPlaybackStatusUpdate` when `status.isBuffering && state.playing && state.active && !suppressEventsRef.current`.

When the Player screen opens while the Hero's singleton session is already PLAYING, the Player's fresh `Video` elements mount cold. Both conditions above are ALL TRUE at mount time, so both watchdogs arm immediately. If HLS takes >12 s to load on the fresh elements (weak network), `buffer-error` fires → FSM transitions PLAYING → RECOVERING_PRIMARY — disrupting a perfectly live broadcast.

Same hazard applies when the fullscreen Modal opens in `player.tsx`: the Modal's `BroadcastHlsPlayer` creates fresh Video elements with no `suppressEvents`.

**Key machine.ts fact**: `buffer-ready` in PLAYING state is a no-op (only transitions from PREPARING_ACTIVE / RECOVERING_*). So spurious `buffer-ready` events from fresh mounts are harmless. Only `buffer-error` is dangerous in PLAYING state.

# Fix

Added `fsmIsWaiting: boolean` prop to `BroadcastBuffer` and an internal `fsmIsWaitingRef`. The prop is `true` only when the FSM is in `PREPARING_ACTIVE`, `RECOVERING_PRIMARY`, or `RECOVERING_FAILOVER`.

Both watchdog arm conditions now include `&& fsmIsWaitingRef.current`:

```typescript
// Load timeout (reset effect):
if (!suppressEvents && state.playing && state.active && fsmIsWaitingRef.current) { ... }

// Buffering stall (onPlaybackStatusUpdate):
if (status.isBuffering && state.playing && state.active && !suppressEventsRef.current && fsmIsWaitingRef.current) { ... }
```

`V2PlayerContainer` computes `fsmIsWaiting` from `snapshot.state` and passes it to both `BroadcastBuffer` instances.

Also added a first-frame loading indicator (`ActivityIndicator`, `styles.firstFrameLoading`) shown when `!videoReady && !overlayContent && !minimal && !!posterUrl` — gives visual feedback while Video elements cold-load in PLAYING state.

**Why:** The Hero runs with `suppressEvents=true` (already safe). The Player runs with `suppressEvents=false`. Without `fsmIsWaiting`, every Hero→Player navigation could corrupt the FSM on weak networks.

**How to apply:** Any future `BroadcastBuffer` consumer must pass `fsmIsWaiting` from the parent's `snapshot.state`. Default is `false` (safe — watchdogs disarmed) but FSM won't recover genuine stalls either; pass the correct value.
