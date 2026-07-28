/**
 * mobileAds.web.ts — Web platform stub for the Mobile Ads SDK bootstrap.
 *
 * Metro resolves `.web.ts` over `.ts` on the web platform, so this file is
 * used instead of mobileAds.ts when bundling for web (Expo web preview /
 * browser testing). The native file does dynamic `import("react-native-google-
 * mobile-ads")` which causes Metro/webpack to pull in react-native internals
 * that are not supported on web, crashing the bundle before any code runs.
 *
 * This stub exports the same interface but does nothing — ads are never
 * shown on web, so every surface that calls `adsCanRequest()` will get
 * `false` and skip the ad request path entirely.
 */

export interface AdsRuntime {
  initialized: boolean;
  canRequestAds: boolean;
  nonPersonalizedOnly: boolean;
}

const _noopRuntime: AdsRuntime = {
  initialized: false,
  canRequestAds: false,
  nonPersonalizedOnly: false,
};

/** Always returns the no-op runtime on web — ads are not supported. */
export function getAdsRuntime(): AdsRuntime {
  return _noopRuntime;
}

/** Always false on web — Google Mobile Ads is a native-only SDK. */
export function adsCanRequest(): boolean {
  return false;
}

/**
 * No-op on web. Returns immediately with canRequestAds=false so callers
 * that await this before requesting ads proceed without hanging.
 */
export async function initializeMobileAds(): Promise<AdsRuntime> {
  return _noopRuntime;
}

/** No-op on web. */
export function defaultRequestOptions(): { requestNonPersonalizedAdsOnly: boolean } {
  return { requestNonPersonalizedAdsOnly: false };
}
