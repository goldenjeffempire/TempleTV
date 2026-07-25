/**
 * mobileAds — Google Mobile Ads (AdMob) SDK bootstrap for Temple TV.
 *
 * Responsibilities, in order:
 *   1. Gather UMP (User Messaging Platform) consent — GDPR/GPP. Uses
 *      `AdsConsent.gatherConsent()` which performs the info-update + shows the
 *      consent form only when required. Never blocks or throws.
 *   2. Apply the global RequestConfiguration (COPPA/TFUA tags, max ad content
 *      rating, test-device allowlist).
 *   3. Initialize the SDK.
 *
 * Everything is dynamically imported and wrapped so a failure at ANY step
 * (SDK blocked, no network, web platform, native module missing in Expo Go)
 * degrades gracefully to "ads off" and can NEVER crash app boot. This mirrors
 * the existing defensive style in index.ts / app/_layout.tsx.
 *
 * A module-level runtime snapshot (`getAdsRuntime`) lets ad surfaces decide
 * whether they may request ads and whether to request non-personalized ads.
 */

import { Platform } from "react-native";
import {
  getMaxAdContentRating,
  getTestDeviceIdentifiers,
  TAG_FOR_CHILD_DIRECTED_TREATMENT,
  TAG_FOR_UNDER_AGE_OF_CONSENT,
  PROGRAMMATIC_LIMITED_ADS_ENABLED,
  ADS_ENABLED,
  IS_DEV,
} from "@/lib/ads/adConfig";
import { reportAdEvent } from "@/lib/ads/adTelemetry";

export interface AdsRuntime {
  /** True once MobileAds().initialize() has resolved. */
  initialized: boolean;
  /** UMP says the app may request ads (consent obtained or not required). */
  canRequestAds: boolean;
  /**
   * When true, ad requests should set requestNonPersonalizedAdsOnly. This is
   * the case whenever the user has not granted personalization consent but
   * limited/non-personalized ads are still permitted (Programmatic Limited
   * Ads). Defaults to false (personalized) until proven otherwise.
   */
  nonPersonalizedOnly: boolean;
}

let _runtime: AdsRuntime = {
  initialized: false,
  // Optimistic default so ads can attempt to load in regions where consent is
  // not required; corrected downward as soon as UMP reports its status.
  canRequestAds: true,
  nonPersonalizedOnly: false,
};

let _initPromise: Promise<AdsRuntime> | null = null;

/** Current ads runtime snapshot (safe to read from any surface). */
export function getAdsRuntime(): AdsRuntime {
  return _runtime;
}

/** Whether ad surfaces are permitted to attempt loading right now. */
export function adsCanRequest(): boolean {
  return ADS_ENABLED && Platform.OS !== "web" && _runtime.canRequestAds;
}

async function gatherConsent(): Promise<void> {
  try {
    const mod = await import("react-native-google-mobile-ads");
    const AdsConsent = mod.AdsConsent;
    if (!AdsConsent || typeof AdsConsent.gatherConsent !== "function") return;

    // In development force the EEA geography so the consent form can be
    // exercised on demand; in production the real geography is used.
    const options = IS_DEV
      ? {
          debugGeography: mod.AdsConsentDebugGeography?.EEA,
          tagForUnderAgeOfConsent: TAG_FOR_UNDER_AGE_OF_CONSENT,
          testDeviceIdentifiers: getTestDeviceIdentifiers(),
        }
      : { tagForUnderAgeOfConsent: TAG_FOR_UNDER_AGE_OF_CONSENT };

    const info = await AdsConsent.gatherConsent(options);
    const status = info?.status;
    const canRequestAds = info?.canRequestAds ?? true;

    // OBTAINED → personalized allowed. Any other state that still permits ads
    // (REQUIRED-but-canRequestAds, or limited-ads) → request non-personalized
    // when Programmatic Limited Ads is enabled.
    const obtained = status === mod.AdsConsentStatus?.OBTAINED;
    _runtime = {
      ..._runtime,
      canRequestAds,
      nonPersonalizedOnly:
        !obtained && PROGRAMMATIC_LIMITED_ADS_ENABLED ? true : !obtained,
    };
    reportAdEvent(canRequestAds ? "ad_consent_obtained" : "ad_consent_required", {
      status: String(status ?? "UNKNOWN"),
      canRequestAds,
    });
  } catch (err) {
    // Consent failures must not disable ads outright in non-EEA regions where
    // consent is not required — keep the optimistic default and report.
    reportAdEvent("ad_consent_error", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

async function applyRequestConfiguration(): Promise<void> {
  try {
    const mod = await import("react-native-google-mobile-ads");
    const MobileAds = mod.default;
    const rating = getMaxAdContentRating();
    const maxAdContentRating =
      mod.MaxAdContentRating?.[rating] ?? mod.MaxAdContentRating?.PG;
    await MobileAds().setRequestConfiguration({
      maxAdContentRating,
      tagForChildDirectedTreatment: TAG_FOR_CHILD_DIRECTED_TREATMENT,
      tagForUnderAgeOfConsent: TAG_FOR_UNDER_AGE_OF_CONSENT,
      testDeviceIdentifiers: getTestDeviceIdentifiers(),
    });
  } catch {
    /* non-critical — SDK will use defaults */
  }
}

/**
 * Initialize the Mobile Ads SDK exactly once. Safe to call multiple times —
 * subsequent calls return the same promise. Never throws.
 */
export async function initializeMobileAds(): Promise<AdsRuntime> {
  if (_initPromise) return _initPromise;

  _initPromise = (async (): Promise<AdsRuntime> => {
    if (!ADS_ENABLED || Platform.OS === "web") {
      _runtime = { ..._runtime, initialized: false, canRequestAds: false };
      return _runtime;
    }
    try {
      // 1. Consent first (delay_app_measurement_init in app config ensures the
      //    SDK waits for this signal before attributing measurement events).
      await gatherConsent();
      // 2. Global request configuration (privacy tags, content rating).
      await applyRequestConfiguration();
      // 3. Initialize the SDK.
      const MobileAds = (await import("react-native-google-mobile-ads")).default;
      await MobileAds().initialize();
      _runtime = { ..._runtime, initialized: true };
      reportAdEvent("ad_sdk_initialized", {
        canRequestAds: _runtime.canRequestAds,
        nonPersonalizedOnly: _runtime.nonPersonalizedOnly,
      });
    } catch (err) {
      // Non-critical — ads will not load but the broadcast plays normally.
      reportAdEvent("ad_load_failed", {
        format: "sdk_init",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    return _runtime;
  })();

  return _initPromise;
}

/** Default RequestOptions shared by every ad request in the app. */
export function defaultRequestOptions(): { requestNonPersonalizedAdsOnly: boolean } {
  return { requestNonPersonalizedAdsOnly: _runtime.nonPersonalizedOnly };
}
