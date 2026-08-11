/**
 * Dynamic Expo config.
 *
 * `app.json` remains the static source of truth; Expo reads it first and passes
 * it here as `config`. This layer injects the PRODUCTION Google Mobile Ads
 * (AdMob) App IDs from environment variables / EAS secrets at build time so the
 * committed repo never hard-codes account identifiers:
 *
 *   EXPO_PUBLIC_ADMOB_ANDROID_APP_ID = ca-app-pub-6817509745706083~XXXXXXXXXX
 *   EXPO_PUBLIC_ADMOB_IOS_APP_ID     = ca-app-pub-6817509745706083~YYYYYYYYYY
 *
 * When unset (e.g. local/dev builds) the Google sample App IDs already present
 * in app.json are used, so the SDK still initialises for QA without a live
 * account. See lib/ads/adConfig.ts for the matching ad-unit resolution.
 */

import type { ConfigContext, ExpoConfig } from "expo/config";

type PluginEntry = NonNullable<ExpoConfig["plugins"]>[number];

const GMA_PLUGIN = "react-native-google-mobile-ads";
const SAMPLE_ANDROID_APP_ID = "ca-app-pub-3940256099942544~3347511713";
const SAMPLE_IOS_APP_ID = "ca-app-pub-3940256099942544~1458002511";

/** Returns true when the value is a build-time placeholder rather than a real ID. */
function isPlaceholder(value: string): boolean {
  return value.startsWith("REPLACE_WITH_") || value.startsWith("REPLACE_");
}

/**
 * Read an AdMob App ID from the environment.
 *
 * @param name     - env var name (EXPO_PUBLIC_ADMOB_*_APP_ID)
 * @param sampleId - fallback sample ID for non-production builds
 * @param platform - "android" | "ios" — only enforce the production guard when
 *                   EAS_BUILD_PLATFORM matches (or is unset). This lets an
 *                   Android-only build proceed even when the iOS App ID hasn't
 *                   been created yet, and vice-versa.
 */
function readAppId(
  name: string,
  sampleId: string,
  platform?: "android" | "ios",
): string {
  const raw = process.env[name]?.trim() ?? "";
  // Reject unfilled eas.json placeholders ("REPLACE_WITH_*") the same way we
  // treat a missing env var — they must never reach the native plugin because
  // the GMA plugin bakes the value into the compiled AndroidManifest/Info.plist
  // at build time and an invalid App ID will break SDK initialization at runtime.
  const value = isPlaceholder(raw) ? "" : raw;
  if (value) return value;

  const appEnv = (process.env.APP_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
  // EAS sets EAS_BUILD_PLATFORM to "android" or "ios" during cloud builds.
  const buildPlatform = (process.env.EAS_BUILD_PLATFORM ?? "").toLowerCase() as
    | "android"
    | "ios"
    | "";

  // Only throw when we are actually building for this platform. If the build
  // platform is the *other* platform (or not set), fall back to the sample ID
  // so builds aren't blocked by a missing credential for a platform not in scope.
  const isRelevantPlatform =
    !platform || !buildPlatform || buildPlatform === platform;

  if (appEnv === "production" && isRelevantPlatform) {
    throw new Error(
      `[mobile config] ${name} is required for production ${platform ?? ""} builds. ` +
        "The Google sample App ID must never ship in a release binary. " +
        "Set it as an EAS secret or fill in the eas.json placeholder.",
    );
  }

  return sampleId;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const androidAppId = readAppId(
    "EXPO_PUBLIC_ADMOB_ANDROID_APP_ID",
    SAMPLE_ANDROID_APP_ID,
    "android",
  );
  const iosAppId = readAppId(
    "EXPO_PUBLIC_ADMOB_IOS_APP_ID",
    SAMPLE_IOS_APP_ID,
    "ios",
  );

  const plugins: PluginEntry[] = (config.plugins ?? []).map((entry): PluginEntry => {
    if (Array.isArray(entry) && entry[0] === GMA_PLUGIN) {
      const [name, opts] = entry as [string, Record<string, unknown>];
      return [
        name,
        {
          ...opts,
          // react-native-google-mobile-ads expects camelCase plugin options.
          // The snake_case keys previously used here were ignored, leaving
          // the sample IDs in the generated native projects.
          androidAppId,
          iosAppId,
        },
      ] as PluginEntry;
    }
    return entry;
  });

  return {
    // `config` already carries every field from app.json (name, slug, etc.).
    ...(config as ExpoConfig),
    plugins,
  };
};
