---
name: Android 15 edge-to-edge + PiP implementation
description: How Android 15 edge-to-edge compliance and Picture-in-Picture were added to the mobile app (v1.0.11).
---

## Edge-to-edge (Android 15 / API 35)

**Why:** Apps targeting API 35+ have edge-to-edge enforced automatically. Without explicit theme configuration the status/nav bars retain colored backgrounds that clash with the video player and look wrong on Android 15.

**How to apply:** `artifacts/mobile/plugins/with-edge-to-edge.js` — config plugin that modifies `AppTheme` in `res/values/styles.xml`:
- Sets `statusBarColor` and `navigationBarColor` to transparent
- Sets `windowDrawsSystemBarBackgrounds=true`
- Sets `windowTranslucentStatus/Navigation=false`
- Sets `windowLayoutInDisplayCutoutMode=shortEdges` (fills notch in landscape)
- Sets `windowOptOutEdgeToEdgeEnforcement=false` (explicitly opt IN)
- Plugin is idempotent: strips existing managed items before re-adding

**SafeAreaProvider** is already at root (`app/_layout.tsx`) so insets are provided to all screens. `useSafeAreaInsets()` is already used in `player.tsx` for player controls.

## Picture-in-Picture

**Architecture:**
- Local Expo native module: `artifacts/mobile/modules/expo-pip-android/`
  - `expo-module.config.json` → registers `ExpoPipAndroidModule` with Expo autolinking
  - `android/src/.../ExpoPipAndroidModule.kt` → calls `Activity.enterPictureInPictureMode()` with `PictureInPictureParams` (API 26+, safe on older API)
  - `src/index.ts` → JS wrapper with typed exports: `enterPictureInPicture()`, `isPictureInPictureSupported()`, `isInPictureInPictureMode()`
- Registered in `artifacts/mobile/package.json` as `"expo-pip-android": "file:./modules/expo-pip-android"`
- **Import path**: hook uses relative `../modules/expo-pip-android/src` (not package name) so TypeScript resolves without needing `pnpm install` to create symlink first

**Hook:** `artifacts/mobile/hooks/usePictureInPicture.ts`
- Returns `{ isSupported, isInPip, enterPip }`
- Polls `isInPictureInPictureMode()` on AppState changes (no native lifecycle observer needed)
- `autoEnterOnBackground` option handled explicitly in `player.tsx` to keep fullscreen Modal open during PiP entry

**Player integration** (`artifacts/mobile/app/player.tsx`):
- PiP hook mounted after `videoAspectRatio` state; `autoEnterOnBackground=false` (handled manually)
- AppState background handler: if `isPipSupported && !isYoutube`, calls `enterPip()` and keeps fullscreen Modal open so the video fills the PiP window; falls back to portrait restore if rejected
- PiP button in fullscreen top bar (`fsTopBar`) and in action bar ("Mini Player") — Android only, hidden for YouTube
- `isInPip` used to suppress ChatPanel, CountdownOverlay (inline+fullscreen) — PiP window too small for interaction

**Manifest:** `with-android-activity-flags.js` already sets `android:supportsPictureInPicture="true"` and the required configChanges (`screenLayout|smallestScreenSize|screenSize`). No changes needed.

**What:** Activity declaration and configChanges were already correct. Only the JS-side PiP invocation and the native module bridge were missing.
