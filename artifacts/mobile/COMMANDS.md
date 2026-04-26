# Temple TV Mobile — Command Reference

Quick reference for all `pnpm` scripts in `artifacts/mobile/`. Run every command from this directory:

```bash
cd ~/TempleTV/artifacts/mobile
```

---

## Environment health

### `pnpm run mobile:doctor`
Read-only environment check. Verifies Node ≥ 24, `/usr/local/bin/node` symlink, pnpm, `babel.config.js` integrity, Android SDK location and ownership, Build Tools completeness (catches half-extracted folders), `cmdline-tools/sdkmanager`, free disk space, and stale Android build caches.

Exits 0 unless a hard FAIL fires. Warnings are advisory.

### `pnpm run mobile:doctor -- --fix`
Same checks, plus auto-removes stale `.cxx` / `build` / `.gradle` / codegen caches that cause CMake "codegen/jni/ is not an existing directory" errors. Stops the Gradle daemon first.

---

## Setup & reset

### `pnpm run android:setup`
One-shot setup: chains prebuild → SDK detection → `local.properties` write → Node path helper for Android Studio. Run once after a fresh checkout, or any time `local.properties` is missing.

### `pnpm run android:reset`
Full nuke-and-regen of the `android/` folder when it's in a confused state. Sequence: doctor `--fix` → `gradlew clean` → `expo prebuild --clean` → final doctor verification. Use this when CMake codegen fails, native modules behave oddly, or after a merge that touched native config.

### `pnpm run android:clean`
`gradlew clean` only — lighter than `android:reset`, keeps the `android/` folder intact.

### `pnpm run android:stop`
Stop the Gradle daemon. Useful when Gradle hangs or holds file locks.

### `pnpm run android:prebuild`
`expo prebuild --platform android --no-install` only — regenerates native files without nuking. Rarely needed directly; use `android:reset` for the full pipeline.

---

## Build

All build commands run `mobile:doctor` first as a gate. A FAIL aborts the build before Gradle starts.

### `pnpm run build:android`
Produces `.aab` for Play Store upload at `android/app/build/outputs/bundle/release/app-release.aab`.

### `pnpm run build:android:apk`
Produces `.apk` for sideloading at `android/app/build/outputs/apk/release/app-release.apk`.

### `pnpm run build:android:install`
`build:android:apk` + `adb install -r` to push the APK to the connected device. `-r` reinstalls while keeping app data.

---

## Device interaction (require connected device + adb)

### `pnpm run logcat`
Streams filtered live device logs. Two modes auto-selected:
- App is running → `adb logcat --pid=<PID>` (cleanest, app-only)
- App not running → tag filter (`ReactNative`, `ReactNativeJS`, `AndroidRuntime`, `System.err`) so logs appear when the app starts

Clears the ring buffer first. Ctrl-C to stop.

### `pnpm run screenshot`
Saves the device screen as `artifacts/mobile/screenshots/screenshot-YYYY-MM-DD_HH-MM-SS.png`. Verifies the PNG magic header before declaring success (catches locked-screen / permission-denied silent failures).

### `pnpm run record [seconds]`
Records the device screen as MP4 to `artifacts/mobile/screenshots/recording-YYYY-MM-DD_HH-MM-SS.mp4`. Default 30 seconds, max 180 (Android limit). Ctrl-C stops early and still produces a valid playable file.

```bash
pnpm run record         # 30s
pnpm run record 60      # 60s
```

---

## Release

### `pnpm run release:patch`
Cuts a patch release in one shot. Refuses to run with a dirty working tree. Bumps `app.json` `expo.version` (semver patch), `app.json` `expo.android.versionCode` (+1 — Play Store requirement), and `package.json` `version`. Runs the full build. If the build fails, version edits are reverted and the working tree returns to exactly its pre-release state. If the build succeeds, creates a commit `Release vX.Y.Z`, an annotated tag `vX.Y.Z`, and a stub entry in `RELEASES.md` for you to fill in.

Does **not** push the tag or upload the .aab — both require deliberate review. The script prints the four manual follow-up steps when it finishes.

### `pnpm run release:rollback`
Safely undoes the most recent **local** release before you push. Deletes the local tag, hard-resets HEAD to the pre-release commit, restoring `app.json`, `package.json`, and `RELEASES.md` byte-identically. Refuses if the working tree is dirty, if HEAD isn't a release commit, or if the tag has been pushed to a remote. Asks for `y/N` confirmation before doing anything destructive.

If the tag is already on the remote, the script prints the deliberate-undo recipe (`git push --delete origin <tag>` + `git revert HEAD`) instead of acting silently.

---

## Common failure messages

| Message | Fix |
|---|---|
| `command 'node' error=2` (Android Studio) | `sudo ln -s "$(which node)" /usr/local/bin/node` |
| `adb: command not found` | Add `$ANDROID_HOME/platform-tools` to PATH |
| `error: no devices/emulators found` | Plug in device with USB debugging enabled, or start emulator |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | `adb uninstall com.templetv.jctm`, then retry |
| CMake "codegen/jni/ is not an existing directory" | `pnpm run mobile:doctor -- --fix` (or `pnpm run android:reset` if persistent) |
| Build Tools 35.0.0 / 36.0.0 missing files | Doctor flags it; follow its `rm -rf … && sdkmanager …` instruction |
| `babel-preset-expo` not found | `pnpm run mobile:doctor` will catch a broken `babel.config.js` |

---

## Typical workflows

### Daily inner loop
```bash
git pull
pnpm run build:android:install
```
The post-merge hook runs the doctor automatically if mobile files changed. The build runs the doctor again as a gate. The install pushes to your device.

### Bug reproduction with full evidence
```bash
# Terminal 1
pnpm run logcat | tee /tmp/templetv-bug.log

# Terminal 2 — start recording, reproduce the bug, hit Ctrl-C when done
pnpm run record 60

# Optional: grab a key-frame screenshot
pnpm run screenshot
```
Attach the `.log`, `.mp4`, and `.png` to your bug report.

### Recovering from a broken Android workspace
```bash
pnpm run android:reset
pnpm run build:android
```

### One-time Git hook setup (do once per fresh clone)
```bash
git config core.hooksPath .githooks
```
After this, every `git pull` that touches mobile files auto-runs the doctor.
