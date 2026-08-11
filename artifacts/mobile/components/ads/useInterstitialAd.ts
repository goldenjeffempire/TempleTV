/**
 * useInterstitialAd — lifecycle-aware interstitial ad hook for Temple TV.
 *
 * Safety contract:
 *   • Never loads or shows during active playback (isPlaybackActive guard).
 *   • Never shows while the app is in the background.
 *   • Frequency-capped: respects FrequencyCapManager rules ("interstitial").
 *   • Exponential backoff on load failures (up to MAX_RETRIES attempts).
 *   • ILRD (Impression-Level Revenue): reportAdRevenue fires on every paid event.
 *   • All SDK callbacks are wrapped — failures never crash the caller.
 *   • Graceful no-op on web, in Expo Go, or when no ad unit is configured.
 *
 * Usage:
 *   const { isLoaded, show } = useInterstitialAd({ isPlaybackActive });
 *   // Call show() at a safe navigation moment (e.g. after video ends, between screens).
 *   // show() returns true if an ad was displayed, false if not ready / suppressed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { resolveAdUnitId } from "@/lib/ads/adConfig";
import { adsCanRequest, defaultRequestOptions } from "@/services/ads/mobileAds";
import {
  reportAdEvent,
  reportAdRevenue,
  type AdPaidEvent,
} from "@/lib/ads/adTelemetry";
import { FrequencyCapper, nextBackoffDelay } from "@/lib/ads/adFrequency";

const MAX_RETRIES = 5;

// Module-level frequency cap shared across all hook instances so concurrent
// mounts in different screens still respect the same cap.
const _cap = new FrequencyCapper({
  interstitial: { cooldownMs: 5 * 60 * 1_000, maxPerSession: 4 },
});

interface InterstitialAdModule {
  InterstitialAd: {
    createForAdRequest: (
      unitId: string,
      opts?: Record<string, unknown>,
    ) => InterstitialAdInstance;
  };
  AdEventType: Record<string, string>;
  TestIds: Record<string, string>;
}

interface InterstitialAdInstance {
  addAdEventListener: (
    event: string,
    handler: (e?: unknown) => void,
  ) => () => void;
  load: () => void;
  show: () => void;
  loaded: boolean;
}

async function loadModule(): Promise<InterstitialAdModule | null> {
  try {
    const mod = await import("react-native-google-mobile-ads");
    if (!mod?.InterstitialAd || !mod?.AdEventType) return null;
    return mod as unknown as InterstitialAdModule;
  } catch {
    return null;
  }
}

interface UseInterstitialAdOptions {
  /** When true, suppress loading and showing (live broadcast playback). */
  isPlaybackActive?: boolean;
}

interface UseInterstitialAdResult {
  /** True when an ad is loaded and ready to be shown. */
  isLoaded: boolean;
  /**
   * Show the interstitial. Returns true if the ad was shown, false otherwise.
   * Never throws.
   */
  show: () => boolean;
}

