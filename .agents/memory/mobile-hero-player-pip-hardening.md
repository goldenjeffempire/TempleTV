---
name: Mobile Hero+Player FSM isolation & PiP hardening
description: All bugs found and fixed across V2PlayerContainer / usePictureInPicture / push-notification deep-link during the comprehensive mobile broadcast audit (two sessions).
---

## Architecture facts

- **Singleton FSM session**: `useV2BroadcastNative` keys sessions by `baseUrl`. Both Hero and Player use the same key → same machine + transport + adapter. Navigating away does NOT stop the transport — instant resume on remount.
- **Hero is view-only**: `minimal=true` on Hero's V2PlayerContainer — BroadcastBuffers get `suppressEvents={true}` so they never fire buffer-error/watchdog events into the shared FSM. Player screen drives the FSM.
- **AppState reconnect**: Both Hero and Player V2PlayerContainers register AppState listeners. With the 50 ms debounce (Session 2), simultaneous same-tick calls are safe.
- **PiP detection**: Polled via `isInPictureInPictureMode()` on AppState changes only — battery-neutral. Must also be set eagerly on enter (manual and auto) to avoid stale-state flash.
- **Notification params**: player.tsx reads `params.isLive` and `params.broadcastMode`. Using `params.live` (wrong key) silently produces `isLive=false`.

---

## Session 1 — FSM isolation + suppressEvents (8 bugs fixed)

Root cause: Multiple mounted V2PlayerContainers sharing one FSM with no way for secondary (Hero, inline-while-fullscreen) instances to opt out of event reporting.

1. **Hero BroadcastBuffers fire to FSM** — `minimal=true` now implies `suppressEvents=true`; Hero is view-only.
2. **Fullscreen dual V2PlayerContainer** — Inline BroadcastHlsPlayer gets `suppressEvents={isFullscreen}`; Modal player is sole FSM driver.
3. **Load timeout watchdog on Hero** — Gated with `!suppressEvents`.
4. **Buffering watchdog on Hero** — Gated with `!suppressEventsRef.current`.
5. **Portrait auto-PiP missing** — AppState handler now calls `enterPip()` on background.
6. **Fullscreen controls in PiP window** — Wrapped with `{!isInPip && (...)}`.
7. **AppState dep array** — Added `isBroadcastV2` to avoid stale closure.
8. **BroadcastHlsPlayer props** — Added `suppressEvents?: boolean` + threaded through.

### Critical regressions also fixed in Session 1

- **`useCallback` not imported** — V2PlayerContainer.tsx used `useCallback` at line 365 but it was missing from the React import → runtime ReferenceError silently swallowed by ErrorBoundary.
- **`suppressEvents` not destructured** — Declared in Props interface but missing from the component's destructured parameter list. With `minimal=false` (Player screen), `false || !!suppressEvents` threw a ReferenceError → live broadcast player NEVER rendered on the Player screen. Hero safe via short-circuit (`true || !!suppressEvents`).

**Why:** Metro bundler does NOT block on TypeScript errors. TS errors become runtime ReferenceErrors. Always verify with `pnpm --filter @workspace/mobile run typecheck` after adding props.

**How to apply:** Any new V2PlayerContainer that is "decorative" (muted preview, background, inline while modal is primary) must pass `suppressEvents={true}` or `minimal={true}`. The primary player that owns the UX must NOT set suppressEvents.

---

## Session 2 — Push notif + double reconnect + PiP state bugs (5 bugs fixed)

### Bug 3 — Push notification deep-link wrong param key (CRITICAL)
`_layout.tsx` sent `live: "true"` in router.push params, but `player.tsx` reads `params.isLive` (not `params.live`). Every user who tapped a "live started" push notification landed with `isLive=false` and saw a blank placeholder.

**Fix:** Changed `live: "true"` → `isLive: "true"` in `_layout.tsx`.

### Bug 4 — Double `forceReconnect()` when Hero + Player both mounted
Expo Router caches the Home tab while the Player screen is open. Both AppState listeners call `forceReconnect()` on the same singleton transport in the same JS tick → second call clears the first's timer and fires `onConnectionChange(false)` twice (spurious connected=false flash).

**Fix:** Added `forceReconnectDebounce: ReturnType<typeof setTimeout> | null` to `NativeSession` in `react-native.ts`. The hook's returned `forceReconnect` debounces at 50 ms — collapses all same-tick calls into one `transport.forceReconnect()`.

### Bug 5 — `enterPip()` doesn't set `isInPip=true` immediately
`enterPip()` called `enterPictureInPicture()` and returned the result but never called `setIsInPip(true)`. PiP-hidden elements (controls, countdown overlay, chat) flashed briefly visible inside the PiP window on every manual PiP entry.

**Fix:** `const entered = await enterPictureInPicture(...); if (entered) setIsInPip(true); return entered;`

### Bug 6 — Auto-enter path NEVER set `isInPip=true`
`autoEnterOnBackground` path called `enterPictureInPicture(...).catch(() => {})` with no `.then()`. The `isInPictureInPictureMode()` check runs BEFORE `enterPictureInPicture()` completes → `isInPip` was set to `false` and never updated to `true` for the entire PiP session. Controls stayed visible for ALL auto-enter PiP sessions.

**Fix:** `.then((entered) => { if (entered) setIsInPip(true); }).catch(() => {})`

### Bug 7 — Initial `isInPip` hardcoded to `false`
`useState(false)` ignores actual PiP state on mount. If Player remounts while already in a PiP window, `isInPip` starts wrong and PiP-hidden elements flash.

**Fix:** `useState<boolean>(() => { if (Platform.OS !== "android") return false; try { return isInPictureInPictureMode(); } catch { return false; } })`

---

## Known remaining gap

`useBroadcastSync()` (v1 WS to `/api/playback/ws`) is always called in `player.tsx` even in v2 mode — creates a second WS connection. Only used for `sync.viewerCount` display. Fixing requires v2 server to expose viewerCount in its snapshot, or conditional hook logic. Acceptable as-is (benign duplicate connection).
