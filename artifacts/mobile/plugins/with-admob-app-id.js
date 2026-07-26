/**
 * with-admob-app-id — Expo Config Plugin
 *
 * Overrides the AdMob Application ID that react-native-google-mobile-ads
 * injects into AndroidManifest.xml and iOS Info.plist with values supplied
 * via environment variables at EAS build time.
 *
 * Why a separate plugin instead of using the rn-google-mobile-ads androidAppId/
 * iosAppId options directly?
 *
 *   The rn-google-mobile-ads options are evaluated once during `expo prebuild`
 *   using whatever is in app.json at that moment. They cannot read EAS secret
 *   env vars because those are only injected at EAS *build* time, after prebuild
 *   runs. This plugin fires in the `withAndroidManifest` / `withInfoPlist`
 *   hooks which execute at build time when the env vars ARE available.
 *
 * Environment variables:
 *   ADMOB_ANDROID_APP_ID  — Production AdMob App ID for Android
 *                           Format: ca-app-pub-6817509745706083~XXXXXXXXXX
 *   ADMOB_IOS_APP_ID      — Production AdMob App ID for iOS
 *                           Format: ca-app-pub-6817509745706083~YYYYYYYYYY
 *
 * When unset (local / CI dev builds) the existing value from the
 * react-native-google-mobile-ads plugin (test App ID) is preserved.
 *
 * Publisher: pub-6817509745706083 (Temple TV / JCTM)
 */

const { withAndroidManifest, withInfoPlist } = require("expo/config-plugins");

const ANDROID_META_KEY = "com.google.android.gms.ads.APPLICATION_ID";
const IOS_INFO_KEY = "GADApplicationIdentifier";
const DELAY_INIT_KEY = "com.google.android.gms.ads.DELAY_APP_MEASUREMENT_INIT";

/**
 * Patch AndroidManifest.xml <application> meta-data:
 *   • com.google.android.gms.ads.APPLICATION_ID → ADMOB_ANDROID_APP_ID env var
 *   • com.google.android.gms.ads.DELAY_APP_MEASUREMENT_INIT → true
 *     (required for UMP consent-first flow; mirrors delayAppMeasurementInit in plugin config)
 */
function withAdmobAndroid(config) {
  return withAndroidManifest(config, (cfg) => {
    const appId = process.env.ADMOB_ANDROID_APP_ID;

    const app = cfg.modResults.manifest?.application?.[0];
    if (!app) return cfg;

    // Ensure meta-data array exists.
    if (!Array.isArray(app["meta-data"])) {
      app["meta-data"] = [];
    }

    const metaData = app["meta-data"];

    // ── APPLICATION_ID ────────────────────────────────────────────────────
    if (appId) {
      const existing = metaData.find(
        (m) => m.$?.["android:name"] === ANDROID_META_KEY,
      );
      if (existing) {
        // Override whatever the rn-google-mobile-ads plugin wrote.
        existing.$["android:value"] = appId;
      } else {
        metaData.push({
          $: {
            "android:name": ANDROID_META_KEY,
            "android:value": appId,
          },
        });
      }
      console.log(
        `[with-admob-app-id] ✓ Android AdMob App ID set from ADMOB_ANDROID_APP_ID`,
      );
    } else {
      console.log(
        `[with-admob-app-id] ⚠ ADMOB_ANDROID_APP_ID not set — using existing App ID in manifest`,
      );
    }

    // ── DELAY_APP_MEASUREMENT_INIT ────────────────────────────────────────
    // Belt-and-suspenders: make sure the delay flag is always true so the SDK
    // waits for UMP consent before initialising measurement, regardless of
    // what the rn-google-mobile-ads plugin wrote.
    const delay = metaData.find(
      (m) => m.$?.["android:name"] === DELAY_INIT_KEY,
    );
    if (delay) {
      delay.$["android:value"] = "true";
    } else {
      metaData.push({
        $: {
          "android:name": DELAY_INIT_KEY,
          "android:value": "true",
        },
      });
    }

    return cfg;
  });
}

/**
 * Patch iOS Info.plist:
 *   • GADApplicationIdentifier → ADMOB_IOS_APP_ID env var
 *   • GADDelayAppMeasurementInit → true (UMP consent-first)
 */
function withAdmobIos(config) {
  return withInfoPlist(config, (cfg) => {
    const appId = process.env.ADMOB_IOS_APP_ID;

    if (appId) {
      cfg.modResults[IOS_INFO_KEY] = appId;
      console.log(
        `[with-admob-app-id] ✓ iOS AdMob App ID set from ADMOB_IOS_APP_ID`,
      );
    } else {
      console.log(
        `[with-admob-app-id] ⚠ ADMOB_IOS_APP_ID not set — using existing App ID in Info.plist`,
      );
    }

    // Ensure measurement delay is always on.
    cfg.modResults["GADDelayAppMeasurementInit"] = true;

    return cfg;
  });
}

/**
 * Composite plugin — apply both Android and iOS patches.
 */
function withAdmobAppId(config) {
  config = withAdmobAndroid(config);
  config = withAdmobIos(config);
  return config;
}

module.exports = withAdmobAppId;
