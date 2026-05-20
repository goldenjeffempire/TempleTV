// Expo Config Plugin — Android TV / Amazon Fire TV Support
// Adds <uses-feature android:name="android.software.leanback" android:required="false"/>
// and <uses-feature android:name="android.hardware.touchscreen" android:required="false"/>
// plus a LEANBACK_LAUNCHER intent filter to the main activity.

const path = require("path");
const { withAndroidManifest } = require(
  path.resolve(__dirname, "../node_modules/@expo/config-plugins")
);

/** @param {import('@expo/config-plugins').ExpoConfig} config */
module.exports = function androidTVPlugin(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults;

    // ── uses-feature ──────────────────────────────────────────────────────────
    if (!manifest.manifest["uses-feature"]) {
      manifest.manifest["uses-feature"] = [];
    }

    const features = manifest.manifest["uses-feature"];

    const ensureFeature = (name, required) => {
      const exists = features.some((f) => f.$?.["android:name"] === name);
      if (!exists) {
        features.push({ $: { "android:name": name, "android:required": String(required) } });
      }
    };

    ensureFeature("android.software.leanback", false);
    ensureFeature("android.hardware.touchscreen", false);
    ensureFeature("android.hardware.touchscreen.multitouch", false);
    ensureFeature("android.hardware.wifi", false);

    // ── LEANBACK_LAUNCHER intent filter ───────────────────────────────────────
    const application = manifest.manifest.application?.[0];
    if (!application) return mod;

    const activities = application.activity ?? [];
    const mainActivity = activities.find(
      (a) => a.$?.["android:name"] === ".MainActivity",
    );

    if (mainActivity) {
      if (!mainActivity["intent-filter"]) {
        mainActivity["intent-filter"] = [];
      }

      const hasLeanback = mainActivity["intent-filter"].some((filter) =>
        (filter.category ?? []).some(
          (c) => c.$?.["android:name"] === "android.intent.category.LEANBACK_LAUNCHER",
        ),
      );

      if (!hasLeanback) {
        mainActivity["intent-filter"].push({
          action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
          category: [
            { $: { "android:name": "android.intent.category.LEANBACK_LAUNCHER" } },
          ],
        });
      }

      // TV layout direction must be LTR
      if (!mainActivity.$["android:configChanges"]?.includes("layoutDirection")) {
        mainActivity.$["android:configChanges"] =
          (mainActivity.$["android:configChanges"] ?? "") + "|layoutDirection";
      }
    }

    return mod;
  });
};
