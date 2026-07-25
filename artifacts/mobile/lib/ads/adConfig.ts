/**
 * adConfig — single source of truth for Temple TV AdMob / Google Ad Manager
 * configuration.
 *
 * DESIGN GOALS
 *  • Pure, dependency-free module (no `react-native-google-mobile-ads` import)
 *    so it is safe to import on web, in Expo Go, in unit tests, and during the
 *    config-plugin/prebuild phase. Native constants (Google's official
 *    `TestIds`) are injected by the caller via `pickAdUnitId(prod, test)`.
 *  • Test ad units in DEBUG builds, production ad units in RELEASE builds —
 *    never the reverse (Google policy: real ad units must not be clicked in
 *    development, and test devices must be used for QA).
 *  • Production identifiers are injected at build time via EXPO_PUBLIC_* env
 *    vars / EAS secrets. When a production unit is missing, that format is
 *    disabled (returns null) rather than falling back to a wrong/other unit —
 *    a disabled format is always safe; a wrong unit id violates policy.
 *
 * PUBLISHER (from account configuration)
 *   AdMob / AdSense publisher ID : pub-6817509745706083
 *   AdSense customer ID          : 973-378-3024
 *   Time zone                    : Africa/Lagos (GMT+01:00)
 *   Currency                     : USD ($)
 *   Programmatic Limited Ads     : Enabled
 *   Share full IP address        : Disabled
 *
 * The AdMob *App ID* (ca-app-pub-6817509745706083~XXXXXXXXXX) and each
 * production *Ad Unit ID* (ca-app-pub-6817509745706083/YYYYYYYYYY) are NOT
 * derivable from the publisher ID alone — they must be created in the AdMob
 * console and supplied through the env vars below.
 */

/** Google AdMob / AdSense publisher id for Temple TV (JCTM). */
export const ADMOB_PUBLISHER_ID = "pub-6817509745706083";

/** AdSense customer id associated with the publisher account. */
export const ADSENSE_CUSTOMER_ID = "973-378-3024";

/** Reporting currency for revenue analytics (account configuration). */
export const ADS_REPORTING_CURRENCY = "USD";

/**
 * `__DEV__` is injected by Metro at runtime but is undefined under plain Node
 * (unit tests) and during config resolution. Resolve it defensively so this
 * module never throws a ReferenceError.
 */
export const IS_DEV: boolean =
  typeof __DEV__ !== "undefined"
    ? __DEV__
    : process.env.NODE_ENV !== "production";

function envStr(name: string): string {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : "";
}

