/**
 * useInterstitialAd — Google Ad Manager interstitial ad hook for the
 * Temple TV mobile broadcast player.
 *
 * Integration strategy for a 24/7 live broadcast:
 *   • Shows an interstitial on first PLAYING state (preroll-like experience).
 *   • Also shows an interstitial when the active buffer swaps (i.e. when the
 *     broadcast transitions to a new queue item) — this is the natural break
 *     point between sermon/worship segments.
 *   • Frequency cap: no more than once per 30 minutes per session (stored in
 *     a module-level ref, not persisted across app restarts).
 *   • Gracefully no-ops when EXPO_PUBLIC_GAM_INTERSTITIAL_AD_UNIT_ID is not
 *     set or when running in development with test mode disabled.
 *   • Automatically pre-loads the next interstitial immediately after an ad
 *     closes so the next break never waits.
 *   • Never shows during loading states (BOOTSTRAP, SYNCING, etc.) or while
 *     a YouTube live override is active.
 *
 * Configuration:
 *   Set EXPO_PUBLIC_GAM_INTERSTITIAL_AD_UNIT_ID in your EAS secrets / .env:
 *     ca-app-pub-XXXXXXXXXXXXXXXX/YYYYYYYYYY
 *
 *   In development (__DEV__ = true), the hook uses Google's test interstitial
 *   ID which always fills, so you can verify the integration without a real
 *   GAM account.
 */

import { useEffect, useRef } from "react";
import { useInterstitialAd, TestIds } from "react-native-google-mobile-ads";
import { resolveAdUnitId } from "@/lib/ads/adConfig";
import { adsCanRequest, defaultRequestOptions } from "@/services/ads/mobileAds";
import { nextBackoffDelay } from "@/lib/ads/adFrequency";
import {
  reportAdEvent,
  reportAdRevenue,
  type AdPaidEvent,
} from "@/lib/ads/adTelemetry";

/**
 * The ad unit ID resolved for the current environment via the central ad
 * config. In DEBUG this is Google's GAM interstitial test id (always fills);
 * in RELEASE it is EXPO_PUBLIC_GAM_INTERSTITIAL_AD_UNIT_ID (null/disabled when
 * not provisioned). `resolveAdUnitId` also honours the global ads kill-switch.
 */
const AD_UNIT_ID = resolveAdUnitId("gamInterstitial", TestIds.GAM_INTERSTITIAL) ?? "";

/** Minimum milliseconds between interstitial impressions. */
const AD_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/** FSM states where ads must never be shown. */
const NON_PLAYABLE_STATES = new Set([
  "BOOTSTRAP",
  "SYNCING",
  "PREPARING_ACTIVE",
  "RECOVERING_PRIMARY",
  "RECOVERING_FAILOVER",
  "SKIP_PENDING",
  "OFFLINE_HOLD",
  "LIVE_OVERRIDE_ACTIVE",
  "FATAL",
]);

// ── Hook ──────────────────────────────────────────────────────────────────────

interface UseBroadcastInterstitialAdOptions {
  /** Current broadcast FSM state string from useV2BroadcastNative. */
  broadcastState: string;
  /** Currently active HLS/MP4 buffer slot ("A" | "B"). */
  activeBufferId: "A" | "B";
  /**
   * True when a YouTube live override is active. Interstitials are suppressed
   * during YouTube overrides — the user is watching a specific live event and
   * an ad break would be inappropriate.
   */
  isYouTubeOverride: boolean;
  /**
   * Set to false to completely disable ad loading (e.g. in the hero/minimal
   * variant or when the player is suppressed). Defaults to true.
   */
  enabled?: boolean;
}

/**
 * Call this hook inside a broadcast player component to request and show
 * Google Ad Manager interstitial ads at natural break points.
 *
 * No return value is needed — the ad is shown by the OS as a full-screen
 * overlay managed entirely by the GAM SDK.
 */
