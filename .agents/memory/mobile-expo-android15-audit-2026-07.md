---
name: Mobile Expo/Android 15 full audit (July 2026) — baseline already clean
description: Full-project Expo doctor / dependency / edge-to-edge audit result; confirms most items in a broad "audit and fix everything" request were already satisfied by prior work, and pinpoints the real remaining upstream source of Play Console's edge-to-edge deprecation warning.
---

## State found (before any changes)
- `npx expo-doctor` → 20/20 checks passed, zero issues.
- `npx expo install --check` → "Dependencies are up to date" (SDK 57.0.6, RN 0.86.0 — both already the latest published versions on npm).
- `expo-modules-core` is NOT a direct dependency in `artifacts/mobile/package.json` — it only appears as a transitive dep with a pnpm patch (`patches/expo-modules-core@57.0.5.patch`) applied via root `package.json` `patchedDependencies`. Nothing to uninstall.
- `expo-av` has zero live imports anywhere in the app — fully migrated to `expo-video` + `expo-audio` already (only comments referencing migration history remain). See `expo-av-to-expo-video-migration.md`.
- `pnpm run verify:mobile-lockfile` passes (4 checks). `pnpm --filter @workspace/mobile run typecheck` has pre-existing failures ONLY in `__tests__/`/`vendor/player-core/tests/` (missing `vitest`/`node:*` types in test-only files, not part of the app bundle) — unrelated to this audit, not regressions.

## Edge-to-edge (Android 15) — root cause of the Play Console warning, confirmed via source inspection
The app's own code is already fully modern:
- `plugins/with-enable-edge-to-edge.js` injects `androidx.activity.enableEdgeToEdge()` into `MainActivity.kt` before `super.onCreate()`.
- `plugins/with-edge-to-edge.js` strips every deprecated theme attribute (`statusBarColor`, `navigationBarColor`, `windowTranslucent*`, `windowOptOutEdgeToEdgeEnforcement`) and keeps only `windowLayoutInDisplayCutoutMode=always`.

Traced the actual bytecode source of `getStatusBarColor`/`setStatusBarColor`/`getNavigationBarColor`/`setNavigationBarColor` Play Console flags to **two** places:
1. `react-native-screens` `ScreenViewManager.kt` overrides `setStatusBarColor`/`setNavigationBarColor` — **false positive**: these are no-op (`= Unit`) view-manager prop setters for iOS-only `Screen` props, never touch `android.view.Window`. Confirmed unchanged in latest 4.26.1.
2. **React Native core itself** (`ReactAndroid/.../views/view/WindowUtil.kt`, function `Window.enableEdgeToEdge()`, annotated `@Suppress("DEPRECATION")` by Meta) unconditionally calls the deprecated `Window.statusBarColor =` / `Window.navigationBarColor =` setters. This function is invoked from `ReactModalHostView.kt` (`dialogWindow.enableEdgeToEdge()`) every time a native RN `<Modal>` opens. Confirmed still present in RN 0.86.0 (latest stable) — **no upstream fix released yet**. This app uses `<Modal>` in `AuthGateModal`, `FeedbackModal`, `PrayerRequestModal`, `NotificationOptInModal`, `ErrorFallback`, `account.tsx`, `player.tsx`, `LocalVideoPlayer.tsx`, so the deprecated call does fire at runtime.

**Why:** Play Console's static bytecode scanner flags the deprecated Android API call sites regardless of app-level `enableEdgeToEdge()` usage, because RN core's *own* Modal support path calls them internally. There is no config or app-code change that removes this without either (a) patching RN core's compiled AAR (high risk/maintenance burden, deprecated ≠ broken — still fully functional on API 35/36) or (b) replacing every native `<Modal>` in the app with a JS-only modal implementation (large, functionality-neutral rewrite, not something to do silently).

**How to apply:** don't attempt to "fix" this by touching app code — it's correctly implemented already. When re-auditing, first re-check the exact RN version's `WindowUtil.kt`/`ReactModalHostView.kt` for whether Meta has removed the deprecated calls; if not, this is a documented accepted upstream warning, not a regression.

## Dependency version notes (deliberately NOT bumped)
- `react-native-webview` pinned at 13.16.1 (latest is 14.0.1), `@sentry/react-native` pinned at ~7.11.0 (latest is 8.18.0) — both have a pnpm patch keyed to the exact pinned version (Gradle DSL modernization patches, see `android-build-warnings-audit.md`). `expo-doctor`/`expo install --check` both report these as correct/up-to-date for SDK 57, i.e. Expo has not yet vetted the newer majors for this SDK line. Bumping either is a major-version jump requiring patch regeneration + full regression testing — flagged as optional future work, not applied, to honor "preserve app functionality."
- `react-native-svg` 15.15.4→15.15.5 and `react-native-keyboard-controller` 1.21.9→1.22.1 (patch/minor, also patch-pinned) — same reasoning, low-risk but not applied without a way to verify compiled output locally (no Android SDK in this container; see below).

## Environment limitation
This Replit container only has `android-sdk-platform-tools` (adb), no full Android SDK (`build-tools`/`platforms`) — a local `./gradlew bundleRelease`/`assembleRelease` is not possible here. The project's own validation path is EAS Build (`scripts/eas-build.sh`, already authenticated via `EXPO_TOKEN`). Use `npx eas-cli@latest build --platform android --profile preview --non-interactive --no-wait` to submit and `eas-cli build:view <id> --json` to poll — expect free-tier queue times that can exceed 30+ minutes, so don't block a whole session on it; give the user the dashboard link (`https://expo.dev/accounts/<owner>/projects/<slug>/builds/<id>`) and let them (or a later session) confirm completion.
