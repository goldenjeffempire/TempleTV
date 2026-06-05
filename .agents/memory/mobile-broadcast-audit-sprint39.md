---
name: Mobile player broadcast audit sprint 39
description: 7 bugs found and fixed across the mobile broadcast/VOD player pipeline — machine FSM, V2PlayerContainer, LocalVideoPlayer, and player screen.
---

## Bugs fixed

**Bug 1 — machine.ts `onOnline()` missing snapshot callback**
- `onOnline()` transitioned OFFLINE_HOLD→SYNCING but never called `this.onNeedSnapshotCb?.()`.
- Result: the FSM had to wait for the transport's scheduled reconnect (up to ~8 s) instead of immediately requesting fresh state.
- Fix: call `this.onNeedSnapshotCb?.()` after the state transition, mirroring the HANDOFF path.

**Bug 2 — V2PlayerContainer `suppressBanner` missing `overlayContent` clause**
- `suppressBanner` only checked `isYouTubeOverride || isCoverMode || isCountingDown`.
- When `overlayContent` was set (e.g. YouTube override), the amber reconnect banner still rendered behind the overlay — double UI.
- Fix: add `!!overlayContent ||` as the first clause of `suppressBanner`.

**Bug 3 — V2PlayerContainer stale doc comment**
- Comment said "25 s" load timeout; actual constant `LOAD_TIMEOUT_MS = 12_000`.
- Fix: updated comment to "12 s".

**Bug 4 — LocalVideoPlayer VOD retry resumes from wrong position**
- On error → retry, the code passed `startPositionMs` (the original route param, always 0 on second playthrough) instead of `lastProgressMsRef.current`.
- Result: viewer lost their watch position and restarted from 0.
- Fix: use `Math.round(lastProgressMsRef.current)` in the retry `positionMillis` prop.

**Bug 5 — LocalVideoPlayer stall watchdog dep array includes `onError` directly**
- The native stall watchdog `useEffect` had `onError` in its dep array.
- `onError` was an inline lambda in `player.tsx` → new reference every 500ms progress update → stall clock reset continuously → watchdog could never fire.
- Fix: pattern `const onErrorRef = useRef(onError); onErrorRef.current = onError;` + use `onErrorRef.current?.()` inside the effect with dep array `[STALL_FAIL_MS]` only.

**Bug 6 — player.tsx inline `onError` lambda root cause**
- The root cause of Bug 5: `onError={() => { ... }}` passed directly to `<LocalVideoPlayer>` → new function reference every render.
- Fix: `const handleVodError = useCallback(() => { ... }, [])` — stable reference across renders.

**Bug 7 — player.tsx `fsHideTimerRef` not cleared on unmount**
- The 3-second fullscreen controls-hide timer was cleared on: new scheduleFsHide call, handleFsTap, handleFsScrub, exitFullscreen, isFullscreen→false.
- But: if the user navigated away while `isFullscreen=true` (deep-link, OS back gesture), none of these paths fire.
- Result: the timeout fires after 3 s against an orphaned `Animated.Value`, then calls `setFsControlsVisible(false)` on an unmounted component.
- Fix: added `if (fsHideTimerRef.current) clearTimeout(fsHideTimerRef.current)` inside the existing `useEffect(() => { return () => {...} }, [])` unmount cleanup.

## Key patterns

- **Stall/watchdog useEffect dep arrays must never include callbacks from parent.** Use a `useRef` mirror (`onErrorRef`) and call `ref.current?.()` inside the effect. Or ensure the callback is `useCallback`-memoized by the caller before it can land in a dep array.
- **Every fullscreen-related timer needs unmount cleanup**, not just change-triggered cleanup, because navigation can tear down the component while the timer is in-flight.
- **`suppressBanner` must cover every overlay state** that renders over the player shell — adding a new overlay state without updating `suppressBanner` causes double UI.
- **Retry position**: use `lastProgressMsRef.current`, not the original route-param `startPositionMs`, which is always 0 after the first play.
