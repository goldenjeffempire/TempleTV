---
name: useV2BroadcastNative multi-consumer session dedup
description: Stall reporter + escape valve belong in getOrCreateSession, not in the hook body, to avoid N-fold firing when N consumers share the same session.
---

## The rule

The stall reporter (`POST /report-stall`) and SKIP_PENDING escape valve (`setTimeout → forceReconnect()`) must be wired once per **session** inside `getOrCreateSession`, never inside `useV2BroadcastNative`.

## Why

In a typical live-viewing session the **same baseUrl session** has three simultaneous consumers:
1. `HeroSection` in `index.tsx` — reads `snapshot` state to drive the ON AIR badge, thumbnails, and fallback sermon metadata.
2. `V2PlayerContainer` (Hero, unconditionally mounted, `muted minimal`) — drives the A/B expo-av buffers to keep the session warm.
3. `V2PlayerContainer` (Player screen, when mounted) — drives the visible A/B buffers.

Each call to `useV2BroadcastNative` adds its own `snapshotListeners` entry. If the stall reporter or escape valve lives in the hook body, every SKIP_PENDING transition fires:
- **3× POST /report-stall** for the same `itemId` — wastes server rate-limit budget, especially on weak-signal devices where SKIP_PENDING cycles can be frequent.
- **3 escape valve timers** all firing `forceReconnect()` at ~8 s. The `forceReconnectDebounce` collapses them into one actual reconnect, but the duplicate timers and log noise are unnecessary.

## How to apply

In `lib/player-core/src/react-native.ts`, `getOrCreateSession` adds both listeners to `session.snapshotListeners` after the session object is created and before `startJanitor()`. The listeners close over `baseUrl` and `transport` (both in scope at that point). `useV2BroadcastNative` itself has only ONE `useEffect` — the subscription effect that adds/removes `setSnapshot` and `setConnected` listeners.

**The escape valve timer is self-cleaning**: when the snapshot transitions out of SKIP_PENDING the `else if` branch calls `clearTimeout`. When the janitor evicts the session and calls `transport.stop()`, a late-firing timer calls `transport.forceReconnect()` which is a safe no-op (guarded by `this.stopped`).

**Why**  
Pattern generalizes: any "fire once per session" side-effect (network call, timer, metric recorder) that reacts to `snapshotListeners` should live in `getOrCreateSession`, not in the hook, because the hook may be called by multiple React tree nodes sharing the same underlying session.
