---
name: Android 15 edge-to-edge + PiP implementation
description: How Android 15 edge-to-edge compliance and Picture-in-Picture were implemented in the mobile app, including the Google Play deprecation fix.
---

## Edge-to-edge (Android 15 / API 35) — current correct approach

**Why:** Apps targeting API 35+ have edge-to-edge enforced automatically. The old theme-attribute approach (`android:statusBarColor`, `android:navigationBarColor`, etc.) is deprecated in API 35 and flagged by Google Play as "deprecated APIs or parameters for edge-to-edge".

**Two-part fix (both plugins required):**

### 1. `plugins/with-enable-edge-to-edge.js` (NEW — the core fix)
Uses `withMainActivity` to inject into `MainActivity.kt`:
- `import androidx.activity.enableEdgeToEdge`
- `enableEdgeToEdge()` call BEFORE `super.onCreate(savedInstanceState)`

This is the modern replacement for all the deprecated theme attributes. `enableEdgeToEdge()` is from `androidx.activity:activity-ktx` which ships transitively with React Native 0.75+.

**Plugin is idempotent** — checks for `enableEdgeToEdge()` presence before injecting. Handles both `super.onCreate(savedInstanceState)` and `super.onCreate(null)` patterns.

### 2. `plugins/with-edge-to-edge.js` (UPDATED — removes deprecated attrs)
Only retains the two non-deprecated theme items:
- `android:windowLayoutInDisplayCutoutMode = shortEdges` — fills notch in landscape video fullscreen
- `android:windowOptOutEdgeToEdgeEnforcement = false` — explicitly opt IN to Android 15 enforcement

Actively removes deprecated items if present from old plugin version:
- `android:statusBarColor` ← deprecated API 35
- `android:navigationBarColor` ← deprecated API 35
- `android:windowTranslucentStatus` ← deprecated
- `android:windowTranslucentNavigation` ← deprecated
- `android:windowDrawsSystemBarBackgrounds` ← deprecated

**Plugin order in app.json:** `with-enable-edge-to-edge.js` THEN `with-edge-to-edge.js`.

**SafeAreaProvider** is already at root (`app/_layout.tsx`) so insets are provided to all screens. `useSafeAreaInsets()` is already used in `player.tsx` for player controls.

## Picture-in-Picture — current correct structure

**Why the previous build failed Google Play PiP check:** The `expo-pip-android` native module was missing its entire Android native implementation (`android/` directory was absent). The manifest declared `android:supportsPictureInPicture="true"` but there was no Kotlin code to actually invoke it, so Google Play correctly flagged it as "implement picture-in-picture".

**Architecture:**

### Native module: `modules/expo-pip-android/`
Required file structure:
```
expo-module.config.json       ← registers ExpoPipAndroidModule
package.json
src/index.ts                  ← JS wrapper (already existed)
android/build.gradle          ← NEW: gradle config with expo-module-gradle-plugin
android/src/main/AndroidManifest.xml  ← NEW: package declaration
android/src/main/kotlin/expo/modules/pipandroid/
  ExpoPipAndroidModule.kt     ← NEW: Kotlin implementation
```

### `ExpoPipAndroidModule.kt` exports:
- `AsyncFunction("enterPictureInPicture")` — calls `activity.enterPictureInPictureMode(params)` on UI thread via `runOnUiThread + CountDownLatch(3s)`. Returns `Boolean`. Posts restore notification if `withRestore=true`.
- `Function("isPictureInPictureSupported")` — checks `packageManager.hasSystemFeature("android.software.picture_in_picture")`
- `Function("isInPictureInPictureMode")` — reads `activity.isInPictureInPictureMode`
- `AsyncFunction("updatePipParams")` — calls `activity.setPictureInPictureParams(params)` on UI thread (pre-register for system-gesture PiP, API 31+)
- `AsyncFunction("cancelPipRestoreNotification")` — cancels notification ID 9001

**UI thread pattern:** `enterPictureInPictureMode()` and `setPictureInPictureParams()` must run on the main thread. Use `activity.runOnUiThread { ... }` + `CountDownLatch(1).await(3, SECONDS)` — DO NOT call these from the background thread Expo runs AsyncFunctions on.

**Restore button:** Uses `RemoteAction` with `android.R.drawable.ic_menu_zoom` icon + `PendingIntent.getActivity` for launch intent. Also posts a persistent `NotificationCompat.PRIORITY_LOW` notification (channel: `pip_restore_channel`, ID: 9001) via `NotificationManager`.

**Manifest (with-android-activity-flags.js):** Already sets `android:supportsPictureInPicture="true"` and configChanges including `screenLayout|smallestScreenSize|screenSize`. No changes needed.

**Hook:** `hooks/usePictureInPicture.ts` — polls `isInPictureInPictureMode()` on AppState changes, auto-enters on background if `autoEnterOnBackground=true`.

**Import path in hook:** `"../modules/expo-pip-android/src"` (relative, not package name) — TypeScript resolves without needing symlink first.

## Version for this fix
versionCode 56 (v1.0.16 → next build). `production-android` has `autoIncrement:false` so versionCode must be bumped manually in `app.json` for each release.

## Build failure history (June 2026)

Build `bd5ad982` (versionCode 83) failed with `EAS_BUILD_UNKNOWN_GRADLE_ERROR` — same root cause as Google Play PiP check: `android/` directory was absent. The missing three files were recreated:
- `android/build.gradle` — uses `expo-module-gradle-plugin` + `org.jetbrains.kotlin.android`; namespace `expo.modules.pipandroid`; minSdkVersion 24
- `android/src/main/AndroidManifest.xml` — package declaration only
- `android/src/main/kotlin/expo/modules/pipandroid/ExpoPipAndroidModule.kt` — full Kotlin impl (see above)

New build `d112e173` (versionCode 84) submitted with both the TypeScript fixes (8 errors across 5 files) and the restored Kotlin native module.
