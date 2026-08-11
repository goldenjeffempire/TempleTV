/**
 * useRewardedAd — lifecycle-aware rewarded ad hook for Temple TV.
 *
 * Rewarded ads earn the user a reward (e.g. unlocking a premium sermon) in
 * exchange for watching a full ad. They are opt-in only — never auto-shown.
 *
 * Safety contract (same as useInterstitialAd):
 *   • Never shows during active playback.
 *   • Never shows while backgrounded.
 *   • Frequency-capped (1 per 15 minutes, max 3 per session).
 *   • Exponential backoff on load failures.
 *   • ILRD callbacks on every paid event.
 *   • All SDK callbacks are wrapped — failures never crash the caller.
 *   • Graceful no-op on web / Expo Go / no unit configured.
 *
 * Usage:
 *   const { isLoaded, show } = useRewardedAd({ isPlaybackActive });
 *   // show() returns { earned: true, type, amount } | null
 *   // Caller must handle null (not shown) gracefully.
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

const _cap = new FrequencyCapper({
  rewarded: { cooldownMs: 15 * 60 * 1_000, maxPerSession: 3 },
});

export interface RewardItem {
  type: string;
  amount: number;
}

interface RewardedAdModule {
  RewardedAd: {
    createForAdRequest: (
      unitId: string,
      opts?: Record<string, unknown>,
    ) => RewardedAdInstance;
  };
  AdEventType: Record<string, string>;
  RewardedAdEventType: Record<string, string>;
  TestIds: Record<string, string>;
}

interface RewardedAdInstance {
  addAdEventListener: (
    event: string,
    handler: (e?: unknown) => void,
  ) => () => void;
  load: () => void;
  show: () => void;
  loaded: boolean;
}

async function loadModule(): Promise<RewardedAdModule | null> {
  try {
    const mod = await import("react-native-google-mobile-ads");
    if (!mod?.RewardedAd) return null;
    return mod as unknown as RewardedAdModule;
  } catch {
    return null;
  }
}

interface UseRewardedAdOptions {
  isPlaybackActive?: boolean;
  /** Called when the user earns the reward. */
  onEarnedReward?: (reward: RewardItem) => void;
}

interface UseRewardedAdResult {
  isLoaded: boolean;
  /** Returns true if the ad was shown. */
  show: () => boolean;
}

export function useRewardedAd({
  isPlaybackActive = false,
  onEarnedReward,
}: UseRewardedAdOptions = {}): UseRewardedAdResult {
  const [mod, setMod] = useState<RewardedAdModule | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const adRef = useRef<RewardedAdInstance | null>(null);
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
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!mod) return;
    unitIdRef.current = resolveAdUnitId("rewarded", mod.TestIds?.REWARDED ?? "");
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
      const ad = m.RewardedAd.createForAdRequest(unitId, defaultRequestOptions());
      adRef.current = ad;

      const unLoaded = ad.addAdEventListener(m.AdEventType.LOADED ?? "loaded", () => {
        if (!isMountedRef.current) return;
        attemptRef.current = 0;
        setIsLoaded(true);
        reportAdEvent("ad_loaded", { format: "rewarded", adUnitId: unitId });
      });

      const unClosed = ad.addAdEventListener(m.AdEventType.CLOSED ?? "closed", () => {
        if (!isMountedRef.current) return;
        setIsLoaded(false);
        adRef.current = null;
        retryTimerRef.current = setTimeout(() => {
          if (isMountedRef.current) loadAd();
        }, 1_000);
      });

      // Reward earned callback.
      const rewardEvent =
        m.RewardedAdEventType?.EARNED_REWARD ?? "rewardedAdUserEarnedReward";
      const unReward = ad.addAdEventListener(rewardEvent, (e?: unknown) => {
        const reward = e as RewardItem | undefined;
        if (reward) {
          reportAdEvent("ad_reward_earned", {
            format: "rewarded",
            adUnitId: unitId,
            rewardType: reward.type,
            rewardAmount: reward.amount,
          });
          try {
            onEarnedRef.current?.(reward);
          } catch {
            /* callback errors must not propagate */
          }
        }
      });

      const unPaid = ad.addAdEventListener("paid" as string, (e?: unknown) => {
        if (e) reportAdRevenue(e as AdPaidEvent, { format: "rewarded", adUnitId: unitId });
      });

      const unError = ad.addAdEventListener(
        m.AdEventType.ERROR ?? "error",
        (e?: unknown) => {
          if (!isMountedRef.current) return;
          setIsLoaded(false);
          adRef.current = null;
          const msg = e instanceof Error ? e.message : String(e ?? "unknown");
          reportAdEvent("ad_load_failed", {
            format: "rewarded",
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
        },
      );

      cleanupRef.current = [unLoaded, unClosed, unReward, unPaid, unError];
      reportAdEvent("ad_requested", { format: "rewarded", adUnitId: unitId });
      ad.load();
    } catch (err) {
      reportAdEvent("ad_load_failed", {
        format: "rewarded",
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
    if (!_cap.canShow("rewarded")) return false;

    try {
      _cap.markShown("rewarded");
      reportAdEvent("ad_impression", {
        format: "rewarded",
        adUnitId: unitIdRef.current ?? undefined,
      });
      adRef.current.show();
      return true;
    } catch (err) {
      reportAdEvent("ad_show_failed", {
        format: "rewarded",
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
