# EAS Build Checklist — Temple TV Mobile

Use this checklist before every production build. Steps marked **[one-time]** only need to be done once per machine/account.

---

## 1. Prerequisites [one-time]

- [ ] **EAS CLI installed**: `npm install -g eas-cli` (requires CLI ≥ 18.0.0 per `eas.json`)
- [ ] **Logged in to Expo**: `eas login` with the `templetv` Expo account
- [ ] **Linked to EAS project**: `eas project:info` should show the project ID populated by `eas init` (under the `temple_tv` Expo account)
- [ ] **Android keystore uploaded**: `eas credentials --platform android` → upload or generate keystore. Stored remotely (`credentialsSource: "remote"` in `eas.json`). **Keep a local backup.**
- [ ] **iOS distribution certificate + provisioning profile**: `eas credentials --platform ios`. Required for App Store builds.
- [ ] **Apple App Store Connect API key**: Download a `.p8` key from App Store Connect → Users & Access → Keys. Place at `/tmp/asc-api-key.p8` (path expected by `eas.json` submit config). Alternatively configure via `EXPO_APPLE_APP_STORE_CONNECT_API_KEY_*` env vars.

---

## 2. Firebase / Push Notifications [one-time per Firebase project change]

### Android
- [ ] **Replace `google-services.json`** (`artifacts/mobile/google-services.json`):
  - The file currently contains `REPLACE_WITH_...` placeholder values.
  - Download the real file from Firebase Console → Project Settings → Your Apps → Android app → `google-services.json`.
  - Required fields: `project_number`, `project_id`, `mobilesdk_app_id`, `current_key`
  - Package name must match: `com.templetv.app`

### iOS
- [ ] **Add `GoogleService-Info.plist`** (`artifacts/mobile/GoogleService-Info.plist`):
  - Download from Firebase Console → Project Settings → Your Apps → iOS app → `GoogleService-Info.plist`.
  - Bundle ID must match: `com.templetv.app`
  - Verify `REVERSED_CLIENT_ID` is present (required for Google Sign-In if used).

### Verify Push Setup
- [ ] EAS project ID in `app.json` (`extra.eas.projectId`) — auto-populated by `npx eas init` under the `temple_tv` account
- [ ] `expo-notifications` mode in `app.json` plugins = `"production"` ✅ (already set)
- [ ] Upload FCM server key to Expo: Dashboard → Project → Push Notifications → Add Android FCM key

---

## 3. Google Play Submit Credentials [one-time]

- [ ] **Create `google-service-account.json`** (`artifacts/mobile/google-service-account.json`):
  - Google Play Console → Setup → API access → Link to Google Cloud project → Create service account
  - Grant role: **Release Manager** (or **Release Manager** + **Internal Tester**)
  - Download the JSON key, save as `artifacts/mobile/google-service-account.json`
  - This file is read by `eas submit` (configured in `eas.json` submit.production.android)
  - **Never commit this file.** Add to `.gitignore`.

---

## 4. Pre-Build Checks (every build)

- [ ] **API URL correct**: All production profiles have `EXPO_PUBLIC_API_URL: https://api.templetv.org.ng` ✅
- [ ] **Version code**: `android.versionCode` in `app.json` is currently `80`. Production profile uses `autoIncrement: true` so EAS will bump it automatically. Verify the next expected code in Play Console (Internal Testing track → App versions).
- [ ] **App version**: `version` in `app.json` is `1.0.29`. Update before significant releases: `artifacts/mobile/app.json` → `"version"` + `artifacts/mobile/package.json` → `"version"` (keep in sync).
- [ ] **ProGuard rules current**: `app.json` `extraProguardRules` covers all native modules. If you add a new native module, add its package keep-rule here before building.
- [ ] **No placeholder Firebase values**: Verify `google-services.json` does NOT contain `REPLACE_WITH_`.
- [ ] **Sentry DSN set**: `EXPO_PUBLIC_SENTRY_DSN` in `eas.json` production profile = the production DSN ✅ (already set).

---

## 5. Build Commands

### Production (recommended — builds both platforms)
```bash
# Android AAB for Play Store
eas build --platform android --profile production

# iOS IPA for App Store
eas build --platform ios --profile production

# Both simultaneously
eas build --platform all --profile production
```

### Platform-specific production variants
```bash
# Android only (autoIncrement: true — EAS bumps versionCode automatically)
eas build --platform android --profile production-android

# iOS only
eas build --platform ios --profile production-ios
```