export function useInterstitialAd({
  isPlaybackActive = false,
}: UseInterstitialAdOptions = {}): UseInterstitialAdResult {
  const [mod, setMod] = useState<InterstitialAdModule | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const adRef = useRef<InterstitialAdInstance | null>(null);
  const cleanupRef = useRef<Array<() => void>>([]);
  const attemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const unitIdRef = useRef<string | null>(null);

  // ── Load native module once ──────────────────────────────────────────────
  useEffect(() => {
    if (Platform.OS === "web") return;
    let cancelled = false;
    void loadModule().then((m) => {
      if (!cancelled && isMountedRef.current) setMod(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Resolve ad unit id ───────────────────────────────────────────────────
  useEffect(() => {
    if (!mod) return;
    unitIdRef.current = resolveAdUnitId(
      "interstitial",
      mod.TestIds?.INTERSTITIAL ?? "",
    );
  }, [mod]);

  // ── Create + load ad instance ────────────────────────────────────────────
  const loadAd = useCallback(() => {
    const m = mod;
    const unitId = unitIdRef.current;
    if (!m || !unitId || !adsCanRequest() || isPlaybackActive) return;

    // Tear down previous instance + listeners.
    cleanupRef.current.forEach((fn) => fn());
    cleanupRef.current = [];
    adRef.current = null;
    setIsLoaded(false);

    try {
      const ad = m.InterstitialAd.createForAdRequest(
        unitId,
        defaultRequestOptions(),
      );
      adRef.current = ad;

      const unLoaded = ad.addAdEventListener(m.AdEventType.LOADED ?? "loaded", () => {
        if (!isMountedRef.current) return;
        attemptRef.current = 0;
        setIsLoaded(true);
        reportAdEvent("ad_loaded", { format: "interstitial", adUnitId: unitId });
      });

      const unClosed = ad.addAdEventListener(m.AdEventType.CLOSED ?? "closed", () => {
        if (!isMountedRef.current) return;
        setIsLoaded(false);
        adRef.current = null;
        // Preload next ad for the next navigation moment.
        retryTimerRef.current = setTimeout(() => {
          if (isMountedRef.current) loadAd();
        }, 500);
      });

      const unOpened = ad.addAdEventListener(m.AdEventType.OPENED ?? "opened", () => {
        reportAdEvent("ad_opened", { format: "interstitial", adUnitId: unitId });
      });

      const unClicked = ad.addAdEventListener(
        m.AdEventType.CLICKED ?? "clicked",
        () => {
          reportAdEvent("ad_clicked", {
            format: "interstitial",
            adUnitId: unitId,
          });
        },
      );

      // ILRD — paid event (revenue callback).
      const unPaid = ad.addAdEventListener(
        "paid" as string,
        (e?: unknown) => {
          if (e) {
            reportAdRevenue(e as AdPaidEvent, {
              format: "interstitial",
              adUnitId: unitId,
            });
          }
        },
      );

      const unError = ad.addAdEventListener(
        m.AdEventType.ERROR ?? "error",
        (e?: unknown) => {
          if (!isMountedRef.current) return;
          setIsLoaded(false);
          adRef.current = null;
          const errorMessage =
            e instanceof Error ? e.message : String(e ?? "unknown");
          reportAdEvent("ad_load_failed", {
            format: "interstitial",
            adUnitId: unitId,
            attempt: attemptRef.current,
            errorMessage,
          });
          // Retry with exponential backoff.
          if (attemptRef.current < MAX_RETRIES) {
            const delay = nextBackoffDelay(attemptRef.current);
            attemptRef.current += 1;
            retryTimerRef.current = setTimeout(() => {
              if (isMountedRef.current) loadAd();
            }, delay);
          }
        },
      );

      cleanupRef.current = [unLoaded, unClosed, unOpened, unClicked, unPaid, unError];

      reportAdEvent("ad_requested", { format: "interstitial", adUnitId: unitId });
      ad.load();
    } catch (err) {
      reportAdEvent("ad_load_failed", {
        format: "interstitial",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }, [mod, isPlaybackActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Trigger load when module resolves and playback is inactive.
  useEffect(() => {
    if (!mod || !adsCanRequest() || isPlaybackActive) return;
    loadAd();
  }, [mod, isPlaybackActive, loadAd]);

  // ── Cleanup on unmount ───────────────────────────────────────────────────
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      cleanupRef.current.forEach((fn) => fn());
      cleanupRef.current = [];
      adRef.current = null;
    };
  }, []);

  // ── Show function ────────────────────────────────────────────────────────
  const show = useCallback((): boolean => {
    if (!isLoaded || !adRef.current) return false;
    if (isPlaybackActive) return false;
    if (AppState.currentState !== "active") return false;
    if (!adsCanRequest()) return false;
    if (!_cap.canShow("interstitial")) return false;

    try {
      _cap.markShown("interstitial");
      reportAdEvent("ad_impression", {
        format: "interstitial",
        adUnitId: unitIdRef.current ?? undefined,
      });
      adRef.current.show();
      return true;
    } catch (err) {
      reportAdEvent("ad_show_failed", {
        format: "interstitial",
        adUnitId: unitIdRef.current ?? undefined,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      // Reset so the next load attempt can succeed.
      setIsLoaded(false);
      adRef.current = null;
      return false;
    }
  }, [isLoaded, isPlaybackActive]);

  return { isLoaded, show };
}
