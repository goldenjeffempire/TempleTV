// Expo Config Plugin — Android Predictive Back Gesture (API 33+)
//
// Adds android:enableOnBackInvokedCallback="true" to the <application> tag.
//
// Required for targetSdkVersion 33+ to opt-in to the predictive back gesture
// introduced in Android 13 (API 33). Without this:
//   • Play Console shows a "Predictive back" compatibility warning for apps
//     targeting API 33+ since the attribute is required starting in targetSdk 35.
//   • The system back gesture uses the legacy animation (no rubber-band preview)
//     which is noticeably laggy compared to system apps on Android 13+ devices.
//   • On Android 15+ (API 35), apps targeting SDK 35 that omit this attribute
//     receive an implicit "false" that disables certain back-gesture APIs and
//     can cause NavigationUI.navigateUp() to silently ignore back presses in
//     edge cases with nested Fragment back stacks.
//
// expo-router (React Navigation underneath) handles the BackHandler event
// correctly on both legacy and predictive-back paths, so enabling this is safe.
// React Native 0.74+ added the necessary bridge support (BackHandler.addEventListener
// fires correctly when predictive back is enabled).

const { withAndroidManifest } = require("@expo/config-plugins");

/** @param {import('@expo/config-plugins').ExpoConfig} config */
module.exports = function withPredictiveBack(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) return mod;

    // Set on the <application> element so it applies to all Activities,
    // including any launched by third-party SDKs (Play Core update dialogs,
    // notification trampoline activities, etc.).
    application.$["android:enableOnBackInvokedCallback"] = "true";

    return mod;
  });
};
