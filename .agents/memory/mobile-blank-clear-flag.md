---
name: Mobile preview blank on every restart (--clear flag)
description: Why the Expo mobile canvas iframe goes blank after each workflow restart and the fix
---

# Mobile preview blank after workflow restart

The mobile (`artifacts/mobile`) Expo web preview goes fully blank for ~60–90s
after every workflow restart, then renders normally.

**Cause:** the mobile `dev` script in `artifacts/mobile/package.json` ran
`expo start … --clear`, which wipes Metro's bundler cache on *every* start
("Bundler cache is empty, rebuilding"). Metro only builds the ~13 MB web bundle
on first request, so the iframe shows nothing until that full rebuild finishes.

**Fix:** remove `--clear` from the dev script so restarts reuse the on-disk
Metro cache (warm bundle serves in ~0.3s). Only pass `--clear` manually when a
stale-cache problem actually needs it.

**Why:** users repeatedly perceived the blank cold-rebuild window as a broken
app. The bundle itself compiles fine (HTTP 200) — it was purely a cache-warmup
delay, not a code defect.

**How to apply:** if mobile preview is reported "blank," first confirm whether
the workflow just restarted and Metro is mid-rebuild before hunting for a JS
bug. Curl the entry bundle the HTML references
(`/artifacts/mobile/index.ts.bundle?platform=web&dev=true&…`) — a 200 with a
large body means the bundle is healthy.

# Local .aab build is impossible in this container

No Android SDK is installed (`ANDROID_HOME` empty, no `sdkmanager`/`gradle`),
and there's no `android/` prebuild dir. Only JDK 17 is present. The local
`build:android` gradle script cannot run here. Building the `.aab` must go
through **EAS cloud build** (`EXPO_ACCESS_TOKEN` is configured). Use the
`production-android` profile — it emits `app-bundle` (.aab) with
`autoIncrement: false`, so `android.versionCode` in `app.json` must be bumped
manually each release. eas-cli is not installed locally; invoke via
`npx eas-cli` (the `scripts/eas-build.sh` wrapper hardcodes a global `eas`).
