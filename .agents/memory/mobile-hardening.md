---
name: Mobile app hardening — confirmed bugs and audit outcomes
description: Durable lessons from the mobile full-audit. What was broken, what was already OK, and the rules to keep in mind for future mobile work.
---

# Mobile App Hardening (May 2026)

## Bugs fixed

### Quick-finish retry timer race (V2PlayerContainer)
`setTimeout(1_000)` in the HLS quick-finish retry path stored no handle, so clearing it on `bindRevision` change was impossible. If the queue advanced during that 1 s window the retry fired `playFromPositionAsync(0)` on the **new** source, seeking it to position 0 and creating a desync loop.

**Fix:** `quickFinishRetryTimerRef` stores the handle; `clearQuickFinishRetry()` is called both in the `bindRevision` reset effect and the unmount cleanup.

**How to apply:** Any `setTimeout` inside a per-bindRevision effect that touches `ref.current` must be stored in a ref and cancelled in the `state.bindRevision` effect and the unmount effect.

### Audio session not restored on player screen unmount (player.tsx)
`player.tsx` asserts `shouldDuckAndroid: false` (exclusive focus) on mount but never restored the global `shouldDuckAndroid: true` policy on unmount. After leaving the player, radio and other in-app audio lost the ability to duck correctly on Android.

**Fix:** The `Audio.setAudioModeAsync` call in player.tsx now returns a cleanup that re-asserts `shouldDuckAndroid: true`.

**How to apply:** Any screen that tightens the global audio policy for its own needs must restore it in the effect cleanup.

### ChatClient WebSocket NAT drop (ChatClient.ts)
No client-side ping was sent. Mobile NAT gateways silently drop idle TCP connections after 2-5 min. The client only discovered the dead socket when the user tapped Chat (next send call) or the app foregrounded.

**Fix:** `startPing(ws)` starts a 25 s `setInterval` on `onopen`; `stopPing()` is called on `onclose` and `stop()`. Sends `{ type: "ping" }` which the server handles as a no-op.

**How to apply:** All WS clients in mobile must use a ≤30 s client-side ping. 25 s is the confirmed safe interval.

### useMidnightPrayersSwitch fetch had no AbortController (V2PlayerContainer)
Config fetch on mount ran without a signal. Rapid navigation → unmount before fetch resolved → React "setState on unmounted component" warning, plus stale channel switch.

**Fix:** `new AbortController()` per effect; `controller.abort()` in cleanup.

**How to apply:** All `fetch()` calls inside `useEffect` must pass `{ signal: controller.signal }` and return `() => controller.abort()`.

## Audited — confirmed OK (no fix needed)

- **SSRF suffix matching** — `endsWith(".domain.com")` requires a dot before domain; correct.
- **Stall vote double-skip** — protected by `stallActionCooldown`; correct.
- **HLS_SMALL_DRIFT_SKIP_MS = 30 s** — only applies to VOD HLS position seeks; live HLS always uses `playAsync()` which latches to the live edge. No drift guard needed for live.
- **Quick-finish race wrt unmount** — `ref.current` is null on unmount; `ref.current?.playAsync()` is a safe no-op.
- **Session janitor (react-native.ts)** — correctly evicts sessions after 5 min idle; listener count check is correct.
- **LocalVideoPlayer stall nudge on native** — already branches on `Platform.OS === "web"` (DOM `currentTime`) vs native (`setPositionAsync` via expo-av); correct.
- **probeHasAudio false on timeout** — intentional; video-only is the safe fallback.
