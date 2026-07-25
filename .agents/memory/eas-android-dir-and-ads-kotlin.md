---
name: EAS monorepo .easignore + google-mobile-ads Kotlin pinning
description: Root .easignore governs monorepo EAS uploads (mobile-level one is ignored); google-mobile-ads versions pin play-services-ads whose Kotlin metadata must match the project Kotlin.
---

# Two EAS Android build failure patterns (July 2026)

## 1. Root .easignore governs — stale android/ dir upload
In a pnpm monorepo, EAS packs from the **workspace root** and uses the **root** `.easignore`; the one inside `artifacts/mobile/` is NOT applied. If `artifacts/mobile/android/` isn't excluded at the root, the generated native dir (incl. `android/build/generated/autolinking/autolinking.json` with absolute `/home/runner/workspace/...` paths) is uploaded, EAS skips clean prebuild, and Gradle fails with:
`Configuring project ':react-native-worklets' without an existing directory is not allowed`.

**How to apply:** root `.easignore` must contain `artifacts/mobile/android/`, `artifacts/mobile/ios/`, `artifacts/mobile/web-dist/`, `artifacts/mobile/.expo/`. Local module android dirs (`artifacts/mobile/modules/*/android/`) must stay. Tell-tale sign it's broken: `eas build` prints "Specified value for android.package in app.json is ignored because an android directory was detected".

## 2. react-native-google-mobile-ads ↔ Kotlin version coupling
The package reads `sdkVersions.android.googleMobileAds` from its own package.json — no gradle property override. play-services-ads 25.4.0 (rn-google-mobile-ads 16.4.0) ships Kotlin 2.3.0 metadata → fails compile on projects with Kotlin 2.1.x (Expo SDK 57 default):
`Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is 2.3.0, expected version is 2.1.0`.
Also, v14.11.0 fails on RN 0.86 with `Unresolved reference 'currentActivity'` (unqualified base-class API removed).

**How to apply:** with Expo SDK 57 / Kotlin 2.1.20, pin `react-native-google-mobile-ads@16.3.4` (play-services-ads 25.0.0). Check the mapping with `npm view react-native-google-mobile-ads@<v> sdkVersions.android.googleMobileAds` before any bump.

## v16 config-plugin key rename (startup crash)
- rn-google-mobile-ads v16 plugin expects camelCase option keys in app.json (`androidAppId`, `iosAppId`, `skAdNetworkItems`, `userTrackingUsageDescription`, `delayAppMeasurementInit`). v14-style snake_case keys are silently ignored → no `com.google.android.gms.ads.APPLICATION_ID` in AndroidManifest → SDK crashes app at launch.
- v16 hook `show()` is synchronous (returns void) — `.catch()` on it is a type error; wrap in try/catch.
- UMP: `AdsConsent.gatherConsent()` (= requestInfoUpdate + loadAndShowConsentFormIfRequired) must run before `MobileAds().initialize()`; consent failure must be non-fatal.
