---
name: Mobile broadcasting sprint 42 fixes
description: Pre-load error guard for fresh-mount Video elements + double onFatal router.back() bug
---

## Bug 1 — Pre-load error guard: Hero+Player duplicate recovery cycles

**Root cause:** When the Player screen opens while the Hero singleton session is PLAYING, Player's freshly-mounted `BroadcastBuffer` Video elements are in a cold-start state (`loadedRevision !== bindRevision`). If ExoPlayer emits `onError` (codec negotiation, manifest probe transient) or `onPlaybackStatusUpdate` with `!isLoaded && status.error` before `onLoad` fires, `emit({type:"buffer-error"})` was called unconditionally. Since Player's `suppressEvents=false`, this drove the shared FSM into `RECOVERING_PRIMARY` — interrupting the Hero's live stream.

The load-timeout and isBuffering watchdog already had the `fsmIsWaitingRef` guard (only arm when FSM is PREPARING_ACTIVE / RECOVERING_*). `handleError` and the `onPlaybackStatusUpdate` not-loaded error path did not.

**Fix:** Added `loadedRevisionRef` + `bindRevisionRef` (ref mirrors of the corresponding state/prop) to `BroadcastBuffer`. Both `handleError` and the `!status.isLoaded && status.error` branch in `onPlaybackStatusUpdate` now check:
```js
if (!fsmIsWaitingRef.current && loadedRevisionRef.current !== bindRevisionRef.current) return;
```
Suppresses transient pre-load errors. Once `onLoad` fires (loadedRevisionRef catches up to bindRevisionRef), all subsequent errors propagate normally.

**Why safe:** The load-timeout watchdog (gated on `fsmIsWaiting=true`) catches genuinely broken sources when the FSM is waiting. Genuine mid-play errors (stream drops after a successful load) still propagate because `loadedRevisionRef === bindRevisionRef` at that point.

**Files:** `artifacts/mobile/components/V2PlayerContainer.tsx`

---

## Bug 2 — Double `router.back()` from inline + fullscreen BroadcastHlsPlayer on FATAL

**Root cause:** When `isFullscreen=true`, player.tsx mounts TWO `BroadcastHlsPlayer` instances:
1. Inline player — `suppressEvents=true`, `muted=true`, `onFatal={handleFatal}` (wired inside BroadcastHlsPlayer, not a prop of it)
2. Fullscreen Modal player — `suppressEvents=false`, `onFatal={handleFatal}`

Both V2PlayerContainers watch `snapshot.state`. When FSM enters FATAL, both instances' `fatalFiredRef` effects fire (each has its own `fatalFiredRef`). Both call `onFatal?.()` → two `router.back()` calls → user navigates TWO levels back instead of one (past the player screen, back to the wrong tab or out of the stack entirely).

**Fix:** Gate the `onFatal?.()` call on `!suppressEvents && !minimal`:
```js
if (!suppressEvents && !minimal) onFatal?.();
```
The primary driver (fullscreen player, `suppressEvents=false`) fires. The suppressed inline player and minimal Hero instance do not.

**Why correct:** `suppressEvents=true` semantics = "view-only, don't drive the FSM". The natural extension is "also don't react to FSM lifecycle events that trigger navigation". `minimal=true` (Hero preview) already doesn't pass `onFatal`, so `onFatal?.()` was a no-op anyway — the guard also makes this explicit.

**Note:** The `fatalFiredRef` within each instance still prevents double-firing from the SAME instance across re-renders (unchanged). The new guard prevents double-firing ACROSS instances.

**Files:** `artifacts/mobile/components/V2PlayerContainer.tsx`
