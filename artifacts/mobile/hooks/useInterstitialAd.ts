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
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useInterstitialAd, TestIds } from "react-native-google-mobile-ads";

// GAM_INTERSTITIAL is the test ID for Google Ad Manager interstitials.
// TestIds.INTERSTITIAL (AdMob) is an empty string — do NOT use it for GAM.
const GAM_TEST_INTERSTITIAL_ID = TestIds.GAM_INTERSTITIAL;

// ── Configuration ─────────────────────────────────────────────────────────────

const PROD_AD_UNIT_ID =
  process.env.EXPO_PUBLIC_GAM_INTERSTITIAL_AD_UNIT_ID ?? "";

/** The ad unit ID resolved for the current environment. */
const AD_UNIT_ID = __DEV__ ? GAM_TEST_INTERSTITIAL_ID : PROD_AD_UNIT_ID;

/** Minimum milliseconds between interstitial impressions. */
const AD_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/**
 * AsyncStorage key persisting the last impression time so the 30-minute
 * frequency cap survives app restarts (a session-only cap lets a user who
 * relaunches the app see an ad every time).
 */
const LAST_SHOWN_STORAGE_KEY = "ads:interstitial:lastShownAt";

/** Load-failure retry backoff schedule (ms). Resets on successful load. */
const LOAD_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000];

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
  const { isLoaded, isClosed, error, load, show } = useInterstitialAd(
    adUnitId ?? "",
    {
      // Honour GDPR/CCPA consent signals from the UMP SDK (see MobileAds
      // initialization in app/_layout.tsx) before this request is made.
      requestNonPersonalizedAdsOnly: false,
    },
  );

  // ── Persistent frequency cap ──────────────────────────────────────────────
  // Hydrated from AsyncStorage on mount so the cooldown survives app
  // restarts. Until hydration finishes, the cap conservatively blocks ads
  // (capHydratedRef=false) — worst case an ad shows a few hundred ms late.
  const lastShownAtRef = useRef<number | null>(null);
  const capHydratedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(LAST_SHOWN_STORAGE_KEY);
        if (!cancelled && raw) {
          const parsed = Number(raw);
          if (Number.isFinite(parsed) && parsed > 0) {
            // Keep the more restrictive of persisted vs in-memory value.
            lastShownAtRef.current = Math.max(lastShownAtRef.current ?? 0, parsed);
          }
        }
      } catch {
        // Storage unavailable — fall back to session-only capping.
      } finally {
        if (!cancelled) capHydratedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── State tracking refs ───────────────────────────────────────────────────
  const prevActiveBufferIdRef = useRef<"A" | "B">(activeBufferId);
  const prevBroadcastStateRef = useRef<string>(broadcastState);
  const hasShownFirstAdRef = useRef(false);

  // ── Initial ad load ───────────────────────────────────────────────────────
  // Load the first ad as soon as the hook is enabled and a valid unit ID is
  // configured. The ad loads in the background; the first impression fires
  // only when a natural break point is detected (see effect below).
  useEffect(() => {
    if (!enabled || !adUnitId) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, adUnitId]);

  // ── Reload after close ────────────────────────────────────────────────────
  // Pre-load the next interstitial immediately after the current one is
  // dismissed so the next break never has to wait for a cold load.
  useEffect(() => {
    if (!enabled || !adUnitId) return;
    if (isClosed) {
      retryAttemptRef.current = 0;
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClosed, enabled, adUnitId]);

  // ── Load-failure retry with backoff ──────────────────────────────────────
  // "No fill" and transient network errors are routine; retry on a bounded
  // exponential schedule instead of leaving the slot empty until the next
  // ad close. The attempt counter resets whenever an ad loads successfully.
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isLoaded) {
      retryAttemptRef.current = 0;
    }
  }, [isLoaded]);

  useEffect(() => {
    if (!enabled || !adUnitId || !error) return;
    const attempt = retryAttemptRef.current;
    if (attempt >= LOAD_RETRY_DELAYS_MS.length) return; // give up until next close
    const delay = LOAD_RETRY_DELAYS_MS[attempt];
    retryAttemptRef.current = attempt + 1;
    if (__DEV__) {
      console.warn(
        `[useInterstitialAd] load failed (attempt ${attempt + 1}), retrying in ${delay}ms:`,
        error?.message ?? error,
      );
    }
    retryTimerRef.current = setTimeout(() => {
      try {
        load();
      } catch {
        // Non-fatal — next error event re-arms the schedule.
      }
    }, delay);
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, enabled, adUnitId]);

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

    // Gate: frequency cap (blocked until persisted value hydrates).
    if (!capHydratedRef.current) return;
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
    // Persist for the cross-restart frequency cap (fire-and-forget).
    AsyncStorage.setItem(
      LAST_SHOWN_STORAGE_KEY,
      String(lastShownAtRef.current),
    ).catch(() => {});

    try {
      // v16 hook show() is synchronous (returns void); failures surface via
      // the hook's `error` field or a thrown exception.
      show();
    } catch (err: unknown) {
      // SDK failed to show (ad expired, dismissed before show, etc.).
      // This is non-fatal — the broadcast continues normally.
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
