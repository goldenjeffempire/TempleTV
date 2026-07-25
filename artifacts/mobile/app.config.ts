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

function readAppId(name: string, sampleId: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;

  const appEnv = (process.env.APP_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
  if (appEnv === "production") {
    throw new Error(
      `[mobile config] ${name} is required for production builds. ` +
        "The Google sample App ID must never ship in a release binary.",
    );
  }

  return sampleId;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const androidAppId = readAppId(
    "EXPO_PUBLIC_ADMOB_ANDROID_APP_ID",
    SAMPLE_ANDROID_APP_ID,
  );
  const iosAppId = readAppId(
    "EXPO_PUBLIC_ADMOB_IOS_APP_ID",
    SAMPLE_IOS_APP_ID,
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
