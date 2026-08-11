---
name: Player bounce-back root cause and fix
description: "Open Player" button on Android causes the player modal to open briefly and immediately return to home — two-layer root cause and fix.
---

## Root Cause

Two independent issues combine to cause the bounce-back:

### 1. LiveBroadcastSupervisor concurrent-push race (primary cause)

`LiveBroadcastSupervisor.checkForLive()` fires on mount AND on every SSE event. When it returns `isLive: true` (which it can for a YouTube-only deployment if `/api/youtube/live/status` returns a fresh cached value), it calls the Supervisor's internal `navigateToPlayer()` via `safeNavPush("/player", ...)`.

If this resolves while a user-triggered `safeNavPush("/player", ...)` is already mid-animation (< 1500 ms in), the `onPlayer()` guard does NOT block it because `segmentsRef.current` (from `useSegments()`) hasn't been re-read from the updated navigation state yet. Expo Router receives a **second push onto a transitioning modal** and resets the navigation stack to the last stable state — home screen.

**Fix:** Added `isNavPushActive()` check inside the Supervisor's local `navigateToPlayer` helper. Since `safeNavPush` sets `navPushActiveUntil + 1500ms`, the Supervisor blocks its own push during any other in-flight navigation.

### 2. Android predictive back gesture (secondary cause)

`presentation: "modal"` with `animation: "slide_from_bottom"` on Android 13+ allows the predictive back gesture. A tap near the bottom edge of the screen (where "Open Player" lives) during the opening animation can be interpreted as a back gesture and dismiss the modal.

**Fix:** Added `gestureEnabled: false` to the player Stack.Screen in `_layout.tsx`.

## Files Changed

- `artifacts/mobile/components/LiveBroadcastSupervisor.tsx` — import `isNavPushActive` from `@/lib/safeNavPush`; add `if (isNavPushActive()) return;` guard before the push in local `navigateToPlayer`.
- `artifacts/mobile/app/_layout.tsx` — add `gestureEnabled: false` to the player Stack.Screen options.
- `artifacts/mobile/app.json` — versionCode bumped 127 → 128 for this fix.

**Why:** The `onPlayer()` guard (checks `segmentsRef.current.includes("player")`) is inherently racy during the React render cycle — it's only reliable after the segment update propagates via re-render. `isNavPushActive()` is module-level and synchronous — it's set immediately when `safeNavPush` is called, making it a reliable concurrent-navigation gate.

**How to apply:** If `LiveBroadcastSupervisor` gets a new navigation helper, always check `isNavPushActive()` before any `safeNavPush` call inside async callbacks (network requests, timers, SSE handlers).
