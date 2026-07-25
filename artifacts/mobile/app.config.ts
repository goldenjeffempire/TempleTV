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

export default ({ config }: ConfigContext): ExpoConfig => {
  const androidAppId = process.env.EXPO_PUBLIC_ADMOB_ANDROID_APP_ID?.trim();
  const iosAppId = process.env.EXPO_PUBLIC_ADMOB_IOS_APP_ID?.trim();

  const plugins: PluginEntry[] = (config.plugins ?? []).map((entry): PluginEntry => {
    if (Array.isArray(entry) && entry[0] === GMA_PLUGIN) {
      const [name, opts] = entry as [string, Record<string, unknown>];
      return [
        name,
        {
          ...opts,
          ...(androidAppId ? { android_app_id: androidAppId } : {}),
          ...(iosAppId ? { ios_app_id: iosAppId } : {}),
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
