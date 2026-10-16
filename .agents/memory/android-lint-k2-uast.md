---
name: Android release lint K2 UAST compatibility
description: Post-build lint can crash on applied Kotlin Gradle scripts after a successful AAB build.
---

Keep full release lint enabled, but use its supported K1 frontend consistently
across modules on the current AGP 8.12 toolchain when K2 script analysis crashes.

**Why:** A signed AAB was produced successfully, but the EAS success hook then
failed in Worklets' lint analysis with "Cannot find a KaModule for the VirtualFile".
This was a Kotlin UAST analyzer exception, not an application compilation error.

**How to apply:** Pass `-Pandroid.lint.useK2Uast=false` to the hook's
`:app:lintRelease` invocation. This does not change the app's Kotlin compiler.
Do not suppress lint failures, exclude library tasks, or remove certificate/R8
verification. A replacement cloud build is still required to establish native
success; controlled hook tests alone do not prove it.

The option is defined in Android tools' `OptionalBooleanOption`:
https://android.googlesource.com/platform/tools/base/+/studio-2025.1.2/build-system/gradle-core/src/main/java/com/android/build/gradle/options/OptionalBooleanOption.kt
