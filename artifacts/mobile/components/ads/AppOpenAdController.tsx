/**
 * AppOpenAdController — shows a Google App Open ad when the user brings the app
 * back to the foreground, NEVER on cold start and NEVER while blocked (e.g.
 * during live playback). Renders nothing; the ad is a native full-screen
 * overlay managed by the SDK.
 *
 * Guards:
 *   • web / ads-disabled / no-unit-configured → completely inert (adUnitId null).
 *   • Only shows after the app has actually been backgrounded once, so it can
 *     never appear over the splash screen or interrupt initial navigation.
 *   • `isBlocked` (passed by the caller when a live player/radio is active)
 *     suppresses the ad so it can never interrupt live TV or restart playback.
 *   • Frequency-capped (module-level, survives remounts) and backoff-retried.
 */

import { useEffect, useRef } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";
import { useAppOpenAd, TestIds } from "react-native-google-mobile-ads";
import { resolveAdUnitId } from "@/lib/ads/adConfig";
import { adsCanRequest, defaultRequestOptions } from "@/services/ads/mobileAds";
import { FrequencyCapper, nextBackoffDelay } from "@/lib/ads/adFrequency";
import {
  reportAdEvent,
  reportAdRevenue,
  type AdPaidEvent,
} from "@/lib/ads/adTelemetry";

// Module-level so the cap survives component remounts within a session.
//
// Policy: App Open ads must not be shown more often than once per 30 minutes.
// Google's own guidelines recommend at least 4 hours between impressions for
// general-audience apps, but 30 minutes is the floor we enforce in code.
// maxPerSession: 6 caps total daily exposure (30 min × 6 = 3 h minimum spread
// across a full day's usage) while still allowing reasonable foreground-resume
// coverage for users who open the app frequently.
const capper = new FrequencyCapper({
  appOpen: { cooldownMs: 30 * 60 * 1_000, maxPerSession: 6 },
});

interface AppOpenAdControllerProps {
  /** True when a live player / radio is active — suppresses the ad. */
  isBlocked?: boolean;
}

export function AppOpenAdController({ isBlocked = false }: AppOpenAdControllerProps): null {
  const unitId =
    Platform.OS === "web" ? null : resolveAdUnitId("appOpen", TestIds.APP_OPEN);

  const { isLoaded, isClosed, error, revenue, load, show } = useAppOpenAd(
    unitId,
    defaultRequestOptions(),
  );

  const attemptRef = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasBackgroundedRef = useRef(false);
  const lastAppState = useRef<AppStateStatus>(AppState.currentState);
  const lastRevenueRef = useRef<AdPaidEvent | null>(null);

  // Initial preload.
  useEffect(() => {
    if (!unitId || !adsCanRequest()) return;
    load();
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitId]);

  // Reload after close so the next foreground has an ad ready.
  useEffect(() => {
    if (!unitId || !adsCanRequest()) return;
    if (isClosed) {
      attemptRef.current = 0;
      load();
      reportAdEvent("ad_closed", { format: "app_open", adUnitId: unitId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClosed, unitId]);

  // Backoff retry on load error.
  useEffect(() => {
    if (!unitId || !error) return;
    reportAdEvent("ad_load_failed", {
      format: "app_open",
      adUnitId: unitId,
      attempt: attemptRef.current,
      errorMessage: error.message,
    });
    const delay = nextBackoffDelay(attemptRef.current);
    attemptRef.current += 1;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => load(), delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, unitId]);

  // Report impression-level revenue exactly once per paid event.
  useEffect(() => {
    if (revenue && revenue !== lastRevenueRef.current) {
      lastRevenueRef.current = revenue as AdPaidEvent;
      reportAdRevenue(revenue as AdPaidEvent, { format: "app_open", adUnitId: unitId ?? undefined });
    }
  }, [revenue, unitId]);

  // Foreground → maybe show.
  useEffect(() => {
    if (!unitId) return;
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      const prev = lastAppState.current;
      lastAppState.current = next;

      if (next === "background" || next === "inactive") {
        hasBackgroundedRef.current = true;
        return;
      }
      // Returning to foreground.
      if (prev !== "active" && next === "active") {
        if (!hasBackgroundedRef.current) return; // never on first cold foreground
        if (isBlocked) return; // never over live playback
        if (!adsCanRequest()) return;
        if (!isLoaded) return;
        if (!capper.canShow("appOpen")) return;
        try {
          capper.markShown("appOpen");
          reportAdEvent("ad_opened", { format: "app_open", adUnitId: unitId });
          show();
        } catch (e) {
          reportAdEvent("ad_show_failed", {
            format: "app_open",
            adUnitId: unitId,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
        }
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitId, isBlocked, isLoaded, show]);

  return null;
}

export default AppOpenAdController;
