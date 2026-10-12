---
name: SDK 57 Android build compatibility
description: Why Play Console's AGP 9 recommendation cannot be forced onto Temple TV's SDK 57/RN 0.86 Android build.
---

Keep React Native, Gradle, Kotlin and AGP on the set validated together by the current Expo SDK. An AGP major upgrade is not safe just because Play Console recommends it.

**Why:** Expo maintainers confirm React Native 0.86 does not support AGP 9; upgrading AGP alone risks a native build or app regression. Kotlin/Gradle metadata compatibility also constrains Gradle upgrades.

**How to apply:** Preserve optimized R8/resource shrinking on the validated toolchain. Revisit AGP 9 only with a coordinated Expo/RN upgrade and a clean signed Android release build.
