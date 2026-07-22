---
name: Android 16 (API 36) migration audit — mobile app
description: Full audit results for Android 16 / Google Play compliance; what was already done, what was changed, and rules to follow going forward.
---

## Audit result: project was already 90% Android 16-ready

All critical SDK targets (compileSdk 36, targetSdk 36, minSdk 24, buildToolsVersion 36.0.0, NDK r27) were already set via expo-build-properties. New Architecture (newArchEnabled=true), Hermes, and Kotlin 2.1.20 were all already in place.

## Pre-existing compliant plugins (do NOT remove or change):

- `with-enable-edge-to-edge.js` — injects `enableEdgeToEdge()` before `super.onCreate()`; required for API 36 which removes windowOptOutEdgeToEdgeEnforcement
- `with-edge-to-edge.js` — strips deprecated `windowOptOutEdgeToEdgeEnforcement` from themes
- `with-foreground-service-type.js` — ensures RNTP MusicService has `foregroundServiceType="mediaPlayback"` (API 34+ hard requirement)
- `with-16kb-page-size.js` — sets `jniLibs.useLegacyPackaging=false` for 16KB page alignment (NDK r27 required)
- `with-android-activity-flags.js` — PiP, resizeableActivity, configChanges set
- `with-predictive-back.js` — `android:enableOnBackInvokedCallback="true"` (API 33+)
- `expo-pip-android/ExpoPipAndroidModule.kt` — PiP with FLAG_IMMUTABLE, RECEIVER_NOT_EXPORTED, setAutoEnterEnabled(API 31+)

## Changes made in this migration:

### 1. ExpoPipAndroidModule.kt — 4 improvements:
- **Android 15+ (API 35 / VANILLA_ICE_CREAM) `setCloseAction()`**: Custom close button in PiP overlay fires `{ action: "close" }` to JS. Without this, user closing PiP leaves media playing invisibly in background.
- **`disableAutoEnterPip()` function (API 31+)**: More targeted than `updatePipParams(autoEnter=false)` — only resets autoEnter flag; avoids racing a concurrent PiP session. Called from hook cleanup.
- **`areNotificationsEnabled()` guard before `postRestoreNotification()`**: API 33+ (TIRAMISU) runtime notification permission check. Prevents SecurityException on devices where user denied POST_NOTIFICATIONS.
- **`channelCreated` flag**: Makes channel creation idempotent without re-constructing the NotificationChannel object on every notification post.
- **ACTION_PIP_CLOSE + RC_CLOSE constants** added; receiver filter updated to include the close action.

### 2. expo-pip-android/src/index.ts:
- `PipActionEvent.action` union widened to `"play" | "pause" | "close"` (backward compatible).
- `disableAutoEnterPip()` exported function added.
- `NativeModule` interface updated with `disableAutoEnterPip()`.

### 3. hooks/usePictureInPicture.ts:
- `onClose?: () => void` option added. The "close" event from the PiP overlay is routed to `onCloseRef.current?.()` (separate from `onPlayPause`). Player callers should add `onClose` to stop playback when the PiP close button is tapped.
- Cleanup now calls `disableAutoEnterPip()` instead of `updatePipParams(autoEnter=false)`.

### 4. plugins/with-android-activity-flags.js:
- Added `android.window.PROPERTY_ACTIVITY_EMBEDDING_ALLOW_SYSTEM_OVERRIDE = "true"` as application-level `<meta-data>`. Required for Google Play "Large screen ready" badge — opts in to system-managed split-screen on tablets/foldables without requiring manual implementation.
- Added `grammaticalGender` to `configChanges` (Android 14 / API 34 new category for RTL locale handling).

### 5. plugins/with-gradle-config.js:
- Added `android.enableJetifier=false` — all RN 0.86 / Expo 57 deps are AndroidX-native; Jetifier is an unused build step that was only adding overhead. Deprecated in AGP 9.x.
- Added `org.gradle.configuration-cache=true` — Gradle 8.1+ feature; caches task configuration graph between builds; saves 30–90s per incremental build.

### 6. plugins/with-foreground-service-type.js:
- Added second pass over `<receiver>` elements: receivers WITH intent-filters get `exported="true"`, receivers WITHOUT get `exported="false"`. Prevents AGP 8.x build errors on API 31+.
- Added RNTP 2.x legacy service name (`com.guichaguri.trackplayer.service.MusicService`) to `MEDIA_SERVICE_NAMES` set.

### 7. modules/expo-in-app-updates/android/build.gradle:
- `kotlinx-coroutines-android` and `kotlinx-coroutines-play-services` updated `1.9.0 → 1.10.1` (latest stable; aligned with Kotlin 2.1.x and API 36).
- Migrated to `plugins {}` block (AGP 8.x) from `apply plugin:` to silence deprecation warnings.

### 8. eas.json:
- `production-android.autoIncrement`: `false → true`. Without this, versionCode must be manually bumped before every Play Store submission; forgetting causes the AAB to be rejected.

### 9. app.json:
- `android.versionCode`: `111 → 112` to account for the native code changes in this migration.

## Rules for ongoing development:

**PiP close action**: Any player screen using `usePictureInPicture` should pass `onClose: () => stopPlayback()` to stop media and release resources when the user closes the PiP overlay on Android 15+. Without it, media continues invisibly after the overlay is dismissed.

**DO NOT re-enable Jetifier**: `android.enableJetifier=false` is intentional; adding new dependencies that require Jetifier means the dependency itself is using legacy Support Library (a red flag) — fix the dep, don't re-enable Jetifier.

**DO NOT re-enable configuration-cache**: If a build breaks with "Configuration cache problems", fix the offending Gradle plugin rather than disabling the cache.

**Embedding property**: `android.window.PROPERTY_ACTIVITY_EMBEDDING_ALLOW_SYSTEM_OVERRIDE` in the Application metadata must stay as `"true"` — removing it drops the Google Play large screen compatibility score.

**`VANILLA_ICE_CREAM` constant**: `Build.VERSION_CODES.VANILLA_ICE_CREAM` = API 35 (Android 15). `Build.VERSION_CODES.BAKLAVA` = API 36 (Android 16). Both are available since compileSdk 36.
