/**
 * AdBanner — a crash-proof, layout-safe anchored adaptive banner.
 *
 * Safety contract:
 *   • Renders NOTHING (zero layout impact) on web, when ads are disabled, when
 *     no banner unit is configured for the environment, or after a load
 *     failure — so a missing/no-fill ad never leaves an empty gap or shifts UI.
 *   • The native module is lazily `require`d inside an effect (never imported
 *     at module top-level) so bundling for web / loading in Expo Go can't throw.
 *   • Every SDK callback is wrapped; failures schedule a jittered exponential
 *     backoff retry (by remounting via a key) up to a small cap, then give up
 *     silently.
 *   • Impression-level revenue (onPaid) and lifecycle events are reported to
 *     ad telemetry.
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

interface AdBannerModule {
  BannerAd: React.ComponentType<Record<string, unknown>>;
  BannerAdSize: Record<string, string>;
  TestIds: Record<string, string>;
}

const MAX_RETRIES = 4;

interface AdBannerProps {
  /** Optional wrapper style (e.g. margins). The banner itself is centered. */
  style?: ViewStyle;
  /** Set false to force-disable this specific placement. */
  enabled?: boolean;
}

/** Lazily obtain the native module; resolves null if unavailable (e.g. web). */
async function loadModule(): Promise<AdBannerModule | null> {
  try {
    const mod = await import("react-native-google-mobile-ads");
    if (!mod?.BannerAd) return null;
    return {
      BannerAd: mod.BannerAd as unknown as React.ComponentType<Record<string, unknown>>,
      BannerAdSize: mod.BannerAdSize as unknown as Record<string, string>,
      TestIds: mod.TestIds,
    };
  } catch {
    return null;
  }
}

export function AdBanner({ style, enabled = true }: AdBannerProps): React.ReactElement | null {
  const [mod, setMod] = useState<AdBannerModule | null>(null);
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const attemptRef = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const active = enabled && Platform.OS !== "web" && adsCanRequest();

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void loadModule().then((m) => {
      if (!cancelled) setMod(m);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);

  useEffect(() => {
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  const unitId = useMemo(() => {
    if (!mod) return null;
    return resolveAdUnitId("banner", mod.TestIds?.BANNER ?? "");
  }, [mod]);

  if (!active || !mod || !unitId || failed) return null;

  const { BannerAd, BannerAdSize } = mod;
  const size =
    BannerAdSize?.ANCHORED_ADAPTIVE_BANNER ??
    BannerAdSize?.ADAPTIVE_BANNER ??
    "ANCHORED_ADAPTIVE_BANNER";

  return (
    <View
      style={[{ alignItems: "center", justifyContent: "center" }, style]}
      // Collapse to zero height until the ad actually loads so there is no
      // reserved blank space on no-fill.
      pointerEvents="box-none"
    >
      <BannerAd
        // Remount on retry to force a fresh request.
        key={`banner-${retryKey}`}
        unitId={unitId}
        size={size}
        requestOptions={defaultRequestOptions()}
        onAdLoaded={() => {
          attemptRef.current = 0;
          reportAdEvent("ad_loaded", { format: "banner", adUnitId: unitId });
          reportAdEvent("ad_impression", { format: "banner", adUnitId: unitId });
        }}
        onAdFailedToLoad={(error: Error) => {
          reportAdEvent("ad_load_failed", {
            format: "banner",
            adUnitId: unitId,
            attempt: attemptRef.current,
            errorMessage: error?.message,
          });
          if (attemptRef.current < MAX_RETRIES) {
            const delay = nextBackoffDelay(attemptRef.current);
            attemptRef.current += 1;
            if (retryTimer.current) clearTimeout(retryTimer.current);
            retryTimer.current = setTimeout(() => setRetryKey((k) => k + 1), delay);
          } else {
            // Give up quietly — no reserved space, no crash.
            setFailed(true);
          }
        }}
        onPaid={(event: AdPaidEvent) => {
          reportAdRevenue(event, { format: "banner", adUnitId: unitId });
        }}
        onAdOpened={() => reportAdEvent("ad_opened", { format: "banner" })}
        onAdClosed={() => reportAdEvent("ad_closed", { format: "banner" })}
      />
    </View>
  );
}

export default AdBanner;
