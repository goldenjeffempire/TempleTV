---
name: Player-core hook ref stability
description: useV2BroadcastNative must wrap all returned callbacks in useCallback; video ref callbacks in TV/admin must be stable or HLS tears down and reattaches on every render.
---

## Rule

**Mobile hook** (`lib/player-core/src/react-native.ts`): every function in the `useV2BroadcastNative` return object — `reportBufferEvent`, `forceReconnect`, `notifyOnline` — plus both `useSyncExternalStore` lambdas must be wrapped in `useCallback([session])`. The session object is the stable singleton, so these callbacks change only when `baseUrl` or `enabled` changes (i.e. almost never).

**TV/admin video ref callbacks**: `attach.A` and `attach.B` from `useV2Broadcast` (web hook, `react.ts`) are already `useCallback`-ized and stable. But wrapping them in inline JSX lambdas (e.g. `ref={(el) => { myRef.current = el; attach.A(el); }}`) creates a NEW function on every render. React calls the OLD lambda with `null` (cleanup → `detachElements` → HLS destroyed, src cleared) then the NEW lambda with `el` (→ `attachElements` → HLS re-initialized). Fix: extract a `useCallback` ref that captures both the local ref write and `attach.A(el)`.

**Why:**
- `reportBufferEvent` flows into `BroadcastBuffer`'s `emit = useCallback(..., [reportBufferEvent])`. If `reportBufferEvent` is new each render, `emit` is new, and the play effect re-runs — calling `playFromPositionAsync()` on MP4/non-HLS buffers even when nothing in the broadcast changed (spurious seek stall).
- `forceReconnect` / `notifyOnline` sit in `V2PlayerContainer`'s AppState `useEffect` dep-array. New references each render remove and re-add the AppState listener each time — a brief window where app-foregrounding is not handled.
- Inline video ref lambdas cause full HLS teardown+reattach on every re-render of the TV/admin preview component: brief black-frame flash, buffer refill delay, spurious `buffer-error` FSM events. The web hook's own comment says exactly this.

**How to apply:**
- Whenever `useV2BroadcastNative` result functions are used in dependency arrays or passed to `React.memo` children, ensure the hook returns stable references.
- Whenever mounting `<video ref={...} />` elements that call `attach.A`/`attach.B`, define the ref callback outside JSX using `useCallback([attach.A])` / `useCallback([attach.B])`.
- Files fixed: `lib/player-core/src/react-native.ts`, `artifacts/tv/src/components/LiveBroadcastV2.tsx`, `artifacts/admin/src/playback/BroadcastPreviewV2.tsx`.
