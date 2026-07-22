// Expo Config Plugin — Android Activity Compliance Flags
//
// Adds attributes to MainActivity and Application required for:
//   1. Google Play "Large screen / foldable compatibility" warnings
//      (android:resizeableActivity="true")
//   2. Picture-in-Picture support at the manifest level
//      (android:supportsPictureInPicture="true")
//   3. Android 12L+ Activity Embedding / split-screen on large screens
//      (android.window.PROPERTY_ACTIVITY_EMBEDDING_ALLOW_SYSTEM_OVERRIDE)
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

    // ── android.window.PROPERTY_ACTIVITY_EMBEDDING_ALLOW_SYSTEM_OVERRIDE ─────
    // Android 12L (API 32) introduced Activity Embedding: the system can split
    // the screen between two activities on large screens and foldables. Setting
    // this property to "true" opts in to system-managed embedding, improving the
    // app's Google Play large screen compatibility score without requiring manual
    // split-screen implementation.
    //
    // With this opt-in, on eligible large-screen devices (tablets, foldables,
    // ChromeOS) Android can run Temple TV side-by-side with another app in a
    // multi-pane layout. The app does not need to implement any embedding APIs —
    // the system handles layout, the app just needs to declare readiness.
    //
    // Required for Google Play's "Large screen ready" badge (Play Console →
    // Android vitals → App quality → Large screen).
    if (!application["meta-data"]) application["meta-data"] = [];
    const hasEmbeddingProp = application["meta-data"].some(
      (m) =>
        m.$?.["android:name"] ===
        "android.window.PROPERTY_ACTIVITY_EMBEDDING_ALLOW_SYSTEM_OVERRIDE",
    );
    if (!hasEmbeddingProp) {
      application["meta-data"].push({
        $: {
          "android:name":
            "android.window.PROPERTY_ACTIVITY_EMBEDDING_ALLOW_SYSTEM_OVERRIDE",
          "android:value": "true",
        },
      });
    }

    // ── android.window.PROPERTY_COMPAT_ALLOW_USER_ASPECT_RATIO_OVERRIDE ────────
    // Android 14 (API 34) introduced user-controlled aspect ratio overrides on
    // large-screen devices (tablets, foldables, ChromeOS). Users can enable this
    // in Settings → Display → Large Screen. Setting this property to "true" opts
    // the app in to that override path, signalling to the Play Console large screen
    // quality checker that the app is compatible with user-controlled aspect ratio.
    //
    // Without it, some OEMs letterbox the app even when resizeableActivity="true"
    // is set, because the system can't confirm the app has been tested against the
    // aspect ratio override path. This property is the explicit opt-in for the
    // improved large-screen behaviour formalised in the Android 16 compatibility
    // guidelines and required for the Play Console "Large Screen ready" tier.
    const hasAspectRatioProp = application["meta-data"].some(
      (m) =>
        m.$?.["android:name"] ===
        "android.window.PROPERTY_COMPAT_ALLOW_USER_ASPECT_RATIO_OVERRIDE",
    );
    if (!hasAspectRatioProp) {
      application["meta-data"].push({
        $: {
          "android:name":
            "android.window.PROPERTY_COMPAT_ALLOW_USER_ASPECT_RATIO_OVERRIDE",
          "android:value": "true",
        },
      });
    }

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
    // colorMode: prevents activity recreation when the display color mode
    //   changes (HDR, wide color gamut, dark/light mode on some OEM skins).
    //   On Android 16 devices with HDR or high-refresh-rate displays, OS-level
    //   color-mode switches (e.g. auto-HDR while playing video) would otherwise
    //   destroy and recreate the Activity mid-playback. Unknown on API < 26,
    //   which safely ignores unrecognised config-change flags.
    // grammaticalGender: Android 14 (API 34) added grammatical gender as a
    //   configChange category (RTL-language locale features). Without it,
    //   locale changes involving grammatical gender markers on supported locales
    //   recreate the Activity on API 34+ devices.
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
      "colorMode",
      // Android 14 (API 34): grammatical gender locale changes.
      "grammaticalGender",
    ];
    const present = new Set(existingConfigChanges.split("|").filter(Boolean));
    for (const flag of required) present.add(flag);
    mainActivity.$["android:configChanges"] = Array.from(present).join("|");

    return mod;
  });
};
