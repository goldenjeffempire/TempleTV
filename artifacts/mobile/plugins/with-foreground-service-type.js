const { withAndroidManifest } = require("@expo/config-plugins");

/**
 * Expo Config Plugin — Android 14+ Foreground Service Type Compliance
 *
 * Android 14 (API 34) introduced a hard requirement: any app targeting
 * SDK 34+ that starts a foreground service MUST declare
 * android:foregroundServiceType on the <service> element AND pass the
 * matching type flag to startForeground(). Failure causes an
 * android.app.MissingForegroundServiceTypeException crash — native,
 * uncatchable by JS, presents as "app crashed due to its own issues."
 *
 * react-native-track-player v4.x registers MusicService as a foreground
 * media playback service.  Its own AndroidManifest.xml should carry the
 * foregroundServiceType attribute, but manifest-merger can silently drop
 * or mismerge it when targetSdkVersion changes.  This plugin ensures it
 * is present regardless.
 *
 * References:
 *  - https://developer.android.com/about/versions/14/changes/fgs-types-required
 *  - https://developer.android.com/reference/android/app/Service#startForeground(int,%20android.app.Notification,%20int)
 */

const MEDIA_SERVICES = [
  "com.doublesymmetry.trackplayer.service.MusicService",
];

/** @param {import('@expo/config-plugins').ExpoConfig} config */
module.exports = function withForegroundServiceType(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults;
    const application = manifest.manifest.application?.[0];
    if (!application) return mod;

    const services = application.service ?? [];

    for (const svc of services) {
      const name = svc.$?.["android:name"];
      if (!name) continue;

      const isMediaService =
        MEDIA_SERVICES.includes(name) ||
        name.toLowerCase().includes("music") ||
        name.toLowerCase().includes("mediaplayer");

      if (isMediaService) {
        if (!svc.$["android:foregroundServiceType"]) {
          svc.$["android:foregroundServiceType"] = "mediaPlayback";
        }
        // Android 12+ (API 31) requires every <service> to carry an explicit
        // android:exported declaration.  Without it the Play Store flags the APK
        // and some devices throw a SecurityException when the OS tries to bind
        // the service on behalf of media-session clients.  MusicService is an
        // internal service (it must NOT be exported — only the app itself binds
        // it), so we force exported="false" as the safe default unless the
        // library's own manifest already set it to "true".
        if (svc.$["android:exported"] === undefined || svc.$["android:exported"] === null) {
          svc.$["android:exported"] = "false";
        }
      }
    }

    return mod;
  });
};
