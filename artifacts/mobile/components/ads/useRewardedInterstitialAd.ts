/**
 * useRewardedInterstitialAd — rewarded interstitial ad hook for Temple TV.
 *
 * Rewarded interstitial ads are shown without requiring user opt-in (they
 * appear automatically at natural content breaks) but still deliver a reward.
 * They must be used sparingly and never block navigation or interrupt playback.
 *
 * Frequency cap: 1 per 20 minutes, max 2 per session — more conservative than
 * plain interstitials because they are shown automatically rather than opt-in.
 *
 * Otherwise same safety contract as useInterstitialAd / useRewardedAd.
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
import {
  FrequencyCapper,
  nextBackoffDelay,
} from "@/lib/ads/adFrequency";
import type { RewardItem } from "./useRewardedAd";

const MAX_RETRIES = 5;

const _cap = new FrequencyCapper({
  rewardedInterstitial: { cooldownMs: 20 * 60 * 1_000, maxPerSession: 2 },
});

interface RewardedInterstitialModule {
  RewardedInterstitialAd: {
    createForAdRequest: (
      unitId: string,
      opts?: Record<string, unknown>,
    ) => RewardedInterstitialInstance;
  };
  AdEventType: Record<string, string>;
  RewardedAdEventType: Record<string, string>;
  TestIds: Record<string, string>;
}

interface RewardedInterstitialInstance {
  addAdEventListener: (
    event: string,
    handler: (e?: unknown) => void,
  ) => () => void;
  load: () => void;
  show: () => void;
  loaded: boolean;
}

async function loadModule(): Promise<RewardedInterstitialModule | null> {
  try {
    const mod = await import("react-native-google-mobile-ads");
    if (!mod?.RewardedInterstitialAd) return null;
    return mod as unknown as RewardedInterstitialModule;
  } catch {
    return null;
  }
}

interface UseRewardedInterstitialAdOptions {
  isPlaybackActive?: boolean;
  onEarnedReward?: (reward: RewardItem) => void;
}

interface UseRewardedInterstitialAdResult {
  isLoaded: boolean;
  show: () => boolean;
}

export function useRewardedInterstitialAd({
  isPlaybackActive = false,
  onEarnedReward,
}: UseRewardedInterstitialAdOptions = {}): UseRewardedInterstitialAdResult {
  const [mod, setMod] = useState<RewardedInterstitialModule | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const adRef = useRef<RewardedInterstitialInstance | null>(null);
  const cleanupRef = useRef<Array<() => void>>([]);
  const attemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const unitIdRef = useRef<string | null>(null);
  const onEarnedRef = useRef(onEarnedReward);
  onEarnedRef.current = onEarnedReward;

  useEffect(() => {
    if (Platform.OS === "web") return;
    let cancelled = false;
    void loadModule().then((m) => {
      if (!cancelled && isMountedRef.current) setMod(m);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!mod) return;
    unitIdRef.current = resolveAdUnitId(
      "rewardedInterstitial",
      mod.TestIds?.REWARDED_INTERSTITIAL ?? "",
    );
  }, [mod]);

  const loadAd = useCallback(() => {
    const m = mod;
    const unitId = unitIdRef.current;
    if (!m || !unitId || !adsCanRequest() || isPlaybackActive) return;

    cleanupRef.current.forEach((fn) => fn());
    cleanupRef.current = [];
    adRef.current = null;
    setIsLoaded(false);

    try {
      const ad = m.RewardedInterstitialAd.createForAdRequest(
        unitId,
        defaultRequestOptions(),
      );
      adRef.current = ad;

      const unLoaded = ad.addAdEventListener(m.AdEventType.LOADED, () => {
        if (!isMountedRef.current) return;
        attemptRef.current = 0;
        setIsLoaded(true);
        reportAdEvent("ad_loaded", { format: "rewardedInterstitial", adUnitId: unitId });
      });

      const unClosed = ad.addAdEventListener(m.AdEventType.CLOSED, () => {
        if (!isMountedRef.current) return;
        setIsLoaded(false);
        adRef.current = null;
        retryTimerRef.current = setTimeout(() => {
          if (isMountedRef.current) loadAd();
        }, 1_000);
      });

      const rewardEvent =
        m.RewardedAdEventType?.EARNED_REWARD ?? "rewardedAdUserEarnedReward";
      const unReward = ad.addAdEventListener(rewardEvent, (e?: unknown) => {
        const reward = e as RewardItem | undefined;
        if (reward) {
          reportAdEvent("ad_reward_earned", {
            format: "rewardedInterstitial",
            adUnitId: unitId,
            rewardType: reward.type,
            rewardAmount: reward.amount,
          });
          try { onEarnedRef.current?.(reward); } catch { /* */ }
        }
      });

      const unPaid = ad.addAdEventListener("paid" as string, (e?: unknown) => {
        if (e) reportAdRevenue(e as AdPaidEvent, { format: "rewardedInterstitial", adUnitId: unitId });
      });

      const unError = ad.addAdEventListener(m.AdEventType.ERROR ?? "error", (e?: unknown) => {
        if (!isMountedRef.current) return;
        setIsLoaded(false);
        adRef.current = null;
        const msg = e instanceof Error ? e.message : String(e ?? "unknown");
        reportAdEvent("ad_load_failed", {
          format: "rewardedInterstitial",
          adUnitId: unitId,
          attempt: attemptRef.current,
          errorMessage: msg,
        });
        if (attemptRef.current < MAX_RETRIES) {
          const delay = nextBackoffDelay(attemptRef.current);
          attemptRef.current += 1;
          retryTimerRef.current = setTimeout(() => {
            if (isMountedRef.current) loadAd();
          }, delay);
        }
      });

      cleanupRef.current = [unLoaded, unClosed, unReward, unPaid, unError];
      reportAdEvent("ad_requested", { format: "rewardedInterstitial", adUnitId: unitId });
      ad.load();
    } catch (err) {
      reportAdEvent("ad_load_failed", {
        format: "rewardedInterstitial",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }, [mod, isPlaybackActive]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mod || !adsCanRequest() || isPlaybackActive) return;
    loadAd();
  }, [mod, isPlaybackActive, loadAd]);

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

  const show = useCallback((): boolean => {
    if (!isLoaded || !adRef.current) return false;
    if (isPlaybackActive) return false;
    if (AppState.currentState !== "active") return false;
    if (!adsCanRequest()) return false;
    if (!_cap.canShow("rewardedInterstitial")) return false;

    try {
      _cap.markShown("rewardedInterstitial");
      reportAdEvent("ad_impression", {
        format: "rewardedInterstitial",
        adUnitId: unitIdRef.current ?? undefined,
      });
      adRef.current.show();
      return true;
    } catch (err) {
      reportAdEvent("ad_show_failed", {
        format: "rewardedInterstitial",
        adUnitId: unitIdRef.current ?? undefined,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      setIsLoaded(false);
      adRef.current = null;
      return false;
    }
  }, [isLoaded, isPlaybackActive]);

  return { isLoaded, show };
}
