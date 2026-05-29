// Expo Config Plugin — Android 15 Edge-to-Edge Compatibility
//
// Android 15 (API 35) enforces edge-to-edge for all apps that target API 35+.
// This plugin configures the Android theme so content extends behind the
// transparent status and navigation bars, relying on react-native-safe-area-context
// (already installed at the app root as <SafeAreaProvider>) to supply insets
// that keep interactive UI clear of the system bars.
//
// Changes applied to res/values/styles.xml (AppTheme):
//   • statusBarColor = transparent     → no coloured band behind status icons
//   • navigationBarColor = transparent → no coloured band behind gesture bar
//   • windowDrawsSystemBarBackgrounds  → app draws the backgrounds itself
//   • windowTranslucentStatus/Nav = false → use the explicit color set above
//   • windowLayoutInDisplayCutoutMode = shortEdges → content extends into
//     notch/punch-hole cutouts in landscape (status bar area only in portrait)
//   • windowOptOutEdgeToEdgeEnforcement = false → explicitly opt IN to Android
//     15 edge-to-edge (the default, but declared here for clarity)
//
// NOTE: This plugin does NOT change softwareKeyboardLayoutMode — the app
// uses react-native-keyboard-controller which handles keyboard insets via
// WindowInsetsAnimationCompat regardless of the window soft input mode.

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

    const EDGE_TO_EDGE_ITEMS = [
      { name: "android:windowTranslucentStatus",             value: "false" },
      { name: "android:windowTranslucentNavigation",         value: "false" },
      { name: "android:statusBarColor",                      value: "@android:color/transparent" },
      { name: "android:navigationBarColor",                  value: "@android:color/transparent" },
      { name: "android:windowDrawsSystemBarBackgrounds",     value: "true" },
      // Display cutout: content extends into notch area in landscape so the
      // video player fills the full screen including the camera cutout zone.
      { name: "android:windowLayoutInDisplayCutoutMode",    value: "shortEdges" },
      // Android 15 edge-to-edge enforcement: false = opt IN (do not opt out).
      // This attribute is no-op on API < 35 (safely ignored by older frameworks).
      { name: "android:windowOptOutEdgeToEdgeEnforcement",  value: "false" },
    ];

    // Remove stale values set by earlier runs or the Expo default theme,
    // then append the canonical edge-to-edge set.
    const MANAGED_NAMES = new Set(EDGE_TO_EDGE_ITEMS.map((i) => i.name));
    appTheme.item = appTheme.item.filter((item) => !MANAGED_NAMES.has(item.$?.name));

    for (const { name, value } of EDGE_TO_EDGE_ITEMS) {
      appTheme.item.push({ $: { name }, _: value });
    }

    return mod;
  });
};
