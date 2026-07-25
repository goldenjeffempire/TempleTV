/**
 * useRewardedAd / useRewardedInterstitialAd — opt-in rewarded ad hooks.
 *
 * Rewarded formats are ONLY ever shown as a result of an explicit user action
 * (e.g. "watch an ad to unlock X"), never automatically, so they can never
 * interrupt live playback or navigation. These hooks add preloading, jittered
 * backoff retry, reward delivery, and ILRD revenue reporting on top of the
 * SDK's own hooks.
 *
 * Usage:
 *   const { isLoaded, showReward } = useTempleRewardedAd();
 *   <Button disabled={!isLoaded} onPress={() => showReward(() => grantReward())} />
 */

import { useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import {
  useRewardedAd,
  useRewardedInterstitialAd,
  TestIds,
} from "react-native-google-mobile-ads";
import { resolveAdUnitId, type AdFormat } from "@/lib/ads/adConfig";
import { adsCanRequest, defaultRequestOptions } from "@/services/ads/mobileAds";
import { nextBackoffDelay } from "@/lib/ads/adFrequency";
import {
  reportAdEvent,
  reportAdRevenue,
  type AdPaidEvent,
} from "@/lib/ads/adTelemetry";

interface RewardedControllerResult {
  isLoaded: boolean;
  isEarnedReward: boolean;
  /** Show the ad; `onEarned` fires only if the user actually earns the reward. */
  showReward: (onEarned?: (reward?: { type: string; amount: number }) => void) => void;
}

type AdHook = {
  isLoaded: boolean;
  isClosed: boolean;
  isEarnedReward?: boolean;
  reward?: { type: string; amount: number };
  error?: Error;
  revenue?: AdPaidEvent;
  load: () => void;
  show: () => void;
};

function useRewardedController(
  ad: AdHook,
  format: AdFormat,
  unitId: string | null,
): RewardedControllerResult {
  const attemptRef = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEarnedRef = useRef<((reward?: { type: string; amount: number }) => void) | null>(null);
  const lastRevenueRef = useRef<AdPaidEvent | null>(null);
  const rewardHandledRef = useRef(false);

  // Preload.
  useEffect(() => {
    if (!unitId || !adsCanRequest()) return;
    ad.load();
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitId]);

  // Reload after close.
  useEffect(() => {
    if (!unitId || !adsCanRequest()) return;
    if (ad.isClosed) {
      attemptRef.current = 0;
      rewardHandledRef.current = false;
      ad.load();
      reportAdEvent("ad_closed", { format, adUnitId: unitId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ad.isClosed, unitId]);

  // Backoff on error.
  useEffect(() => {
    if (!unitId || !ad.error) return;
    reportAdEvent("ad_load_failed", {
      format,
      adUnitId: unitId,
      attempt: attemptRef.current,
      errorMessage: ad.error.message,
    });
    const delay = nextBackoffDelay(attemptRef.current);
    attemptRef.current += 1;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => ad.load(), delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ad.error, unitId]);

  // Deliver reward exactly once.
  useEffect(() => {
    if (ad.isEarnedReward && !rewardHandledRef.current) {
      rewardHandledRef.current = true;
      reportAdEvent("ad_reward_earned", {
        format,
        adUnitId: unitId ?? undefined,
        rewardType: ad.reward?.type,
        rewardAmount: ad.reward?.amount,
      });
      try {
        onEarnedRef.current?.(ad.reward);
      } catch {
        /* consumer callback must never crash the ad flow */
      }
    }
  }, [ad.isEarnedReward, ad.reward, format, unitId]);

  // ILRD revenue.
  useEffect(() => {
    if (ad.revenue && ad.revenue !== lastRevenueRef.current) {
      lastRevenueRef.current = ad.revenue;
      reportAdRevenue(ad.revenue, { format, adUnitId: unitId ?? undefined });
    }
  }, [ad.revenue, format, unitId]);

  const showReward = useCallback(
    (onEarned?: (reward?: { type: string; amount: number }) => void) => {
      if (!unitId || !adsCanRequest() || !ad.isLoaded) return;
      onEarnedRef.current = onEarned ?? null;
      try {
        reportAdEvent("ad_opened", { format, adUnitId: unitId });
        ad.show();
      } catch (e) {
        reportAdEvent("ad_show_failed", {
          format,
          adUnitId: unitId,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [ad, format, unitId],
  );

  return {
    isLoaded: !!ad.isLoaded,
    isEarnedReward: !!ad.isEarnedReward,
    showReward,
  };
}

/** Standard rewarded video ad. */
export function useTempleRewardedAd(): RewardedControllerResult {
  const unitId =
    Platform.OS === "web" ? null : resolveAdUnitId("rewarded", TestIds.REWARDED);
  const ad = useRewardedAd(unitId, defaultRequestOptions());
  return useRewardedController(ad as unknown as AdHook, "rewarded", unitId);
}

/** Rewarded interstitial (shown at a transition, still opt-in via a prompt). */
export function useTempleRewardedInterstitialAd(): RewardedControllerResult {
  const unitId =
    Platform.OS === "web"
      ? null
      : resolveAdUnitId("rewardedInterstitial", TestIds.REWARDED_INTERSTITIAL);
  const ad = useRewardedInterstitialAd(unitId, defaultRequestOptions());
  return useRewardedController(ad as unknown as AdHook, "rewardedInterstitial", unitId);
}
