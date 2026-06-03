---
name: Mobile Hero+Player FSM isolation & PiP hardening
description: 8 bugs fixed in mobile Hero broadcast + fullscreen + PiP — all root-caused to multiple V2PlayerContainer instances competing on the same singleton FSM session.
---

## Root cause

`useV2BroadcastNative` is keyed by `baseUrl` — one singleton FSM+transport shared across all mounted V2PlayerContainer instances. Three instances can be simultaneously mounted:
1. Hero's V2PlayerContainer (`minimal=true, muted=true`) — always on Home tab
2. Player screen's inline V2PlayerContainer (`muted={isFullscreen}`) 
3. Fullscreen Modal's V2PlayerContainer (`muted=false`) — when `isFullscreen=true`

All three mount their own pair of expo-av BroadcastBuffer components, and all call `reportBufferEvent` to the SAME FSM. The Hero's buffers can fire spurious `buffer-error` (load-timeout after 12 s in background) that interrupts the fullscreen player's stream.

## Fix: `suppressEvents` prop + `emit` wrapper

Added `suppressEvents?: boolean` to `BufferProps` and `Props` in `V2PlayerContainer.tsx`.

In `BroadcastBuffer`, all `reportBufferEvent(` calls replaced with `emit(` where:
```ts
const suppressEventsRef = useRef(suppressEvents);
suppressEventsRef.current = suppressEvents;
const emit = useCallback((...args) => {
  if (!suppressEventsRef.current) reportBufferEvent(...args);
}, [reportBufferEvent]);
```

Key: use `suppressEventsRef` (not `suppressEvents` directly) inside the `useCallback` so `emit` is stable and does NOT re-run the play `useEffect` on every fullscreen toggle.

Load timeout and buffering watchdog arming also gated: `if (!suppressEvents && state.playing && state.active)`.

V2PlayerContainer passes `suppressEvents={minimal || !!suppressEvents}` to both BroadcastBuffer instances.

## Bugs fixed

1. **Hero BroadcastBuffers fire to FSM** — `minimal=true` now implies `suppressEvents=true`; Hero is view-only.
2. **Fullscreen dual V2PlayerContainer** — Inline BroadcastHlsPlayer gets `suppressEvents={isFullscreen}`; Modal player is sole FSM driver.
3. **Load timeout watchdog on Hero** — Gated with `!suppressEvents` — Hero backgrounded videos can't fire spurious buffer-error.
4. **Buffering watchdog on Hero** — Gated with `!suppressEventsRef.current` in onPlaybackStatusUpdate.
5. **Portrait auto-PiP missing** — AppState handler now calls `enterPip()` when `!isFullscreen && isBroadcastV2 && isPipSupported && !isYoutube`.
6. **Fullscreen controls in PiP window** — Wrapped with `{!isInPip && (...)}` to hide during PiP.
7. **AppState dep array** — Added `isBroadcastV2` to the deps to avoid stale closure.
8. **BroadcastHlsPlayer props** — Added `suppressEvents?: boolean` interface + threaded through to V2PlayerContainer.

## Known remaining gap

`useBroadcastSync()` (v1 WS to `/api/playback/ws`) is always called in `player.tsx` even in v2 mode — creates a duplicate WS connection. Only used for `sync.viewerCount` display. Fixing requires v2 server to expose viewerCount in its snapshot, or conditional hook logic. Acceptable as-is (benign double connection).

**Why:** Multiple mounted V2PlayerContainers sharing one FSM is by design (Hero preview + Player active simultaneously in React Navigation stack). The FSM singleton is correct; what was missing was a way for secondary instances to opt out of event reporting.

**How to apply:** Any new V2PlayerContainer that is "decorative" (muted preview, background, inline while modal is primary) should pass `suppressEvents={true}` or be `minimal={true}`. The primary player instance that owns the UX must NOT set suppressEvents.
