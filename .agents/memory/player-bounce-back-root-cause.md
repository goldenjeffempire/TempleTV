---
name: Player Android navigation — complete root cause map (builds 127–130)
description: Definitive diagnosis of why the player screen never appeared on Android — four layered root causes, each fixed in sequence.
---

## Root Causes (four layers, all fixed)

### Layer 1 — LiveBroadcastSupervisor concurrent-push race (fixed build 128)
Supervisor fires navigateToPlayer() from SSE/poll while a user-initiated
safeNavPush is mid-animation. segmentsRef hasn't updated yet so onPlayer()=false,
causing a second push → React Navigation resets stack to last stable state (home).

**Fix:** `if (isNavPushActive()) return;` guard in navigateToPlayer.
`safeNavPush` stamps `navPushActiveUntil` immediately so the guard is synchronous.

### Layer 2 — Android predictive-back gesture on modal (fixed build 128→129)
`presentation: "modal"` with `animation: "slide_from_bottom"` on Android 13+:
The OS predictive-back system shows a dismiss preview even during the opening
animation. `gestureEnabled: false` at the layout level is insufficient because
React Navigation's `setOptions` merge order means it can silently be dropped
before it reaches the native screen implementation.

**Fix (build 128):** `gestureEnabled: false` added to layout Stack.Screen.
**Fix (build 129):** Removed `presentation: "modal"` entirely on Android → card push.
React Navigation 7 changed modal to an overlay on Android (home screen stays
underneath). Card push fully replaces the previous screen — no overlay race.

### Layer 3 — Component-level Stack.Screen drops gestureEnabled (fixed build 130)
`player.tsx` renders `<Stack.Screen options={{ headerShown:false, header:null, title:"" }}>`.
In React Navigation 7 / Expo Router SDK 57, this calls `navigation.setOptions()`
which can REPLACE the navigator-level options rather than merging on Android,
silently dropping `gestureEnabled:false` and `animation`. The screen then has
default gesture=true, re-enabling Android predictive-back on the card screen.

**Fix (build 130):** Re-declare `gestureEnabled:false` and `animation:"slide_from_bottom"`
in the component-level `<Stack.Screen options={...}>`. Now both layers explicitly
set these — they can never be lost through any merge/replace behavior.

**Rule:** Any `<Stack.Screen options={...}>` rendered inside a route component MUST
repeat the gesture and animation options from the layout's `<Stack.Screen name="…">`.

### Layer 4 — No BackHandler on Android (fixed build 130)
Without a `BackHandler.addEventListener("hardwareBackPress", ...)` in the player,
the Android system back button (hardware + predictive-back gesture completion) is
handled by React Navigation's default behavior. If gestureEnabled is accidentally
true (Layer 3), a predictive-back swipe completes the dismiss automatically.

**Fix (build 130):** `useFocusEffect` + `BackHandler.addEventListener` in player.tsx.
Intercepts `hardwareBackPress` while player is focused, handles it ourselves
(router.back() or router.replace("/")), returns `true` to prevent default.
Auto-cleaned up when player loses focus (e.g. user opens a child modal).

### Bonus: Player transparent on first render (fixed build 130)
`styles.root = { flex:1 }` — no static backgroundColor. Dynamic `c.background`
from `useColors()` theme hook can be undefined before theme resolves → transparent
first frame. On card push (not modal), the navigation container shows through.

**Fix (build 130):** `styles.root = { flex:1, backgroundColor:"#0a0a0a" }`.
The dynamic `{ backgroundColor: c.background }` inline style overrides once
the theme resolves, but the fallback ensures the screen is opaque from frame 1.

### Bonus: navPushActiveUntil window too short (fixed build 130)
1500ms window may expire before React Navigation commits the screen on slow
Android devices (push animation + commit cycle). After expiry, if the Supervisor
checks again, `isNavPushActive()=false` AND `onPlayer()` might still be false
(segments not yet updated) → Supervisor fires a second push → stack resets.

**Fix (build 130):** `navPushActiveUntil = Date.now() + 3_000` (was 1500ms).

## Key Architecture Facts
- `isBroadcastV2 = isLive && !(!!youtubeId && !hlsUrl)` — always true when
  opening from hero hero CTA (youtubeId="", isLive=true). Player renders
  BroadcastHlsPlayer on first frame, swaps to YoutubePlayer ~100ms after the
  V2 snapshot arrives (YouTube-only platform).
- `handleOpenPlayer` passes `hlsUrl:"", youtubeId:"", isLive:"true"` — the
  player resolves source internally from V2 broadcast state, not from params.
- `LiveBroadcastSupervisor` is in `_layout.tsx` (global). Effect dep `[playLive]`.
  `playLive` is useCallback([]) — stable. Effect runs ONCE per app session.
  COLD-START RULE 2: first V2/YouTube poll = baseline only, never auto-navigates.
- `ClassicTabLayout` (Android) has ZERO navigation logic. No router.replace.
- `AuthContext.router.replace("/login")` only fires on session expiry.
- `NativeTabLayout` (iOS 18+ liquid glass) has router.replace("/") guard,
  already protected by `isNavPushActive()`.

## Build History
- Build 127: LinearGradient/View fix (wrong diagnosis). Player still broken.
- Build 128: isNavPushActive() guard + gestureEnabled:false. Partially fixed Layer 1.
- Build 129: card presentation on Android (no modal). Fixed Layer 2. v1.0.63/129.
- Build 130: BackHandler + component-level gestureEnabled + backgroundColor +
  navPushActiveUntil=3s. Fixed Layers 3+4+bonus. v1.0.63/130.