export function useBroadcastInterstitialAd({
  broadcastState,
  activeBufferId,
  isYouTubeOverride,
  enabled = true,
}: UseBroadcastInterstitialAdOptions): void {
  // When no ad unit is configured, this hook is a complete no-op.
  const adUnitId = AD_UNIT_ID || null;

  // useInterstitialAd from react-native-google-mobile-ads.
  // When adUnitId is null / empty we still call the hook (rules of hooks)
  // but the ad will never load — the SDK ignores empty unit IDs gracefully.
  // requestNonPersonalizedAdsOnly is driven by the UMP consent result gathered
  // in services/ads/mobileAds.ts so we stay GDPR/CCPA compliant.
  const { isLoaded, isClosed, error, revenue, load, show } = useInterstitialAd(
    adUnitId ?? "",
    defaultRequestOptions(),
  );

  // Backoff retry on load error.
  const errorAttemptRef = useRef(0);
  const errorRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!enabled || !adUnitId || !error) return;
    reportAdEvent("ad_load_failed", {
      format: "gamInterstitial",
      adUnitId,
      attempt: errorAttemptRef.current,
      errorMessage: error.message,
    });
    const delay = nextBackoffDelay(errorAttemptRef.current);
    errorAttemptRef.current += 1;
    if (errorRetryTimer.current) clearTimeout(errorRetryTimer.current);
    errorRetryTimer.current = setTimeout(() => load(), delay);
    return () => {
      if (errorRetryTimer.current) clearTimeout(errorRetryTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, enabled, adUnitId]);

  // Report impression-level ad revenue (ILRD) once per paid event.
  const lastRevenueRef = useRef<AdPaidEvent | null>(null);
  useEffect(() => {
    if (revenue && revenue !== lastRevenueRef.current) {
      lastRevenueRef.current = revenue as AdPaidEvent;
      reportAdRevenue(revenue as AdPaidEvent, {
        format: "gamInterstitial",
        adUnitId: adUnitId ?? undefined,
      });
    }
  }, [revenue, adUnitId]);

  // ── Session frequency cap ─────────────────────────────────────────────────
  // Use a module-level ref (not state/localStorage) so it survives re-renders
  // but resets on app restart — acceptable for a live broadcast session.
  const lastShownAtRef = useRef<number | null>(null);

  // ── State tracking refs ───────────────────────────────────────────────────
  const prevActiveBufferIdRef = useRef<"A" | "B">(activeBufferId);
  const prevBroadcastStateRef = useRef<string>(broadcastState);
  const hasShownFirstAdRef = useRef(false);

  // ── Initial ad load ───────────────────────────────────────────────────────
  // Load the first ad as soon as the hook is enabled and a valid unit ID is
  // configured. The ad loads in the background; the first impression fires
  // only when a natural break point is detected (see effect below).
  useEffect(() => {
    if (!enabled || !adUnitId || !adsCanRequest()) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, adUnitId]);

  // ── Reload after close ────────────────────────────────────────────────────
  // Pre-load the next interstitial immediately after the current one is
  // dismissed so the next break never has to wait for a cold load.
  useEffect(() => {
    if (!enabled || !adUnitId || !adsCanRequest()) return;
    if (isClosed) {
      errorAttemptRef.current = 0;
      reportAdEvent("ad_closed", { format: "gamInterstitial", adUnitId });
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClosed, enabled, adUnitId]);

  // ── Show trigger ──────────────────────────────────────────────────────────
  // Evaluate whether to show an ad on every relevant state change.
  useEffect(() => {
    const prevState = prevBroadcastStateRef.current;
    const prevBufferId = prevActiveBufferIdRef.current;

    prevBroadcastStateRef.current = broadcastState;
    prevActiveBufferIdRef.current = activeBufferId;

    // Gate: not enabled or no ad unit configured.
    if (!enabled || !adUnitId) return;

    // Gate: ad not loaded yet.
    if (!isLoaded) return;

    // Gate: suppressed states.
    if (NON_PLAYABLE_STATES.has(broadcastState)) return;
    if (isYouTubeOverride) return;
    if (broadcastState !== "PLAYING") return;

    // Gate: frequency cap.
    if (
      lastShownAtRef.current !== null &&
      Date.now() - lastShownAtRef.current < AD_COOLDOWN_MS
    ) {
      return;
    }

    // Trigger 1: First arrival at PLAYING state (preroll-like).
    const isFirstPlaying =
      !hasShownFirstAdRef.current && prevState !== "PLAYING";

    // Trigger 2: Buffer swap = broadcast transitioned to a new queue item.
    const isBufferSwap = prevBufferId !== activeBufferId;

    if (!isFirstPlaying && !isBufferSwap) return;

    // Fire the ad.
    hasShownFirstAdRef.current = true;
    lastShownAtRef.current = Date.now();

    // NOTE: `show()` from useInterstitialAd returns `void` (NOT a Promise).
    // The previous `show().catch(...)` threw "undefined is not an object" at
    // runtime every time an interstitial fired during live playback. Guard
    // with a synchronous try/catch instead — show errors surface via the
    // hook's `error` state, which the backoff effect above handles.
    try {
      reportAdEvent("ad_impression", { format: "gamInterstitial", adUnitId });
      show();
    } catch (err) {
      reportAdEvent("ad_show_failed", {
        format: "gamInterstitial",
        adUnitId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      if (__DEV__) {
        console.warn("[useInterstitialAd] show() failed:", err);
      }
    }
  }, [
    broadcastState,
    activeBufferId,
    isYouTubeOverride,
    enabled,
    adUnitId,
    isLoaded,
    show,
  ]);
}
