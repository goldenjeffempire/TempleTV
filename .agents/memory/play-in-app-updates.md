---
name: Play In-App Updates architecture
description: How the Google Play In-App Updates native module + React hook are wired for Temple TV mobile.
---

## Native module (Kotlin)
- `ExpoInAppUpdatesModule.kt` at `modules/expo-in-app-updates/android/...`
- `AppUpdateManager` created in `OnCreate`; `AppUpdateOptions` + `startUpdateFlowForResult` in `AsyncFunction("startUpdate")`
- The Play dialog result arrives in `OnActivityResult` — bridge to the suspended coroutine with `CompletableDeferred<Int>`; `withTimeout(120_000L)` prevents indefinite hang
- `InstallStateUpdatedListener` registered in `attachInstallListener()` (idempotent); sends `onInstallStateUpdate` events with `{status, progress, bytesDownloaded, totalBytesToDownload}`
- `completeUpdate()` triggers app restart for flexible updates

## React hook (`hooks/usePlayInAppUpdates.ts`)
- **Circular dep pattern**: `scheduleRetry` must call `runCheck` but `runCheck` must call `scheduleRetry`. Fix: `runCheckRef = useRef(async ()=>{})`, schedule uses `runCheckRef.current`, effect keeps ref current with `runCheckRef.current = runCheck`
- **Snooze**: per-`versionCode` 24 h snooze in AsyncStorage (`@temple_tv/play_update_snoozed_vc`)
- **Mandatory threshold**: `staleDays >= 5` OR `serverIsMandatory` → IMMEDIATE update auto-starts; falls back to FLEXIBLE if IMMEDIATE not allowed
- **stateRef**: `stateRef.current` kept in sync inside `setPartial` so `dismissSheet` can read latest state without stale closure

## Context integration (`context/UpdateContext.tsx`)
- `usePlayInAppUpdates(state.isMandatory)` called inside `UpdateProvider`
- Play state synced into `UpdateState.play` via effect with bail-out comparison (9 fields)
- `UpdateState.play: PlayUpdateState` + `UpdateActions.playActions: PlayUpdateActions` exposed via `useUpdate()`
- Global `checkNow()` also calls `playUpdate.checkNow()`

## Layout wiring (`app/_layout.tsx`)
- `PlayFlexibleUpdateOverlay` component reads `play` + `playActions` from `useUpdate()` and renders `FlexibleUpdateSheet`
- Mounted after `MandatoryUpdateGate` in root layout tree

## Build
- `build.gradle`: `com.google.android.play:app-update-ktx:2.1.0` + `kotlinx-coroutines-play-services:1.9.0`
- `app.json extraProguardRules`: `-keep class com.google.android.play.core.**` + `expo.modules.inappupdates.**`
- Package registered as `"expo-in-app-updates": "file:./modules/expo-in-app-updates"` in mobile `package.json`

**Why:**
Play In-App Updates requires Activity lifecycle (dialog + `onActivityResult`) which can't be done purely in JS. The `CompletableDeferred` + `OnActivityResult` bridge is the only reliable way to suspend a coroutine until the Play dialog resolves.