function envBool(name: string, fallback: boolean): boolean {
  const v = envStr(name).toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

/**
 * Master ad kill-switch. Ads are ON by default in release builds and can be
 * disabled remotely-ish by shipping `EXPO_PUBLIC_ADS_ENABLED=false` in an OTA
 * update or EAS profile without touching code. When ads are disabled every
 * surface degrades to rendering nothing / no-op.
 */
export const ADS_ENABLED = envBool("EXPO_PUBLIC_ADS_ENABLED", true);

/** The supported ad formats in this app. */
export type AdFormat =
  | "appOpen"
  | "banner"
  | "interstitial"
  | "gamInterstitial"
  | "rewarded"
  | "rewardedInterstitial"
  | "native";

/**
 * Map each ad format to the env var that carries its PRODUCTION ad unit id.
 * Keep names stable — they double as the EAS secret names.
 */
const PROD_UNIT_ENV: Record<AdFormat, string> = {
  appOpen: "EXPO_PUBLIC_ADMOB_APP_OPEN_UNIT_ID",
  banner: "EXPO_PUBLIC_ADMOB_BANNER_UNIT_ID",
  interstitial: "EXPO_PUBLIC_ADMOB_INTERSTITIAL_UNIT_ID",
  // Retain the pre-existing GAM interstitial env var name for backwards
  // compatibility with anything already provisioned in EAS.
  gamInterstitial: "EXPO_PUBLIC_GAM_INTERSTITIAL_AD_UNIT_ID",
  rewarded: "EXPO_PUBLIC_ADMOB_REWARDED_UNIT_ID",
  rewardedInterstitial: "EXPO_PUBLIC_ADMOB_REWARDED_INTERSTITIAL_UNIT_ID",
  native: "EXPO_PUBLIC_ADMOB_NATIVE_UNIT_ID",
};

/** Production ad unit id for a format (empty string when not configured). */
export function getProdAdUnitId(format: AdFormat): string {
  return envStr(PROD_UNIT_ENV[format]);
}

/**
 * Resolve the ad unit id to actually request for the current environment.
 *
 * @param prodUnitId  the production unit id (usually `getProdAdUnitId(format)`)
 * @param testUnitId  the matching Google `TestIds.*` constant (injected by the
 *                    native caller so this module stays free of native imports)
 * @returns the unit id to use, or `null` when ads should not load for this
 *          format (disabled globally, or no production id configured in a
 *          release build).
 */
export function pickAdUnitId(
  prodUnitId: string,
  testUnitId: string,
): string | null {
  if (!ADS_ENABLED) return null;
  if (IS_DEV) return testUnitId || null;
  return prodUnitId ? prodUnitId : null;
}

/** Convenience wrapper: resolve directly from the format + injected test id. */
export function resolveAdUnitId(
  format: AdFormat,
  testUnitId: string,
): string | null {
  return pickAdUnitId(getProdAdUnitId(format), testUnitId);
}

// ── AdMob App ID (native SDK bootstrap identifier) ──────────────────────────
// Google's official *sample* App IDs — safe to compile with; they let the SDK
// initialise in development without a real account. Overridden by the env vars
// below at build time (see app.config.ts).
export const TEST_ANDROID_APP_ID = "ca-app-pub-3940256099942544~3347511713";
export const TEST_IOS_APP_ID = "ca-app-pub-3940256099942544~1458002511";

export function getAndroidAppId(): string {
  return envStr("EXPO_PUBLIC_ADMOB_ANDROID_APP_ID") || TEST_ANDROID_APP_ID;
}

export function getIosAppId(): string {
  return envStr("EXPO_PUBLIC_ADMOB_IOS_APP_ID") || TEST_IOS_APP_ID;
}

// ── Privacy / compliance knobs ──────────────────────────────────────────────

/**
 * COPPA — tag requests as child-directed. Temple TV is a general-audience
 * ministry app, so this defaults to false, but is env-overridable in case the
 * Play listing target audience changes.
 */
export const TAG_FOR_CHILD_DIRECTED_TREATMENT = envBool(
  "EXPO_PUBLIC_ADMOB_TAG_CHILD_DIRECTED",
  false,
);

/** GDPR — tag requests for users under the age of consent (TFUA). */
export const TAG_FOR_UNDER_AGE_OF_CONSENT = envBool(
  "EXPO_PUBLIC_ADMOB_TAG_UNDER_AGE",
  false,
);

/**
 * Maximum ad content rating. "PG" keeps ad content appropriate for a faith /
 * general-audience broadcast. Override with EXPO_PUBLIC_ADMOB_MAX_AD_RATING
 * (one of G | PG | T | MA).
 */
export function getMaxAdContentRating(): "G" | "PG" | "T" | "MA" {
  const v = envStr("EXPO_PUBLIC_ADMOB_MAX_AD_RATING").toUpperCase();
  return v === "G" || v === "PG" || v === "T" || v === "MA" ? v : "PG";
}

/**
 * Programmatic Limited Ads — enabled on the account. When the user has NOT
 * granted personalization consent we request non-personalized / limited ads so
 * eligible impressions still serve (and still earn) in a privacy-safe way.
 */
export const PROGRAMMATIC_LIMITED_ADS_ENABLED = envBool(
  "EXPO_PUBLIC_ADMOB_LIMITED_ADS",
  true,
);

/** Account setting: full IP address sharing is DISABLED. Documented for parity. */
export const SHARE_FULL_IP_ADDRESS = false;

/**
 * Comma-separated list of test device ids (advertising ids) that should always
 * receive test ads even in release builds — used by QA to validate the live ad
 * pipeline without generating invalid traffic on the production account.
 * `EMULATOR` is accepted by the SDK for emulator devices.
 */
export function getTestDeviceIdentifiers(): string[] {
  const raw = envStr("EXPO_PUBLIC_ADMOB_TEST_DEVICE_IDS");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
