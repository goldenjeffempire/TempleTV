// Expo Config Plugin — Android 16 KB Page Size Compliance
//
// Android 15 (API 35) introduced device support for 16 KB memory pages.
// Android 16 (API 36) expands this and future devices will default to it.
// Apps with native libraries (.so files) MUST be 16 KB page-aligned to
// install and run correctly on those devices.
//
// Three layers are required together:
//
//   1. NDK r27+  (set via ndkVersion in expo-build-properties)
//      Produces ELF segments whose p_align >= 16384 instead of 4096.
//      Without this, the .so itself is mis-aligned regardless of packaging.
//
//   2. AGP 8.5+  (already used by Expo 57 / RN 0.86)
//      Packs .so files into the APK/AAB with the correct 16 KB file-offset
//      alignment.  Earlier AGP versions use 4 KB alignment even for NDK r27+
//      libraries.
//
//   3. jniLibs.useLegacyPackaging = false  (this plugin)
//      Stores .so files UNCOMPRESSED in the APK/AAB.  The system then
//      directly mmaps them from the archive at their stored (aligned) offset.
//      If they were compressed the OS would extract them to /data/app/ at
//      install time — that extraction path loses the alignment, so mmap
//      would fault with SIGBUS on a 16 KB page device.
//
// References:
//  - https://developer.android.com/guide/practices/page-sizes
//  - https://developer.android.com/ndk/guides/page-sizes
//  - https://developer.android.com/about/versions/15/behavior-changes-15#16kb-page-size

const { withAppBuildGradle } = require("@expo/config-plugins");

/** @param {import('@expo/config-plugins').ExpoConfig} config */
module.exports = function with16kbPageSize(config) {
  return withAppBuildGradle(config, (mod) => {
    let contents = mod.modResults.contents;

    // Idempotent — skip if already injected.
    if (contents.includes("useLegacyPackaging")) return mod;

    // By the time this plugin runs, with-modern-gradle-dsl.js has already
    // renamed `packagingOptions {` → `packaging {` in the generated file.
    // We insert `jniLibs { useLegacyPackaging = false }` as the FIRST
    // sub-block inside `packaging { }` so it coexists safely with any
    // existing pickFirsts / excludes entries.
    if (contents.includes("packaging {")) {
      contents = contents.replace(
        /\bpackaging\s*\{/,
        "packaging {\n        jniLibs {\n            useLegacyPackaging = false\n        }",
      );
    } else {
      // No packaging block exists yet — add one ahead of the buildTypes block,
      // which is always present in the React Native app/build.gradle template.
      contents = contents.replace(
        /(\bbuildTypes\s*\{)/,
        [
          "packaging {",
          "        jniLibs {",
          "            useLegacyPackaging = false",
          "        }",
          "    }",
          "",
          "    $1",
        ].join("\n"),
      );
    }

    mod.modResults.contents = contents;
    return mod;
  });
};