### TV platforms
```bash
eas build --platform android --profile androidtv    # Android TV AAB
eas build --platform android --profile firetv       # Fire TV APK
eas build --platform ios --profile appletv          # Apple TV IPA (scheme: TempleTv-tvOS)
```

### Simulator / internal testing
```bash
# Android emulator APK (uses 10.0.2.2:8080 — Android emulator localhost alias)
eas build --platform android --profile development

# Physical device (points to api.templetv.org.ng)
eas build --platform android --profile development-device

# Internal preview APK/IPA
eas build --platform all --profile preview
```

---

## 6. Submit Commands

```bash
# Submit to Google Play internal track
eas submit --platform android --profile production

# Submit to Apple App Store (TestFlight)
eas submit --platform ios --profile production
```

Submit will read:
- Android: `google-service-account.json` (service account key) — **must exist before submitting**
- iOS: `/tmp/asc-api-key.p8` (App Store Connect API key) — **must exist before submitting**

---

## 7. OTA Updates (JS-only changes)

For JavaScript/TypeScript-only changes (no native module changes, no `app.json` plugin changes):

```bash
# Publish to production OTA channel
eas update --branch production --message "describe the change"

# Or via the GitHub Action (auto-triggers on main push):
# .github/workflows/ota-update.yml
```

OTA updates use `runtimeVersion.policy: "appVersion"` — only devices on the same `version` (e.g. `1.0.20`) will receive the update. Bump `version` in `app.json` when you update native code.

---

## 8. Post-Build Verification

After every production build, verify on a real device:

- [ ] App launches without crash (especially on Android — check for `NoClassDefFoundError` in logcat)
- [ ] Login flow completes and returns a valid JWT
- [ ] Live broadcast player loads HLS stream: `https://api.templetv.org.ng/api/hls/<videoId>/master.m3u8`
- [ ] Push notification received after calling `registerForPushTokenAsync()`
- [ ] Deep link `templetv://` scheme opens the app correctly
- [ ] Settings screen shows correct version (`1.0.29`) and has working Privacy Policy + Terms links

---

## 9. Common Build Failures

| Symptom | Cause | Fix |
|---|---|---|
| `NoClassDefFoundError: com.doublesymmetry.kotlinaudio...` | ProGuard stripped kotlin-audio-engine | Check `extraProguardRules` in `app.json` — rule already present ✅ |
| `Failed to get push token: ... FCM` | `google-services.json` has placeholder values | Replace with real Firebase file |
| `Build failed: could not find keystore` | Keystore not uploaded to EAS | Run `eas credentials --platform android` |
| `Unauthorized: invalid service account` | Wrong/expired `google-service-account.json` | Download a fresh key from Google Cloud Console |
| `ITMS-90535: Invalid Info.plist` | Missing iOS privacy strings | All usage descriptions are set in `app.json` infoPlist ✅ |
| Push notifications work on iOS, fail on Android | FCM server key not uploaded to Expo | Expo Dashboard → Push Notifications → Add FCM key |
| API 404 on device | Wrong `EXPO_PUBLIC_API_URL` in build profile | Check `eas.json` profile env, rebuild |
| `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory` | V8 heap limit too low for Metro bundling | `NODE_OPTIONS=--max-old-space-size=8192` is now set in all `eas.json` profiles ✅ |
| Metro OOM during `expo export:embed` | Too many parallel transform workers | `config.maxWorkers = 2` set in `metro.config.js` ✅ |
| Slow EAS install / Metro graph OOM | Dead browser-only library in native deps | `shaka-player` removed from mobile dependencies ✅ |

---

## 10. Build Status

| Profile | Platform | Output | Channel | Auto versionCode |
|---|---|---|---|---|
| `production` | Android | `.aab` | production | ✅ yes |
| `production` | iOS | `.ipa` | production | — |
| `production-android` | Android | `.aab` | production | ✅ yes |
| `production-ios` | iOS | `.ipa` | production | — |
| `androidtv` | Android TV | `.aab` | androidtv | ✅ yes |
| `firetv` | Fire TV | `.apk` | firetv | ✅ yes |
| `appletv` | tvOS | `.ipa` | appletv | ✅ yes |
| `preview` | Android + iOS | `.apk` / `.ipa` | preview | — |
| `development` | Android emulator | `.apk` | — | — |
| `development-device` | Android device | `.apk` | — | — |
