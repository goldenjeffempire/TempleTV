// Expo Config Plugin — Android Edge-to-Edge Theme Items (non-deprecated)
//
// Android 15 (API 35) deprecated the old attribute-based approach:
//   • android:statusBarColor          → deprecated API 35
//   • android:navigationBarColor      → deprecated API 35
//   • android:windowTranslucentStatus → deprecated
//   • android:windowTranslucentNavigation → deprecated
//   • android:windowDrawsSystemBarBackgrounds → deprecated
//
// Those are now handled by enableEdgeToEdge() called in MainActivity.onCreate()
// via the companion with-enable-edge-to-edge.js plugin.
//
// This plugin retains ONLY the two attributes that are still valid and required:
//   • android:windowLayoutInDisplayCutoutMode = shortEdges
//       → content fills the notch/punch-hole area in landscape (video fullscreen)
//   • android:windowOptOutEdgeToEdgeEnforcement = false
//       → explicitly opt IN to Android 15 edge-to-edge enforcement (the default,
//         but declared here so it survives future Expo theme regenerations)
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

    // Items to keep / add (non-deprecated in API 35+).
    const EDGE_TO_EDGE_ITEMS = [
      // Display cutout: content extends into notch area in landscape so the
      // video player fills the full screen including the camera cutout zone.
      { name: "android:windowLayoutInDisplayCutoutMode", value: "shortEdges" },
      // Android 15 edge-to-edge enforcement: false = opt IN (do not opt out).
      // This attribute is no-op on API < 35 (safely ignored by older frameworks).
      { name: "android:windowOptOutEdgeToEdgeEnforcement", value: "false" },
    ];

    // Deprecated attributes replaced by enableEdgeToEdge() — remove them if
    // they were set by an earlier version of this plugin or by Expo defaults.
    const DEPRECATED_NAMES = new Set([
      "android:statusBarColor",
      "android:navigationBarColor",
      "android:windowTranslucentStatus",
      "android:windowTranslucentNavigation",
      "android:windowDrawsSystemBarBackgrounds",
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
