---
name: Player bounce-back root cause and fix
description: "Open Player" button on Android — player modal opens briefly and immediately returns to home. Three-layer diagnosis across builds 128 and 129.
---

## Root Causes (three layers)

### Layer 1 — LiveBroadcastSupervisor concurrent-push race (fixed build 128)

`LiveBroadcastSupervisor` fires `navigateToPlayer()` from async SSE/poll callbacks.
If the callback resolves while a user-triggered `safeNavPush("/player")` is mid-animation,
`segmentsRef.current` hasn't updated yet so `onPlayer()` returns false and the Supervisor
pushes a second time — Expo Router resets the stack to the last stable state (home).

**Fix (build 128):** Added `if (isNavPushActive()) return;` guard in `navigateToPlayer`.
`safeNavPush` stamps `navPushActiveUntil + 1500ms` so the guard is synchronous and reliable.

### Layer 2 — Android predictive-back gesture (fixed build 128)

`presentation: "modal"` with `animation: "slide_from_bottom"` on Android 13+ allows
the predictive back gesture during the opening animation. Tap near the bottom edge →
Android interprets as back gesture → modal dismissed before it settles.

**Fix (build 128):** Added `gestureEnabled: false` to the player Stack.Screen.

### Layer 3 — React Navigation 7 modal overlay behaviour on Android (fixed build 129)

In React Navigation 7 (Expo Router SDK 57), `presentation: "modal"` changed on Android:
the modal is now an *overlay* (like iOS) where the previous screen stays rendered/visible
underneath. On Android 13+ the OS predictive-back system can immediately dismiss this
overlay even with `gestureEnabled: false` in React Navigation — because `gestureEnabled`
controls the RN gesture recognizer but NOT the Android system-level back prediction.

Result: player slides up briefly, Android system dismisses it, home screen snaps back.
User sees "the home screen never leaves" because the home screen IS always behind the modal.

**Fix (build 129):** Made `presentation` platform-aware:
- iOS: keeps `presentation: "modal"` (native sheet UX)
- Android: omits `presentation` entirely → default "card" full-screen push (no overlay,
  no dismissal race)

**Why:** "card" on Android fully replaces the previous screen in the view hierarchy —
there is no overlay, no transparency, and no system back event fired during the push.
The `animation: "slide_from_bottom"` still gives the same visual effect.

**How to apply:** Any screen that uses `presentation: "modal"` and behaves correctly on
iOS but immediately dismisses on Android should switch to this pattern:
```tsx
...(Platform.OS === "ios" ? { presentation: "modal" as const } : {}),
animation: "slide_from_bottom",
gestureEnabled: false,
```

## Diagnostic added (build 129)

`+not-found.tsx` now calls `Sentry.captureMessage` + `addBreadcrumb` when it mounts,
logging the pathname. This is a canary: if a player navigation path shows up here in
Sentry it means the route failed to resolve (module crash or path mismatch).

## Files Changed

- `artifacts/mobile/app/_layout.tsx` — player Stack.Screen: platform-aware presentation
- `artifacts/mobile/components/LiveBroadcastSupervisor.tsx` — `isNavPushActive()` guard
- `artifacts/mobile/app/+not-found.tsx` — Sentry canary logging
- `artifacts/mobile/app.json` — versionCode: 127→128→129
