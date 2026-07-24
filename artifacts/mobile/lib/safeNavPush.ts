/**
 * safeNavPush / safeNavReplace — production-safe navigation wrappers
 *
 * Every router.push/replace call in the app should go through one of these
 * instead of calling expo-router's `router` directly. They provide:
 *
 *  1. try/catch  — router.push can throw when the navigator is in a transient
 *     bad state (rapid back→push, concurrent navigation, or the navigator not
 *     yet fully attached on a very-fast cold-start tap). Without a catch,
 *     the error propagates to a void async context and is silently dropped.
 *
 *  2. One automatic retry  — After 300 ms. Covers the "navigator not yet
 *     attached" failure mode: the navigator is typically ready within ~100 ms
 *     of the first render, so a single retry after 300 ms reliably succeeds.
 *
 *  3. navLogger telemetry  — Records every attempt/failure as a Sentry
 *     breadcrumb and (on failure) a Sentry exception. Both appear in the
 *     session timeline, making silent navigation failures visible.
 *
 *  4. __DEV__ console logs  — Logged by navLogger; no extra work needed here.
 *
 * Usage:
 *   safeNavPush("/player", { isLive: "true" }, "hero-cta");
 *   safeNavReplace("/", {}, "auth-redirect");
 */

import { router } from "expo-router";
import { navLogger } from "@/lib/navLogger";

export type NavParams = Record<string, string | number | boolean | undefined>;

/**
 * Wraps router.push with error recovery and telemetry.
 *
 * @param pathname  Expo Router pathname (e.g. "/player", "/(tabs)/library")
 * @param params    Route params to pass (string values only — Expo Router
 *                  serialises everything to strings in the URL anyway)
 * @param source    Human-readable tag for logs/Sentry (e.g. "hero-cta",
 *                  "mini-bar", "notification", "live-supervisor")
 */
export function safeNavPush(
  pathname: string,
  params?: NavParams,
  source = "unknown",
): void {
  const startTs = navLogger.logAttempt(pathname, params as Record<string, unknown> | undefined, source);

  const attempt = (n: number): void => {
    try {
      router.push({ pathname: pathname as never, params: params as never });
      // Log success on the same tick. A more accurate "screen mounted"
      // confirmation is emitted by navLogger.logSuccess() inside player.tsx's
      // mount useEffect — this is just the "push did not throw" confirmation.
      navLogger.logSuccess(pathname, startTs, source);
    } catch (err: unknown) {
      navLogger.logFailure(pathname, err, source, n);
      if (n === 1) {
        // Single retry — 300 ms gives the navigator time to settle after a
        // rapid state change (e.g. back gesture resolving) before we try again.
        setTimeout(() => attempt(2), 300);
      }
      // n === 2: both attempts failed. navLogger already captured the exception
      // to Sentry. Surface nothing to the user — the tap simply did not navigate.
      // The user can tap again; the next attempt will succeed once the navigator
      // recovers.
    }
  };

  attempt(1);
}

/**
 * Wraps router.replace with error recovery and telemetry.
 * Same guarantees as safeNavPush but uses replace semantics (no new history entry).
 */
export function safeNavReplace(
  pathname: string,
  params?: NavParams,
  source = "unknown",
): void {
  const startTs = navLogger.logAttempt(pathname, params as Record<string, unknown> | undefined, source);

  const attempt = (n: number): void => {
    try {
      router.replace({ pathname: pathname as never, params: params as never });
      navLogger.logSuccess(pathname, startTs, source);
    } catch (err: unknown) {
      navLogger.logFailure(pathname, err, source, n);
      if (n === 1) {
        setTimeout(() => attempt(2), 300);
      }
    }
  };

  attempt(1);
}
