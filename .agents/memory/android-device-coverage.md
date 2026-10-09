---
name: Android device coverage
description: Broad device-support goal and permission-implied Google Play filtering pitfalls.
---

The user wants the app to support all types of devices.

**Why:** The user explicitly requested broad device coverage after Google Play
reported a large loss of TV eligibility and smaller phone/tablet losses.

**How to apply:** Preserve existing Android device eligibility where compatible,
and distinguish store eligibility from tested usability on TV, Wear OS, cars,
Chromebooks, and XR. Do not promise universal support merely from manifest flags.

Playback-only releases must not accidentally require a microphone. An unrelated
native-library removal can remove a permission-removal manifest directive,
exposing another plugin's default recording permission.

**Why:** Comparing actual consecutive AAB manifests revealed newly requested
RECORD_AUDIO while minimum SDK, target SDK, CPU architectures, and existing
optional TV/touch features were unchanged. Removing the unused image-picker
plugin had exposed the audio plugin's default recording permission. Google Play
can infer required hardware from permissions even without a uses-feature entry.

**How to apply:** Compare built manifests and ABIs before diagnosing device losses.
Disable unused recording in the audio plugin, retain a manifest-merger permission
block, and declare microphone hardware optional. Preserve playback/background
audio. Verify the rebuilt bundle and Play's device comparison before asserting
that the exclusion count is resolved.
