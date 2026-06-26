---
name: YouTube override mobile dead-air — load-timeout cascade
description: BroadcastBuffer's 12s load timeout fires for YouTube overrides (url=null → no Video element → onLoad never clears it), driving FSM into RECOVERING_PRIMARY which then tries the raw YouTube URL → ExoPlayer errors → SKIP_PENDING → dead air.
---

## The Bug

Two compounding problems in the mobile player caused periodic dead-air during YouTube-only broadcast operation:

### Problem 1: Load timeout arms when `url=null` (primary cause)

In `BroadcastBuffer`'s `[state.bindRevision]` effect (`V2PlayerContainer.tsx`):

```ts
// BEFORE — always arms when playing+active+fsmIsWaiting
if (!suppressEventsRef.current && state.playing && state.active && fsmIsWaitingRef.current) {
    loadTimeoutRef.current = setTimeout(() => emit("buffer-error", "load-timeout"), LOAD_TIMEOUT_MS);
}
```

`fsmIsWaiting` includes `LIVE_OVERRIDE_ACTIVE`. YouTube overrides pass `excludeYouTube=true` → `url=null` → no `<Video>` element → `onLoad` never fires. So every YouTube override engagement armed a 12-second countdown to `buffer-error`.

Cascade after timeout fires:
1. `buffer-error` → `onBufferError` → `primaryRetries=1` → `transition("RECOVERING_PRIMARY")`
2. In `RECOVERING_PRIMARY`, `isYouTubeOverride=false` (requires `LIVE_OVERRIDE_ACTIVE`) → `excludeYouTube=false`
3. `sourceUrl` returns raw `https://youtube.com/watch?v=…` → ExoPlayer tries to play it → errors
4. `primaryRetries=3` → `SKIP_PENDING` → dead air
5. Escape-valve reconnect (8s) → new WS connection → receives snapshot → back to `LIVE_OVERRIDE_ACTIVE` → repeat

### Problem 2: `onSnapshot` calls `engageOverride` on every keepalive (secondary cause)

`machine.ts` `onSnapshot`:
```ts
if (server.mode === "override" && server.override) {
    return this.engageOverride(server.override);  // BEFORE: no same-ID guard
}
```

The server re-sends a full snapshot on every keepalive (≤15s). Each call to `engageOverride` swaps A↔B buffers, increments `bindRevision`, and re-arms the load timeout — restarting the 12s countdown on every keepalive.

## The Fix

**Fix 1 (`V2PlayerContainer.tsx` — primary):**
```ts
// AFTER — only arm when there is a URL to load
if (!suppressEventsRef.current && state.playing && state.active && fsmIsWaitingRef.current && url !== null) {
```

**Fix 2 (`machine.ts` — secondary, defense-in-depth):**
```ts
if (server.mode === "override" && server.override) {
    if (this.snapshot.state === "LIVE_OVERRIDE_ACTIVE") {
        const activeId = this.snapshot.activeBufferId;
        const activeBuffer = activeId === "A" ? this.snapshot.bufferA : this.snapshot.bufferB;
        if (activeBuffer !== null && !("source" in activeBuffer) && (activeBuffer as V2Override).id === server.override.id) {
            return; // same override already engaged — nothing to do
        }
    }
    return this.engageOverride(server.override);
}
```

**Why:** Fix 1 alone is sufficient — with `url=null` the timeout can never fire. Fix 2 removes the unnecessary buffer-swap on every keepalive (stops the 12s countdown from being restarted, and prevents `bindRevision`/`videoReady` churn).

## Files changed

- `artifacts/mobile/components/V2PlayerContainer.tsx` — Fix 1 (load timeout `url !== null` guard)
- `lib/player-core/src/machine.ts` — Fix 2 (same-ID skip in `onSnapshot`)
- `artifacts/mobile/vendor/player-core/src/machine.ts` — Fix 2 (vendor mirror, always update alongside lib)

## Key invariant

**Both lib and vendor must always stay in sync.** `artifacts/mobile/vendor/player-core/` mirrors `lib/player-core/` for the mobile Expo build. Any machine.ts edit requires the same change in both locations.
