// Expo Config Plugin — android:largeHeap for video-intensive apps
//
// Sets android:largeHeap="true" on the <application> element in
// AndroidManifest.xml.  This doubles the max Dalvik heap on most
// devices (e.g. from 192 MB to 512 MB on a typical mid-range Android).
//
// Why this matters for Temple TV:
//   - React Native / Hermes baseline: ~100 MB
//   - React Native UI tree + bridge: ~30–50 MB
//   - ExoPlayer in-memory buffer + DRM: ~50–100 MB
//   - expo-av audio session: ~20 MB
//   - BitmapCache / thumbnail atlas: ~30 MB
//   - Total peak at broadcast player mount: ~250–300 MB
//
// On 2 GB devices the default heap ceiling can be as low as 192 MB,
// triggering an OOM GC cascade mid-playback.  largeHeap="true" requests
// a larger VM heap from the OS; Android grants it based on available RAM
// and does NOT cause other apps to be killed more aggressively.
//
// NOTE: largeHeap does not help OutOfMemoryErrors in native (C/C++) heap.
// Those are addressed separately via jvmArgs in expo-build-properties.

const { withAndroidManifest } = require("@expo/config-plugins");

/** @param {import('@expo/config-plugins').ExpoConfig} config */
module.exports = function withLargeHeap(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) return mod;

    // Idempotent: only set if not already present
    if (application.$["android:largeHeap"] !== "true") {
      application.$["android:largeHeap"] = "true";
    }

    return mod;
  });
};
