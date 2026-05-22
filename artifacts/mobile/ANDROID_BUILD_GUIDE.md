# Temple TV — Android .aab Build Guide
> Google Play Store release for **com.templetv.app** (Temple TV JCTM)
>
> Stack: Expo SDK 54 · React Native 0.81.5 · Expo Router 6 · EAS Build

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 18 or 20 LTS | https://nodejs.org |
| pnpm | 9+ | `npm i -g pnpm` |
| EAS CLI | 14+ | `npm i -g eas-cli` |
| Expo account | any | https://expo.dev |

> **You do not need Android Studio, Java, or Gradle.** EAS Build runs the
> Gradle build on Expo's cloud infrastructure.

---

## 1. One-time EAS Project Setup

```bash
# From the repo root
cd artifacts/mobile

# Log in to your Expo account
eas login

# Link to an EAS project (creates a real UUID projectId)
eas init
```

After `eas init`, open `app.json` and replace the placeholder:

```json
"extra": {
  "eas": {
    "projectId": "PASTE-UUID-FROM-EAS-INIT-HERE"
  }
}
```

Commit the updated `app.json`.

---

## 2. Android Signing Credentials

EAS manages the Android keystore automatically with `credentialsSource: "remote"`.

```bash
# Generate and upload a new production keystore (one-time, stored securely in EAS)
eas credentials --platform android
```

Choose **Generate new keystore** when prompted. EAS stores it encrypted — you
never need to handle `.jks` files manually.

> **Important**: after generating, download a backup from the EAS dashboard:
> `https://expo.dev/accounts/<username>/projects/mobile/credentials`
> Store the backup securely (e.g. 1Password, company vault). Without the
> keystore, future updates cannot be published to the same Play Store listing.

---

## 3. Configure Environment Variables in EAS

The production build reads `EXPO_PUBLIC_API_URL` from `eas.json` — it is
already set to `https://api.templetv.org.ng`. If you need extra secrets that
must NOT be in source control (e.g. Sentry DSN, analytics keys), add them via:

```bash
eas secret:create --scope project --name SENTRY_DSN --value "https://..."
```

---

## 4. Trigger the Production Build

```bash
# From artifacts/mobile/
eas build --platform android --profile production
```

This will:
1. Bundle the JS with Metro (Hermes engine)
2. Compile native code with Gradle on EAS Linux workers
3. Sign the `.aab` with the EAS-managed keystore
4. Upload the artifact — you get a download link when done (≈ 15–25 min)

Track progress in your browser at `https://expo.dev` → Builds.

---

## 5. First-Time Google Play Setup

1. Create a new app in [Google Play Console](https://play.google.com/console)
   - Package name: `com.templetv.app`
   - Default language: English (United States)
2. Fill out the **Store listing** (description, screenshots, feature graphic)
3. Complete **Content rating** questionnaire (choose Entertainment / General)
4. Set up **App content** declarations (no sensitive permissions)

---

## 6. Submit to Google Play

### Option A — Manual upload
1. Download the `.aab` from the EAS build page
2. In Play Console → **Testing → Internal testing** → Create new release
3. Upload the `.aab`, add release notes, and roll out

### Option B — EAS Submit (automated)

Set up a Google Play service account:
1. In Play Console → **Setup → API access** → link to a Google Cloud project
2. Create a service account with **Release Manager** role
3. Download the JSON key and save as `google-service-account.json` (gitignored)

```bash
eas submit --platform android --profile production
```

EAS Submit reads `eas.json` → `submit.production.android.serviceAccountKeyPath`
and uploads directly to the `production` track.

---

## 7. Subsequent Releases

The `autoIncrement: true` flag in `eas.json` bumps `versionCode` automatically
on every production build — you never need to edit `app.json` manually between
releases. Increment `version` (the human-readable string) when shipping a new
user-visible release:

```json
"version": "1.1.0"
```

---

## 8. Fire TV / Amazon Appstore (.apk)

The `firetv` build profile produces a signed release `.apk` instead of `.aab`:

```bash
eas build --platform android --profile firetv
```

Upload the resulting `.apk` to the **Amazon Developer Portal**:
`https://developer.amazon.com/apps-and-games`

The `android-tv.js` config plugin already injects the `LEANBACK_LAUNCHER`
intent filter and the `android.software.leanback` feature declaration required
by Fire TV.

---

## 9. OTA Updates (without a Play Store release)

For JS-only fixes (no native module changes), publish an over-the-air update:

```bash
eas update --branch production --message "Fix: broadcast sync on Android 14"
```

Users on the production channel receive the update silently on next app open.
No Play Store review needed for JS-only changes.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Build fails: `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | Testing APK installed over a different keystore | Uninstall from device and reinstall |
| Build fails: `duplicate class` | pnpm dependency conflict | Run `pnpm install --frozen-lockfile` in repo root |
| SSE not connecting on Android | `api.templetv.org.ng` firewall | Ensure HTTPS port 443 is open; SSE uses `NativeSSEClient` (XHR-backed) on native |
| `projectId` not a valid UUID | `eas init` not run | Follow Section 1 |
| App crashes on launch | Missing API reachability | Ensure `EXPO_PUBLIC_API_URL` resolves from the device's network |
| **"Temple TV keeps stopping" on Play Store release** | R8/ProGuard strips native module classes | See note below |

### "Temple TV keeps stopping" / "App crashed due to its own issues" — Play Store immediate launch crash

This class of crash has been through three rounds of diagnosis and fixes. See `ROOT_CAUSE_REPORT.md`
for the full forensic breakdown. Quick summary:

| Round | versionCode | Root cause | Fix |
|-------|------------|-----------|-----|
| 1 | 22→25 | ProGuard stripped `com.doublesymmetry.kotlinaudio.*` (RNTP engine) → `NoClassDefFoundError` in `MusicService` | Added `-keep class com.doublesymmetry.kotlinaudio.** { *; }` |
| 2 | 27→28 | Missing Kotlin runtime, Hermes, OkHttp, New Architecture classes in ProGuard | Comprehensive keep rules for all native modules |
| 3 | 29→30 | Missing `com.facebook.soloader.**` (JNI library loader) → `UnsatisfiedLinkError`; Android 14 foreground service type unguaranteed | Added SoLoader keep rule; new `with-foreground-service-type.js` plugin; added `com.facebook.react.defaults.**` |

**Current state (v1.0.5 / versionCode 30):** All three crash vectors are fixed.

**If you ever add a new native module**, add a corresponding
`-keep class <java-package-name>.** { *; }` rule in the `extraProguardRules` string in
`app.json` under `expo-build-properties`. Find the Java package name in the library's
`android/src/main/AndroidManifest.xml` (`package` attribute).

**Android 14+ foreground service rule:** any new foreground service must declare
`android:foregroundServiceType` in the manifest. The `with-foreground-service-type.js`
plugin handles this for MusicService (RNTP) automatically.

---

## Build Artifact Summary

| Profile | Output | Destination |
|---------|--------|-------------|
| `production` | `.aab` | Google Play Store |
| `firetv` | `.apk` | Amazon Appstore |
| `androidtv` | `.aab` | Google Play (Android TV track) |
| `preview` | `.apk` | Internal testers (sideload) |

---

*Generated for Temple TV JCTM Broadcasting — Jesus Christ Temple Ministry*
