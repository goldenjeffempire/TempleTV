// Expo Config Plugin — Modernize Generated Android Gradle DSL
//
// The Expo / React Native 0.86 prebuild template generates android/app/build.gradle
// using several deprecated Gradle DSL methods that produce deprecation warnings
// with Android Gradle Plugin 8.x and Gradle 9.x:
//
//   minSdkVersion  → minSdk          (deprecated in AGP 7.0, removed in AGP 9.x)
//   targetSdkVersion → targetSdk     (same deprecation timeline)
//   packagingOptions { } → packaging { }   (block renamed in AGP 7.0)
//   android.packagingOptions[prop] → android.packaging[prop]  (accessor renamed)
//   lintOptions { } → lint { }             (block renamed in AGP 7.0)
//   proguard-android.txt → proguard-android-optimize.txt
//       (the non-optimized ruleset disables R8 ProGuard optimisations; using the
//       optimized ruleset is required for full R8 shrinking in AGP 8+ and produces
//       a measurably smaller, faster release APK/AAB without changing behaviour)
//
// This plugin patches the generated android/app/build.gradle at prebuild time
// so EAS builds produce zero deprecated-DSL warnings without:
//   – manually touching the generated file (would be overwritten on next prebuild)
//   – forking the upstream Expo/React Native template
//   – modifying third-party library build files
//
// Replacement strategy
// ────────────────────
// 1. minSdk / targetSdk  — only replaces the `rootProject.ext.*` variants that
//    the template emits, avoiding accidental matches in comments.
//
// 2. packaging block  — `\bpackagingOptions\s*{` is precise enough; the word
//    only appears as a block opener in this context within the android {} DSL.
//
// 3. Dynamic packagingOptions accessor — only replaces the bracket accessor form
//    `android.packagingOptions[` to avoid touching the `findProperty` string
//    literal `"android.packagingOptions.$prop"` which references the gradle.properties
//    key name and must remain unchanged.
//
// 4. lintOptions → lint  — the legacy `lintOptions { }` block was renamed to
//    `lint { }` in AGP 7.0 and generates a deprecation warning in AGP 8.x.
//
// 5. proguard-android.txt → proguard-android-optimize.txt  — enables full R8
//    ProGuard optimisation (dead-code removal, inlining, class merging). Safe
//    for all RN projects because the explicit keep rules in proguard-rules.pro
//    already protect every reflection-accessed class.

const { withAppBuildGradle } = require("@expo/config-plugins");

/** @param {import('@expo/config-plugins').ExpoConfig} config */
module.exports = function withModernGradleDsl(config) {
  return withAppBuildGradle(config, (mod) => {
    let contents = mod.modResults.contents;

    // ── 1. defaultConfig: minSdkVersion → minSdk ─────────────────────────────
    contents = contents.replace(
      /\bminSdkVersion(\s+)(rootProject\.ext\.minSdkVersion)/g,
      "minSdk$1$2",
    );

    // ── 2. defaultConfig: targetSdkVersion → targetSdk ───────────────────────
    contents = contents.replace(
      /\btargetSdkVersion(\s+)(rootProject\.ext\.targetSdkVersion)/g,
      "targetSdk$1$2",
    );

    // ── 2b. android-block: compileSdkVersion → compileSdk ────────────────────
    // The `android { compileSdkVersion N }` block-level form (not inside
    // defaultConfig) is also deprecated in AGP 7.0 and removed in AGP 9.x.
    // Matches both the `rootProject.ext.*` form and any bare integer literal so
    // the replacement is safe regardless of where the template puts the value.
    contents = contents.replace(
      /\bcompileSdkVersion(\s+)(rootProject\.ext\.compileSdkVersion|\d+)/g,
      "compileSdk$1$2",
    );

    // ── 3. android { packagingOptions { } } → android { packaging { } } ──────
    // Replaces the block opener only. Property names inside (pickFirsts,
    // excludes, merges, doNotStrip) are identical in both APIs.
    contents = contents.replace(/\bpackagingOptions\s*\{/g, "packaging {");

    // ── 4. android.packagingOptions[prop] → android.packaging[prop] ──────────
    // Only the bracket-accessor form used in the gradle.properties loop;
    // leaves `findProperty("android.packagingOptions.$prop")` untouched.
    contents = contents.replace(/\bandroid\.packagingOptions\[/g, "android.packaging[");

    // ── 5. lintOptions { } → lint { } ────────────────────────────────────────
    // The app-level build.gradle rarely contains lintOptions directly, but
    // this ensures the generated file is clean if the template ever adds one.
    contents = contents.replace(/\blintOptions\s*\{/g, "lint {");

    // ── 6. proguard-android.txt → proguard-android-optimize.txt ─────────────
    // Enables R8 full-mode optimisations (dead-code removal, method inlining,
    // class merging). The optimized ruleset is a strict superset of the base
    // ruleset — all -keep rules in proguard-rules.pro still apply.
    contents = contents.replace(
      /getDefaultProguardFile\s*\(\s*["']proguard-android\.txt["']\s*\)/g,
      'getDefaultProguardFile("proguard-android-optimize.txt")',
    );

    mod.modResults.contents = contents;
    return mod;
  });
};
