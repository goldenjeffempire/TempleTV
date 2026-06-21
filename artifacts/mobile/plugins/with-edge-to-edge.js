// Expo Config Plugin — Android Edge-to-Edge Theme Items
//
// Android 15 (API 35) deprecated the old attribute-based approach:
//   • android:statusBarColor                     → deprecated API 35
//   • android:navigationBarColor                 → deprecated API 35
//   • android:windowTranslucentStatus            → deprecated
//   • android:windowTranslucentNavigation        → deprecated
//   • android:windowDrawsSystemBarBackgrounds    → deprecated
//   • android:windowOptOutEdgeToEdgeEnforcement  → deprecated API 36
//
// All of the above are handled by enableEdgeToEdge() called in
// MainActivity.onCreate() via the companion with-enable-edge-to-edge.js plugin.
//
// This plugin retains ONLY the one attribute that is still valid and required:
//   • android:windowLayoutInDisplayCutoutMode = always
//       → content extends into the display cutout (notch/punch-hole) in EVERY
//         orientation (portrait AND landscape).  "shortEdges" only applied the
//         cutout extension in landscape — "always" is the correct value for a
//         fully immersive edge-to-edge video app on Android 9+ (API 28+).
//
// NOTE: SafeAreaProvider at the app root (app/_layout.tsx) + useSafeAreaInsets()
// in player.tsx continue to supply insets that keep interactive UI clear of bars.

const { withAndroidStyles } = require("@expo/config-plugins");

/** @param {import('@expo/config-plugins').ExpoConfig} config */
module.exports = function withEdgeToEdge(config) {
  return withAndroidStyles(config, (mod) => {
    const styles = mod.modResults;

    const appTheme = styles.resources?.style?.find(
      (s) => s.$?.name === "AppTheme",
    );
    if (!appTheme) return mod;

    if (!Array.isArray(appTheme.item)) appTheme.item = [];

    // Items to keep / add (valid in API 28+ through API 36+).
    const EDGE_TO_EDGE_ITEMS = [
      // Display cutout: content extends into notch/punch-hole in ALL orientations
      // so the video player fills the full screen edge-to-edge.  "always" is the
      // modern value (API 28+); the deprecated "shortEdges" only worked landscape.
      { name: "android:windowLayoutInDisplayCutoutMode", value: "always" },
    ];

    // Deprecated attributes replaced by enableEdgeToEdge() — remove them if
    // they were set by an earlier version of this plugin or by Expo defaults.
    const DEPRECATED_NAMES = new Set([
      "android:statusBarColor",
      "android:navigationBarColor",
      "android:windowTranslucentStatus",
      "android:windowTranslucentNavigation",
      "android:windowDrawsSystemBarBackgrounds",
      // Deprecated in Android API 36 (compileSdkVersion 36).  The attribute
      // was a temporary opt-out escape hatch for Android 15's enforcement.
      // On API 36+ it is silently ignored; leaving it in the theme triggers
      // lint warnings and Google Play's "deprecated edge-to-edge parameters"
      // warning.  enableEdgeToEdge() in MainActivity is the correct signal.
      "android:windowOptOutEdgeToEdgeEnforcement",
    ]);

    const MANAGED_NAMES = new Set(EDGE_TO_EDGE_ITEMS.map((i) => i.name));

    // Remove stale deprecated items and stale managed items, then re-add.
    appTheme.item = appTheme.item.filter(
      (item) =>
        !DEPRECATED_NAMES.has(item.$?.name) && !MANAGED_NAMES.has(item.$?.name),
    );

    for (const { name, value } of EDGE_TO_EDGE_ITEMS) {
      appTheme.item.push({ $: { name }, _: value });
    }

    return mod;
  });
};
