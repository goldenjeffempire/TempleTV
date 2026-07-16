---
name: Broadcast shutdown flush completeness
description: All three broadcast state stores are now explicitly awaited on graceful shutdown to prevent stale-resume after a video-advance races the process exit.
---

## Problem

`flushCheckpointForShutdown()` previously flushed only two state stores:

1. `checkpointRepo` (player_position_checkpoint — item ID + positionMs)
2. `runtimeRepo` (broadcast_runtime_state — cycleStartedAtMs cycle epoch)

The third store — `ytShuffleState` (broadcast_runtime_state.yt_shuffle_state JSONB column) — was only written by fire-and-forget `persistState()` calls inside `ytShuffleFallback.advance()`. A process exit arriving within milliseconds of a video advance (before the fire-and-forget TCP write completed) could leave the DB with stale ytShuffleState, causing the next restart to compute the wrong elapsed time or fall through to fresh YouTube activation.

## Fix

Added `flushStateForShutdown(): Promise<void>` (public) to `YtShuffleFallback` in `youtube-shuffle-fallback.ts` and wired it into `flushCheckpointForShutdown()` in `broadcast-orchestrator.ts` as the third sequential write with a 3-second timeout guard.

**Shutdown flush sequence (all awaited, in order):**
1. `persistCheckpoint()` — player_position_checkpoint; 10 s timeout
2. `runtimeRepo.save()` — cycle epoch (startedAtMs); 8 s timeout
3. `ytShuffleFallback.flushStateForShutdown()` — ytShuffleState JSONB; 3 s timeout

Also fixed a stale comment: `"up to CHECKPOINT_INTERVAL_MS (15 s)"` → `"5 s"` at the event-driven checkpoint block.

**Why 3 s for ytShuffleState:** it is secondary to the cycle-anchor and position checkpoint; failure is non-fatal (staleness guard in `tryResumeFromHydratedState()` handles an already-ended video by falling through to fresh activation).

## Confirmed-working findings (no changes needed)

- **Cycle epoch restore**: `runtimeRepo.startedAtMs` written on every `bump()` (fire-and-forget) + awaited in `flushCheckpointForShutdown()`. `hydrate()` loads it as `restoredCycleAnchor`; `reloadInner()` applies it directly as `cycleStartedAtMs`. Zero arithmetic — exact wall-clock epoch.
- **Position checkpoint**: Every 5 s + event-driven on item-advance/queue-change/override-start/override-end. Fallback path for cycle-anchor restore (savedAtMs arithmetic).
- **`_bootAnchorPreserved`**: Survives MISSING_BLOB oscillation at boot — queue empties and refills without losing the cycle epoch.
- **YouTube resume**: `tryResumeFromHydratedState()` computes `resumeSeconds`, stores it on the override object. TV client reads `override.resumeSeconds` → `initialStartSecs` → `&start=N` in the iframe URL via `buildSlotSrc()`. End-to-end verified in daemon logs (resumed at 1002 s after restart).
- **Same-video guard (TV client)**: `if (activeContent === ytId)` guard at LiveBroadcastV2.tsx ~line 642 — no iframe reload/flash for viewers who stayed connected across the daemon restart.
- **SSE proxy retry**: 30 s retry window in `daemon-proxy.ts`; SSE clients receive `:keepalive` comments during daemon restart, then resume transparently.
- **`drizzle-kit push --force`**: Only adds missing tables/columns; never drops data rows. Broadcast state tables safe across builds.
- **Shutdown order**: prod-supervisor stops API first, daemon last; daemon flushes all three state stores before the process exits.

**How to apply:**
Any new broadcast state store added to the orchestrator (new JSONB column, new table) must also be flushed in `flushCheckpointForShutdown()` with a timeout guard sized to its criticality.
