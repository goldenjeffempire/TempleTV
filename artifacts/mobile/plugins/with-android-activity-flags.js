// Expo Config Plugin — Android Activity Compliance Flags
//
// Adds attributes to MainActivity required for:
//   1. Google Play "Large screen / foldable compatibility" warnings
//      (android:resizeableActivity="true")
//   2. Picture-in-Picture support at the manifest level
//      (android:supportsPictureInPicture="true")
//
// Note: setting supportsPictureInPicture only declares capability. The
// actual PiP entry must be triggered from native (enterPictureInPictureMode)
// or via a player library that wraps it (expo-video has built-in support;
// the legacy expo-av does NOT auto-enter PiP on Android). See README.

const { withAndroidManifest } = require("@expo/config-plugins");

/** @param {import('@expo/config-plugins').ExpoConfig} config */
module.exports = function withAndroidActivityFlags(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults;

    // Advertise Picture-in-Picture capability at the manifest level with
    // required="false" so the Play Console understands the app uses PiP WITHOUT
    // excluding the (rare) devices that lack it from installing. The activity
    // attribute below is what actually enables PiP; this declaration is the
    // documented best-practice companion. We dedupe so re-runs are idempotent.
    if (!manifest.manifest["uses-feature"]) {
      manifest.manifest["uses-feature"] = [];
    }
    const usesFeature = manifest.manifest["uses-feature"];
    const hasPipFeature = usesFeature.some(
      (f) => f.$?.["android:name"] === "android.software.picture_in_picture",
    );
    if (!hasPipFeature) {
      usesFeature.push({
        $: {
          "android:name": "android.software.picture_in_picture",
          "android:required": "false",
        },
      });
    }

    const application = manifest.manifest.application?.[0];
    if (!application) return mod;

    const activities = application.activity ?? [];
    const mainActivity = activities.find(
      (a) => a.$?.["android:name"] === ".MainActivity",
    );
    if (!mainActivity || !mainActivity.$) return mod;

    // android:hasFragileUserData="false" — tells Android there is no locally
    // stored user data worth preserving on uninstall, suppressing the
    // "Keep app data?" dialog that Android 7+ shows when uninstalling apps
    // that have stored any files.  All sensitive state (auth tokens, prefs) is
    // kept in SecureStore / encrypted SharedPreferences and the API server; the
    // user can restore their account on a fresh install just by signing in.
    // This is consistent with android:allowBackup="false" already set in app.json.
    application.$["android:hasFragileUserData"] = "false";

    // Large-screen / foldable / multi-window compatibility.
    mainActivity.$["android:resizeableActivity"] = "true";

    // Picture-in-Picture capability declaration.
    mainActivity.$["android:supportsPictureInPicture"] = "true";

    // Ensure config-change handling covers the PiP lifecycle. Without
    // screenLayout + smallestScreenSize + screenSize, Android recreates
    // the activity on every PiP enter/exit which destroys playback state.
    //
    // layoutDirection: prevents activity recreation on locale/RTL changes
    //   (API 24+). Without it a language change while in PiP kills the
    //   ExoPlayer instance mid-stream and the user sees a black screen.
    // density: prevents recreation on display-zoom / font-size changes
    //   (API 26+). Without it adjusting Accessibility display size while
    //   watching triggers a full Activity teardown inside the PiP window,
    //   causing an ANR-looking black flash on low-end devices.
    // fontScale: prevents recreation when the user changes system font size
    //   in Accessibility settings (API 24+), which is a common accessibility
    //   action taken while an app is backgrounded / in PiP.
    const existingConfigChanges = mainActivity.$["android:configChanges"] || "";
    const required = [
      "keyboard",
      "keyboardHidden",
      "orientation",
      "screenLayout",
      "screenSize",
      "smallestScreenSize",
      "uiMode",
      "layoutDirection",
      "density",
      "fontScale",
      // API 26+ — prevents activity recreation when the display color mode
      // changes (HDR, wide color gamut, dark/light mode on some OEM skins).
      // On Android 16 devices with HDR or high-refresh-rate displays, OS-level
      // color-mode switches (e.g. auto-HDR while playing video) would otherwise
      // destroy and recreate the Activity mid-playback. Unknown on API < 26,
      // which safely ignores unrecognised config-change flags.
      "colorMode",
    ];
    const present = new Set(existingConfigChanges.split("|").filter(Boolean));
    for (const flag of required) present.add(flag);
    mainActivity.$["android:configChanges"] = Array.from(present).join("|");

    return mod;
  });
};
