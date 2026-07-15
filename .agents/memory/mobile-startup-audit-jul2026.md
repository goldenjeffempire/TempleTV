---
name: Mobile startup audit — Jul 2026 full pipeline review
description: Comprehensive audit of the mobile app cold-start pipeline; bugs found and fixed; areas confirmed production-grade.
---

# Mobile Startup Audit — Full Pipeline (Jul 2026)

## What was audited
Full cold-start pipeline: index.ts → _layout.tsx → AuthContext → PlayerContext → RadioStreamContext → UpdateContext → DownloadContext → usePictureInPicture → nowPlaying.ts → PlayerService.ts → notifications.native.ts → app.json / expo-build-properties / all plugins.

## Bugs found and fixed

### 1. PlayerContext.tsx — shuffle queue pin-key bug
`setQueue()` was calling `buildShuffledQueue(sermons, currentSermonRef.current?.youtubeId)`. For local/MP4 uploads `youtubeId` is `""`, so `findIndex(s => s.id === "")` always returns -1 and the current video is never pinned to position 0. Fixed: use `.id` (UUID) as the pin key.

### 2. usePictureInPicture.ts — missing mounted guard on async callbacks
Two `.then()` chains called `setIsInPip(true)` without checking `mountedRef.current`. Fixed: added `mountedRef` (useRef+useEffect cleanup), all setIsInPip calls guarded.

### 3. app.json — missing explicit New Architecture + Hermes flags
`expo-build-properties` android/ios sections had no `newArchEnabled` or `jsEngine` keys, relying on implicit SDK 57 defaults. Added explicitly for deterministic EAS builds.

### 4. app.json — missing android:largeHeap
High-res video + React Native peak ~280 MB, but default Dalvik heap on 2 GB devices can be as low as 192 MB → OOM cascade mid-playback. Fixed: new `plugins/with-large-heap.js` sets `android:largeHeap="true"` on the `<application>` element.

### 5. _layout.tsx — layout_mount fired on every render
`markStartupPhase("layout_mount")` was in the function body, firing on every re-render. Fixed: module-level `_layoutMountRecorded` boolean guard.

## New infrastructure added

### startupLifecycle.ts (`lib/startupLifecycle.ts`)
Phase tracer: `markStartupPhase(phase)` → timestamps + Sentry breadcrumbs. Phases:
`sentry_init → global_error_handler → rntp_register → layout_module_load → layout_mount → fonts_loaded → splash_hidden → audio_session → track_player_setup → auth_restore_start → auth_restore_done → providers_ready`
Wired into: index.ts, _layout.tsx, AuthContext.tsx

### ProvidersReadyMarker component
Zero-output component placed as innermost child of the provider stack in _layout.tsx. Records `providers_ready` phase once on first mount. Elapsed between `providers_ready` and `auth_restore_done` = token-restore latency visible to the user.

### Regression test suite (`__tests__/startup.test.ts`)
39 tests via node:test + tsx/esm. Covers: parseBoolParam, parseNumberParam, startupLifecycle, playbackQueue (including shuffle-key regression guard). Run: `pnpm --filter @workspace/mobile test`.

## Confirmed production-grade (no changes needed)
- index.ts: AbortSignal.timeout polyfill, Sentry init, ErrorUtils global handler, unhandledrejection listener, RNTP default-deny guard
- _layout.tsx: 8s splash safety timer, 800ms font timeout, setAudioSessionPromise coordination, setupTrackPlayer lazy
- AuthContext: 2-attempt SecureStore retry (500ms delay), finally always sets isLoading=false
- nowPlaying.ts: isNativeRNTPCapable() default-deny, lastBroadcastMode replay, all ops try/catch
- PlayerService.ts: lazy require("react-native-track-player") inside PlaybackService
- RadioStreamContext: stall watchdog, AppState recovery, exponential backoff, mountedRef cleanup
- UpdateContext: Play In-App Updates, mandatory block, OTA auto-apply, all platform-guarded
- notifications.native.ts: lazy require, try/catch registration, channel setup guarded
- All Android plugins: edge-to-edge, largeHeap, predictive back, PiP flags, foreground service type
- ProGuard rules: comprehensive coverage of all TurboModule + native library classes

**Why:** Pipeline is the product of many prior deep-fix sessions. The 4 bugs above were the only remaining gaps found after full re-audit.

## Follow-up re-audit (same month): cold-start notification-tap race
Re-ran a full pipeline audit (Application/native entry, Fabric/TurboModules, all native module registration, NavigationContainer/deep-linking, Player page, background tasks, permissions) via 3 parallel explorers. Everything from the original audit held up; one new/missed bug found:

`app/_layout.tsx`'s killed-app cold-start notification tap handler (`getLastNotificationResponseAsync`) fired `router.push()` after a hardcoded `setTimeout(..., 500)` guessing the navigator would be mounted by then. Slow cold starts (font load, auth restore) could exceed 500ms, dropping or crashing the deep-link navigation.

**Fix:** replaced the fixed delay with `useRootNavigationState()` readiness gating — the pending notification is queued in a ref and flushed by an effect keyed on `rootNavigationState?.key` (the real signal Expo Router's navigator has attached), with a 5s bounded fallback timer only as a last resort. This is the correct general pattern for any cold-start deep-link/notification routing in Expo Router — prefer `useRootNavigationState()?.key` over a fixed delay whenever `router.push()`/`router.replace()` must fire before the app has had a chance to render.
