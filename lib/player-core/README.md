# `@workspace/player-core` — Universal player FSM + transport

Framework-agnostic A/B-buffer player state machine and WebSocket/SSE transport for the Temple TV v2 broadcast system. Shared across the admin console (web), Smart TV (web), and mobile (React Native) player surfaces.

---

## Architecture

```
V2Transport  (WS-first, SSE fallback, auto-reconnect, sequence replay)
     │
     │  PlayerEvent stream
     ▼
PlayerMachine  (A/B-buffer FSM — deterministic, no DOM/media access)
     │
     │  AdapterIntent stream
     ▼
Platform adapter  (web <video> via attachHls | expo-av on RN)
```

The machine itself never touches the DOM or any media element. Platform adapters subscribe to `bind`, `play`, `pause`, `swap`, `unbind` intents and apply them to the underlying player(s). This makes the FSM testable and shareable across all surfaces.

---

## Exports

```ts
// Core FSM and transport
import { PlayerMachine, V2Transport } from "@workspace/player-core";

// Platform capability detection
import { detectCapabilitiesWeb, pickStrategy } from "@workspace/player-core";

// Stall watchdog
import { Watchdog } from "@workspace/player-core";

// React hooks (web)
import { useV2Broadcast } from "@workspace/player-core/react";

// React Native hook
import { useV2BroadcastNative } from "@workspace/player-core/react-native";

// Web adapter (HLS.js + native <video>)
import { attachHls } from "@workspace/player-core/adapters/web";

// Mobile adapter (expo-av)
import { createMobileAdapter } from "@workspace/player-core/adapters/mobile";
```

---

## Source layout

```
lib/player-core/
└── src/
    ├── machine.ts           ← PlayerMachine — A/B-buffer FSM
    ├── transport.ts         ← V2Transport — WS/SSE with reconnect + sequence replay
    ├── watchdog.ts          ← Watchdog — 3-phase adaptive stall detection
    ├── resolver.ts          ← client capability detection + playback strategy picker
    ├── types.ts             ← V2Snapshot, V2Item, PlayerEvent, AdapterIntent, etc.
    ├── index.ts             ← main barrel (machine, transport, watchdog, resolver, types)
    ├── react.ts             ← useV2Broadcast hook (web + TV)
    ├── react-native.ts      ← useV2BroadcastNative hook (pure WS, no EventSource)
    └── adapters/
        ├── web.ts           ← attachHls (hls.js + native HLS <video>)
        └── mobile.ts        ← createMobileAdapter (expo-av)
```

---

## PlayerMachine

Deterministic FSM driving the A/B buffer model. Invariants:

- The **active** buffer always plays. The **inactive** buffer preloads `next` if known.
- We never destroy a buffer — only swap z-index/audio. Guarantees zero blank frames between items.
- Server snapshots win on disagreement. Local errors trigger recovery transitions but the server's view of `current` is authoritative.

**State flow:**

```
BOOTSTRAP / SYNCING
  → (snapshot with new item) → PREPARING_ACTIVE
  → (buffer-ready) → PLAYING
  → (buffer-error × 1) → RECOVERING_PRIMARY → PLAYING (retries reset)
  → (buffer-error again) → RECOVERING_FAILOVER → PLAYING | SKIP_PENDING
  → (report-stall) → server skips → new snapshot → cycle repeats
  → SYNCING (no more items) → "Off air" overlay
```

Guards against common failure modes:
- **Stale-snapshot guard** — ignores snapshots for items whose `endsAtMs` has already passed
- **Post-natural-end guard** — blocks re-binding the just-finished item for up to 30 s (TTL safety valve if `naturalItemEnd` POST failed)
- **SKIP_PENDING anchor** — prevents infinite PREPARING_ACTIVE → RECOVERING → SKIP_PENDING loop on unloadable sources
- **Clock calibration** — `setClockOffsetMs(serverTimeMs − Date.now())` applied to every `resolvePositionSecs()` call to correct device OS clock skew (primary cause of mobile VOD HLS desync)

---

## V2Transport

WebSocket-first transport with SSE fallback and dead-socket detection.

| Feature | Detail |
|---------|--------|
| Primary | WebSocket at `/api/broadcast-v2/ws` |
| Fallback | SSE at `/api/broadcast-v2/events` (after 2 consecutive WS failures) |
| Reconnect | Exponential backoff 300 ms → 30 s with ±25% jitter |
| Replay | `resume {lastSequence}` sent on reconnect; `lastSequence` persisted to sessionStorage/mobile storage with 15-min TTL |
| Dead-socket detection | Heartbeat watchdog every 6 s; force-reconnect if no frame received in 14 s |
| Snapshot cache | `localStorage` cache with 30-min TTL — seeds FSM when server temporarily unreachable |
| Clock calibration | Measures `serverTimeMs − Date.now()` from every `hello`/`heartbeat`/`snapshot` frame; forwards via `onClockCalibration` callback |

---

## Watchdog

3-phase adaptive stall threshold:

| Phase | Threshold | Condition |
|-------|-----------|-----------|
| Initial load | 20 s | Before any `timeupdate` progress |
| Rebuffer | 15 s | After first progress, then stalls again |
| Stable | 25 s | Continuously playing for ≥30 s |

Fires `onStall` callback at most once per stall event; stall clock resets after each fire. Call `watchdog.feed(positionSecs)` on every `timeupdate` / equivalent event. Call `watchdog.notifyActive()` when buffering but `currentTime` hasn't moved yet (prevents false positives during rebuffer).

---

## Mobile storage adapter

React Native has no `localStorage`/`sessionStorage`. Before constructing any `V2Transport`, call `configureMobileStorage()` once at app boot with a synchronous in-memory adapter (optionally backed by AsyncStorage):

```ts
import { configureMobileStorage } from "@workspace/player-core";

configureMobileStorage({
  getItem: (key) => memStore.get(key) ?? null,
  setItem: (key, val) => { memStore.set(key, val); AsyncStorage.setItem(key, val); },
  removeItem: (key) => { memStore.delete(key); AsyncStorage.removeItem(key); },
});
```

Reads must be synchronous (called from the Transport constructor). Writes may fire-and-forget.

---

## HLS position resolution

`resolvePositionSecs(item, startsAtMs, clockOffsetMs)` returns:

- **HLS** — `min(elapsed, durationSecs - 2)` where `elapsed = (Date.now() + clockOffsetMs - startsAtMs) / 1000`. Cap at `durationSecs - 2` prevents seeking past the encoded video end (which causes AVPlayer/ExoPlayer to fire `didJustFinish` immediately).
- **MP4 / DASH / YouTube** — always `0` (moov-atom seeking on large non-faststart MP4s through a proxy chain reliably exceeds the stall watchdog before `loadedmetadata` fires).

---

## Preload lead time

`PRELOAD_LEAD_MS = 90_000` (90 s). The server sends a `preload` frame this far before the current item ends. Gives the inactive buffer time to download the moov atom + initial segments of the next item on slow/congested connections before the swap.

---

## Related

- [`@workspace/broadcast-types`](../broadcast-types/README.md) — v1 companion surface types
- [`@workspace/broadcast-sync`](../broadcast-sync/README.md) — v1 sync engine
- [`artifacts/admin`](../../artifacts/admin/README.md) — admin v2 console consumer
- [`artifacts/tv`](../../artifacts/tv/README.md) — TV v2 player consumer
- [`artifacts/mobile`](../../artifacts/mobile/README.md) — mobile v2 player consumer
- Project [README](../../README.md)
