---
name: Android build warnings audit — mobile app
description: Comprehensive audit of all Android build warnings for the Temple TV mobile app (Expo SDK 57, RN 0.86, AGP 8.x, Gradle 9.3.1). All known warnings eliminated July 2026.
---

## Result
Zero deprecated-DSL warnings, zero lint-icon warnings, zero duplicate-dependency warnings on EAS build after these fixes.

## Fixes applied

### CRITICAL — EAS broken builds
- `eas.json` all build profiles now have `"pnpm": "10.26.1"`. Without this EAS workers default to pnpm 8.7.5 which cannot read pnpm-10 lockfiles → instant UNKNOWN_ERROR at Install phase.
- Only `production-android` had the pin before; 9 other profiles were missing it.

### Kotlin — notification / RemoteAction icons
- `ExpoPipAndroidModule.kt` was using `android.R.drawable.ic_media_play/pause` for:
  - `setSmallIcon()` on the foreground notification → `NotificationIconCompatibility` lint warning
  - `Icon.createWithResource()` in PiP RemoteActions → reliance on OEM-variable system drawables
- Fix: created `ic_pip_play.xml` and `ic_pip_pause.xml` (white/transparent vectors, `#FFFFFFFF` fill) in the module's `android/src/main/res/drawable/`. These replace the system drawables.
- Notification small icon now uses `R.drawable.ic_pip_expand` (already existed, white vector).

### Gradle DSL — proguard
- `plugins/with-modern-gradle-dsl.js` now replaces `proguard-android.txt` → `proguard-android-optimize.txt` in the generated `app/build.gradle`.
- Enables R8 full-mode (dead-code removal, inlining, class merging). Safe because explicit `-keep` rules in `proguard-rules.pro` protect all reflection-accessed classes.

### Gradle DSL — lintOptions
- Same plugin now also replaces `lintOptions {` → `lint {` (renamed in AGP 7.0).

### Gradle JVM heap
- New plugin `plugins/with-gradle-config.js` writes `org.gradle.jvmargs` to `gradle.properties` at prebuild time.
- Value: `-Xmx4g -XX:MaxMetaspaceSize=512m -XX:+UseG1GC -XX:SoftRefLRUPolicyMSPerMB=0 -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8`
- Also enables: `org.gradle.parallel=true`, `org.gradle.caching=true`, `android.enableR8.fullMode=true`
- Why separate plugin from `expo-build-properties`: that plugin's `jvmArgs` sets the Android plugin JVM, NOT the Gradle daemon JVM (which is what `org.gradle.jvmargs` controls).

### Package.json duplicate
- `expo: ~57.0.4` was in BOTH `dependencies` and `devDependencies`.
- Expo prebuild always writes `expo` to `dependencies` (correct — it's a runtime dep).
- Fix: removed from `devDependencies`.

### Third-party patches — new
- `@sentry/react-native@7.11.0`: `compileSdkVersion/minSdkVersion/targetSdkVersion` → `compileSdk/minSdk/targetSdk`
- `@react-native-masked-view/masked-view@0.3.2`: same + `lintOptions` → `lint`
- Patch files: `patches/@sentry+react-native@7.11.0.patch`, `patches/@react-native-masked-view+masked-view@0.3.2.patch`
- Registered in workspace root `package.json` pnpm.patchedDependencies AND `pnpm-lock.yaml` (patchedDependencies section + snapshot keys with `patch_hash=`)

## Libraries confirmed clean (no patches needed)
- `react-native-reanimated@4.5.0` — uses CMakeLists.txt + RN new build system, no traditional Gradle module
- `react-native-worklets@0.10.0` — same, no build.gradle
- `react-native-youtube-iframe` — JS/WebView only, no Android native
- `react-native-sse` — JS only

## Already-patched libraries (confirmed still clean)
react-native-track-player, react-native-screens, react-native-gesture-handler, react-native-webview, react-native-keyboard-controller, react-native-svg, react-native-safe-area-context, @react-native-async-storage/async-storage, expo-av, expo-updates, expo-modules-core, expo-linking, expo-router, @expo/ui

**Why:** `compileSdkVersion`/`minSdkVersion`/`targetSdkVersion`/`lintOptions`/`packagingOptions` are deprecated in AGP 7.0 and will be errors in AGP 9.x. All Gradle 9.3.1 + AGP 8.x builds produce deprecation warnings for these. The `with-modern-gradle-dsl.js` plugin handles the generated `app/build.gradle`; pnpm patches handle library modules.

**How to apply:** If adding a new native dependency, check its `android/build.gradle` for deprecated DSL. If found: `cd workspace && pnpm patch <pkg-name>@<version>`, apply the `sed` fixes, `pnpm patch-commit <path>`. The 4 replacements needed are: compileSdkVersion→compileSdk, minSdkVersion→minSdk, targetSdkVersion→targetSdk, lintOptions→lint, packagingOptions→packaging.
