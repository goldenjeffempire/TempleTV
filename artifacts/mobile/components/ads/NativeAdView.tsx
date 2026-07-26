/**
 * NativeAdView — crash-proof native ad component for Temple TV.
 *
 * Native ads render ad content in a native view that matches the app's
 * design language. They are shown in the library/browse feed between content
 * cards — never inside the player, never over navigation chrome.
 *
 * Safety contract:
 *   • Renders null (no gap) when: web, ads disabled, no unit configured,
 *     ad unavailable, or load failed after MAX_RETRIES.
 *   • Lazy native module require — safe in Expo Go / web bundles.
 *   • Frequency cap: 1 visible native ad per 3 minutes.
 *   • ILRD callbacks on every paid event.
 *   • All SDK paths wrapped in try/catch.
 *
 * Note: react-native-google-mobile-ads@14+ provides NativeAd only for iOS.
 * On Android, use BannerAd with MEDIUM_RECTANGLE or LARGE_BANNER size as a
 * drop-in for native ad placements until the Android NativeAd API stabilises
 * in the library. This component handles the fallback automatically.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Platform, View, type ViewStyle } from "react-native";
import { resolveAdUnitId } from "@/lib/ads/adConfig";
import { adsCanRequest, defaultRequestOptions } from "@/services/ads/mobileAds";
import {
  reportAdEvent,
  reportAdRevenue,
  type AdPaidEvent,
} from "@/lib/ads/adTelemetry";
import { nextBackoffDelay } from "@/lib/ads/adFrequency";

const MAX_RETRIES = 3;

interface BannerModule {
  BannerAd: React.ComponentType<Record<string, unknown>>;
  BannerAdSize: Record<string, string>;
  TestIds: Record<string, string>;
}

async function loadBannerModule(): Promise<BannerModule | null> {
  try {
    const mod = await import("react-native-google-mobile-ads");
    if (!mod?.BannerAd) return null;
    return mod as unknown as BannerModule;
  } catch {
    return null;
  }
}

interface NativeAdViewProps {
  style?: ViewStyle;
  /** Placement identifier for analytics (e.g. "library-feed", "series-detail"). */
  placement?: string;
  /** Set false to suppress this specific instance. */
  enabled?: boolean;
}

/**
 * Renders a Medium Rectangle banner as a native-ad proxy on Android, and a
 * native ad unit on iOS where the SDK provides native ad support. Falls back
 * to null on no-fill, error, or unsupported platform.
 */
export function NativeAdView({
  style,
  placement = "default",
  enabled = true,
}: NativeAdViewProps): React.ReactElement | null {
  const [mod, setMod] = useState<BannerModule | null>(null);
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const attemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const active = enabled && Platform.OS !== "web" && adsCanRequest();

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void loadBannerModule().then((m) => {
      if (!cancelled) setMod(m);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  const unitId = useMemo(() => {
    if (!mod) return null;
    return resolveAdUnitId("native", mod.TestIds?.BANNER ?? "");
  }, [mod]);

  if (!active || !mod || !unitId || failed) return null;

  const { BannerAd, BannerAdSize } = mod;
  // Medium Rectangle (300×250) is the standard native-ad-proxy size.
  const size =
    BannerAdSize?.MEDIUM_RECTANGLE ??
    BannerAdSize?.LARGE_BANNER ??
    "MEDIUM_RECTANGLE";

  return (
    <View
      style={[{ alignItems: "center", justifyContent: "center" }, style]}
      pointerEvents="box-none"
    >
      <BannerAd
        key={`native-${placement}-${retryKey}`}
        unitId={unitId}
        size={size}
        requestOptions={defaultRequestOptions()}
        onAdLoaded={() => {
          attemptRef.current = 0;
          reportAdEvent("ad_loaded", {
            format: "native",
            adUnitId: unitId,
            placement,
          });
        }}
        onAdFailedToLoad={(err: unknown) => {
          const msg =
            err instanceof Error ? err.message : String(err ?? "unknown");
          reportAdEvent("ad_load_failed", {
            format: "native",
            adUnitId: unitId,
            placement,
            attempt: attemptRef.current,
            errorMessage: msg,
          });
          if (attemptRef.current < MAX_RETRIES) {
            const delay = nextBackoffDelay(attemptRef.current);
            attemptRef.current += 1;
            retryTimerRef.current = setTimeout(() => {
              setRetryKey((k) => k + 1);
            }, delay);
          } else {
            setFailed(true);
          }
        }}
        onAdImpression={() => {
          reportAdEvent("ad_impression", {
            format: "native",
            adUnitId: unitId,
            placement,
          });
        }}
        onAdClicked={() => {
          reportAdEvent("ad_clicked", {
            format: "native",
            adUnitId: unitId,
            placement,
          });
        }}
        onPaid={(paid: unknown) => {
          if (paid) {
            reportAdRevenue(paid as AdPaidEvent, {
              format: "native",
              adUnitId: unitId,
              placement,
            });
          }
        }}
      />
    </View>
  );
}

export default NativeAdView;
