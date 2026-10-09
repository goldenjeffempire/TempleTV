# Android native validation build

## Prepared profile

`android-validation` in `eas.json` inherits `production-cloud`, but outputs an
internally distributed **release APK**, not a development client or Play AAB.
This exercises release minification, resource shrinking, and native dependency
patches. It retains the existing Expo/Gradle versions, Node 22.14.0, pnpm
10.26.1, remote signing, production EAS environment, and production API.

This is **not a staging backend**: the app accesses real production services.
Use authorized test accounts and avoid destructive actions against production
data. Its `android-validation` update channel is separate from the production
channel. Do not publish production updates to that channel.

## Before starting a build

1. Obtain approval to start the cloud build. Adding this profile does not start
   a build or submit anything to Google Play.
2. Confirm that the intended source revision includes the native fixes and the
   registered `expo-updates` patch in both `package.json` and `pnpm-lock.yaml`.
   For a GitHub-triggered build, the settings and fixes must first be committed
   and pushed through the user's approved Git workflow.
3. Run the existing lockfile guard and Android regression tests:
   ```sh
   # Repository root
   pnpm run verify:mobile-lockfile
   cd artifacts/mobile
   node --import tsx/esm --test __tests__/android-reliability.test.ts
   ```
4. Confirm the Expo project's remote credentials using its credentials page.
   Do not regenerate or replace keys during validation. Certificate fingerprints
   are public; passwords, private keys, and credentials files must not be logged.
5. Verify that the local PiP module's Android sources are included in the build
   archive. Generated top-level `android/` is excluded, but the local module's
   `modules/expo-pip-android/android/` must remain included.
6. Choose the installation route:
   - **Clean test device:** the prepared APK can be installed without touching
     an existing production installation.
   - **Device with Temple TV already installed:** check version code and signing
     identity first. The workspace currently declares 1.0.71 / code 139, while
     the supplied Play report identifies 1.0.72 / code 140. Auto-increment is
     disabled. Changing release identifiers requires a separate decision.
     Play's app-signing certificate can differ from the EAS upload certificate,
     even when the upload key is correct. A higher version code alone does not
     resolve that signature mismatch.
   - **Play upgrade testing:** use a separately approved Store AAB and Play
     internal testing release with an eligible version code instead of assuming
     this sideloaded APK can replace a Play-installed app.

Do not uninstall an existing app without informed consent: uninstalling can
remove local downloads, settings, and sign-in state.

## Build command — only after approval

From `artifacts/mobile`:

```sh
pnpm run eas:build -- --platform android --profile android-validation --clear-cache
```

The wrapper runs the lockfile guard and existing Replit archive workarounds.
Clearing the cloud cache ensures validation does not reuse outdated native
outputs. Do not use automatic submission. In Expo's GitHub build form, use
Android, base directory `artifacts/mobile`, profile `android-validation`, the
approved Git revision, and no EAS Submit.

## Required validation

- Confirm the downloaded APK's application ID, version code, and certificate
  before installation. Inspect build logs for applied patches and successful
  native Kotlin compilation; JavaScript tests are not a substitute.
- Test older supported Android versions and Android 15/16, including gesture
  and three-button navigation, light/dark appearance, display cutouts, screen
  rotation, fullscreen video, and entering/exiting PiP.
- Check full-player and YouTube poster sizing and image loading. Test rapid
  navigation, image failures, and repeated loads with constrained memory.
- Where reload-screen images are exercised, confirm caching, failure fallback,
  and cancellation when the reload view closes or changes configuration.
- Retain device/version details and logs for crashes or ANRs. Compare memory
  and rendering behavior with the preceding release under equivalent conditions.

The source fixes are not release-approved until native build and device checks
pass. Google Play's static warnings can only be reassessed after an approved
new Store artifact is uploaded and analyzed; an internal APK cannot establish
that those warnings have disappeared.
