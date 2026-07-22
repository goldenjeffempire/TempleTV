// Expo Config Plugin — Android 14+ Foreground Service Type & Receiver Compliance
//
// Android 14 (API 34) introduced a hard requirement: any app targeting
// SDK 34+ that starts a foreground service MUST declare
// android:foregroundServiceType on the <service> element AND pass the
// matching type flag to startForeground(). Failure causes an
// android.app.MissingForegroundServiceTypeException crash — native,
// uncatchable by JS, surfaces as "app crashed due to its own issues."
//
// react-native-track-player v4.x registers MusicService as a foreground
// media playback service.  Its own AndroidManifest.xml carries the attribute,
// but manifest-merger can silently mismerge it when targetSdkVersion changes.
// This plugin ensures the attribute is present regardless.
//
// Android 12 (API 31) ALSO requires every <service> and <receiver> element to
// have an explicit android:exported attribute. Without it, AGP 8.x raises a
// build error and some OEM devices throw SecurityException when the OS tries
// to bind the service on behalf of a MediaSession client.
//
// References:
//   https://developer.android.com/about/versions/14/changes/fgs-types-required
//   https://developer.android.com/guide/components/services#Foreground
//   https://developer.android.com/reference/android/app/Service#startForeground(int,%20android.app.Notification,%20int)

const { withAndroidManifest } = require("@expo/config-plugins");

// Canonical RNTP v4.x service names. The package was renamed during v2→v4 but
// some builds still emit the old guichaguri namespace depending on which RNTP
// version is linked at compile time (version mismatch in a monorepo, or a stale
// patch file). We handle both to make this plugin version-range-safe.
const MEDIA_SERVICE_NAMES = new Set([
  "com.doublesymmetry.trackplayer.service.MusicService",  // RNTP 4.x (primary)
  "com.guichaguri.trackplayer.service.MusicService",       // RNTP 2.x / legacy
]);

/** @param {import('@expo/config-plugins').ExpoConfig} config */
module.exports = function withForegroundServiceType(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults;
    const application = manifest.manifest.application?.[0];
    if (!application) return mod;

    // ── Services ─────────────────────────────────────────────────────────────
    for (const svc of application.service ?? []) {
      const name = svc.$?.["android:name"];
      if (!name) continue;

      const isMediaService =
        MEDIA_SERVICE_NAMES.has(name) ||
        name.toLowerCase().includes("music") ||
        name.toLowerCase().includes("mediaplayer");

      if (!isMediaService) continue;

      // Android 14+ (API 34): foreground service type must be declared in the
      // manifest AND passed to startForeground(). RNTP 4.x calls
      // startForeground(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      // internally; we only need to ensure the manifest attribute matches.
      if (!svc.$["android:foregroundServiceType"]) {
        svc.$["android:foregroundServiceType"] = "mediaPlayback";
      }

      // Android 12+ (API 31): every <service> must have an explicit exported
      // declaration. MusicService is an internal-only service (only the app
      // itself binds it — no external MediaSession clients should bind to it
      // directly), so exported="false" is the secure default. RNTP's own manifest
      // may already set it; we only write if absent to avoid overriding an
      // intentional "true".
      if (
        svc.$["android:exported"] === undefined ||
        svc.$["android:exported"] === null
      ) {
        svc.$["android:exported"] = "false";
      }
    }

    // ── BroadcastReceivers ────────────────────────────────────────────────────
    // Android 12+ requires explicit android:exported on BroadcastReceivers too.
    // This pass ensures any receiver that:
    //   (a) has at least one <intent-filter> → must be exported="true"
    //       (it's meant to receive external broadcasts, e.g. BOOT_COMPLETED,
    //       MEDIA_BUTTON, HEADSET_PLUG for media sessions)
    //   (b) has NO <intent-filter> → must be exported="false"
    //       (it's registered at runtime by the app and is package-private)
    // Both rules are mandated by AGP 8.x build validation; violating either
    // prevents the AAB/APK from being accepted by the Play Console.
    //
    // We only write the attribute when it's absent — an existing value from
    // the library's own manifest is respected.
    for (const receiver of application.receiver ?? []) {
      if (!receiver.$) continue;
      if (
        receiver.$["android:exported"] !== undefined &&
        receiver.$["android:exported"] !== null
      ) {
        continue; // already declared — don't overwrite
      }

      const hasIntentFilter =
        Array.isArray(receiver["intent-filter"]) &&
        receiver["intent-filter"].length > 0;

      receiver.$["android:exported"] = hasIntentFilter ? "true" : "false";
    }

    return mod;
  });
};
