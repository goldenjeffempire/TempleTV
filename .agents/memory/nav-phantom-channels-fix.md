---
name: Phantom Channels navigation root causes and permanent fixes
description: Root causes of the app always opening to Channels tab and phantom player navigation, and the exact fixes applied.
---

# Phantom Channels Navigation — Root Causes & Fixes

## Root causes (all fixed July 2026)

### 1 — Wrong default tab (`(tabs)/_layout.tsx`)
- `ClassicTabLayout` had `initialRouteName="channels"` → every cold start on Android/older iOS landed on Channels instead of Watch/Home.
- `NativeTabLayout` `useLayoutEffect` called `router.replace("/channels")` once per app session → same effect on iOS 18+.
- **Fix:** `initialRouteName="index"`, NativeTabLayout redirects to `"/"` (Watch/Home).

### 2 — `LiveBroadcastSupervisor` `segments` in effect deps (PRIMARY phantom-nav cause)
- `useEffect([playLive, segments])` meant the ENTIRE effect (all timers, SSE connections, subscriptions) tore down and re-ran on every tab switch or navigation.
- On re-creation, `checkForLive()` and `checkV2Broadcast()` fired immediately.
- If YouTube was live, `checkForLive` → `router.push("/player")` on every tab change.
- **Fix:** Move segments access to `segmentsRef` (updated every render), remove `segments` from deps → effect runs once per mount.

### 3 — Cold-start aggressive V2 navigation (`LiveBroadcastSupervisor`)
- First V2 poll: if `prev === null` AND mode is PLAYING → `router.push("/player")` immediately.
- This meant every cold start while a broadcast was running → forced user to player screen.
- **Fix:** First poll = establish baseline only. Navigation fires only on TRANSITION (non-playing → PLAYING) while app is already open.

### 4 — All fallback redirects pointed to Channels
- `+not-found.tsx`: `router.replace("/(tabs)/channels")` → every 404 looked like phantom Channels tap.
- `_layout.tsx` deep-link guard (3 places): unknown/malformed URLs → `"/(tabs)/channels"`.
- **Fix:** All changed to `router.replace("/")` (Watch/Home).

## Safe remaining `/(tabs)/channels` references
- `link.tsx`: Cancel button press (user-triggered).
- `series/[slug].tsx`: Back-navigation fallback (user-triggered).
- `_layout.tsx` notification handler: `router.push("/(tabs)/channels")` for `emergency_broadcast`, `prayer`, `default` notification taps (user-triggered; `push` not `replace`).

## Key rule for future changes
**NEVER list `segments` from `useSegments()` in a `useEffect` dep array** if that effect manages timers, subscriptions, or polling. Use `segmentsRef.current` pattern instead.

**NEVER call `router.replace("/(tabs)/channels")` in automatic/non-user-triggered code.** Fallbacks go to `"/"` (Watch/Home). Channels is a content screen, not the app home.

## Nav debounce added
`LiveBroadcastSupervisor` now has `lastNavAtRef` + `NAV_DEBOUNCE_MS=3000` preventing stacked `router.push("/player")` calls within 3s of each other.
