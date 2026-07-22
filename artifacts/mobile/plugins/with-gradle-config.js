// Expo Config Plugin — Gradle Build Configuration
//
// Applies build-environment settings to gradle.properties that cannot be set
// declaratively through expo-build-properties:
//
//   org.gradle.jvmargs
//     Controls the Gradle *daemon* JVM heap.  The default (-Xmx2048m) is not
//     enough for a complex Expo + RN 0.86 project with New Architecture, Hermes,
//     and Kotlin 2.x compilation.  4 GiB matches the EAS medium worker limit and
//     prevents OutOfMemoryErrors during R8 full-mode optimisation on release builds.
//
//   org.gradle.parallel=true
//     Already set by the RN template; we ensure it is not accidentally removed.
//
//   org.gradle.caching=true
//     Gradle's local build cache. Drastically reduces clean-build times on EAS when
//     inputs haven't changed (Gradle re-uses cached task outputs).
//
//   android.nonTransitiveRClass=true
//     Eliminates the global merged R.java file (AGP 8.x recommended setting).
//     Each module only sees its *own* resources in R; avoids accidental cross-module
//     resource name collisions and shrinks the DEX size.  React Native itself is
//     compatible with non-transitive R classes since RN 0.72.
//
//   android.enableR8.fullMode=true
//     Forces R8 to use its full (Kotlin / Proguard) optimisation pipeline instead
//     of compat mode.  Produces smaller, faster release binaries and is required
//     to honour all ProGuard rules written in the -keep style.  This is the AGP 8+
//     default for new projects but not for projects migrated from earlier AGP.
//
// Why a separate plugin instead of putting this in expo-build-properties?
//   expo-build-properties supports `android.jvmArgs` but maps it to the Gradle
//   *Android plugin* JVM args, NOT the daemon JVM.  org.gradle.jvmargs controls
//   the daemon and must be set in gradle.properties directly.

const { withGradleProperties } = require("@expo/config-plugins");

/** @param {import('@expo/config-plugins').ExpoConfig} config */
module.exports = function withGradleConfig(config) {
  return withGradleProperties(config, (mod) => {
    const props = mod.modResults;

    /** Upsert a property (replace existing or append). */
    const upsert = (key, value) => {
      const idx = props.findIndex((p) => p.type === "property" && p.key === key);
      if (idx >= 0) {
        props[idx].value = value;
      } else {
        props.push({ type: "property", key, value });
      }
    };

    // ── Gradle daemon JVM heap ────────────────────────────────────────────────
    // 4 GiB with G1GC (better pause-time profile than ParallelGC for the daemon
    // which is long-lived and runs many tasks).  MaxMetaspaceSize=512m covers
    // the Kotlin compiler plugin classloaders which grow with project complexity.
    upsert(
      "org.gradle.jvmargs",
      "-Xmx4g -XX:MaxMetaspaceSize=512m -XX:+UseG1GC -XX:SoftRefLRUPolicyMSPerMB=0 -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8"
    );

    // ── Gradle parallel project execution ────────────────────────────────────
    upsert("org.gradle.parallel", "true");

    // ── Gradle local build cache ──────────────────────────────────────────────
    upsert("org.gradle.caching", "true");

    // ── R8 full mode (smaller, faster release APK/AAB) ───────────────────────
    // Enables dead-code removal, method inlining, and class merging in R8.
    // Safe because all reflection-accessed classes are already guarded by the
    // explicit -keep rules in proguard-rules.pro and expo-build-properties.
    upsert("android.enableR8.fullMode", "true");

    // ── Non-transitive R classes (AGP 8.x best practice) ─────────────────────
    // Each module's R.java only references its OWN resources, not the merged
    // set from all transitive dependencies.  Benefits:
    //   • Smaller DEX — eliminates the giant merged R.class from the final APK
    //   • Faster incremental builds — resource changes in one module do not
    //     invalidate every other module's R
    //   • Avoids cross-module resource name collisions that can silently surface
    //     wrong resources at runtime (e.g. two libraries with identically named
    //     drawables; without non-transitive R the last one wins randomly)
    // React Native ≥ 0.72 and all Expo SDK 50+ packages are compatible.
    upsert("android.nonTransitiveRClass", "true");

    return mod;
  });
};
